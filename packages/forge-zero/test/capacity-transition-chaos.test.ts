import { describe, expect, it } from "vitest";
import {
  CapacityReservationLedger,
  type CapacityReservationRequest,
  type CapacityRoute,
  type CapacityWindow,
  type ProviderCapacityPool,
} from "../src/index.js";

/**
 * R33 Mission P — capacity-transition chaos at the reservation ledger.
 *
 * These cases were discovered against real provider supply: GitHub Models serves inference
 * but returns no quota headers (absent windows must deny — unmeasured supply is never
 * counted), Mistral reports `limit: 0` on out-of-capacity models, and a 16k-token turn
 * demand legitimately exceeds an 8k TPM window. The ledger is the fail-closed edge where
 * each of those becomes a deny rather than an admit.
 */

const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const RESET = "2026-09-26T00:00:00.000Z";

function win(overrides: Partial<CapacityWindow> = {}): CapacityWindow {
  return { unit: "requests", limit: 100, remaining: 100, resetAt: RESET, scope: "ORG", observedAt: new Date(NOW).toISOString(), authoritative: true, ...overrides };
}

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
      win(),
      win({ unit: "input_tokens", limit: 16_000, remaining: 16_000 }),
      win({ unit: "output_tokens", limit: 10_000, remaining: 10_000 }),
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
  routeIds: readonly string[],
  overrides: Partial<CapacityReservationRequest> = {},
): CapacityReservationRequest {
  return {
    reservationId,
    userId: "u1",
    routeIds,
    role: "coder",
    taskKind: "normal",
    requests: 1,
    inputTokens: 16_000,
    outputTokens: 1_000,
    isNewUser: false,
    priority: "normal",
    createdAt: new Date(NOW).toISOString(),
    leaseUntil: new Date(NOW + 60_000).toISOString(),
    ...overrides,
  };
}

describe("capacity-transition chaos — unmeasured and malformed windows", () => {
  it("a route with zero measured windows is denied — unmeasured supply is never counted", () => {
    // Live finding: GitHub Models answers inference but emits no quota headers. Its fabric
    // route surfaces with windows:[] and must be CAPACITY_EXHAUSTED, not treated as free.
    const empty = route({ windows: [] });
    const ledger = new CapacityReservationLedger({ routes: [empty], pools: [pool({ windows: [] })], now: () => NOW });
    const decision = ledger.reserve(request("r1", ["r-a"], { inputTokens: 4_000 }));
    expect(decision.admitted).toBe(false);
    expect(decision.reason).toBe("CAPACITY_EXHAUSTED");
    expect(ledger.snapshot().activeReservations).toBe(0);
  });

  it("a credit-windowed route admits without request/token windows — credits are its accounting dimension", () => {
    // User-entitlement pools (e.g. monthly credit allowances) are denominated in credits;
    // absent token headers must not produce a false denial on their authoritative unit.
    const credited = route({ windows: [win({ unit: "credits", limit: 50, remaining: 50, scope: "USER_ACCOUNT" })] });
    const ledger = new CapacityReservationLedger({ routes: [credited], pools: [pool({ windows: credited.windows })], now: () => NOW });
    const decision = ledger.reserve(request("r1", ["r-a"], { credits: 1 }));
    expect(decision.admitted).toBe(true);
  });

  it("a provider-units window (neuron-style accounting) admits within remaining and denies past it", () => {
    const metered = route({ windows: [win({ unit: "provider_units", limit: 8_000, remaining: 8_000 })] });
    const ledger = new CapacityReservationLedger({ routes: [metered], pools: [pool({ windows: metered.windows })], now: () => NOW });
    expect(ledger.reserve(request("r1", ["r-a"], { providerUnits: 8_000 })).admitted).toBe(true);
    expect(ledger.reserve(request("r2", ["r-a"], { providerUnits: 1 })).reason).toBe("CAPACITY_EXHAUSTED");
  });

  it("a negative remaining count denies — malformed values fail closed, never admit", () => {
    const negative = route({ windows: [win({ remaining: -5 }), win({ unit: "input_tokens", limit: 16_000, remaining: 16_000 })] });
    const ledger = new CapacityReservationLedger({ routes: [negative], pools: [pool({ windows: negative.windows })], now: () => NOW });
    expect(ledger.reserve(request("r1", ["r-a"], { requests: 1, inputTokens: 10 })).admitted).toBe(false);
  });

  it("an unparseable resetAt still denies on capacity and never poisons nextAvailableAt", () => {
    const garbage = route({ windows: [
      win({ limit: 0, remaining: 0, resetAt: "not-a-date" }),
      win({ unit: "input_tokens", limit: 16_000, remaining: 16_000 }),
    ] });
    const ledger = new CapacityReservationLedger({ routes: [garbage], pools: [pool({ windows: garbage.windows })], now: () => NOW });
    const decision = ledger.reserve(request("r1", ["r-a"]));
    expect(decision.admitted).toBe(false);
    // The garbage reset is skipped; the other window's parseable reset still surfaces.
    expect(decision.nextAvailableAt).toBe(RESET);
  });

  it("nextAvailableAt is absent when every window's resetAt is unparseable", () => {
    const garbage = route({ windows: [
      win({ limit: 0, remaining: 0, resetAt: "not-a-date" }),
      win({ unit: "input_tokens", limit: 0, remaining: 0, resetAt: "also-garbage" }),
    ] });
    const ledger = new CapacityReservationLedger({ routes: [garbage], pools: [pool({ windows: garbage.windows })], now: () => NOW });
    const decision = ledger.reserve(request("r1", ["r-a"]));
    expect(decision.admitted).toBe(false);
    expect(decision.nextAvailableAt).toBeUndefined();
  });

  it("a limit:0 window (a provider's out-of-capacity signal) denies like exhaustion", () => {
    // Live finding: Mistral devstral/mistral-small returned x-ratelimit-limit-req-minute: 0 —
    // the provider's own way of saying this model has no allocation right now.
    const zeroed = route({ windows: [win({ limit: 0, remaining: 0 }), win({ unit: "input_tokens", limit: 16_000, remaining: 16_000 })] });
    const ledger = new CapacityReservationLedger({ routes: [zeroed], pools: [pool({ windows: zeroed.windows })], now: () => NOW });
    expect(ledger.reserve(request("r1", ["r-a"])).reason).toBe("CAPACITY_EXHAUSTED");
  });
});

describe("capacity-transition chaos — demand boundary and pool precedence", () => {
  it("a demand exactly at the window boundary admits; one token over denies", () => {
    const ledger = new CapacityReservationLedger({ routes: [route()], pools: [pool()], now: () => NOW });
    expect(ledger.reserve(request("r1", ["r-a"], { inputTokens: 16_000 })).admitted).toBe(true);
    expect(ledger.reserve(request("r2", ["r-a"], { inputTokens: 16_001 })).reason).toBe("CAPACITY_EXHAUSTED");
  });

  it("a 16k-token turn demand cannot fit an 8k TPM pool even with requests to spare", () => {
    // Live finding: Groq's measured 8k TPM pools are inadmissible for agent turns whose
    // honest demand is 16k input tokens — the broker refuses rather than over-promising.
    const narrow = route({ windows: [
      win({ limit: 1_000, remaining: 1_000 }),
      win({ unit: "input_tokens", limit: 8_000, remaining: 8_000 }),
    ] });
    const ledger = new CapacityReservationLedger({ routes: [narrow], pools: [pool({ windows: narrow.windows })], now: () => NOW });
    expect(ledger.reserve(request("r1", ["r-a"], { inputTokens: 16_000 })).reason).toBe("CAPACITY_EXHAUSTED");
  });

  it("pool windows override route windows — the physical pool is the accounting authority", () => {
    const roomyRoute = route();
    const tightPool = pool({ windows: [win({ limit: 1, remaining: 0 }), win({ unit: "input_tokens", limit: 16_000, remaining: 16_000 })] });
    const ledger = new CapacityReservationLedger({ routes: [roomyRoute], pools: [tightPool], now: () => NOW });
    expect(ledger.reserve(request("r1", ["r-a"])).reason).toBe("CAPACITY_EXHAUSTED");
  });

  it("a pool row naming a different provider can never lend its windows to this route", () => {
    const foreign = pool({ providerId: "someone-else" });
    const ledger = new CapacityReservationLedger({ routes: [route()], pools: [foreign], now: () => NOW });
    expect(ledger.reserve(request("r1", ["r-a"])).reason).toBe("CAPACITY_POOL_IDENTITY_MISMATCH");
  });

  it("a non-authoritative (documented, unmeasured) window still gates by its declared numbers", () => {
    // `authoritative:false` marks provenance, not trust-to-zero: a documented provider limit
    // is usable capacity information, but the declared remaining is still the ceiling.
    const documented = route({ windows: [
      win({ limit: 150, remaining: 150, authoritative: false }),
      win({ unit: "input_tokens", limit: 8_000, remaining: 8_000, authoritative: false }),
    ] });
    const ledger = new CapacityReservationLedger({ routes: [documented], pools: [pool({ windows: documented.windows })], now: () => NOW });
    expect(ledger.reserve(request("r1", ["r-a"], { inputTokens: 8_000 })).admitted).toBe(true);
    expect(ledger.reserve(request("r2", ["r-a"], { inputTokens: 8_001 })).reason).toBe("CAPACITY_EXHAUSTED");
  });
});
