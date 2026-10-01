// Reproduce the v9 denial: qualified 120b route + healthy stamped quota, then decide()
// through the production-wired fabric + ledger. Prints every window and the reserve verdict.
import { ForgeZero } from "../../../packages/forge-zero/dist/index.js";
import { CapacityReservationLedger } from "../../../packages/forge-zero/dist/capacity-reservations.js";
import { FreeFabric } from "../../../packages/eight-bit/dist/free-fabric.js";
import { FreeCloudService, NormalizedModelRegistry } from "../../../packages/model-registry/dist/index.js";
import { InMemoryProviderCatalog, createMockProvider } from "../../../packages/providers/dist/index.js";

const MODEL = "openai/gpt-oss-120b";
const START = Date.now();

const freeRecord = (providerId, modelId) => ({
  providerId,
  modelId,
  displayName: modelId,
  freeStatus: "verified_free",
  freeStatusVerifiedAt: new Date(START).toISOString(),
  tier: "free",
  contextWindow: 131072,
  capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
  costProfile: {
    inputCostPerMillion: 0, outputCostPerMillion: 0, isFree: true,
    freeTierVerifiedAt: new Date(START).toISOString(),
    paidFallbackPossible: false, paidFallbackDisabled: true, source: "pricing+live-catalog",
  },
  isRemote: true, isCloudHosted: true,
  accessClass: "FREE_NATIVE",
  privacyClass: "standard",
  lastVerified: new Date(START).toISOString(),
  verificationSource: "pricing+live-catalog",
  health: { status: "available", lastCheckedAt: new Date(START).toISOString() },
});

const fw = new ForgeZero();
fw.register(freeRecord("groq", MODEL));
const catalog = new InMemoryProviderCatalog();
catalog.register(createMockProvider({ providerId: "groq" }));

const svc = new FreeCloudService({
  firewall: fw,
  providerCatalog: catalog,
  registry: new NormalizedModelRegistry(),
  now: () => new Date(),
  qualificationCycleIntervalMs: 0,
  qualificationRunner: async (model) => {
    const role = { role: "CODER", status: "QUALIFIED", testCases: [], hardFailures: [], overallScore: 1,
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
    return {
      suiteVersion: "R41_ROLE_QUALIFICATION_V3",
      providerId: model.providerId, modelId: model.modelId, modelDisplayName: model.modelId,
      accessClass: "FREE_NATIVE", freeStatus: "verified_free",
      roleResults: { CODER: role },
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      totalLatencyMs: 5, qualificationState: "QUALIFIED", hardFailureRoles: [],
    };
  },
});
// Packaged-run connection shape: user API key, local owner, free plan attested.
svc.setConnection({
  providerId: "groq", connected: true, credentialSource: "SECURE_STORAGE",
  authState: "ok", ownerUserId: "local", planAttested: true,
});

// Stamp quota with the REAL captured Groq headers (request window 934/1000 pending reset,
// token window 7923/8000 already past its 577ms reset — the state at the denied decide).
svc.onProviderResponse({
  providerId: "groq", modelId: MODEL, status: 200,
  headers: [
    ["x-ratelimit-limit-requests", "1000"],
    ["x-ratelimit-remaining-requests", "934"],
    ["x-ratelimit-reset-requests", "44m38.4s"],
    ["x-ratelimit-limit-tokens", "8000"],
    ["x-ratelimit-remaining-tokens", "7923"],
    ["x-ratelimit-reset-tokens", "577ms"],
  ],
  observedAt: Date.now(),
});

const produced = await svc.qualifyPending();
console.log("receipts:", produced.length, "eligible:", svc.isForgeAutoEligible("groq", MODEL));

// Production wiring (index.ts:362-383).
const ledger = new CapacityReservationLedger({ routes: [], pools: [], maxActiveReservationsPerUser: 8 });
const fabric = new FreeFabric({
  managedRoutes: () => svc.capacityRoutes().filter((r) => r.capacityPoolScope !== "PER_USER_POOL"),
  managedPools: () => svc.capacityPools().filter((p) => p.scope !== "PER_USER_POOL"),
  userSources: [{ routesForUser: (u) => svc.routesForUser(u), poolsForUser: (u) => svc.poolsForUser(u) }],
  reservations: ledger,
  tokenizerRatioFor: () => 1.5,
});

const userRoutes = svc.routesForUser("local");
const pools = svc.poolsForUser("local");
for (const r of userRoutes) {
  console.log("\nROUTE", r.routeId, "pool:", r.capacityPoolId, "scope:", r.capacityPoolScope,
    "supply:", r.supplyClass, "healthy:", r.healthy, "enabled:", r.enabled,
    "lifecycle:", r.lifecycle, "explicitZeroPrice:", r.explicitZeroPrice,
    "freeOnlyAdmissionProven:", r.freeOnlyAdmissionProven, "capacityIdentity:", r.capacityIdentity);
  for (const w of r.windows) console.log("   route win:", JSON.stringify(w));
}
for (const p of pools) {
  console.log("\nPOOL", p.poolId, "scope:", p.scope);
  for (const w of p.windows) console.log("   pool win:", JSON.stringify(w));
}

const decision = fabric.decide({
  requestId: "repro-1",
  userId: "local",
  userIdentities: svc.capacityIdentitiesFor("local"),
  role: "PRIMARY_CODING_AGENT",
  healthRole: "CODER",
  demand: { requests: 1, estimatedPromptTokens: 8729, outputTokens: 2048 },
});
console.log("\nDECIDE:", decision.outcome, "queued:", JSON.stringify(decision.queued));
for (const r of decision.candidates ?? []) {
  console.log(`   ${r.status} ${r.providerId}/${r.modelId} ${JSON.stringify(r.reasonCodes)}`);
}

// Step into reserve() directly on the projected route/pool to name the failing check.
const route = userRoutes.find((r) => r.modelId === MODEL);
if (route) {
  const res = ledger.reserve({
    reservationId: "repro-res", userId: "local", routeIds: [route.routeId],
    role: "PRIMARY_CODING_AGENT", taskKind: "task",
    requests: 1, inputTokens: Math.ceil(8729 * 1.5 * 1.15), outputTokens: 2048,
    capacityIdentity: route.capacityIdentity, isNewUser: false,
    createdAt: new Date().toISOString(),
    leaseUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  console.log("\nRESERVE:", JSON.stringify(res));
}
