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
    // route surfaces with windows:[] and must deny — R51 names the truth CAPACITY_UNMEASURED:
    // a verification gap the runtime can close with a bounded probe, never an admit on faith
    // and never a fabricated "exhausted" wait state.
    const empty = route({ windows: [] });
    const ledger = new CapacityReservationLedger({ routes: [empty], pools: [pool({ windows: [] })], now: () => NOW });
    const decision = ledger.reserve(request("r1", ["r-a"], { inputTokens: 4_000 }));
    expect(decision.admitted).toBe(false);
    expect(decision.reason).toBe("CAPACITY_UNMEASURED");
    expect(decision.nextAvailableAt).toBeUndefined();
    expect(ledger.snapshot().activeReservations).toBe(0);
  });

  it("R51: an unmeasured route does not masquerade as measured exhaustion — a measured denial still wins the real reason", () => {
    // routeIds reserve in order: the exhausted route denies first (measured truth), the
    // unmeasured one adds its own flag — the verdict must still be CAPACITY_UNMEASURED only
    // when NO measured denial exists; a mixed set reports the real exhaustion.
    const exhausted = route({ routeId: "r-ex", capacityPoolId: "pool-ex", windows: [win({ remaining: 0 })] });
    const unmeasured = route({ routeId: "r-un", capacityPoolId: "pool-un", windows: [] });
    const ledger = new CapacityReservationLedger({
      routes: [exhausted, unmeasured],
      pools: [pool({ poolId: "pool-ex", windows: exhausted.windows }), pool({ poolId: "pool-un", windows: [] })],
      now: () => NOW,
    });
    const decision = ledger.reserve(request("r1", ["r-ex", "r-un"]));
    expect(decision.admitted).toBe(false);
    expect(decision.reason).toBe("CAPACITY_EXHAUSTED");
    expect(decision.nextAvailableAt).toBe(RESET);
    const only = new CapacityReservationLedger({ routes: [unmeasured], pools: [pool({ poolId: "pool-un", windows: [] })], now: () => NOW });
    expect(only.reserve(request("r2", ["r-un"])).reason).toBe("CAPACITY_UNMEASURED");
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
    // The denied unit is requests at limit:0 — a structural zero no reset can serve, and its
    // own resetAt is unparseable anyway. The route contributes no horizon rather than
    // borrowing the healthy token window's reset for a denial that reset cannot cure.
    expect(decision.nextAvailableAt).toBeUndefined();
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

  it("an empty-window pool must not swallow the route's reset horizon — nextAvailableAt falls back to route windows", () => {
    // Live finding (R59): a per-user pool row exists even when the connection declares no
    // quota dimensions (userConnectedFree unstamped → windows: []). reserve() already falls
    // back to route windows for the deny decision, but nextReset() consulted
    // `pools.get(...)?.windows ?? route.windows` — [] is not nullish, so the empty pool hid
    // the route's real reset and the queued verdict surfaced with no recovery horizon.
    const exhausted = route({
      windows: [
        win({ limit: 100, remaining: 0, resetAt: RESET }),
        win({ unit: "input_tokens", limit: 16_000, remaining: 16_000, resetAt: RESET }),
      ],
    });
    const ledger = new CapacityReservationLedger({
      routes: [exhausted],
      pools: [pool({ windows: [] })],
      now: () => NOW,
    });
    const decision = ledger.reserve(request("r1", ["r-a"]));
    expect(decision.admitted).toBe(false);
    expect(decision.reason).toBe("CAPACITY_EXHAUSTED");
    expect(decision.nextAvailableAt).toBe(RESET);
  });
});

describe("capacity-transition chaos — demand boundary and pool precedence", () => {
  it("a demand exactly at the window boundary admits; one over the limit is provider-arbitrated, never fabricated-exhausted", () => {
    // R59: the token demand is an estimate (chars/4 × a borrowed tokenizer ratio); past the
    // window's declared limit no refill can satisfy it, but the estimate cannot prove the
    // real request won't fit either. With the window unheld the provider's wire response is
    // the honest arbiter — the reservation admits (tokenBucketDecision's rule), and a real
    // success or a real 429 replaces the estimate with evidence.
    expect(new CapacityReservationLedger({ routes: [route()], pools: [pool()], now: () => NOW })
      .reserve(request("r1", ["r-a"], { inputTokens: 16_000 })).admitted).toBe(true);
    expect(new CapacityReservationLedger({ routes: [route()], pools: [pool()], now: () => NOW })
      .reserve(request("r2", ["r-a"], { inputTokens: 16_001 })).admitted).toBe(true);
  });

  it("an over-limit turn demand admits only while the window is unheld — a live hold serializes the retry on the lease, not a reset", () => {
    // Groq's measured 8k TPM pools see turn demands above their limit. The first request is
    // provider-arbitrated; the SECOND must not double-book the same window — it waits for
    // the live lease to free, which is the horizon that can actually serve it.
    const narrow = route({ windows: [
      win({ limit: 1_000, remaining: 1_000 }),
      win({ unit: "input_tokens", limit: 8_000, remaining: 8_000 }),
    ] });
    const ledger = new CapacityReservationLedger({ routes: [narrow], pools: [pool({ windows: narrow.windows })], now: () => NOW });
    const first = ledger.reserve(request("r1", ["r-a"], { inputTokens: 16_000 }));
    expect(first.admitted).toBe(true);
    const second = ledger.reserve(request("r2", ["r-a"], { inputTokens: 16_000 }));
    expect(second.admitted).toBe(false);
    expect(second.reason).toBe("CAPACITY_EXHAUSTED");
    // The horizon is the live lease (NOW + 60s), not either window's reset — a refill cannot
    // serve an over-limit demand but a freed window lets the provider arbitrate it.
    expect(second.nextAvailableAt).toBe(new Date(NOW + 60_000).toISOString());
  });

  it("a token-short denial reports the token reset, not an earlier request reset — the horizon names the blocking dimension", () => {
    // R59 live finding: min-over-all-window-resets advertised the requests window's earlier
    // reset while the input_tokens window was the one that actually denied — a horizon that
    // arrives and still cannot serve the demand.
    const tokenReset = "2026-09-25T13:00:00.000Z";
    const tight = route({ windows: [
      win({ limit: 1_000, remaining: 0, resetAt: "2026-09-25T12:05:00.000Z" }),
      win({ unit: "input_tokens", limit: 8_000, remaining: 0, resetAt: tokenReset }),
    ] });
    const ledger = new CapacityReservationLedger({ routes: [tight], pools: [pool({ windows: tight.windows })], now: () => NOW });
    const decision = ledger.reserve(request("r1", ["r-a"], { inputTokens: 4_000 }));
    expect(decision.reason).toBe("CAPACITY_EXHAUSTED");
    expect(decision.nextAvailableAt).toBe(tokenReset);
  });

  it("real exhaustion still denies truthfully — a demand inside the limit but over remaining queues on its own reset", () => {
    const depleted = route({ windows: [
      win({ limit: 1_000, remaining: 900 }),
      win({ unit: "input_tokens", limit: 8_000, remaining: 3_000, resetAt: RESET }),
    ] });
    const ledger = new CapacityReservationLedger({ routes: [depleted], pools: [pool({ windows: depleted.windows })], now: () => NOW });
    const decision = ledger.reserve(request("r1", ["r-a"], { inputTokens: 5_000 }));
    expect(decision.admitted).toBe(false);
    expect(decision.reason).toBe("CAPACITY_EXHAUSTED");
    expect(decision.nextAvailableAt).toBe(RESET);
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
