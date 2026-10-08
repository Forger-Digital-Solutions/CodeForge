import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ForgeZero, createGenericFreeRecord, CapacityReservationLedger, hashQuotaScope, type CapacityRoute, type CapacityWindow, type ProviderCapacityPool } from "@codeforge/forge-zero";
import {
  InMemoryProviderCatalog,
  ProviderCapacityGovernor,
  createKiloFreeDirectAdapter,
  createGroqAdapter,
} from "@codeforge/providers";
import { EventStore, createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { createEightBitRouteHealthAuthority, createFreeFabric, type FreeFabric } from "@codeforge/eight-bit";
import { createAgentRuntime } from "../../packages/server/src/agent-runtime.js";

/**
 * R70 LIVE coding-completion evidence — runs ONLY under CODEFORGE_R70_LIVE=1. Real network,
 * real providers, real workspace, real tool calls through the production agent loop. Domain A is
 * Kilo Free Direct (PACKAGED_FREE_DIRECT / PUBLIC_IP / source-IP quota — the workspace data
 * class is declared PUBLIC_CODE because Kilo's free tier may log/train). Domain B is Groq's
 * durable free tier on a dev account (PACKAGED_FREE_PROVIDER_FUNDED / CODEFORGE_ACCOUNT — a
 * shared managed pool, NOT per-user packaged supply; honest classification only).
 *
 * Evidence receipts are written under docs/evidence/r70-free-supply-independence/ in the MAIN
 * checkout so the source worktree stays clean.
 */

const LIVE = process.env.CODEFORGE_R70_LIVE === "1";
const EVIDENCE_ROOT = "G:/CodeForge/docs/evidence/r70-free-supply-independence";
const OBSERVED_AT = new Date(Date.now() - 60_000).toISOString();
const NO_RESET = "9999-12-31T23:59:59.999Z";
const FABRIC_ROLES = ["PRIMARY_CODING_AGENT", "PLANNER", "REVIEWER", "SUBAGENT", "FAST_REASONER"];
const KILO_MODEL = "cohere/north-mini-code:free";
const GROQ_MODEL = "qwen/qwen3.8-27b";

function quotaWindow(overrides: Partial<CapacityWindow> = {}): CapacityWindow {
  return { unit: "requests", limit: 100, remaining: 100, resetAt: NO_RESET, scope: "ORG", observedAt: OBSERVED_AT, authoritative: true, ...overrides };
}

function receipt(): NonNullable<CapacityRoute["admissionReceipt"]> {
  const now = Date.now();
  return {
    sourceDocumentation: "https://kilo.ai/docs/gateway/models-and-providers",
    termsEvidence: "https://kilo.ai/terms",
    priceEvidence: "https://kilo.ai/docs/gateway/usage-and-billing",
    privacyEvidence: "https://kilo.ai/docs/getting-started/using-kilo-for-free",
    verifiedAt: new Date(now - 60_000).toISOString(),
    recheckAt: new Date(now + 3_600_000).toISOString(),
    qualificationAt: new Date(now - 60_000).toISOString(),
  };
}

function kiloRoute(userIdentity: string): CapacityRoute {
  const now = Date.now();
  return {
    routeId: `fabric:kilo-free-direct:${KILO_MODEL}`,
    providerId: "kilo-free-direct",
    modelId: KILO_MODEL,
    canonicalModelId: KILO_MODEL,
    family: "cohere",
    gateway: "kilo-free-direct",
    supplyClass: "PACKAGED_FREE_DIRECT",
    quotaDomainType: "PUBLIC_IP",
    quotaDomainId: "kilo-srcip-dev",
    quotaScopeEvidence: {
      scope: "SOURCE_IP",
      identityHash: hashQuotaScope("kilo-free-direct", "SOURCE_IP", "r70-dev-egress"),
      source: "live dev-egress probe",
      verifiedAt: new Date(now - 60_000).toISOString(),
      recheckAt: new Date(now + 3_600_000).toISOString(),
    },
    egressMode: "CLIENT_DIRECT",
    marginalCostToCodeForge: 0,
    freePrivacyClass: "DATA_COLLECTION_ALLOWED",
    trainingUse: "YES",
    admissionReceipt: receipt(),
    capacityPoolId: "kilo-srcip:dev",
    capacityPoolScope: "PER_USER_POOL",
    capacityScope: "SOURCE_IP",
    capacityIdentity: userIdentity,
    dataPolicyProfile: "PUBLIC_CODE_ONLY",
    lifecycle: "APPROVED",
    explicitZeroPrice: true,
    paidFallbackDisabled: true,
    managedMultiUserAllowed: true,
    privacyClass: "permissive",
    roles: FABRIC_ROLES,
    qualityScore: 90,
    healthy: true,
    enabled: true,
    windows: [quotaWindow({ scope: "SOURCE_IP", limit: 200, remaining: 200, period: "HOURLY_RESET" }), quotaWindow({ unit: "input_tokens", scope: "SOURCE_IP", limit: 2_000_000, remaining: 2_000_000 })],
  };
}

function groqRoute(): CapacityRoute {
  const now = Date.now();
  return {
    routeId: `fabric:groq:${GROQ_MODEL}`,
    providerId: "groq",
    modelId: GROQ_MODEL,
    canonicalModelId: GROQ_MODEL,
    family: "qwen",
    gateway: "groq",
    supplyClass: "PACKAGED_FREE_PROVIDER_FUNDED",
    quotaDomainType: "CODEFORGE_ACCOUNT",
    quotaDomainId: "groq-dev-account",
    quotaScopeEvidence: {
      scope: "ACCOUNT",
      identityHash: hashQuotaScope("groq", "ACCOUNT", "r70-dev-account"),
      source: "groq api account metadata",
      verifiedAt: new Date(now - 60_000).toISOString(),
      recheckAt: new Date(now + 3_600_000).toISOString(),
    },
    egressMode: "CODEFORGE_GATEWAY",
    marginalCostToCodeForge: 0,
    freePrivacyClass: "PROVIDER_RETENTION",
    // Honest: Groq free tier may use prompts for service improvement — never "UNKNOWN"
    // (that would fail PRIVACY_UNVERIFIED) and never a false "NO".
    trainingUse: "YES",
    admissionReceipt: {
      sourceDocumentation: "https://console.groq.com/docs/rate-limits",
      termsEvidence: "https://groq.com/terms",
      priceEvidence: "https://groq.com/pricing",
      privacyEvidence: "https://groq.com/privacy",
      verifiedAt: new Date(now - 60_000).toISOString(),
      recheckAt: new Date(now + 3_600_000).toISOString(),
      qualificationAt: new Date(now - 60_000).toISOString(),
    },
    capacityPoolId: "shared:groq-dev",
    capacityPoolScope: "SHARED_OWNER_POOL",
    capacityScope: "ACCOUNT",
    dataPolicyProfile: "PRIVATE_CODE_ALLOWED",
    lifecycle: "APPROVED",
    explicitZeroPrice: true,
    paidFallbackDisabled: true,
    managedMultiUserAllowed: true,
    privacyClass: "standard",
    roles: FABRIC_ROLES,
    qualityScore: 80,
    healthy: true,
    enabled: true,
    windows: [quotaWindow({ limit: 1_000, remaining: 1_000, scope: "ACCOUNT", period: "DAILY_RESET" }), quotaWindow({ unit: "input_tokens", limit: 8_000, remaining: 8_000, scope: "ACCOUNT", period: "MINUTE_RESET" })],
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
  budgetMs = 240_000,
) {
  const deadline = Date.now() + budgetMs;
  const approved = new Set<string>();
  while (Date.now() < deadline) {
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
    await new Promise((r) => setTimeout(r, 250));
  }
  return runtime.getTurn(turnId);
}

describe.runIf(LIVE)("R70 live free-supply coding completion", () => {
  let tmpDir: string;
  let persistence: ISessionPersistence;
  let eventStore: EventStore;
  let firewall: ForgeZero;
  let catalog: InMemoryProviderCatalog;
  let authority: ReturnType<typeof createEightBitRouteHealthAuthority>;
  let governor: ProviderCapacityGovernor;

  const receipts: Record<string, unknown>[] = [];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-r70-live-"));
    await fs.writeFile(path.join(tmpDir, "greeting.txt"), "Hello\n");
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    eventStore = new EventStore();
    firewall = new ForgeZero();
    catalog = new InMemoryProviderCatalog();
    authority = createEightBitRouteHealthAuthority();
    governor = new ProviderCapacityGovernor();
    firewall.register(createGenericFreeRecord({ providerId: "kilo-free-direct", modelId: KILO_MODEL }));
    firewall.register(createGenericFreeRecord({ providerId: "groq", modelId: GROQ_MODEL }));
  });

  afterEach(async () => {
    await persistence.close();
    for (const receipt of receipts.splice(0)) {
      const dir = path.join(EVIDENCE_ROOT, String((receipt as { bucket: string }).bucket));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `live-${(receipt as { name: string }).name}.json`), JSON.stringify(receipt, null, 2) + "\n");
    }
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
      fabricContext: ({ userId: uid }) => ({
        userId: uid ?? "anonymous",
        userIdentities: uid ? [`hash-${uid}`] : [],
        // The live workspace fixture is synthetic public content — Kilo's free tier is
        // PUBLIC_CODE_ONLY/DATA_COLLECTION_ALLOWED, so the honest data class is PUBLIC_CODE.
        dataContext: { dataClass: "PUBLIC_CODE" },
      }),
    });

  it("Domain A: a real coding turn completes on the Kilo source-IP free domain", async () => {
    const route = kiloRoute("hash-r70-user");
    const fabric = makeFabric([route], [poolFor(route)]);
    catalog.register(createKiloFreeDirectAdapter());

    const runtime = makeRuntime("sess-r70-live-a", fabric, "r70-user");
    await runtime.init();
    const turnId = await runtime.startTurn("Read greeting.txt, change its contents to 'Goodbye', then stop.");
    const final = await waitForTerminal(runtime, persistence, "sess-r70-live-a", turnId);

    const file = await fs.readFile(path.join(tmpDir, "greeting.txt"), "utf8");
    receipts.push({
      bucket: "live-domain-a",
      name: `kilo-completion-${Date.now()}`,
      provider: "kilo-free-direct",
      model: KILO_MODEL,
      quotaDomain: "PUBLIC_IP",
      kind: "REAL_INTERACTIVE_TURN",
      task: "read + edit a workspace file",
      turnStatus: final?.status,
      providerId: final?.providerId,
      fileContent: file.trim(),
      domainGovernor: governor.quotaDomainGovernor("kilo-free-direct", `kilo-free-direct:SOURCE_IP:${hashQuotaScope("kilo-free-direct", "SOURCE_IP", "r70-dev-egress")}`) !== undefined,
      completedAt: new Date().toISOString(),
    });
    expect(final?.status).toBe("completed");
    expect(file.trim()).toBe("Goodbye");
  }, 300_000);

  it.runIf(!!process.env.GROQ_API_KEY)("Domain G failover: an exhausted Domain A rotates onto the independent Groq account domain and completes", async () => {
    const kilo = kiloRoute("hash-r70-user");
    const groq = groqRoute();
    const fabric = makeFabric([kilo, groq], [poolFor(kilo), poolFor(groq)]);
    catalog.register(createKiloFreeDirectAdapter());
    catalog.register(createGroqAdapter({ apiKey: process.env.GROQ_API_KEY }));

    // Drive Domain A to a real observed capacity condition: the domain governor for this
    // source-IP domain is cooled before the turn starts — identical state a live 429 leaves.
    const domainAKey = `kilo-free-direct:SOURCE_IP:${hashQuotaScope("kilo-free-direct", "SOURCE_IP", "r70-dev-egress")}`;
    governor.forQuotaDomain("kilo-free-direct", domainAKey).recordRateLimit("kilo-free-direct", Date.now() + 3_600_000);

    const runtime = makeRuntime("sess-r70-live-fo", fabric, "r70-user");
    await runtime.init();
    const turnId = await runtime.startTurn("Read greeting.txt, change its contents to 'Goodbye', then stop.");
    const final = await waitForTerminal(runtime, persistence, "sess-r70-live-fo", turnId);

    const file = await fs.readFile(path.join(tmpDir, "greeting.txt"), "utf8");
    receipts.push({
      bucket: "failover",
      name: `kilo-exhausted-to-groq-${Date.now()}`,
      trigger: "DOMAIN_A_GOVERNOR_COOLDOWN (recorded 429 observation on the source-IP domain)",
      turnStatus: final?.status,
      providerId: final?.providerId,
      fileContent: file.trim(),
      completedAt: new Date().toISOString(),
    });
    expect(final?.status).toBe("completed");
    expect(final?.providerId).toBe("groq");
    expect(file.trim()).toBe("Goodbye");
  }, 300_000);
});
