import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ForgeZero, createGenericFreeRecord, CapacityReservationLedger, DEFAULT_FREE_CAPACITY_POLICY, type CapacityRoute, type CapacityWindow, type ProviderCapacityPool } from "@codeforge/forge-zero";
import {
  type ProviderAdapter,
  type ProviderModel,
  type ChatRequest,
  type ChatResponse,
  type StreamEvent,
  InMemoryProviderCatalog,
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
 * R24 Phase 12 — production-shaped serving pilot. The Mission C tests prove each fabric seam
 * in isolation; this file flies a whole day over one shared fleet: three supply domains
 * (managed, sponsored, user-owned) behind one fabric, one reservation ledger and one health
 * authority, serving multiple users and sessions — with failure injected mid-flight.
 *
 * Invariants the pilot must hold end to end:
 *   - every provider call executes inside a live reservation on that provider's route;
 *   - the conservation order (shared → sponsored → user entitlement) holds under failure,
 *     not just on the happy path;
 *   - contention queues honestly and drains when capacity frees — no steal, no bypass;
 *   - one user's pool is never touched by another user under any pressure;
 *   - when the flight ends, every reservation has been released.
 */

type StreamScript = (call: number) => StreamEvent[];

class PilotProvider implements ProviderAdapter {
  readonly isTestProvider = true;
  callCount = 0;
  /** Reservation byRoute snapshot observed at each call — proof the hold preceded the call. */
  holdsDuringCalls: Array<Record<string, number>> = [];

  constructor(
    readonly providerId: string,
    private readonly modelId: string,
    private readonly script: StreamScript,
    private readonly snapshot: () => Record<string, number>,
  ) {}

  async listModels(): Promise<ProviderModel[]> {
    return [{
      modelId: this.modelId,
      displayName: `${this.providerId} ${this.modelId}`,
      isFree: true,
      freeStatus: "verified_free",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    }];
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("Use streamChat");
  }

  async *streamChat(_req: ChatRequest, _signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.callCount++;
    this.holdsDuringCalls.push(this.snapshot());
    yield* this.script(this.callCount);
  }

  async healthCheck() {
    return { status: "available" as const };
  }
}

const okEvents = (text = "Task complete."): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "usage", usage: { inputTokens: 40, outputTokens: 12 } },
  { type: "finish", finishReason: "stop" },
];

const OBSERVED_AT = new Date(Date.now() - 60_000).toISOString();
const NO_RESET = "9999-12-31T23:59:59.999Z";
const FABRIC_ROLES = ["PRIMARY_CODING_AGENT", "PLANNER", "REVIEWER", "SUBAGENT", "FAST_REASONER"];

function quotaWindow(overrides: Partial<CapacityWindow> = {}): CapacityWindow {
  return { unit: "requests", limit: 100, remaining: 100, resetAt: NO_RESET, scope: "ORG", observedAt: OBSERVED_AT, authoritative: true, ...overrides };
}

function sharedRoute(id: string, overrides: Partial<CapacityRoute> = {}): CapacityRoute {
  return {
    routeId: `fabric:${id}`,
    providerId: id,
    modelId: `${id}-model`,
    canonicalModelId: `${id}-model`,
    family: id,
    gateway: id,
    supplyClass: "PURE_MANAGED_FREE",
    capacityPoolId: `shared:${id}`,
    capacityPoolScope: "SHARED_OWNER_POOL",
    capacityScope: "ORG",
    dataPolicyProfile: "PRIVATE_CODE_ALLOWED",
    lifecycle: "APPROVED",
    explicitZeroPrice: true,
    paidFallbackDisabled: true,
    managedMultiUserAllowed: true,
    privacyClass: "standard",
    roles: FABRIC_ROLES,
    qualityScore: 70,
    healthy: true,
    enabled: true,
    windows: [quotaWindow(), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 2_000_000 })],
    ...overrides,
  };
}

function sponsoredRoute(id: string, overrides: Partial<CapacityRoute> = {}): CapacityRoute {
  return sharedRoute(id, { supplyClass: "SPONSORED_FREE", capacityScope: "SPONSORED", ...overrides });
}

function userPoolRoute(identity: string, overrides: Partial<CapacityRoute> = {}): CapacityRoute {
  return {
    ...sharedRoute(`user-${identity}`, {
      providerId: "user-cloud",
      modelId: "user-model",
      canonicalModelId: "user-model",
      gateway: "user-cloud",
      supplyClass: "USER_CONNECTED_FREE",
      capacityPoolId: `user-cloud:user:${identity}`,
      capacityPoolScope: "PER_USER_POOL",
      capacityScope: "USER_ACCOUNT",
      explicitZeroPrice: false,
      freeOnlyAdmissionProven: true,
      windows: [quotaWindow({ unit: "credits", scope: "USER_ACCOUNT", limit: 5, remaining: 5, resetAt: NO_RESET })],
      capacityIdentity: identity,
    }),
    ...overrides,
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

async function waitForTerminal(runtime: ReturnType<typeof createAgentRuntime>, persistence: ISessionPersistence, sessionId: string, turnId: string) {
  const approved = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const state = runtime.getTurn(turnId);
    if (state?.status === "completed" || state?.status === "failed") return state;
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

describe("R24 serving pilot — a day of traffic across managed, sponsored and user-owned supply", () => {
  let tmpDir: string;
  let persistence: ISessionPersistence;
  let eventStore: EventStore;
  let firewall: ForgeZero;
  let catalog: InMemoryProviderCatalog;
  let authority: EightBitRouteHealthAuthority;
  let reservations: CapacityReservationLedger;
  let fabric: FreeFabric;

  const managed = sharedRoute("managed-strong", { qualityScore: 90 });
  const sponsored = sponsoredRoute("sponsored-mid", { qualityScore: 60 });
  const alicePool = userPoolRoute("hash-alice");
  const fleet = [managed, sponsored, alicePool];

  const providers = new Map<string, PilotProvider>();
  const registerFleet = () => {
    for (const r of fleet) {
      firewall.register(createGenericFreeRecord({ providerId: r.providerId, modelId: r.modelId, displayName: `${r.providerId} ${r.modelId}` }));
    }
  };

  const provider = (id: string, script: StreamScript): PilotProvider => {
    const p = new PilotProvider(id, `${id}-model`, script, () => ({ ...(fabric.reservationSnapshot()?.byRoute ?? {}) }));
    providers.set(id, p);
    catalog.register(p);
    return p;
  };

  const holdsOn = (p: PilotProvider, routeId: string): number[] => p.holdsDuringCalls.map((h) => h[routeId] ?? 0);

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-r24-pilot-"));
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    eventStore = new EventStore();
    firewall = new ForgeZero();
    catalog = new InMemoryProviderCatalog();
    authority = createEightBitRouteHealthAuthority();
    // The ledger enforces the same supply-class policy the fabric plans under — mismatched
    // policies would let sponsored supply plan eligible yet never admit.
    reservations = new CapacityReservationLedger({ routes: [], pools: [], policy: { ...DEFAULT_FREE_CAPACITY_POLICY, allowSponsoredFree: true } });
    providers.clear();
    registerFleet();

    fabric = createFreeFabric({
      managedRoutes: () => fleet.filter((r) => r.capacityPoolScope !== "PER_USER_POOL"),
      managedPools: () => fleet.filter((r) => r.capacityPoolScope !== "PER_USER_POOL").map(poolFor),
      userSources: [{
        routesForUser: (userId: string) => fleet.filter((r) => r.capacityPoolScope === "PER_USER_POOL" && r.capacityIdentity === `hash-${userId}`),
        poolsForUser: (userId: string) => fleet.filter((r) => r.capacityPoolScope === "PER_USER_POOL" && r.capacityIdentity === `hash-${userId}`).map(poolFor),
      }],
      health: authority,
      reservations,
      policy: { ...DEFAULT_FREE_CAPACITY_POLICY, allowSponsoredFree: true },
    });
  });

  afterEach(async () => {
    await persistence.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const makeRuntime = (sessionId: string, userId?: string) =>
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
      fabricContext: ({ userId: uid }) => {
        const resolved = uid ?? "anonymous";
        return { userId: resolved, userIdentities: uid ? [`hash-${resolved}`] : [] };
      },
    });

  it("conservation order holds under failure: managed saturates, sponsored serves, the user's pool stays untouched", async () => {
    const managedProvider = provider("managed-strong", () => okEvents());
    const sponsoredProvider = provider("sponsored-mid", () => okEvents());
    const aliceProvider = provider("user-cloud", () => okEvents());
    const runtime = makeRuntime("sess-alice", "alice");
    await runtime.init();

    // Flight 1: healthy fleet — alice's turn takes the strongest shared route; sponsored and
    // her own entitlement are both conserved.
    const t1 = await runtime.startTurn("First task");
    const f1 = await waitForTerminal(runtime, persistence, "sess-alice", t1);
    expect(f1?.status).toBe("completed");
    expect(f1?.providerId).toBe("managed-strong");
    expect(managedProvider.callCount).toBe(1);
    expect(sponsoredProvider.callCount).toBe(0);
    expect(aliceProvider.callCount).toBe(0);
    // The call ran under a hold on the managed route — never reservation-free.
    expect(holdsOn(managedProvider, managed.routeId)).toEqual([1]);
    expect(reservations.snapshot().activeReservations).toBe(0);

    // Inject failure: the shared managed pool saturates (what four real capacity failures
    // would report — injected at the authority, the same place provider 429s land).
    for (let i = 0; i < 4; i++) {
      authority.observe({
        kind: "call_failure",
        providerId: "managed-strong",
        modelId: managed.modelId,
        observedAt: new Date(Date.now()).toISOString(),
        source: "runtime",
        reason: "TEMPORARY_CAPACITY",
        status: 502,
        message: "ResourceExhausted: worker limit reached",
        role: "CODER",
      });
    }

    // Flight 2: the next turn skips the saturated route and lands on sponsored supply —
    // the middle domain — still before touching alice's own quota.
    const t2 = await runtime.startTurn("Second task");
    const f2 = await waitForTerminal(runtime, persistence, "sess-alice", t2);
    expect(f2?.status).toBe("completed");
    expect(f2?.providerId).toBe("sponsored-mid");
    expect(sponsoredProvider.callCount).toBe(1);
    expect(aliceProvider.callCount).toBe(0);
    expect(holdsOn(sponsoredProvider, sponsored.routeId)).toEqual([1]);
    expect(reservations.snapshot().activeReservations).toBe(0);
  });

  it("a mid-turn provider failure re-decides into sponsored supply — never the user's own pool", async () => {
    // Managed answers once, then starts 429ing; the failover must land on the next supply
    // domain (sponsored), not on alice's entitlement — conservation under failover, not
    // just under saturation.
    let managedCalls = 0;
    const managedProvider = provider("managed-strong", () => {
      managedCalls++;
      return managedCalls === 1
        ? okEvents()
        : [{ type: "error", code: "PROVIDER_RATE_LIMITED", status: 429, message: "429 rate limited", retryable: true }];
    });
    const sponsoredProvider = provider("sponsored-mid", () => okEvents());
    const aliceProvider = provider("user-cloud", () => okEvents());
    const runtime = makeRuntime("sess-alice-failover", "alice");
    await runtime.init();

    const t1 = await runtime.startTurn("Warm-up task");
    const f1 = await waitForTerminal(runtime, persistence, "sess-alice-failover", t1);
    expect(f1?.status).toBe("completed");

    const t2 = await runtime.startTurn("Task over a failing route");
    const f2 = await waitForTerminal(runtime, persistence, "sess-alice-failover", t2);
    expect(f2?.status).toBe("completed");
    expect(f2?.providerId).toBe("sponsored-mid");
    expect(sponsoredProvider.callCount).toBe(1);
    expect(aliceProvider.callCount).toBe(0);
    // The failover executed under exactly one hold — on the sponsored route, not two holds
    // on two routes and never reservation-free.
    expect(holdsOn(sponsoredProvider, sponsored.routeId)).toEqual([1]);
    expect(sponsoredProvider.holdsDuringCalls[0]).toEqual({ [sponsored.routeId]: 1 });
    expect(reservations.snapshot().activeReservations).toBe(0);
  });

  it("contention queues a third session honestly, drains when capacity frees, and never leaks into another user's pool", async () => {
    // Both shared pools offer one concurrent slot each; alice's pool exists but belongs to her.
    const tightFleet = [
      { ...managed, windows: [quotaWindow(), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 2_000_000 }), quotaWindow({ unit: "concurrency", limit: 1, remaining: 1 })] },
      { ...sponsored, windows: [quotaWindow(), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 2_000_000 }), quotaWindow({ unit: "concurrency", limit: 1, remaining: 1 })] },
      alicePool,
    ];
    fabric = createFreeFabric({
      managedRoutes: () => tightFleet.filter((r) => r.capacityPoolScope !== "PER_USER_POOL"),
      managedPools: () => tightFleet.filter((r) => r.capacityPoolScope !== "PER_USER_POOL").map(poolFor),
      userSources: [{
        routesForUser: (userId: string) => tightFleet.filter((r) => r.capacityPoolScope === "PER_USER_POOL" && r.capacityIdentity === `hash-${userId}`),
        poolsForUser: (userId: string) => tightFleet.filter((r) => r.capacityPoolScope === "PER_USER_POOL" && r.capacityIdentity === `hash-${userId}`).map(poolFor),
      }],
      health: authority,
      reservations,
      policy: { ...DEFAULT_FREE_CAPACITY_POLICY, allowSponsoredFree: true },
    });

    const managedProvider = provider("managed-strong", () => okEvents());
    const sponsoredProvider = provider("sponsored-mid", () => okEvents());
    const aliceProvider = provider("user-cloud", () => okEvents());

    // Two other users occupy both shared slots before carol's session asks.
    expect(fabric.decide({ requestId: "hold-1", userId: "other-1", role: "PRIMARY_CODING_AGENT" }).outcome).toBe("ADMITTED");
    expect(fabric.decide({ requestId: "hold-2", userId: "other-2", role: "PRIMARY_CODING_AGENT" }).outcome).toBe("ADMITTED");
    expect(reservations.snapshot().activeReservations).toBe(2);

    const runtime = makeRuntime("sess-carol", "carol");
    await runtime.init();
    const t1 = await runtime.startTurn("Work under contention");
    const f1 = await waitForTerminal(runtime, persistence, "sess-carol", t1);
    // Carol has no pool of her own; both shared pools are full — the turn fails closed and
    // no provider was ever called. Alice's entitlement is not even a candidate for her.
    expect(f1?.status).toBe("failed");
    expect(managedProvider.callCount).toBe(0);
    expect(sponsoredProvider.callCount).toBe(0);
    expect(aliceProvider.callCount).toBe(0);
    expect(reservations.snapshot().activeReservations).toBe(2);

    // A slot frees; carol's retry is admitted on whichever pool opened — honest drain order.
    fabric.release("hold-1");
    const t2 = await runtime.startTurn("Work after drain");
    const f2 = await waitForTerminal(runtime, persistence, "sess-carol", t2);
    expect(f2?.status).toBe("completed");
    expect(managedProvider.callCount + sponsoredProvider.callCount).toBe(1);
    expect(reservations.snapshot().activeReservations).toBe(1); // only hold-2 remains

    fabric.release("hold-2");
    expect(reservations.snapshot().activeReservations).toBe(0);
  });
});
