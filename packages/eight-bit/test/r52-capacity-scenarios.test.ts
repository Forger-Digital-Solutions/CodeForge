import { describe, expect, it } from "vitest";
import { CapacityReservationLedger, type CapacityRoute, type CapacityWindow, type ProviderCapacityPool } from "@codeforge/forge-zero";
import { createFreeFabric } from "../src/free-fabric.js";
import { DEFAULT_ROUTE_HEALTH_POLICY, EightBitRouteHealthAuthority } from "../src/route-health-authority.js";

/**
 * R52 Phase C — the waiting/admission state machine stressed across a large route pool.
 * R51 closed the single-domain unmeasured deadlock; these scenarios prove the fabric never
 * false-waits while ANY legitimate supply exists, waits only truthfully, and recovers.
 */

const NOW = Date.parse("2026-09-21T00:00:00.000Z");
const OBSERVED_AT = "2026-09-20T23:00:00.000Z";

function clock(start = NOW) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

function quotaWindow(overrides: Partial<CapacityWindow> = {}): CapacityWindow {
  return { unit: "requests", limit: 1000, remaining: 900, resetAt: "2026-09-22T00:00:00.000Z", scope: "ORG", observedAt: OBSERVED_AT, authoritative: true, period: "DAILY_RESET", ...overrides };
}

function managedRoute(id: string, providerId: string, overrides: Partial<CapacityRoute> = {}): CapacityRoute {
  return {
    routeId: id,
    providerId,
    modelId: `${id}-model`,
    canonicalModelId: `${id}-model`,
    family: id,
    gateway: providerId,
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

function rateLimited(authority: EightBitRouteHealthAuthority, route: CapacityRoute, at: number): void {
  authority.observe({
    kind: "call_failure",
    providerId: route.providerId,
    modelId: route.modelId,
    observedAt: new Date(at).toISOString(),
    source: "runtime",
    reason: "RATE_LIMITED",
    status: 429,
    message: "rate limited",
    role: "CODER",
  });
}

function fabric(routes: readonly CapacityRoute[], extra: {
  reservations?: CapacityReservationLedger;
  health?: EightBitRouteHealthAuthority;
  now?: () => number;
  pools?: readonly ProviderCapacityPool[];
} = {}) {
  return createFreeFabric({
    managedRoutes: () => routes,
    managedPools: () => extra.pools ?? routes.map(poolFor),
    reservations: extra.reservations,
    health: extra.health,
    now: extra.now,
  });
}

describe("R52 Phase C — no false waiting across a large route pool", () => {
  it("scenario 1: 20 candidates, top 5 rate-limited — candidate 6+ serves, no global wait", () => {
    const c = clock();
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    const routes = Array.from({ length: 20 }, (_, i) =>
      managedRoute(`r${i + 1}`, `provider-${(i % 4) + 1}`, { qualityScore: 100 - i }));
    for (const r of routes.slice(0, 5)) rateLimited(authority, r, c.now());
    const reservations = new CapacityReservationLedger({ routes: [], now: c.now });
    const decision = fabric(routes, { reservations, health: authority, now: c.now })
      .decide({ requestId: "r1", userId: "u1", role: "CODER", healthRole: "CODER" });

    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.routeId).toBe("r6");
    for (const excluded of routes.slice(0, 5)) {
      const report = decision.explanation.candidates.find((cand) => cand.routeId === excluded.routeId);
      expect(report?.status).toBe("HEALTH_EXCLUDED");
    }
    expect(decision.nextAvailableAt).toBeUndefined();
  });

  it("scenario 2: one provider fully exhausted — a healthy provider still serves", () => {
    const c = clock();
    const dead = quotaWindow({ remaining: 0 });
    const providerA = Array.from({ length: 3 }, (_, i) =>
      managedRoute(`a${i + 1}`, "provider-a", { windows: [dead], qualityScore: 95 }));
    const providerB = managedRoute("b1", "provider-b", { qualityScore: 60 });
    const decision = fabric([...providerA, providerB], { reservations: new CapacityReservationLedger({ routes: [], now: c.now }), now: c.now })
      .decide({ requestId: "r2", userId: "u1", role: "CODER" });

    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.providerId).toBe("provider-b");
    for (const r of providerA) {
      const report = decision.explanation.candidates.find((cand) => cand.routeId === r.routeId);
      expect(report?.status).toBe("CAPACITY_DENIED");
      expect(report?.reasonCodes).toContain("PROVIDER_QUOTA_EXHAUSTED");
    }
  });

  it("scenario 3: many unmeasured domains — honest denial, bounded measurement admits the probed subset", () => {
    const c = clock();
    const routes = Array.from({ length: 12 }, (_, i) =>
      managedRoute(`u${i + 1}`, `p-${(i % 3) + 1}`, { windows: [] }));
    const reservations = new CapacityReservationLedger({ routes: [], now: c.now });
    const f = fabric(routes, { reservations, now: c.now });

    const denied = f.decide({ requestId: "r3", userId: "u1", role: "CODER" });
    expect(denied.outcome).toBe("DENIED_NO_SUPPLY");
    expect(denied.explanation.candidates.every((cand) => cand.status === "CAPACITY_UNMEASURED")).toBe(true);
    // Unmeasured is never a wait state — there is nothing proven to wait for.
    expect(denied.nextAvailableAt).toBeUndefined();
    expect(denied.suggestions.some((s) => s.includes("probes it on demand"))).toBe(true);

    // The runtime measures at most 4 candidates per decision (agent-runtime bound) —
    // simulate that bound, then re-decide over the same fleet.
    const measured = routes.map((r, i) => (i < 4 ? { ...r, windows: [quotaWindow()] } : r));
    const admitted = fabric(measured, { reservations, now: c.now })
      .decide({ requestId: "r3b", userId: "u1", role: "CODER" });
    expect(admitted.outcome).toBe("ADMITTED");
    expect(["u1", "u2", "u3", "u4"]).toContain(admitted.selected?.routeId);
    expect(admitted.explanation.candidates.filter((cand) => cand.status === "CAPACITY_UNMEASURED").length).toBe(8);
  });

  it("scenario 4: mixed exclusion axes — the one healthy legitimate candidate wins", () => {
    const c = clock();
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    const unmeasured = managedRoute("m-unmeasured", "p1", { windows: [], qualityScore: 99 });
    const cooling = managedRoute("m-cooling", "p2", { qualityScore: 98 });
    rateLimited(authority, cooling, c.now());
    const wrongRole = managedRoute("m-role", "p3", { roles: ["PLANNER"], qualityScore: 97 });
    const policyBlocked = managedRoute("m-policy", "p4", { lifecycle: "PENDING", qualityScore: 96 });
    const demoted = managedRoute("m-demoted", "p5", { qualityScore: 50 });
    const healthy = managedRoute("m-healthy", "p6", { qualityScore: 70 });

    const decision = createFreeFabric({
      managedRoutes: () => [unmeasured, cooling, wrongRole, policyBlocked, demoted, healthy],
      managedPools: () => [unmeasured, cooling, wrongRole, policyBlocked, demoted, healthy].map(poolFor),
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      health: authority,
      now: c.now,
    }).decide({ requestId: "r4", userId: "u1", role: "CODER", healthRole: "CODER" });

    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.routeId).toBe("m-healthy");
    const status = (id: string) => decision.explanation.candidates.find((cand) => cand.routeId === id)?.status;
    expect(status("m-unmeasured")).toBe("CAPACITY_UNMEASURED");
    expect(status("m-cooling")).toBe("HEALTH_EXCLUDED");
    expect(status("m-role")).toBe("ROLE_INELIGIBLE");
    expect(status("m-policy")).toBe("POLICY_EXCLUDED");
    // Demoted peer stays a candidate — quality order, not exclusion — but loses the sort.
    expect(["STANDBY", "RESERVATION_DENIED"]).toContain(status("m-demoted"));
  });

  it("explanation contract — every candidate carries enough structure to explain its skip reason (Phase U)", () => {
    const c = clock();
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    const unmeasured = managedRoute("c-unmeasured", "p1", { windows: [] });
    const cooling = managedRoute("c-cooling", "p2");
    rateLimited(authority, cooling, c.now());
    const healthy = managedRoute("c-healthy", "p3");
    const decision = createFreeFabric({
      managedRoutes: () => [unmeasured, cooling, healthy],
      managedPools: () => [unmeasured, cooling, healthy].map(poolFor),
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      health: authority,
      now: c.now,
    }).decide({ requestId: "rc", userId: "u1", role: "CODER", healthRole: "CODER" });

    expect(typeof decision.explanation.summary).toBe("string");
    expect(decision.explanation.summary.length).toBeGreaterThan(0);
    for (const cand of decision.explanation.candidates) {
      expect(cand.routeId.length).toBeGreaterThan(0);
      expect(cand.providerId.length).toBeGreaterThan(0);
      expect(cand.modelId.length).toBeGreaterThan(0);
      expect(cand.capacityPoolId?.length).toBeGreaterThan(0);
      expect(cand.reasonCodes.length).toBeGreaterThan(0);
      // Never credential material in a receipt.
      expect(JSON.stringify(cand)).not.toMatch(/api[_-]?key|token|secret/i);
    }
    const status = (id: string) => decision.explanation.candidates.find((cand) => cand.routeId === id)?.status;
    expect(status("c-unmeasured")).toBe("CAPACITY_UNMEASURED");
    expect(status("c-cooling")).toBe("HEALTH_EXCLUDED");
    expect(status("c-healthy")).toBe("SELECTED");
  });

  it("scenario 5: every legitimate candidate truly exhausted — truthful wait with evidence", () => {
    const c = clock();
    const resetAt = "2026-09-21T01:00:00.000Z";
    const routes = Array.from({ length: 6 }, (_, i) =>
      managedRoute(`x${i + 1}`, `p-${(i % 3) + 1}`, {
        windows: [quotaWindow({ remaining: 0, resetAt })],
      }));
    const reservations = new CapacityReservationLedger({ routes: [], now: c.now });
    const decision = fabric(routes, { reservations, now: c.now })
      .decide({ requestId: "r5", userId: "u1", role: "CODER" });

    expect(decision.outcome).toBe("QUEUED_FOR_CAPACITY");
    expect(decision.nextAvailableAt).toBe(resetAt);
    expect(decision.explanation.candidates.every((cand) => cand.status === "CAPACITY_DENIED")).toBe(true);
    expect(decision.explanation.candidates.every((cand) => cand.reasonCodes.includes("PROVIDER_QUOTA_EXHAUSTED"))).toBe(true);
    expect(decision.suggestions.some((s) => s.includes("never falls back to paid"))).toBe(true);
  });

  it("scenario 6: capacity recovers — previously exhausted route admits without restart", () => {
    const c = clock();
    const exhausted = quotaWindow({ remaining: 0, resetAt: "2026-09-21T00:30:00.000Z" });
    const route = managedRoute("rec1", "p1", { windows: [exhausted] });
    const reservations = new CapacityReservationLedger({ routes: [], now: c.now });
    const first = fabric([route], { reservations, now: c.now })
      .decide({ requestId: "r6", userId: "u1", role: "CODER" });
    expect(first.outcome).toBe("QUEUED_FOR_CAPACITY");

    // Provider reports the window reopened — next decide sees the fresh observation.
    const recovered = { ...route, windows: [quotaWindow({ remaining: 500, observedAt: "2026-09-21T00:30:01.000Z" })] };
    const second = fabric([recovered], { reservations, now: c.now })
      .decide({ requestId: "r6b", userId: "u1", role: "CODER" });
    expect(second.outcome).toBe("ADMITTED");
    expect(second.selected?.routeId).toBe("rec1");
  });

  it("scenario 7: a new free model discovered mid-run enters selection without restart", () => {
    const c = clock();
    const routes = [managedRoute("old1", "p1", { qualityScore: 60 })];
    const reservations = new CapacityReservationLedger({ routes: [], now: c.now });
    const f = createFreeFabric({
      managedRoutes: () => routes,
      managedPools: () => routes.map(poolFor),
      reservations,
      now: c.now,
    });

    const first = f.decide({ requestId: "r7", userId: "u1", role: "CODER" });
    expect(first.selected?.routeId).toBe("old1");

    // Discovery + qualification + measured capacity materialize a strictly better route.
    routes.push(managedRoute("new1", "p1", { qualityScore: 95, capacityPoolId: "new1-pool" }));
    const second = f.decide({ requestId: "r7b", userId: "u1", role: "CODER" });
    expect(second.outcome).toBe("ADMITTED");
    expect(second.selected?.routeId).toBe("new1");
  });
});
