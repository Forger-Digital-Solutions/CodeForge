import { describe, expect, it } from "vitest";
import { CapacityReservationLedger, type CapacityRoute, type CapacityWindow, type ProviderCapacityPool } from "@codeforge/forge-zero";
import { createFreeFabric, type FabricRequest } from "../src/free-fabric.js";
import { DEFAULT_ROUTE_HEALTH_POLICY, EightBitRouteHealthAuthority, type EightBitRole, type RouteHealthObservation } from "../src/route-health-authority.js";

const NOW = Date.parse("2026-09-21T00:00:00.000Z");
const OBSERVED_AT = "2026-09-20T23:00:00.000Z";

function quotaWindow(overrides: Partial<CapacityWindow> = {}): CapacityWindow {
  return { unit: "requests", limit: 1000, remaining: 900, resetAt: "2026-09-22T00:00:00.000Z", scope: "ORG", observedAt: OBSERVED_AT, authoritative: true, period: "DAILY_RESET", ...overrides };
}

function managedRoute(id: string, overrides: Partial<CapacityRoute> = {}): CapacityRoute {
  return {
    routeId: id,
    providerId: `provider-${id}`,
    modelId: `${id}-model`,
    canonicalModelId: `${id}-model`,
    family: id,
    gateway: `provider-${id}`,
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
    roles: ["REVIEWER"],
    qualityScore: 70,
    healthy: true,
    enabled: true,
    windows: [quotaWindow(), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 1_500_000 })],
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
  };
}

function roleOutcome(route: CapacityRoute, role: EightBitRole, outcome: RouteHealthObservation extends never ? never : "verified_complete" | "role_failed" | "security_blocked", at: number, seq: number, failureClass?: string): RouteHealthObservation {
  return {
    kind: "role_outcome",
    providerId: route.providerId,
    modelId: route.modelId,
    role,
    outcome,
    observedAt: new Date(at + seq * 1000).toISOString(),
    source: "runtime",
    correlationId: `${route.routeId}-${role}-${seq}`,
    ...(failureClass ? { failureClass } : {}),
  } as RouteHealthObservation;
}

function fabricFor(routes: CapacityRoute[], now: () => number) {
  const reservations = new CapacityReservationLedger({ routes: [], now });
  return createFreeFabric({
    managedRoutes: () => routes,
    managedPools: () => routes.map(poolFor),
    userSources: [],
    reservations,
    now,
  });
}

function decideFor(fabric: ReturnType<typeof fabricFor>, authority: EightBitRouteHealthAuthority, role: EightBitRole, requestId: string, overrides: Partial<FabricRequest> = {}) {
  return fabric.decide({
    requestId,
    userId: "u",
    role,
    roleQualityAdjustment: (providerId, modelId) => authority.roleQualityDelta(providerId, modelId, role) ?? { scoreAdjustment: 0, reasonCodes: [] },
    ...overrides,
  });
}

describe("R50 §20 routing decision replay", () => {
  it("Case A — repeated tool-quality failures demote a qualified reviewer below a clean peer", () => {
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, () => NOW);
    const volatile = managedRoute("volatile");
    const stable = managedRoute("stable");
    for (let i = 0; i < 4; i += 1) {
      authority.observe(roleOutcome(volatile, "REVIEWER", "role_failed", NOW - 60_000, i, "INVALID_TOOL_CALL"));
    }
    for (let i = 0; i < 2; i += 1) {
      authority.observe(roleOutcome(stable, "REVIEWER", "verified_complete", NOW - 60_000, i));
    }
    const fabric = fabricFor([volatile, stable], () => NOW);
    const decision = decideFor(fabric, authority, "REVIEWER", "req-a");
    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.routeId).toBe("stable");
  });

  it("Case B — a high-quality but capacity-exhausted route yields to the next admissible candidate", () => {
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, () => NOW);
    const exhausted = managedRoute("star", { qualityScore: 95, windows: [quotaWindow({ remaining: 0 }), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 1_500_000 })] });
    const peer = managedRoute("peer");
    for (let i = 0; i < 4; i += 1) {
      authority.observe(roleOutcome(exhausted, "REVIEWER", "verified_complete", NOW - 60_000, i));
    }
    const fabric = fabricFor([exhausted, peer], () => NOW);
    const decision = decideFor(fabric, authority, "REVIEWER", "req-b");
    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.routeId).toBe("peer");
    const starReport = decision.explanation.candidates.find((r) => r.routeId === "star");
    expect(starReport?.status).toBe("CAPACITY_DENIED");
  });

  it("Case C — poor runtime quality never resurrects a route the role floor excludes", () => {
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, () => NOW);
    const preferred = managedRoute("preferred");
    const failedForRole = managedRoute("failed-for-role");
    for (let i = 0; i < 4; i += 1) {
      authority.observe(roleOutcome(preferred, "REVIEWER", "role_failed", NOW - 60_000, i, "NON_CONVERGENCE"));
    }
    for (let i = 0; i < 5; i += 1) {
      authority.observe(roleOutcome(failedForRole, "REVIEWER", "verified_complete", NOW - 60_000, i));
    }
    const fabric = fabricFor([preferred, failedForRole], () => NOW);
    const decision = decideFor(fabric, authority, "REVIEWER", "req-c", {
      routeAdmission: (providerId) => providerId !== failedForRole.providerId,
    });
    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.routeId).toBe("preferred");
    const excluded = decision.explanation.candidates.find((r) => r.routeId === "failed-for-role");
    expect(excluded?.status).not.toBe("SELECTED");
  });

  it("Case D — verified successes lift a penalized model back above a neutral peer", () => {
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, () => NOW);
    const recovering = managedRoute("recovering");
    const neutral = managedRoute("neutral");
    for (let i = 0; i < 3; i += 1) {
      authority.observe(roleOutcome(recovering, "REVIEWER", "role_failed", NOW - 10 * 60_000, i, "NON_CONVERGENCE"));
    }
    const fabric1 = fabricFor([recovering, neutral], () => NOW);
    expect(decideFor(fabric1, authority, "REVIEWER", "req-d1").selected?.routeId).toBe("neutral");
    for (let i = 0; i < 5; i += 1) {
      authority.observe(roleOutcome(recovering, "REVIEWER", "verified_complete", NOW - 60_000, 100 + i));
    }
    const fabric2 = fabricFor([recovering, neutral], () => NOW);
    const decision = decideFor(fabric2, authority, "REVIEWER", "req-d2");
    expect(decision.selected?.routeId).toBe("recovering");
  });

  it("Case E — a poor-but-qualified sole candidate still admits; quality never invents disqualification", () => {
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, () => NOW);
    const only = managedRoute("only");
    for (let i = 0; i < 5; i += 1) {
      authority.observe(roleOutcome(only, "REVIEWER", "role_failed", NOW - 60_000, i, "NON_CONVERGENCE"));
    }
    const fabric = fabricFor([only], () => NOW);
    const decision = decideFor(fabric, authority, "REVIEWER", "req-e");
    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.routeId).toBe("only");
  });

  it("repeated transient-capacity observations do not alter the runtime quality delta", () => {
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, () => NOW);
    const route = managedRoute("transient");
    for (let i = 0; i < 6; i += 1) {
      authority.observe({
        kind: "call_failure",
        providerId: route.providerId,
        modelId: route.modelId,
        role: "REVIEWER",
        reason: "RATE_LIMITED",
        status: 429,
        message: "429 rate limit",
        observedAt: new Date(NOW - 60_000 + i * 1000).toISOString(),
        source: "runtime",
      });
    }
    const delta = authority.roleQualityDelta(route.providerId, route.modelId, "REVIEWER");
    expect(delta.samples).toBe(0);
    expect(delta.scoreAdjustment).toBe(0);
  });
});
