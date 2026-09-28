import { describe, expect, it } from "vitest";
import { CapacityReservationLedger, type CapacityRoute, type CapacityWindow, type ProviderCapacityPool } from "@codeforge/forge-zero";
import { createFreeFabric } from "../src/free-fabric.js";
import { DEFAULT_ROUTE_HEALTH_POLICY, EightBitRouteHealthAuthority } from "../src/route-health-authority.js";

/**
 * R52 Phase E/F — multi-user fairness and per-user quota behavior through the real
 * fabric + reservation ledger: shared-pool fairness caps, starvation bounds, provider
 * failure isolation, idempotent reservations, and lease recovery. Deterministic — the
 * ledger is synchronous, so "concurrency" is modeled as overlapping live holds.
 */

const NOW = Date.parse("2026-09-21T00:00:00.000Z");
const OBSERVED_AT = "2026-09-20T23:00:00.000Z";

function clock(start = NOW) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

function quotaWindow(overrides: Partial<CapacityWindow> = {}): CapacityWindow {
  return { unit: "requests", limit: 1000, remaining: 400, resetAt: "2026-09-22T00:00:00.000Z", scope: "ORG", observedAt: OBSERVED_AT, authoritative: true, period: "DAILY_RESET", ...overrides };
}

function managedRoute(id: string, providerId: string, poolId: string, overrides: Partial<CapacityRoute> = {}): CapacityRoute {
  return {
    routeId: id,
    providerId,
    modelId: `${id}-model`,
    canonicalModelId: `${id}-model`,
    family: id,
    gateway: providerId,
    supplyClass: "PURE_MANAGED_FREE",
    capacityPoolId: poolId,
    capacityPoolScope: "SHARED_OWNER_POOL",
    capacityScope: "ORG",
    dataPolicyProfile: "PRIVATE_CODE_ALLOWED",
    lifecycle: "APPROVED",
    explicitZeroPrice: true,
    paidFallbackDisabled: true,
    managedMultiUserAllowed: true,
    privacyClass: "standard",
    roles: ["CODER", "EXPLORER", "REVIEWER"],
    qualityScore: 70,
    healthy: true,
    enabled: true,
    windows: [quotaWindow(), quotaWindow({ unit: "input_tokens", limit: 4_000_000, remaining: 3_000_000 })],
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

/** A 4-provider fleet — two models per provider, each model its own pool row. */
function fleet(): CapacityRoute[] {
  const routes: CapacityRoute[] = [];
  for (const p of ["groq", "mistral", "openrouter", "cerebras"]) {
    for (const m of ["alpha", "beta"]) {
      routes.push(managedRoute(`${p}-${m}`, p, `${p}:${m}:pool`));
    }
  }
  return routes;
}

function makeFabric(routes: readonly CapacityRoute[], now: () => number, opts: {
  health?: EightBitRouteHealthAuthority;
  maxActiveReservationsPerUser?: number;
} = {}) {
  const reservations = new CapacityReservationLedger({
    routes: [],
    now,
    maxActiveReservationsPerUser: opts.maxActiveReservationsPerUser ?? 3,
  });
  const fabric = createFreeFabric({
    managedRoutes: () => routes,
    managedPools: () => routes.map(poolFor),
    reservations,
    health: opts.health,
    now,
  });
  return { fabric, reservations };
}

describe("R52 Phase E — multi-user fairness at scale", () => {
  it("50 users × 3 concurrent turns all admit; per-user cap binds, nobody starves, no leases leak", () => {
    const c = clock();
    const routes = fleet();
    const { fabric, reservations } = makeFabric(routes, c.now);
    const admissions = new Map<string, number>();
    const queued = new Map<string, number>();

    // 50 users × 3 turns = 150 live reservations, well under the fleet's budget.
    for (let u = 0; u < 50; u += 1) {
      const userId = `user-${u}`;
      for (let t = 0; t < 3; t += 1) {
        const d = fabric.decide({ requestId: `${userId}-t${t}`, userId, role: "CODER" });
        expect(d.outcome).toBe("ADMITTED");
        admissions.set(userId, (admissions.get(userId) ?? 0) + 1);
      }
    }
    expect(admissions.size).toBe(50);
    expect([...admissions.values()].every((n) => n === 3)).toBe(true);
    expect(reservations.snapshot().activeReservations).toBe(150);

    // A fourth concurrent turn per user must hit the per-user cap — queued, not a
    // duplicate spend and not pushed onto a paid route.
    const d = fabric.decide({ requestId: "user-0-t3", userId: "user-0", role: "CODER" });
    expect(d.outcome).toBe("QUEUED_FOR_CAPACITY");
    expect(d.explanation.reasonCodes).toContain("USER_CONCURRENCY_LIMIT");
    queued.set("user-0", 1);
    expect(reservations.snapshot().activeReservations).toBe(150);

    // Release everything — zero leaked leases.
    for (let u = 0; u < 50; u += 1) {
      for (let t = 0; t < 3; t += 1) expect(fabric.release(`user-${u}-t${t}`)).toBe(true);
    }
    expect(reservations.snapshot().activeReservations).toBe(0);
  });

  it("a single heavy user cannot monopolize the fabric — per-user cap + shared budget stay intact for others", () => {
    const c = clock();
    const routes = fleet();
    const { fabric, reservations } = makeFabric(routes, c.now, { maxActiveReservationsPerUser: 3 });

    // The heavy user grabs the per-user maximum; the fifth hold queues.
    for (let t = 0; t < 4; t += 1) {
      const d = fabric.decide({ requestId: `heavy-${t}`, userId: "heavy", role: "CODER" });
      expect(d.outcome).toBe(t < 3 ? "ADMITTED" : "QUEUED_FOR_CAPACITY");
    }
    // Twenty ordinary users still admit immediately behind them.
    for (let u = 0; u < 20; u += 1) {
      const d = fabric.decide({ requestId: `u${u}-0`, userId: `u${u}`, role: "CODER" });
      expect(d.outcome).toBe("ADMITTED");
    }
    // Heavy user's holds are on shared pools but capped — 23 active, not a monopoly.
    expect(reservations.snapshot().activeReservations).toBe(23);
    expect(reservations.snapshot().byUser["heavy"]).toBe(3);
  });

  it("one provider's failure isolates to its own routes — other users keep the healthy fleet", () => {
    const c = clock();
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    const routes = fleet();
    const { fabric } = makeFabric(routes, c.now, { health: authority });
    // Groq starts returning 429s for everyone — every groq route takes the condition.
    for (const r of routes.filter((r) => r.providerId === "groq")) {
      authority.observe({
        kind: "call_failure", providerId: r.providerId, modelId: r.modelId,
        observedAt: new Date(c.now()).toISOString(), source: "runtime",
        reason: "RATE_LIMITED", status: 429, message: "rate limited", role: "CODER",
      });
    }
    // Ten users across roles — every decision still admits on a non-groq provider.
    for (let u = 0; u < 10; u += 1) {
      for (const role of ["CODER", "EXPLORER", "REVIEWER"]) {
        const d = fabric.decide({ requestId: `u${u}-${role}`, userId: `u${u}`, role, healthRole: role === "REVIEWER" ? "REVIEWER" : "CODER" });
        expect(d.outcome).toBe("ADMITTED");
        expect(d.selected?.providerId).not.toBe("groq");
      }
    }
  });

  it("idempotent requestId — a repeated decide replaces its own hold instead of double-spending", () => {
    const c = clock();
    const routes = fleet();
    const { fabric, reservations } = makeFabric(routes, c.now);
    const req = { requestId: "same-turn", userId: "u", role: "CODER" };
    expect(fabric.decide(req).outcome).toBe("ADMITTED");
    expect(reservations.snapshot().activeReservations).toBe(1);
    // Retry of the same logical turn — still one reservation, not two.
    expect(fabric.decide(req).outcome).toBe("ADMITTED");
    expect(reservations.snapshot().activeReservations).toBe(1);
  });

  it("expired leases recover automatically — capacity returns to the pool without manual release", () => {
    const c = clock();
    const routes = fleet();
    const { fabric, reservations } = makeFabric(routes, c.now);
    for (let u = 0; u < 3; u += 1) {
      expect(fabric.decide({ requestId: `u${u}-0`, userId: `u${u}`, role: "CODER", leaseMs: 60_000 }).outcome).toBe("ADMITTED");
    }
    expect(reservations.snapshot().activeReservations).toBe(3);
    c.advance(61_000);
    // Next decide runs recoverExpired — the holds are gone, capacity is free again.
    expect(fabric.decide({ requestId: "fresh-0", userId: "fresh", role: "CODER" }).outcome).toBe("ADMITTED");
    expect(reservations.snapshot().activeReservations).toBe(1);
  });
});

describe("R52 Phase F — per-user quota / fair-usage layer", () => {
  it("per-user concurrency cap applies per user, never globally — one capped user leaves everyone else admittable", () => {
    const c = clock();
    const routes = fleet();
    const { fabric } = makeFabric(routes, c.now, { maxActiveReservationsPerUser: 2 });
    expect(fabric.decide({ requestId: "a-1", userId: "a", role: "CODER" }).outcome).toBe("ADMITTED");
    expect(fabric.decide({ requestId: "a-2", userId: "a", role: "CODER" }).outcome).toBe("ADMITTED");
    const capped = fabric.decide({ requestId: "a-3", userId: "a", role: "CODER" });
    expect(capped.outcome).toBe("QUEUED_FOR_CAPACITY");
    expect(capped.explanation.reasonCodes).toContain("USER_CONCURRENCY_LIMIT");
    // Other users are unaffected by user-a's cap.
    expect(fabric.decide({ requestId: "b-1", userId: "b", role: "CODER" }).outcome).toBe("ADMITTED");
  });

  it("new-user first-run reserve protects a slice of shared capacity from established demand", () => {
    const c = clock();
    // A tiny pool: 10 request-slots. Reserve 8 of them for first-run users.
    const routes = [managedRoute("only", "groq", "groq:only:pool", { windows: [quotaWindow({ limit: 10, remaining: 10 })] })];
    const reservations = new CapacityReservationLedger({ routes: [], now: c.now, firstRunReserveRequests: 2 });
    const fabric = createFreeFabric({
      managedRoutes: () => routes,
      managedPools: () => routes.map(poolFor),
      reservations,
      now: c.now,
    });
    // Established users can draw 8 slots (10 - 2 reserve); the 9th is denied by the floor.
    let established = 0;
    for (let u = 0; u < 12; u += 1) {
      const d = fabric.decide({ requestId: `e${u}`, userId: `e${u}`, role: "CODER" });
      if (d.outcome === "ADMITTED") established += 1;
    }
    expect(established).toBe(8);
    // A first-run user still gets through — the reserve is theirs.
    const firstRun = fabric.decide({ requestId: "new-1", userId: "new-user", role: "CODER", isNewUser: true });
    expect(firstRun.outcome).toBe("ADMITTED");
  });
});
