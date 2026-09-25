import { describe, expect, it } from "vitest";
import { CapacityReservationLedger, type CapacityRoute, type CapacityWindow, type ProviderCapacityPool } from "@codeforge/forge-zero";
import { createFreeFabric } from "../src/free-fabric.js";
import { DEFAULT_ROUTE_HEALTH_POLICY, EightBitRouteHealthAuthority } from "../src/route-health-authority.js";

const NOW = Date.parse("2026-09-21T00:00:00.000Z");
const OBSERVED_AT = "2026-09-20T23:00:00.000Z";

function clock(start = NOW) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

function quotaWindow(overrides: Partial<CapacityWindow> = {}): CapacityWindow {
  return { unit: "requests", limit: 1000, remaining: 900, resetAt: "2026-09-22T00:00:00.000Z", scope: "ORG", observedAt: OBSERVED_AT, authoritative: true, period: "DAILY_RESET", ...overrides };
}

function managedRoute(id: string, overrides: Partial<CapacityRoute> = {}): CapacityRoute {
  return {
    routeId: id,
    providerId: "managed-a",
    modelId: `${id}-model`,
    canonicalModelId: `${id}-model`,
    family: id,
    gateway: "managed-a",
    supplyClass: "PURE_MANAGED_FREE",
    capacityPoolId: `${id}-pool`,
    capacityPoolScope: "SHARED_OWNER_POOL",
    capacityScope: "ORG",
    dataPolicyProfile: "PRIVATE_CODE_ALLOWED",
    lifecycle: "APPROVED",
    explicitZeroPrice: true,
    paidFallbackDisabled: true,
    managedMultiUserAllowed: true,
    privacyClass: "standard",
    roles: ["CODER"],
    qualityScore: 70,
    healthy: true,
    enabled: true,
    windows: [quotaWindow(), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 1_500_000 })],
    ...overrides,
  };
}

function userRoute(identity: string, overrides: Partial<CapacityRoute> = {}): CapacityRoute {
  return {
    routeId: `user-${identity}`,
    providerId: "ollama-cloud",
    modelId: "gemma4",
    canonicalModelId: "gemma4",
    family: "gemma",
    gateway: "ollama-cloud",
    supplyClass: "USER_CONNECTED_FREE",
    capacityPoolId: `ollama-cloud:user:${identity}`,
    capacityPoolScope: "PER_USER_POOL",
    capacityScope: "USER_ACCOUNT",
    dataPolicyProfile: "PRIVATE_CODE_ALLOWED",
    lifecycle: "APPROVED",
    explicitZeroPrice: false,
    freeOnlyAdmissionProven: true,
    paidFallbackDisabled: true,
    managedMultiUserAllowed: true,
    privacyClass: "standard",
    roles: ["CODER"],
    qualityScore: 80,
    healthy: true,
    enabled: true,
    windows: [quotaWindow({ unit: "credits", scope: "USER_ACCOUNT", limit: 5, remaining: 5, period: "MONTHLY_RESET", resetAt: "2026-10-01T00:00:00.000Z" })],
    capacityIdentity: identity,
    ...overrides,
  };
}

function poolFor(route: CapacityRoute, overrides: Partial<ProviderCapacityPool> = {}): ProviderCapacityPool {
  return {
    poolId: route.capacityPoolId,
    providerId: route.providerId,
    scope: route.capacityPoolScope,
    supplyClass: route.supplyClass,
    windows: route.windows,
    observedAt: OBSERVED_AT,
    authoritative: true,
    capacityIdentity: route.capacityIdentity,
    ...overrides,
  };
}

function saturate(authority: EightBitRouteHealthAuthority, route: CapacityRoute, at: number): void {
  for (let i = 0; i < 4; i += 1) {
    authority.observe({
      kind: "call_failure",
      providerId: route.providerId,
      modelId: route.modelId,
      observedAt: new Date(at + i * 1000).toISOString(),
      source: "runtime",
      reason: "TEMPORARY_CAPACITY",
      status: 502,
      message: "ResourceExhausted: worker limit reached",
      role: "CODER",
    });
  }
}

describe("FreeFabric — supply composition + fair admission", () => {
  it("admits shared managed capacity first and conserves the user's own entitlement", () => {
    const c = clock();
    const shared = managedRoute("shared");
    const alice = userRoute("alicehash");
    const reservations = new CapacityReservationLedger({ routes: [], now: c.now });
    const fabric = createFreeFabric({
      managedRoutes: () => [shared],
      managedPools: () => [poolFor(shared)],
      userSources: [{ routesForUser: () => [alice], poolsForUser: () => [] }],
      reservations,
      now: c.now,
    });
    const decision = fabric.decide({ requestId: "r1", userId: "alice", userIdentities: ["alicehash"], role: "CODER" });
    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.routeId).toBe("shared");
    expect(decision.selected?.quotaOwner).toBe("SHARED_CODEFORGE_POOL");
    expect(decision.selected?.reservationId).toBe("r1");
    expect(decision.explanation.isolationViolations).toEqual([]);
    expect(reservations.snapshot().activeReservations).toBe(1);
  });

  it("falls through to the user's own entitlement when shared capacity is exhausted", () => {
    const c = clock();
    const shared = managedRoute("shared", { windows: [quotaWindow({ remaining: 0 }), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 1_500_000 })] });
    const alice = userRoute("alicehash");
    const reservations = new CapacityReservationLedger({ routes: [], now: c.now });
    const fabric = createFreeFabric({
      managedRoutes: () => [shared],
      userSources: [{ routesForUser: () => [alice], poolsForUser: () => [] }],
      reservations,
      now: c.now,
    });
    const decision = fabric.decide({ requestId: "r1", userId: "alice", userIdentities: ["alicehash"], role: "CODER" });
    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.quotaOwner).toBe("USER_ENTITLEMENT");
    expect(decision.explanation.summary).toContain("your own quota");
    const sharedReport = decision.explanation.candidates.find((r) => r.routeId === "shared");
    expect(sharedReport?.status).toBe("CAPACITY_DENIED");
    expect(sharedReport?.reasonCodes).toContain("CAPACITY_EXHAUSTED");
  });

  it("never selects another user's entitlement even when a source leaks it", () => {
    const c = clock();
    const bob = userRoute("bobhash");
    const reservations = new CapacityReservationLedger({ routes: [], now: c.now });
    const fabric = createFreeFabric({
      managedRoutes: () => [],
      // A buggy source returning bob's route for alice's query must still lose to the
      // ownership check inside the supply plan.
      userSources: [{ routesForUser: () => [bob], poolsForUser: () => [] }],
      reservations,
      now: c.now,
    });
    const decision = fabric.decide({ requestId: "r1", userId: "alice", userIdentities: ["alicehash"], role: "CODER" });
    expect(decision.outcome).toBe("DENIED_NO_SUPPLY");
    expect(decision.selected).toBeUndefined();
    const bobReport = decision.explanation.candidates.find((r) => r.routeId === "user-bobhash");
    expect(bobReport?.status).toBe("NOT_USER_OWNED");
  });

  it("hard-excludes a retired route and admits the next eligible supply", () => {
    const c = clock();
    const shared = managedRoute("shared");
    const alice = userRoute("alicehash");
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    authority.observe({
      kind: "catalog",
      providerId: shared.providerId,
      modelId: shared.modelId,
      observedAt: new Date(c.now()).toISOString(),
      source: "registry",
      fact: "retired",
    });
    const fabric = createFreeFabric({
      managedRoutes: () => [shared],
      userSources: [{ routesForUser: () => [alice], poolsForUser: () => [] }],
      health: authority,
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    const decision = fabric.decide({ requestId: "r1", userId: "alice", userIdentities: ["alicehash"], role: "CODER" });
    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.routeId).toBe("user-alicehash");
    const sharedReport = decision.explanation.candidates.find((r) => r.routeId === "shared");
    expect(sharedReport?.status).toBe("HEALTH_EXCLUDED");
    expect(sharedReport?.healthState).toBe("MODEL_RETIRED");
  });

  it("demotes saturated shared supply behind the user's own healthy pool", () => {
    const c = clock();
    const shared = managedRoute("shared");
    const alice = userRoute("alicehash");
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    saturate(authority, shared, c.now());
    const assess = authority.assess(shared.providerId, shared.modelId, { role: "CODER" });
    expect(assess.state).toBe("SATURATED");
    expect(assess.hardExclude).toBe(false);
    expect(assess.scoreAdjustment).toBeLessThanOrEqual(-50);
    const fabric = createFreeFabric({
      managedRoutes: () => [shared],
      userSources: [{ routesForUser: () => [alice], poolsForUser: () => [] }],
      health: authority,
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    const decision = fabric.decide({ requestId: "r1", userId: "alice", userIdentities: ["alicehash"], role: "CODER" });
    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.quotaOwner).toBe("USER_ENTITLEMENT");
    const sharedReport = decision.explanation.candidates.find((r) => r.routeId === "shared");
    expect(sharedReport?.status).toBe("STANDBY");
    expect(sharedReport?.reasonCodes).toContain("HEALTH_DEMOTED");
    expect(sharedReport?.healthState).toBe("SATURATED");
  });

  it("queues — never pays — when every eligible route is capacity-blocked", () => {
    const c = clock();
    const shared = managedRoute("shared", { windows: [quotaWindow({ remaining: 0 }), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 1_500_000 })] });
    const fabric = createFreeFabric({
      managedRoutes: () => [shared],
      managedPools: () => [poolFor(shared)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    const decision = fabric.decide({ requestId: "r1", userId: "alice", role: "CODER" });
    expect(decision.outcome).toBe("QUEUED_FOR_CAPACITY");
    expect(decision.selected).toBeUndefined();
    expect(decision.nextAvailableAt).toBe("2026-09-22T00:00:00.000Z");
    expect(decision.suggestions.some((s) => /pay|purchase|credit card/i.test(s) && !/never|stays free/i.test(s))).toBe(false);
  });

  it("queues an unmeasured route — absent quota windows are zero usable supply, never assumed", () => {
    // Live finding (R33 supply audit): GitHub Models serves real inference but emits no
    // quota headers, so its fabric route arrives with windows:[]. Unmeasured capacity must
    // behave like exhaustion — a decision to wait — never an admission on faith.
    const c = clock();
    const unmeasured = managedRoute("shared", { windows: [] });
    const fabric = createFreeFabric({
      managedRoutes: () => [unmeasured],
      managedPools: () => [poolFor(unmeasured, { windows: [] })],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    const decision = fabric.decide({ requestId: "r1", userId: "alice", role: "CODER" });
    expect(decision.outcome).toBe("QUEUED_FOR_CAPACITY");
    expect(decision.selected).toBeUndefined();
    const report = decision.explanation.candidates.find((r) => r.routeId === "shared");
    expect(report?.status).toBe("CAPACITY_DENIED");
    expect(report?.reasonCodes).toContain("CAPACITY_EXHAUSTED");
  });

  it("enforces the per-user concurrency cap as QUEUED_FOR_CAPACITY, not a silent extra hold", () => {
    const c = clock();
    const shared = managedRoute("shared");
    const reservations = new CapacityReservationLedger({ routes: [], now: c.now, maxActiveReservationsPerUser: 1 });
    const fabric = createFreeFabric({
      managedRoutes: () => [shared],
      reservations,
      now: c.now,
    });
    const first = fabric.decide({ requestId: "r1", userId: "alice", role: "CODER" });
    expect(first.outcome).toBe("ADMITTED");
    const second = fabric.decide({ requestId: "r2", userId: "alice", role: "CODER" });
    expect(second.outcome).toBe("QUEUED_FOR_CAPACITY");
    expect(second.explanation.reasonCodes).toContain("USER_CONCURRENCY_LIMIT");
    expect(reservations.snapshot().activeReservations).toBe(1);
  });

  it("repeated decide() with the same requestId replaces rather than double-spends", () => {
    const c = clock();
    const shared = managedRoute("shared");
    const reservations = new CapacityReservationLedger({ routes: [], now: c.now });
    const fabric = createFreeFabric({
      managedRoutes: () => [shared],
      reservations,
      now: c.now,
    });
    expect(fabric.decide({ requestId: "r1", userId: "alice", role: "CODER" }).outcome).toBe("ADMITTED");
    expect(fabric.decide({ requestId: "r1", userId: "alice", role: "CODER" }).outcome).toBe("ADMITTED");
    expect(reservations.snapshot().activeReservations).toBe(1);
  });

  it("route-table refreshes keep live reservations and admit on the new fleet", () => {
    const c = clock();
    const first = managedRoute("shared-v1");
    const replacement = managedRoute("shared-v2");
    let fleet = [first];
    const reservations = new CapacityReservationLedger({ routes: [], now: c.now });
    const fabric = createFreeFabric({
      managedRoutes: () => fleet,
      reservations,
      now: c.now,
    });
    expect(fabric.decide({ requestId: "r1", userId: "alice", role: "CODER" }).selected?.routeId).toBe("shared-v1");
    fleet = [replacement];
    const second = fabric.decide({ requestId: "r2", userId: "alice", role: "CODER" });
    expect(second.outcome).toBe("ADMITTED");
    expect(second.selected?.routeId).toBe("shared-v2");
    const snap = reservations.snapshot();
    expect(snap.activeReservations).toBe(2);
    expect(snap.byRoute["shared-v1"]).toBe(1);
    expect(fabric.release("r1")).toBe(true);
  });

  it("protects the first-run reserve: normal users queue, new users are admitted", () => {
    const c = clock();
    const tight = managedRoute("shared", { windows: [quotaWindow({ remaining: 100 }), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 1_500_000 })] });
    const reservations = new CapacityReservationLedger({ routes: [], now: c.now, firstRunReserveRequests: 100 });
    const fabric = createFreeFabric({
      managedRoutes: () => [tight],
      managedPools: () => [poolFor(tight)],
      reservations,
      now: c.now,
    });
    const normal = fabric.decide({ requestId: "r-normal", userId: "alice", role: "CODER", isNewUser: false });
    expect(normal.outcome).toBe("QUEUED_FOR_CAPACITY");
    expect(normal.explanation.candidates.find((r) => r.routeId === "shared")?.reasonCodes).toContain("FIRST_RUN_RESERVE_PROTECTED");
    const firstRun = fabric.decide({ requestId: "r-first", userId: "newbie", role: "CODER", isNewUser: true });
    expect(firstRun.outcome).toBe("ADMITTED");
  });

  it("orders and reports without a reservation ledger (single-caller hosts)", () => {
    const c = clock();
    const fabric = createFreeFabric({
      managedRoutes: () => [managedRoute("shared")],
      now: c.now,
    });
    const decision = fabric.decide({ requestId: "r1", userId: "alice", role: "CODER" });
    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.routeId).toBe("shared");
    expect(decision.selected?.reservationId).toBeUndefined();
  });

  it("reports DENIED_NO_SUPPLY with role-mismatch detail and zero-cost suggestions", () => {
    const c = clock();
    const visionOnly = managedRoute("vision", { roles: ["VISION"] });
    const fabric = createFreeFabric({
      managedRoutes: () => [visionOnly],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    const decision = fabric.decide({ requestId: "r1", userId: "alice", role: "CODER" });
    expect(decision.outcome).toBe("DENIED_NO_SUPPLY");
    expect(decision.explanation.candidates[0]?.status).toBe("ROLE_INELIGIBLE");
    expect(decision.suggestions.some((s) => /connect/i.test(s))).toBe(true);
    expect(decision.suggestions.every((s) => !/\bpay\b|\bpaid\b|purchase|billing/i.test(s) || /never|stays free|not.*paid/i.test(s))).toBe(true);
  });
});
