import { describe, expect, it } from "vitest";
import { CapacityReservationLedger, capacityIndependenceKey, hashQuotaScope, type CapacityRoute, type ProviderCapacityPool } from "@codeforge/forge-zero";
import { ProviderCapacityGovernor } from "@codeforge/providers";
import { createFreeFabric } from "../src/free-fabric.js";
import { createEightBitRouteHealthAuthority } from "../src/route-health-authority.js";

const start = Date.now() - 100;
const at = new Date(start).toISOString();
const reset = new Date(start + 3_600_000).toISOString();
function route(owner: string, modelId = "lab/hot:free", overrides: Partial<CapacityRoute> = {}): CapacityRoute {
  return {
    routeId: `${owner}:${modelId}`, providerId: "kilo-free-direct", modelId, canonicalModelId: modelId,
    family: "lab", gateway: "kilo-free-direct", supplyClass: "PACKAGED_FREE_DIRECT", quotaDomainType: "PUBLIC_IP",
    quotaDomainId: `ip:${owner}`, capacityPoolId: `ip:${owner}`, capacityPoolScope: "PER_USER_POOL", capacityIdentity: owner,
    capacityScope: "SOURCE_IP", dataPolicyProfile: "PUBLIC_CODE_ONLY", lifecycle: "APPROVED", explicitZeroPrice: true,
    paidFallbackDisabled: true, freeOnlyAdmissionProven: true, managedMultiUserAllowed: true, privacyClass: "permissive",
    egressMode: "CLIENT_DIRECT", marginalCostToCodeForge: 0, freePrivacyClass: "DATA_COLLECTION_ALLOWED", trainingUse: "YES",
    roles: ["PRIMARY_CODING_AGENT"], qualityScore: modelId.includes("hot") ? 95 : 80, healthy: true, enabled: true,
    windows: [{ unit: "requests", limit: 200, remaining: 200, resetAt: reset, scope: "SOURCE_IP", observedAt: at, authoritative: true }],
    quotaScopeEvidence: { scope: "SOURCE_IP", identityHash: hashQuotaScope("kilo-free-direct", "SOURCE_IP", owner), source: "verified fixture egress authority", verifiedAt: at, recheckAt: reset },
    admissionReceipt: { sourceDocumentation: "https://kilo.ai/docs/gateway", termsEvidence: "https://kilo.ai/terms", privacyEvidence: "https://kilo.ai/privacy", priceEvidence: "https://kilo.ai/docs/gateway/models-and-providers", verifiedAt: at, recheckAt: reset, qualificationAt: at },
    ...overrides,
  };
}
function pool(r: CapacityRoute): ProviderCapacityPool {
  return { poolId: r.capacityPoolId, providerId: r.providerId, scope: r.capacityPoolScope, supplyClass: r.supplyClass, windows: r.windows, observedAt: at, authoritative: true, capacityIdentity: r.capacityIdentity };
}
function setup(routes: CapacityRoute[], now: () => number) {
  const health = createEightBitRouteHealthAuthority(undefined, now);
  const fabric = createFreeFabric({ managedRoutes: () => [], health, now, reservations: new CapacityReservationLedger({ routes: [], now }),
    userSources: [{ routesForUser: owner => routes.filter(r => r.capacityIdentity === owner), poolsForUser: owner => [...new Map(routes.filter(r => r.capacityIdentity === owner).map(r => [r.capacityPoolId, pool(r)])).values()] }],
  });
  const decide = (owner: string, requestId = owner) => fabric.decide({ requestId, userId: owner, userIdentities: [owner], role: "PRIMARY_CODING_AGENT", dataContext: { dataClass: "PUBLIC_CODE" } });
  return { health, fabric, decide };
}

describe("R71 physical free pools and model cooldowns", () => {
  it("rotates to a healthy Kilo sibling while keeping one physical pool", () => {
    let now = start;
    const hot = route("alice");
    const cold = route("alice", "lab/cold:free");
    const { health, decide, fabric } = setup([hot, cold], () => now);
    expect(decide("alice").selected?.modelId).toBe(hot.modelId);
    health.observe({ kind: "call_failure", providerId: hot.providerId, modelId: hot.modelId, quotaDomainId: hot.capacityPoolId,
      observedAt: at, source: "runtime", reason: "RATE_LIMITED", status: 429, message: "Provider returned error", rateLimitScope: "model", retryAfterMs: 120_000 });
    expect(decide("alice", "rotate").selected?.modelId).toBe(cold.modelId);
    expect(capacityIndependenceKey(hot, now)).toBe(capacityIndependenceKey(cold, now));
    expect(fabric.capacitySnapshot({ userId: "alice", userIdentities: ["alice"], dataContext: { dataClass: "PUBLIC_CODE" } }).verifiedIndependentCapacityGroups).toBe(1);
    now += 120_001;
    expect(decide("alice", "recovered").selected?.modelId).toBe(hot.modelId);
  });

  it("an ambiguous gateway 429 excludes every alias in its pool and survives hydration", () => {
    const hot = route("alice");
    const { health, decide } = setup([hot, route("alice", "lab/cold:free"), route("bob")], () => start);
    health.observe({ kind: "call_failure", providerId: hot.providerId, modelId: hot.modelId, quotaDomainId: hot.capacityPoolId, observedAt: at, source: "runtime", reason: "RATE_LIMITED", status: 429, message: "Rate limit exceeded", retryAfterMs: 120_000 });
    expect(decide("alice").outcome).toBe("QUEUED_FOR_CAPACITY");
    expect(decide("bob").outcome).toBe("ADMITTED");
    const restored = createEightBitRouteHealthAuthority(undefined, () => start);
    for (const snapshot of health.snapshot()) restored.hydrate(snapshot);
    expect(restored.assess(hot.providerId, "lab/cold:free", { quotaDomainId: hot.capacityPoolId }).hardExclude).toBe(true);
    expect(restored.assess(hot.providerId, hot.modelId, { quotaDomainId: "ip:bob" }).hardExclude).toBe(false);
  });

  it.each([2, 10, 25, 50])("isolates %i simultaneous independently entitled users across admission and dispatch", async count => {
    const routes = Array.from({ length: count }, (_, index) => route(`user-${index}`));
    const { health, decide } = setup(routes, () => start);
    const governor = new ProviderCapacityGovernor({ now: () => start });
    const first = routes[0]!;
    const firstKey = capacityIndependenceKey(first, start);
    governor.forQuotaDomain(first.providerId, firstKey).recordRateLimit(first.providerId, start + 120_000);
    health.observe({ kind: "call_failure", providerId: first.providerId, modelId: first.modelId, quotaDomainId: first.capacityPoolId, observedAt: at, source: "runtime", reason: "RATE_LIMITED", status: 429, message: "free-models-per-day limit exceeded for this account", retryAfterMs: 120_000 });
    expect(decide("user-0").outcome).toBe("QUEUED_FOR_CAPACITY");
    const reservations = await Promise.all(routes.slice(1).map(async r => {
      const admitted = decide(r.capacityIdentity!);
      expect(admitted.outcome).toBe("ADMITTED");
      expect(admitted.selected?.capacityPoolId).toBe(r.capacityPoolId);
      const domain = governor.forQuotaDomain(r.providerId, admitted.selected!.independenceKey!);
      const reservation = await domain.acquire(r.providerId, 10, undefined, { modelId: r.modelId });
      expect(domain.getCapacityReport(r.providerId).activeConcurrent).toBe(1);
      return { reservation, domain, providerId: r.providerId };
    }));
    expect(new Set(reservations.map(r => r.domain)).size).toBe(count - 1);
    for (const item of reservations) { item.reservation.release(10); expect(item.domain.getCapacityReport(item.providerId).activeConcurrent).toBe(0); }
  });
});
