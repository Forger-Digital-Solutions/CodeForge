import { describe, expect, it } from "vitest";
import {
  CapacityReservationLedger,
  type CapacityReservationRequest,
  type CapacityRoute,
  type ProviderCapacityPool,
} from "../src/index.js";

const NOW = Date.parse("2026-09-15T12:00:00.000Z");
const RESET = "2026-09-16T00:00:00.000Z";

function route(overrides: Partial<CapacityRoute> = {}): CapacityRoute {
  return {
    routeId: "r-a",
    providerId: "groq",
    modelId: "openai/gpt-oss-120b",
    canonicalModelId: "openai/gpt-oss-120b",
    family: "gpt-oss",
    gateway: "direct",
    supplyClass: "PURE_MANAGED_FREE",
    capacityPoolId: "pool-a",
    capacityPoolScope: "SHARED_OWNER_POOL",
    capacityScope: "ORG",
    dataPolicyProfile: "PRIVATE_CODE_ALLOWED",
    lifecycle: "APPROVED",
    explicitZeroPrice: true,
    paidFallbackDisabled: true,
    managedMultiUserAllowed: true,
    privacyClass: "standard",
    roles: ["coder"],
    qualityScore: 80,
    healthy: true,
    enabled: true,
    windows: [
      { unit: "requests", limit: 100, remaining: 100, resetAt: RESET, scope: "ORG", observedAt: new Date(NOW).toISOString(), authoritative: true },
      { unit: "input_tokens", limit: 10_000, remaining: 10_000, resetAt: RESET, scope: "ORG", observedAt: new Date(NOW).toISOString(), authoritative: true },
      { unit: "output_tokens", limit: 10_000, remaining: 10_000, resetAt: RESET, scope: "ORG", observedAt: new Date(NOW).toISOString(), authoritative: true },
      { unit: "concurrency", limit: 3, remaining: 3, resetAt: RESET, scope: "ORG", observedAt: new Date(NOW).toISOString(), authoritative: true },
    ],
    ...overrides,
  };
}

function pool(overrides: Partial<ProviderCapacityPool> = {}): ProviderCapacityPool {
  return {
    poolId: "pool-a",
    providerId: "groq",
    scope: "SHARED_OWNER_POOL",
    supplyClass: "PURE_MANAGED_FREE",
    windows: route().windows,
    observedAt: new Date(NOW).toISOString(),
    authoritative: true,
    ...overrides,
  };
}

function request(
  reservationId: string,
  userId: string,
  routeIds: readonly string[],
  overrides: Partial<CapacityReservationRequest> = {},
): CapacityReservationRequest {
  return {
    reservationId,
    userId,
    routeIds,
    role: "coder",
    taskKind: "normal",
    requests: 1,
    inputTokens: 10,
    outputTokens: 5,
    isNewUser: false,
    priority: "normal",
    createdAt: new Date(NOW).toISOString(),
    leaseUntil: new Date(NOW + 60_000).toISOString(),
    ...overrides,
  };
}

describe("CapacityReservationLedger indexed accounting", () => {
  it("re-admitting the same reservationId replaces the hold instead of double-booking", () => {
    const a = route();
    const b = route({ routeId: "r-b", providerId: "openrouter", capacityPoolId: "pool-b" });
    const ledger = new CapacityReservationLedger({
      routes: [a, b],
      pools: [pool(), pool({ poolId: "pool-b", providerId: "openrouter" })],
      maxActiveReservationsPerUser: 1,
      now: () => NOW,
    });
    expect(ledger.reserve(request("x", "u", ["r-a"])).admitted).toBe(true);
    // The failover re-decide reuses the reservation id: it must not trip the per-user cap
    // and the moved hold must stop billing the old pool.
    const moved = ledger.reserve(request("x", "u", ["r-b"]));
    expect(moved).toMatchObject({ admitted: true, routeId: "r-b" });
    const snap = ledger.snapshot();
    expect(snap.activeReservations).toBe(1);
    expect(snap.byPool["pool-a"] ?? 0).toBe(0);
    expect(snap.byPool["pool-b"]).toBe(1);
    // Re-deciding onto an ineligible route also replaces rather than stacking.
    const denied = ledger.reserve(request("x", "u", ["r-missing"]));
    expect(denied.admitted).toBe(false);
    expect(ledger.snapshot().activeReservations).toBe(0);
  });

  it("enforces the per-user cap and releases it on expiry", () => {
    let clock = NOW;
    const ledger = new CapacityReservationLedger({ routes: [route()], pools: [pool()], maxActiveReservationsPerUser: 2, now: () => clock });
    expect(ledger.reserve(request("a", "u", ["r-a"])).admitted).toBe(true);
    expect(ledger.reserve(request("b", "u", ["r-a"])).admitted).toBe(true);
    expect(ledger.reserve(request("c", "u", ["r-a"])).reason).toBe("USER_CONCURRENCY_LIMIT");
    clock = NOW + 61_000;
    expect(ledger.reserve(request("c", "u", ["r-a"])).admitted).toBe(true);
    expect(ledger.snapshot().activeReservations).toBe(1);
  });

  it("expired holds free the shared pool for a different user", () => {
    let clock = NOW;
    const narrow = route({ windows: [
      { unit: "requests", limit: 2, remaining: 2, resetAt: RESET, scope: "ORG", observedAt: new Date(NOW).toISOString(), authoritative: true },
      { unit: "input_tokens", limit: 10_000, remaining: 10_000, resetAt: RESET, scope: "ORG", observedAt: new Date(NOW).toISOString(), authoritative: true },
      { unit: "output_tokens", limit: 10_000, remaining: 10_000, resetAt: RESET, scope: "ORG", observedAt: new Date(NOW).toISOString(), authoritative: true },
    ] });
    const ledger = new CapacityReservationLedger({ routes: [narrow], pools: [pool({ windows: narrow.windows })], now: () => clock });
    expect(ledger.reserve(request("a", "u1", ["r-a"])).admitted).toBe(true);
    expect(ledger.reserve(request("b", "u2", ["r-a"])).admitted).toBe(true);
    expect(ledger.reserve(request("c", "u3", ["r-a"])).reason).toBe("CAPACITY_EXHAUSTED");
    clock = NOW + 61_000;
    expect(ledger.reserve(request("c", "u3", ["r-a"])).admitted).toBe(true);
  });

  it("keeps billing a live hold to its pool after updateRoutes removes the route row", () => {
    const shared = { unit: "requests" as const, limit: 1, remaining: 1, resetAt: RESET, scope: "ORG", observedAt: new Date(NOW).toISOString(), authoritative: true };
    const windows = [shared, route().windows[1]!, route().windows[2]!];
    const v1 = route({ windows });
    const v2 = route({ routeId: "r-v2", windows });
    const ledger = new CapacityReservationLedger({ routes: [v1], pools: [pool({ windows })], now: () => NOW });
    expect(ledger.reserve(request("hold", "u1", ["r-a"])).admitted).toBe(true);
    // Catalog refresh swaps the route row for a successor on the same physical pool. The
    // surviving hold still occupies the pool's single request slot — a refresh must not be
    // a way to double-admit quota that is already leased.
    ledger.updateRoutes([v2]);
    expect(ledger.reserve(request("new", "u2", ["r-v2"])).reason).toBe("CAPACITY_EXHAUSTED");
    ledger.release("hold");
    expect(ledger.reserve(request("new", "u2", ["r-v2"])).admitted).toBe(true);
  });

  it("isolates per-user pools: one user's holds never consume another's budget", () => {
    const perUser = route({
      supplyClass: "USER_CONNECTED_FREE",
      freeOnlyAdmissionProven: true,
      capacityPoolScope: "PER_USER_POOL",
      windows: [
        { unit: "requests", limit: 1, remaining: 1, resetAt: RESET, scope: "USER", observedAt: new Date(NOW).toISOString(), authoritative: true },
        { unit: "input_tokens", limit: 10_000, remaining: 10_000, resetAt: RESET, scope: "USER", observedAt: new Date(NOW).toISOString(), authoritative: true },
        { unit: "output_tokens", limit: 10_000, remaining: 10_000, resetAt: RESET, scope: "USER", observedAt: new Date(NOW).toISOString(), authoritative: true },
      ],
    });
    const ledger = new CapacityReservationLedger({ routes: [perUser], now: () => NOW });
    expect(ledger.reserve(request("a", "u1", ["r-a"])).admitted).toBe(true);
    expect(ledger.reserve(request("b", "u1", ["r-a"])).reason).toBe("CAPACITY_EXHAUSTED");
    expect(ledger.reserve(request("c", "u2", ["r-a"])).admitted).toBe(true);
  });

  it("stays flat as the reservation table grows", () => {
    const wide = route({ windows: [
      { unit: "requests", limit: 1_000_000, remaining: 1_000_000, resetAt: RESET, scope: "ORG", observedAt: new Date(NOW).toISOString(), authoritative: true },
      { unit: "input_tokens", limit: 1_000_000_000, remaining: 1_000_000_000, resetAt: RESET, scope: "ORG", observedAt: new Date(NOW).toISOString(), authoritative: true },
      { unit: "output_tokens", limit: 1_000_000_000, remaining: 1_000_000_000, resetAt: RESET, scope: "ORG", observedAt: new Date(NOW).toISOString(), authoritative: true },
    ] });
    const ledger = new CapacityReservationLedger({ routes: [wide], pools: [pool({ windows: wide.windows })], now: () => NOW });
    const COUNT = 30_000;
    for (let i = 0; i < COUNT; i++) {
      expect(ledger.reserve(request(`r-${i}`, `u-${i}`, ["r-a"])).admitted).toBe(true);
    }
    // The index makes each admission O(1); the pre-index full-map scan measured ~0.57µs per
    // live reservation, which would put 500 admits at 30k actives near 9 seconds. Allowing a
    // wide margin for slow CI while still failing the quadratic regression.
    const start = performance.now();
    for (let i = 0; i < 500; i++) ledger.reserve(request(`probe-${i}`, `p-${i}`, ["r-a"]));
    expect(performance.now() - start).toBeLessThan(1_000);
    const snap = ledger.snapshot();
    expect(snap.activeReservations).toBe(COUNT + 500);
    expect(snap.byUser[`u-0`]).toBe(1);
    expect(snap.byPool["pool-a"]).toBe(COUNT + 500);
  });
});
