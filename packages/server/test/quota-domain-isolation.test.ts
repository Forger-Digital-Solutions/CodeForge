import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ForgeZero, createGenericFreeRecord, CapacityReservationLedger, hashQuotaScope, type CapacityRoute, type CapacityWindow, type ProviderCapacityPool } from "@codeforge/forge-zero";
import {
  type ProviderAdapter,
  type ProviderModel,
  type ChatRequest,
  type ChatResponse,
  type StreamEvent,
  InMemoryProviderCatalog,
  ProviderCapacityGovernor,
} from "@codeforge/providers";
import { EventStore, createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import {
  createEightBitRouteHealthAuthority,
  createFreeFabric,
  type EightBitRouteHealthAuthority,
  type FreeFabric,
} from "@codeforge/eight-bit";
import { createAgentRuntime } from "../src/agent-runtime.js";

/**
 * R70 serving-path proof: the quota-domain key admitted by the Free Fabric reaches the real
 * agent loop, so a 429 on one verified account domain cools that domain only — never the
 * provider-global bucket, never a second user's verified-independent account on the same
 * provider, and never an alias that secretly shares the first account's upstream quota.
 */

const PROVIDER = "quota-x";
const MODEL = "quota-x-model";
const FABRIC_ROLES = ["PRIMARY_CODING_AGENT", "PLANNER", "REVIEWER", "SUBAGENT", "FAST_REASONER"];
const OBSERVED_AT = new Date(Date.now() - 60_000).toISOString();
const NO_RESET = "9999-12-31T23:59:59.999Z";

class ScriptedQuotaProvider implements ProviderAdapter {
  readonly providerId = PROVIDER;
  readonly isTestProvider = false;
  calls = 0;

  constructor(private readonly script: (call: number) => StreamEvent[]) {}

  async listModels(): Promise<ProviderModel[]> {
    return [{
      modelId: MODEL,
      displayName: MODEL,
      isFree: true,
      freeStatus: "verified_free",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    }];
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("Use streamChat");
  }

  async *streamChat(_req: ChatRequest): AsyncIterable<StreamEvent> {
    this.calls++;
    yield* this.script(this.calls);
  }

  async healthCheck() {
    return { status: "available" as const };
  }
}

const okEvents = (): StreamEvent[] => [
  { type: "text_delta", delta: "Task complete." },
  { type: "usage", usage: { inputTokens: 40, outputTokens: 12 } },
  { type: "finish", finishReason: "stop" },
];

const accountLimited = (): StreamEvent[] => [
  { type: "error", code: "PROVIDER_RATE_LIMITED", status: 429, message: "429 insufficient_quota: account daily quota exhausted", retryable: true, retryAfter: Date.now() + 3_600_000 },
];

function quotaWindow(overrides: Partial<CapacityWindow> = {}): CapacityWindow {
  return { unit: "requests", limit: 100, remaining: 100, resetAt: NO_RESET, scope: "ORG", observedAt: OBSERVED_AT, authoritative: true, ...overrides };
}

function entitledRoute(userIdentity: string, account: string): CapacityRoute {
  const now = Date.now();
  return {
    routeId: `fabric:${PROVIDER}-${account}`,
    providerId: PROVIDER,
    modelId: MODEL,
    canonicalModelId: MODEL,
    family: PROVIDER,
    gateway: PROVIDER,
    supplyClass: "USER_ENTITLED_FREE",
    quotaDomainType: "USER_ACCOUNT",
    quotaDomainId: `${PROVIDER}-acct-${account}`,
    quotaScopeEvidence: {
      scope: "USER_ACCOUNT",
      identityHash: hashQuotaScope(PROVIDER, "USER_ACCOUNT", account),
      source: "test-account-metadata",
      verifiedAt: new Date(now - 60_000).toISOString(),
      recheckAt: new Date(now + 3_600_000).toISOString(),
    },
    egressMode: "CLIENT_DIRECT",
    marginalCostToCodeForge: 0,
    freePrivacyClass: "PRIVATE_SAFE",
    trainingUse: "NO",
    admissionReceipt: {
      sourceDocumentation: "test",
      termsEvidence: "test",
      priceEvidence: "test",
      privacyEvidence: "test",
      verifiedAt: new Date(now - 60_000).toISOString(),
      recheckAt: new Date(now + 3_600_000).toISOString(),
      qualificationAt: new Date(now - 60_000).toISOString(),
    },
    capacityPoolId: `${PROVIDER}:user:${account}`,
    capacityPoolScope: "PER_USER_POOL",
    capacityScope: "USER_ACCOUNT",
    capacityIdentity: userIdentity,
    dataPolicyProfile: "PRIVATE_CODE_ALLOWED",
    lifecycle: "APPROVED",
    explicitZeroPrice: false,
    freeOnlyAdmissionProven: true,
    paidFallbackDisabled: true,
    managedMultiUserAllowed: true,
    privacyClass: "standard",
    roles: FABRIC_ROLES,
    qualityScore: 80,
    healthy: true,
    enabled: true,
    windows: [quotaWindow({ unit: "credits", scope: "USER_ACCOUNT", limit: 5, remaining: 5, resetAt: NO_RESET })],
  };
}

function poolFor(route: CapacityRoute): ProviderCapacityPool {
  return {
    poolId: route.capacityPoolId,
    providerId: route.providerId,
    scope: route.capacityPoolScope,
    supplyClass: route.supplyClass,
    windows: route.windows,
    observedAt: OBSERVED_AT,
    authoritative: true,
    ...(route.capacityIdentity !== undefined ? { capacityIdentity: route.capacityIdentity } : {}),
  };
}

async function waitForTerminal(
  runtime: ReturnType<typeof createAgentRuntime>,
  persistence: ISessionPersistence,
  sessionId: string,
  turnId: string,
) {
  const approved = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const state = runtime.getTurn(turnId);
    if (state?.status === "completed" || state?.status === "failed" || state?.status === "waiting_for_free_capacity") return state;
    if (state?.status === "waiting_for_approval") {
      const items = await persistence.getWorkItems(sessionId);
      const pending = items.find((it) => it.kind === "approval" && it.turnId === turnId && !it.decision && !approved.has(it.id));
      if (pending) {
        approved.add(pending.id);
        await runtime.resolveApproval(pending.id, "allow_once");
      }
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return runtime.getTurn(turnId);
}

const keyFor = (account: string) => `${PROVIDER}:USER_ACCOUNT:${hashQuotaScope(PROVIDER, "USER_ACCOUNT", account)}`;

describe("R70 quota-domain isolation in the serving path", () => {
  let tmpDir: string;
  let persistence: ISessionPersistence;
  let eventStore: EventStore;
  let firewall: ForgeZero;
  let catalog: InMemoryProviderCatalog;
  let authority: EightBitRouteHealthAuthority;
  let governor: ProviderCapacityGovernor;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-quota-domain-"));
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    eventStore = new EventStore();
    firewall = new ForgeZero();
    catalog = new InMemoryProviderCatalog();
    authority = createEightBitRouteHealthAuthority();
    governor = new ProviderCapacityGovernor();
    firewall.register(createGenericFreeRecord({ providerId: PROVIDER, modelId: MODEL }));
  });

  afterEach(async () => {
    await persistence.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const makeFabric = (routes: CapacityRoute[], pools: ProviderCapacityPool[]): FreeFabric =>
    createFreeFabric({
      managedRoutes: () => routes.filter((r) => r.capacityPoolScope !== "PER_USER_POOL"),
      managedPools: () => pools.filter((p) => p.scope !== "PER_USER_POOL"),
      userSources: [{
        routesForUser: (userId: string) => routes.filter((r) => r.capacityPoolScope === "PER_USER_POOL" && r.capacityIdentity === `hash-${userId}`),
        poolsForUser: (userId: string) => pools.filter((p) => p.scope === "PER_USER_POOL" && p.capacityIdentity === `hash-${userId}`),
      }],
      health: authority,
      reservations: new CapacityReservationLedger({ routes: [], pools: [] }),
    });

  const makeRuntime = (sessionId: string, fabric: FreeFabric, userId: string) =>
    createAgentRuntime({
      sessionId,
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: tmpDir,
      userId,
      routeHealth: authority,
      freeFabric: fabric,
      capacityGovernor: governor,
      fabricContext: ({ userId: uid }) => {
        const resolved = uid ?? "anonymous";
        return { userId: resolved, userIdentities: uid ? [`hash-${resolved}`] : [] };
      },
    });

  it("a 429 on one verified account domain cools that domain only — never the provider-global bucket, never a peer account, and never an alias", async () => {
    const routes = [
      entitledRoute("hash-alice", "acct-alice"),
      entitledRoute("hash-bob", "acct-bob"),
      entitledRoute("hash-carol", "acct-alice"),
    ];
    const fabric = makeFabric(routes, routes.map(poolFor));
    const provider = new ScriptedQuotaProvider((call) => (call === 1 ? accountLimited() : okEvents()));
    catalog.register(provider);

    // Alice's turn: her account returns a 429 — her domain cools, nobody else's does.
    const runtimeA = makeRuntime("sess-dom-alice", fabric, "alice");
    await runtimeA.init();
    const turnA = await runtimeA.startTurn("Do work");
    const finalA = await waitForTerminal(runtimeA, persistence, "sess-dom-alice", turnA);
    // A mid-turn 429 with no admissible replacement either fails the turn or parks it on
    // durable capacity wait — both are honest; what must never happen is silent success or
    // the cooldown escaping Alice's domain.
    expect(finalA?.status).toMatch(/failed|waiting_for_free_capacity/);
    expect(provider.calls).toBeGreaterThanOrEqual(1);

    const domainA = governor.quotaDomainGovernor(PROVIDER, keyFor("acct-alice"));
    expect(domainA?.isCoolingDown(PROVIDER)).toBe(true);
    expect(governor.isCoolingDown(PROVIDER)).toBe(false);

    // Bob's account is a verified-independent quota domain: Alice's cooldown must not reach him.
    const runtimeB = makeRuntime("sess-dom-bob", fabric, "bob");
    await runtimeB.init();
    const turnB = await runtimeB.startTurn("Do work");
    const finalB = await waitForTerminal(runtimeB, persistence, "sess-dom-bob", turnB);
    expect(finalB?.status).toBe("completed");
    expect(governor.quotaDomainGovernor(PROVIDER, keyFor("acct-bob"))?.isCoolingDown(PROVIDER)).toBe(false);

    // Carol's route is a different fabric entry but the same physical account as Alice —
    // the domain governor must already be cooling before a single packet is sent.
    const callsBeforeCarol = provider.calls;
    const runtimeC = makeRuntime("sess-dom-carol", fabric, "carol");
    await runtimeC.init();
    const turnC = await runtimeC.startTurn("Do work");
    const finalC = await waitForTerminal(runtimeC, persistence, "sess-dom-carol", turnC);
    expect(finalC?.status).toMatch(/failed|waiting_for_free_capacity/);
    expect(provider.calls).toBe(callsBeforeCarol);
  });
});
