import { describe, expect, it } from "vitest";
import { CapacityReservationLedger, type CapacityRoute, type CapacityWindow, type ProviderCapacityPool } from "@codeforge/forge-zero";
import { createFreeFabric, type FreeFabric } from "../src/free-fabric.js";
import { DEFAULT_ROUTE_HEALTH_POLICY, EightBitRouteHealthAuthority } from "../src/route-health-authority.js";
import type { ModelQualificationReceipt } from "../src/qualification/types.js";
import { ROLE_QUALIFICATION_SUITE_VERSION } from "../src/qualification/role-protocols.js";

/**
 * R24 Phase 10F — role-aware routing proof. The fabric must choose role-appropriate routes
 * automatically from role evidence (`roles` on the capacity route — the vocabulary
 * qualificationFor projects from role receipts), never by test-side pinning. Health must be
 * able to override static suitability, and capacity must gate even a perfectly suited route.
 */

const NOW = Date.parse("2026-10-06T00:00:00.000Z");
const OBSERVED_AT = "2026-10-05T23:00:00.000Z";

function clock(start = NOW) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

function quotaWindow(overrides: Partial<CapacityWindow> = {}): CapacityWindow {
  return { unit: "requests", limit: 1000, remaining: 900, resetAt: "2026-10-07T00:00:00.000Z", scope: "ORG", observedAt: OBSERVED_AT, authoritative: true, period: "DAILY_RESET", ...overrides };
}

function route(id: string, roles: string[], overrides: Partial<CapacityRoute> = {}): CapacityRoute {
  return {
    routeId: `fabric:${id}`,
    providerId: id,
    modelId: `${id}-model`,
    canonicalModelId: `${id}-model`,
    family: id,
    gateway: id,
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
    roles,
    qualityScore: 70,
    healthy: true,
    enabled: true,
    windows: [quotaWindow(), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 1_500_000 }), quotaWindow({ unit: "concurrency", limit: 4, remaining: 4 })],
    ...overrides,
  };
}

function poolFor(r: CapacityRoute, overrides: Partial<ProviderCapacityPool> = {}): ProviderCapacityPool {
  return { poolId: r.capacityPoolId, providerId: r.providerId, scope: r.capacityPoolScope, supplyClass: r.supplyClass, windows: r.windows, observedAt: OBSERVED_AT, authoritative: true, ...overrides };
}

function roleReceipt(providerId: string, modelId: string, roles: Record<string, "QUALIFIED" | "PROBATION" | "NOT_QUALIFIED" | "HARD_FAILURE">): ModelQualificationReceipt {
  const roleResults = Object.fromEntries(Object.entries(roles).map(([role, status]) => [role, {
    role, status, testCases: [], hardFailures: status === "HARD_FAILURE" ? ["x"] : [],
    overallScore: status === "QUALIFIED" ? 0.95 : status === "PROBATION" ? 0.55 : 0.1,
    startedAt: OBSERVED_AT, completedAt: OBSERVED_AT,
  }]));
  return {
    suiteVersion: ROLE_QUALIFICATION_SUITE_VERSION,
    providerId, modelId, modelDisplayName: modelId, accessClass: "MANAGED", freeStatus: "verified_free",
    roleResults, startedAt: OBSERVED_AT, completedAt: OBSERVED_AT, totalLatencyMs: 1000,
    qualificationState: Object.values(roles).includes("QUALIFIED") ? "QUALIFIED" : "NOT_QUALIFIED",
    hardFailureRoles: [],
  };
}

function fabricWith(routes: CapacityRoute[], health: EightBitRouteHealthAuthority, now: () => number): { fabric: FreeFabric; reservations: CapacityReservationLedger } {
  const reservations = new CapacityReservationLedger({ routes: [], now, maxActiveReservationsPerUser: 8 });
  const fabric = createFreeFabric({
    managedRoutes: () => routes,
    managedPools: () => routes.map((r) => poolFor(r)),
    health,
    reservations,
    now,
  });
  return { fabric, reservations };
}

describe("R24 role-aware routing — the fabric chooses by role evidence", () => {
  it("each role request admits only the route qualified for it — specialization is automatic", () => {
    const c = clock();
    const explorerModel = route("explorica", ["SUBAGENT"], { qualityScore: 60 });
    const coderModel = route("codemax", ["PRIMARY_CODING_AGENT"], { qualityScore: 90 });
    const reviewerModel = route("reviewa", ["REVIEWER"], { qualityScore: 80 });
    const plannerModel = route("planna", ["PLANNER"], { qualityScore: 50 });
    const health = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    const { fabric } = fabricWith([explorerModel, coderModel, reviewerModel, plannerModel], health, c.now);

    // A SUBAGENT (explorer) request picks the explorer-qualified route even though the coder
    // model outranks it globally on qualityScore.
    const ex = fabric.decide({ requestId: "req-ex", userId: "u", role: "SUBAGENT" });
    expect(ex.outcome).toBe("ADMITTED");
    expect(ex.selected?.providerId).toBe("explorica");
    expect(ex.explanation.reasonCodes).toContain("ROLE_QUALIFIED");

    const cd = fabric.decide({ requestId: "req-cd", userId: "u", role: "PRIMARY_CODING_AGENT" });
    expect(cd.selected?.providerId).toBe("codemax");

    const rv = fabric.decide({ requestId: "req-rv", userId: "u", role: "REVIEWER" });
    expect(rv.selected?.providerId).toBe("reviewa");

    const pl = fabric.decide({ requestId: "req-pl", userId: "u", role: "PLANNER" });
    expect(pl.selected?.providerId).toBe("planna");

    // Role-mismatched candidates are reported excluded, not silently scheduled.
    const exReports = ex.explanation.candidates.map((c) => [c.providerId, c.status] as const);
    expect(exReports).toContainEqual(["codemax", "ROLE_INELIGIBLE"]);
    expect(exReports).toContainEqual(["reviewa", "ROLE_INELIGIBLE"]);
    expect(exReports).toContainEqual(["planna", "ROLE_INELIGIBLE"]);
  });

  it("a saturated preferred model yields to the next role-qualified route, then recovers", () => {
    const c = clock();
    const preferred = route("pref", ["SUBAGENT"], { qualityScore: 90 });
    const backup = route("back", ["SUBAGENT"], { qualityScore: 60 });
    const health = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    const routes = [preferred, backup];
    const { fabric } = fabricWith(routes, health, c.now);

    const first = fabric.decide({ requestId: "r1", userId: "u", role: "SUBAGENT" });
    expect(first.selected?.providerId).toBe("pref");
    fabric.release("r1");

    // Preferred explorer saturates — 4 consecutive capacity failures.
    for (let i = 0; i < 4; i++) {
      health.observe({ kind: "call_failure", providerId: "pref", modelId: "pref-model", observedAt: new Date(c.now() + i * 1000).toISOString(), source: "runtime", reason: "TEMPORARY_CAPACITY", status: 502, message: "ResourceExhausted", role: "TOOL_AGENT" });
    }
    const second = fabric.decide({ requestId: "r2", userId: "u", role: "SUBAGENT" });
    expect(second.outcome).toBe("ADMITTED");
    expect(second.selected?.providerId).toBe("back");
    // Saturation demotes the qualified route behind the backup — it stays reachable as
    // standby (health demotes, it does not fabricate ineligibility).
    const prefReport = second.explanation.candidates.find((x) => x.providerId === "pref");
    expect(prefReport?.status).toBe("STANDBY");
    fabric.release("r2");

    // Recovery: once the saturation condition expires the qualified route is eligible again.
    c.advance(20 * 60_000);
    const third = fabric.decide({ requestId: "r3", userId: "u", role: "SUBAGENT" });
    expect(third.selected?.providerId).toBe("pref");
  });

  it("role-scoped health evidence binds only when the caller passes the real work role", () => {
    const c = clock();
    const flaky = route("flaky", ["SUBAGENT"], { qualityScore: 85 });
    const steady = route("steady", ["SUBAGENT"], { qualityScore: 75 });
    const health = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    const { fabric } = fabricWith([flaky, steady], health, c.now);

    // Explorer work measured this route failing explorer tasks: a CAPABILITY_LIMITED
    // condition scoped to EXPLORER, invisible to a tool-agent assessment.
    health.observe({ kind: "role_outcome", providerId: "flaky", modelId: "flaky-model", observedAt: new Date(c.now()).toISOString(), source: "runtime", role: "EXPLORER", outcome: "role_failed" });

    // Product role alone maps SUBAGENT → TOOL_AGENT for health; the explorer-scoped
    // condition does not bind, so the measured-flaky route still ranks first.
    const blind = fabric.decide({ requestId: "hb1", userId: "u", role: "SUBAGENT" });
    expect(blind.selected?.providerId).toBe("flaky");
    fabric.release("hb1");

    // admitThroughFabric passes the caller's real EightBitRole — the same evidence then
    // binds and the explorer-limited route yields to the steady one.
    const honest = fabric.decide({ requestId: "hb2", userId: "u", role: "SUBAGENT", healthRole: "EXPLORER" });
    expect(honest.selected?.providerId).toBe("steady");
    expect(honest.explanation.candidates.find((x) => x.providerId === "flaky")?.status).toBe("STANDBY");
  });

  it("a perfectly suited route still loses when its pool cannot serve the demand", () => {
    const c = clock();
    const exhausted = route("tired", ["REVIEWER"], {
      windows: [quotaWindow({ remaining: 0 }), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 0 }), quotaWindow({ unit: "concurrency", limit: 4, remaining: 0 })],
    });
    const health = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    const { fabric } = fabricWith([exhausted], health, c.now);
    const d = fabric.decide({ requestId: "rv1", userId: "u", role: "REVIEWER" });
    expect(d.outcome).not.toBe("ADMITTED");
  });
});
