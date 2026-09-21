import { describe, it, expect } from "vitest";
import { CapacityReservationLedger, type CapacityRoute, type CapacityWindow, type ProviderCapacityPool } from "@codeforge/forge-zero";
import { createEightBitRouteHealthAuthority, createFreeFabric, type EightBitRouteHealthAuthority } from "@codeforge/eight-bit";
import { buildProviderTopologyCapacity, type TopologyCapacityProjection } from "../src/provider-topology-capacity.js";

/**
 * R24: ForgeGreen topology advice must see the same capacity universe the Free Fabric's
 * decide() sees — shared pools plus the requesting user's own pools, net of health exclusions
 * and live reservation holds. Before this wiring the orchestrator never supplied
 * `providerCapacity`, so the advice layer existed but could never fire in production.
 */

const OBSERVED_AT = new Date(Date.now() - 60_000).toISOString();
const NO_RESET = "9999-12-31T23:59:59.999Z";

function window(overrides: Partial<CapacityWindow> = {}): CapacityWindow {
  return { unit: "requests", limit: 100, remaining: 100, resetAt: NO_RESET, scope: "ORG", observedAt: OBSERVED_AT, authoritative: true, ...overrides };
}

function route(id: string, overrides: Partial<CapacityRoute> = {}): CapacityRoute {
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
    roles: ["PRIMARY_CODING_AGENT"],
    qualityScore: 70,
    healthy: true,
    enabled: true,
    windows: [window()],
    ...overrides,
  };
}

function perUserRoute(identity: string, providerId = "user-cloud"): CapacityRoute {
  return route(providerId, {
    routeId: `fabric:user-${providerId}`,
    supplyClass: "USER_CONNECTED_FREE",
    capacityPoolId: `${providerId}:user:${identity}`,
    capacityPoolScope: "PER_USER_POOL",
    capacityScope: "USER_ACCOUNT",
    freeOnlyAdmissionProven: true,
    capacityIdentity: identity,
  });
}

function pool(r: CapacityRoute, windows: CapacityWindow[] = r.windows): ProviderCapacityPool {
  return {
    poolId: r.capacityPoolId,
    providerId: r.providerId,
    scope: r.capacityPoolScope,
    supplyClass: r.supplyClass,
    windows,
    observedAt: OBSERVED_AT,
    authoritative: true,
    ...(r.capacityIdentity !== undefined ? { capacityIdentity: r.capacityIdentity } : {}),
  };
}

function projection(routes: CapacityRoute[], userRoutes: Record<string, CapacityRoute[]> = {}): TopologyCapacityProjection {
  return {
    capacityRoutes: () => routes,
    capacityPools: () => [...routes, ...Object.values(userRoutes).flat()].map((r) => pool(r)),
    routesForUser: (userId) => userRoutes[userId] ?? [],
  };
}

describe("buildProviderTopologyCapacity — ForgeGreen's live capacity view", () => {
  const authority = (): EightBitRouteHealthAuthority => createEightBitRouteHealthAuthority();

  it("reports UNOBSERVED honestly when no registry is attached", () => {
    expect(buildProviderTopologyCapacity({ freeCloud: undefined, routeHealth: authority() })).toBeUndefined();
  });

  it("shared pools without declared concurrency offer one provably-safe stream each", () => {
    const capacity = buildProviderTopologyCapacity({
      freeCloud: projection([route("provider-a"), route("provider-b")]),
      routeHealth: authority(),
    });
    expect(capacity).toEqual({ distinctHealthyProviders: 2, minimumRouteConcurrency: 1, saturatedRoutes: 0 });
  });

  it("a health-hard-excluded route removes its provider from the count", () => {
    const health = authority();
    health.observe({ kind: "catalog", providerId: "provider-a", modelId: "provider-a-model", observedAt: OBSERVED_AT, source: "registry", fact: "retired" });
    const capacity = buildProviderTopologyCapacity({
      freeCloud: projection([route("provider-a"), route("provider-b")]),
      routeHealth: health,
    });
    expect(capacity?.distinctHealthyProviders).toBe(1);
    expect(capacity?.saturatedRoutes).toBe(0);
  });

  it("per-user pools count only for the stamped owner — another user's supply is invisible", () => {
    const freeCloud = projection([route("provider-a")], { "user-1": [perUserRoute("hash-user-1")] });
    const owner = buildProviderTopologyCapacity({ freeCloud, routeHealth: authority(), localUserId: "user-1" });
    expect(owner?.distinctHealthyProviders).toBe(2);
    const stranger = buildProviderTopologyCapacity({ freeCloud, routeHealth: authority(), localUserId: "user-2" });
    expect(stranger?.distinctHealthyProviders).toBe(1);
  });

  it("a declared concurrency window minus live holds is the plan-able concurrency", () => {
    // Shared pool declares concurrency 2 + a token window (absent token windows fail closed
    // in the reservation ledger); the user's own pool declares concurrency 4.
    const shared = route("provider-a");
    const sharedPool = pool(shared, [
      window(),
      window({ unit: "concurrency", limit: 2, remaining: 2 }),
      window({ unit: "input_tokens", limit: 2_000_000, remaining: 2_000_000 }),
    ]);
    const owned = perUserRoute("hash-user-1");
    const ownedPool = pool(owned, [
      window({ unit: "concurrency", limit: 4, remaining: 4, scope: "USER_ACCOUNT" }),
      window({ unit: "credits", limit: 5, remaining: 5, scope: "USER_ACCOUNT" }),
    ]);
    const freeCloud: TopologyCapacityProjection = {
      capacityRoutes: () => [shared, owned],
      capacityPools: () => [sharedPool, ownedPool],
      routesForUser: (userId) => (userId === "user-1" ? [owned] : []),
    };
    const fabric = createFreeFabric({
      managedRoutes: () => [shared],
      managedPools: () => [sharedPool],
      userSources: [{ routesForUser: () => [owned], poolsForUser: () => [ownedPool] }],
      reservations: new CapacityReservationLedger({ routes: [], pools: [] }),
    });
    const ctx = { freeCloud, routeHealth: authority(), freeFabric: fabric, localUserId: "user-1" };
    // min(shared 2, user 4) — two streams are provably concurrent.
    expect(buildProviderTopologyCapacity(ctx)?.minimumRouteConcurrency).toBe(2);
    // The fabric admits the shared route first (domain order conserves personal quota); its
    // hold drops the shared pool's plan-able concurrency to one.
    const decision = fabric.decide({ requestId: "run-1", userId: "user-1", role: "PRIMARY_CODING_AGENT", userIdentities: ["hash-user-1"] });
    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.capacityPoolId).toBe("shared:provider-a");
    const after = buildProviderTopologyCapacity(ctx);
    expect(after?.minimumRouteConcurrency).toBe(1);
    expect(after?.distinctHealthyProviders).toBe(2); // the user pool still admits in parallel
  });

  it("an unhealthy-but-admissible saturated route is counted, not silently dropped", () => {
    const health = authority();
    // SATURATED is not hard-excluded — the route still counts as capacity but is reported.
    health.observe({ kind: "call_failure", providerId: "provider-a", modelId: "provider-a-model", observedAt: OBSERVED_AT, source: "runtime", reason: "TEMPORARY_CAPACITY", status: 502, message: "Worker local total request limit reached (16/16)" });
    const capacity = buildProviderTopologyCapacity({
      freeCloud: projection([route("provider-a"), route("provider-b")]),
      routeHealth: health,
    });
    expect(capacity?.saturatedRoutes).toBe(1);
    expect(capacity?.distinctHealthyProviders).toBe(2);
  });
});
