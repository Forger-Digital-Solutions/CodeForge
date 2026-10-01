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

  it("denies an unmeasured route as CAPACITY_UNMEASURED — a verification gap, never a wait", () => {
    // Live finding (R33 supply audit): GitHub Models serves real inference but emits no
    // quota headers, so its fabric route arrives with windows:[]. Unmeasured capacity denies
    // as CAPACITY_UNMEASURED so the runtime can probe-and-retry — QUEUED would park on a
    // window that can never return by itself (the R51 false-parking bug). Still never an
    // admission on faith.
    const c = clock();
    const unmeasured = managedRoute("shared", { windows: [] });
    const fabric = createFreeFabric({
      managedRoutes: () => [unmeasured],
      managedPools: () => [poolFor(unmeasured, { windows: [] })],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    const decision = fabric.decide({ requestId: "r1", userId: "alice", role: "CODER" });
    expect(decision.outcome).toBe("DENIED_NO_SUPPLY");
    expect(decision.selected).toBeUndefined();
    expect(decision.explanation.reasonCodes).toContain("CAPACITY_UNMEASURED");
    expect(decision.explanation.summary).toContain("never measured");
    const report = decision.explanation.candidates.find((r) => r.routeId === "shared");
    expect(report?.status).toBe("CAPACITY_UNMEASURED");
    expect(report?.reasonCodes).toContain("PROVIDER_QUOTA_UNMEASURED");
    expect(decision.nextAvailableAt).toBeUndefined();
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

describe("FreeFabric — R34 measured demand (Mission E)", () => {
  /** Groq's measured per-model pool shape: 1k req + 8k TPM — the pool a flat 16k demand
   *  could never use. */
  function narrowPoolRoute(id: string): CapacityRoute {
    return managedRoute(id, {
      windows: [quotaWindow(), quotaWindow({ unit: "input_tokens", limit: 8_000, remaining: 8_000 })],
    });
  }

  it("a small measured turn admits an 8k-TPM pool a flat 16k demand monopolizes", () => {
    const c = clock();
    const groqLike = narrowPoolRoute("groq-small");
    const fabric = createFreeFabric({
      managedRoutes: () => [groqLike],
      managedPools: () => [poolFor(groqLike)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    // R59: an over-limit demand is admitted while the window is unspent — it reserves the
    // whole window and the provider arbitrates whether the real request fits. The measured
    // request reserves only its own (smaller) hold, leaving headroom a second turn can use.
    const flat = fabric.decide({ requestId: "r1", userId: "alice", role: "CODER", demand: { requests: 1, inputTokens: 16_000 } });
    expect(flat.outcome).toBe("ADMITTED");
    // The flat over-limit hold claims the entire window — a second request must queue on it.
    const behind = fabric.decide({ requestId: "r1b", userId: "alice", role: "CODER", demand: { requests: 1, inputTokens: 500 } });
    expect(behind.outcome).toBe("QUEUED_FOR_CAPACITY");
    // The measured trivial-turn request (~3k serialized) at the unlearned 1.5 floor × 1.15
    // reserves ~5.2k — and a same-size second request still fits the remaining ~2.8k? No —
    // the whole-window flat hold leaves nothing; on a fresh fabric it admits alone.
    const solo = createFreeFabric({
      managedRoutes: () => [narrowPoolRoute("groq-solo")],
      managedPools: () => [poolFor(narrowPoolRoute("groq-solo"))],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    const measured = solo.decide({ requestId: "r2", userId: "alice", role: "CODER", demand: { requests: 1, estimatedPromptTokens: 3_000, outputTokens: 2_048 } });
    expect(measured.outcome).toBe("ADMITTED");
    expect(measured.selected?.routeId).toBe("groq-solo");
  });

  it("scales demand per candidate by learned tokenizer ratio — a dense tokenizer reserves more", () => {
    const c = clock();
    const dense = narrowPoolRoute("dense");
    const ratios = new Map([[dense.providerId, 1.8]]);
    const fabric = createFreeFabric({
      managedRoutes: () => [dense],
      managedPools: () => [poolFor(dense)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      tokenizerRatioFor: (p) => ratios.get(p),
      now: c.now,
    });
    // 5k measured × 1.8 learned × 1.15 = 10 350 > 8 000: the hold clamps to the window's
    // 8 000 limit — it monopolizes the window, so a follow-up request cannot co-admit. On
    // a sparser tokenizer the same prompt's hold leaves headroom for the same follow-up.
    const decision = fabric.decide({ requestId: "r1", userId: "alice", role: "CODER", demand: { requests: 1, estimatedPromptTokens: 5_000 } });
    expect(decision.outcome).toBe("ADMITTED");
    const followUp = fabric.decide({ requestId: "r2", userId: "alice", role: "CODER", demand: { requests: 1, estimatedPromptTokens: 500, outputTokens: 128 } });
    expect(followUp.outcome).toBe("QUEUED_FOR_CAPACITY");
    const sparseRoute = narrowPoolRoute("sparse");
    const sparseFabric = createFreeFabric({
      managedRoutes: () => [sparseRoute],
      managedPools: () => [poolFor(sparseRoute)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      tokenizerRatioFor: () => 1.0,
      now: c.now,
    });
    expect(sparseFabric.decide({ requestId: "s1", userId: "alice", role: "CODER", demand: { requests: 1, estimatedPromptTokens: 5_000 } }).outcome).toBe("ADMITTED");
    // 5 000 × 1.0 × 1.15 = 5 750 held of 8 000 — the same follow-up request still fits.
    expect(sparseFabric.decide({ requestId: "s2", userId: "alice", role: "CODER", demand: { requests: 1, estimatedPromptTokens: 500, outputTokens: 128 } }).outcome).toBe("ADMITTED");
  });

  it("reserves exactly estimate × ratio × margin — boundary admits at the computed value, denies one spent token short", () => {
    const c = clock();
    // 3000 × 1.5 (unlearned) × 1.15 = 5175 — the demand is a deterministic function of the
    // measurement, never loose and never tight.
    const exact = managedRoute("exact", {
      windows: [quotaWindow(), quotaWindow({ unit: "input_tokens", limit: 5_175, remaining: 5_175 })],
    });
    const fabric = createFreeFabric({
      managedRoutes: () => [exact],
      managedPools: () => [poolFor(exact)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    expect(fabric.decide({ requestId: "r1", userId: "alice", role: "CODER", demand: { requests: 1, estimatedPromptTokens: 3_000 } }).outcome).toBe("ADMITTED");
    // One token already spent of the 5 175 window leaves 5 174 — a 5 175 demand queues on
    // the window's reset even though its declared limit could hold the clamped hold.
    const spent = managedRoute("spent", {
      windows: [quotaWindow(), quotaWindow({ unit: "input_tokens", limit: 5_175, remaining: 5_174 })],
    });
    const fabric2 = createFreeFabric({
      managedRoutes: () => [spent],
      managedPools: () => [poolFor(spent)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    expect(fabric2.decide({ requestId: "r1", userId: "alice", role: "CODER", demand: { requests: 1, estimatedPromptTokens: 3_000 } }).outcome).toBe("QUEUED_FOR_CAPACITY");
  });

  it("never under-reserves below the window — an over-limit demand holds the window, not a fraction", () => {
    const c = clock();
    // Learned ratio 1.0 (a sparse tokenizer like Groq gpt-oss): demand = est × 1.0 × 1.15,
    // strictly above the provider-observed true cost — systematic under-reservation is
    // impossible while the margin holds.
    const window = 3_449; // just under 3000 × 1.15 = 3450
    const tight = managedRoute("tight", {
      windows: [quotaWindow(), quotaWindow({ unit: "input_tokens", limit: window, remaining: window })],
    });
    const fabric = createFreeFabric({
      managedRoutes: () => [tight],
      managedPools: () => [poolFor(tight)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      tokenizerRatioFor: () => 1.0,
      now: c.now,
    });
    // Demand 3 450 > limit 3 449 clamps to the window — the hold is the whole window, which
    // a second reservation cannot share even partially.
    expect(fabric.decide({ requestId: "r1", userId: "alice", role: "CODER", demand: { requests: 1, estimatedPromptTokens: 3_000 } }).outcome).toBe("ADMITTED");
    expect(fabric.decide({ requestId: "r1b", userId: "alice", role: "CODER", demand: { requests: 1, inputTokens: 1 } }).outcome).toBe("QUEUED_FOR_CAPACITY");
    const fits = managedRoute("fits", {
      windows: [quotaWindow(), quotaWindow({ unit: "input_tokens", limit: 3_450, remaining: 3_450 })],
    });
    const fabric2 = createFreeFabric({
      managedRoutes: () => [fits],
      managedPools: () => [poolFor(fits)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      tokenizerRatioFor: () => 1.0,
      now: c.now,
    });
    expect(fabric2.decide({ requestId: "r1", userId: "alice", role: "CODER", demand: { requests: 1, estimatedPromptTokens: 3_000 } }).outcome).toBe("ADMITTED");
  });

  it("per-candidate output demand falls back to the flat demand on 0/NaN/sub-token and ceils fractions", () => {
    const c = clock();
    const mk = () => {
      const route = managedRoute("out", {
        windows: [
          quotaWindow(),
          quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 1_500_000 }),
          quotaWindow({ unit: "output_tokens", limit: 200, remaining: 50 }),
        ],
      });
      return createFreeFabric({
        managedRoutes: () => [route],
        managedPools: () => [poolFor(route)],
        reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
        now: c.now,
      });
    };
    const decide = (fabric: ReturnType<typeof mk>, requestId: string, outputTokensFor: () => number | undefined) =>
      fabric.decide({ requestId, userId: "alice", role: "CODER", demand: { requests: 1, outputTokens: 100, outputTokensFor } });

    // 0, NaN, a sub-token fraction, and undefined are not real request sizes — the flat
    // 100-token demand applies instead, and 100 > the pool's 50 remaining output tokens.
    // If any of these were honored as-is the route would admit while reserving nothing.
    for (const bad of [0, Number.NaN, 0.5, undefined]) {
      expect(decide(mk(), `r-${String(bad)}`, () => bad).outcome).toBe("QUEUED_FOR_CAPACITY");
    }
    // A fractional demand ceils up: 1.4 holds 2 tokens — under the flat fallback it must
    // not reserve just 2 while claiming 100 was the demand; but 2 still fits 50? No —
    // honoring the fraction is exactly right: a real 2-token request fits the window.
    expect(decide(mk(), "r-frac", () => 1.4).outcome).toBe("ADMITTED");
    // A valid nonzero demand is honored exactly — a 40-token request fits 50 remaining.
    expect(decide(mk(), "r-ok", () => 40).outcome).toBe("ADMITTED");
    // And a demand over what remains still queues — honoring is exact, not permissive.
    expect(decide(mk(), "r-over", () => 60).outcome).toBe("QUEUED_FOR_CAPACITY");
  });

  it("a grown-context turn over the window limit reserves the whole window — provider arbitrates fit", () => {
    const c = clock();
    const groqLike = narrowPoolRoute("groq-small");
    const fabric = createFreeFabric({
      managedRoutes: () => [groqLike],
      managedPools: () => [poolFor(groqLike)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    // A mid-turn continuation measuring 20k serialized tokens exceeds the 8k limit: the
    // hold clamps to the whole unspent window and the provider's response decides — a real
    // 413/429 stamps real exhaustion rather than an estimate declaring permanent zero.
    const decision = fabric.decide({ requestId: "r1", userId: "alice", role: "CODER", demand: { requests: 1, estimatedPromptTokens: 20_000 } });
    expect(decision.outcome).toBe("ADMITTED");
    // A partially spent window cannot serve a whole-window demand — it queues on the reset.
    const spentRoute = managedRoute("spent", {
      windows: [quotaWindow(), quotaWindow({ unit: "input_tokens", limit: 8_000, remaining: 7_999 })],
    });
    const fabric2 = createFreeFabric({
      managedRoutes: () => [spentRoute],
      managedPools: () => [poolFor(spentRoute)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    expect(fabric2.decide({ requestId: "r2", userId: "alice", role: "CODER", demand: { requests: 1, estimatedPromptTokens: 20_000 } }).outcome).toBe("QUEUED_FOR_CAPACITY");
  });

  it("a corrupted learned ratio is capped — wild EMA cannot self-deny every route", () => {
    const c = clock();
    const groqLike = narrowPoolRoute("groq-small");
    const fabric = createFreeFabric({
      managedRoutes: () => [groqLike],
      managedPools: () => [poolFor(groqLike)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      tokenizerRatioFor: () => 999,
      now: c.now,
    });
    // est 500 × min(999→3) × 1.15 = 1725 < 8000 — the cap keeps a broken observation from
    // manufacturing infinite demand.
    const decision = fabric.decide({ requestId: "r1", userId: "alice", role: "CODER", demand: { requests: 1, estimatedPromptTokens: 500 } });
    expect(decision.outcome).toBe("ADMITTED");
  });
});

describe("R37 Mission AH — right-fit capacity preservation", () => {
  function sizedRoute(id: string, contextWindow: number, qualityScore = 70): CapacityRoute {
    return managedRoute(id, {
      contextWindow,
      qualityScore,
      windows: [quotaWindow(), quotaWindow({ unit: "input_tokens", limit: 10_000_000, remaining: 10_000_000 })],
    });
  }

  it("a small task prefers the tight-fitting pool over the scarce large-context route", () => {
    const c = clock();
    const small = sizedRoute("small-ctx", 8_000);
    const huge = sizedRoute("huge-ctx", 200_000);
    const fabric = createFreeFabric({
      managedRoutes: () => [huge, small],
      managedPools: () => [poolFor(huge), poolFor(small)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    // est 1_500 × 1.5 (unlearned) × 1.15 ≈ 2_588 input → ~3.6k demand: 8k pool fits
    // (2.2×), 200k pool is 56× oversized and takes a bounded right-fit penalty.
    const decision = fabric.decide({ requestId: "r1", userId: "alice", role: "CODER", demand: { requests: 1, estimatedPromptTokens: 1_500 } });
    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.routeId).toBe("small-ctx");
    const hugeReport = decision.explanation.candidates.find((r) => r.routeId === "huge-ctx");
    expect(hugeReport?.status).toBe("STANDBY");
    expect(hugeReport?.reasonCodes).toContain("RIGHT_SIZE_PRESERVED");
  });

  it("a genuinely large task is still routed to the large-context route", () => {
    const c = clock();
    const small = sizedRoute("small-ctx", 8_000);
    const huge = sizedRoute("huge-ctx", 200_000);
    const fabric = createFreeFabric({
      managedRoutes: () => [huge, small],
      managedPools: () => [poolFor(huge), poolFor(small)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    // est 60_000 → ~103.5k input + 1k output ≈ 105k demand: the 200k pool is a
    // right-size fit (<2×), the 8k pool is denied by penalty AND cannot serve anyway.
    const decision = fabric.decide({ requestId: "r1", userId: "alice", role: "CODER", demand: { requests: 1, estimatedPromptTokens: 60_000 } });
    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.routeId).toBe("huge-ctx");
  });

  it("right-fit penalty never denies admission — oversized is still better than waiting", () => {
    const c = clock();
    const huge = sizedRoute("huge-ctx", 200_000);
    const fabric = createFreeFabric({
      managedRoutes: () => [huge],
      managedPools: () => [poolFor(huge)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    // Tiny demand on the only pool: penalty applies but admission must still succeed.
    const decision = fabric.decide({ requestId: "r1", userId: "alice", role: "CODER", demand: { requests: 1, estimatedPromptTokens: 100 } });
    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.routeId).toBe("huge-ctx");
  });

  it("right-fit ordering respects domain boundaries — user pool still yields to shared supply", () => {
    const c = clock();
    const sharedHuge = sizedRoute("shared-huge", 200_000);
    const userSmall = userRoute("alicehash", { contextWindow: 8_000 });
    const fabric = createFreeFabric({
      managedRoutes: () => [sharedHuge],
      managedPools: () => [poolFor(sharedHuge)],
      userSources: [{ routesForUser: () => [userSmall], poolsForUser: () => [] }],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    // Domain order dominates the bounded fit penalty: the user's own entitlement is
    // preserved even when it is the better-sized pool for a small task.
    const decision = fabric.decide({ requestId: "r1", userId: "alice", userIdentities: ["alicehash"], role: "CODER", demand: { requests: 1, estimatedPromptTokens: 1_500 } });
    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.routeId).toBe("shared-huge");
  });
});

describe("R37 Mission G/H — probation-tier role fallback", () => {
  it("a probation-qualified route admits when it is the only eligible supply — no premature wait", () => {
    const c = clock();
    const probation = managedRoute("probation", { roles: [], fallbackRoles: ["CODER"], qualityScore: 60 });
    const fabric = createFreeFabric({
      managedRoutes: () => [probation],
      managedPools: () => [poolFor(probation)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    const decision = fabric.decide({ requestId: "r1", userId: "alice", role: "CODER" });
    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.routeId).toBe("probation");
    const report = decision.explanation.candidates.find((r) => r.routeId === "probation");
    expect(report?.status).toBe("SELECTED");
    expect(report?.reasonCodes).toContain("ROLE_PROBATION_FALLBACK");
  });

  it("a qualified peer always outranks a probation route regardless of quality score", () => {
    const c = clock();
    const qualified = managedRoute("qualified", { qualityScore: 50 });
    const probation = managedRoute("probation", { roles: [], fallbackRoles: ["CODER"], qualityScore: 95 });
    const fabric = createFreeFabric({
      managedRoutes: () => [probation, qualified],
      managedPools: () => [poolFor(probation), poolFor(qualified)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    const decision = fabric.decide({ requestId: "r1", userId: "alice", role: "CODER" });
    expect(decision.outcome).toBe("ADMITTED");
    // Qualified at score 50 beats probation at 95 — the -25 fallback penalty holds.
    expect(decision.selected?.routeId).toBe("qualified");
    const report = decision.explanation.candidates.find((r) => r.routeId === "probation");
    expect(report?.status).toBe("STANDBY");
    expect(report?.reasonCodes).toContain("ROLE_PROBATION_FALLBACK");
  });

  it("a route with neither qualified nor probation role evidence stays role-ineligible", () => {
    const c = clock();
    const wrong = managedRoute("wrong", { roles: ["VISION"], fallbackRoles: ["EXPLORER"] });
    const fabric = createFreeFabric({
      managedRoutes: () => [wrong],
      managedPools: () => [poolFor(wrong)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    const decision = fabric.decide({ requestId: "r1", userId: "alice", role: "CODER" });
    expect(decision.outcome).toBe("DENIED_NO_SUPPLY");
    const report = decision.explanation.candidates.find((r) => r.routeId === "wrong");
    expect(report?.status).toBe("ROLE_INELIGIBLE");
  });
});

describe("R37 Mission D/AF — same-provider model-domain independence", () => {
  it("model A's exhausted quota never blocks model B on the same provider", () => {
    const c = clock();
    const exhausted = managedRoute("groq-model-a", {
      providerId: "groq",
      capacityPoolId: "shared:groq:model:model-a",
      windows: [quotaWindow({ remaining: 0 }), quotaWindow({ unit: "input_tokens", limit: 8_000, remaining: 8_000 })],
    });
    const available = managedRoute("groq-model-b", {
      providerId: "groq",
      capacityPoolId: "shared:groq:model:model-b",
      qualityScore: 60,
      windows: [quotaWindow(), quotaWindow({ unit: "input_tokens", limit: 8_000, remaining: 8_000 })],
    });
    const fabric = createFreeFabric({
      managedRoutes: () => [exhausted, available],
      managedPools: () => [poolFor(exhausted), poolFor(available)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    const decision = fabric.decide({ requestId: "r1", userId: "alice", role: "CODER" });
    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.routeId).toBe("groq-model-b");
    const denied = decision.explanation.candidates.find((r) => r.routeId === "groq-model-a");
    expect(denied?.status).toBe("CAPACITY_DENIED");
    // Mission AT: the wait-state ledger names the quota domain, not just "capacity".
    expect(denied?.reasonCodes).toContain("MODEL_QUOTA_EXHAUSTED");
    expect(denied?.reasonCodes).toContain("CAPACITY_EXHAUSTED");
  });

  it("account-scoped exhaustion reports PROVIDER_QUOTA_EXHAUSTED — the domain is named", () => {
    const c = clock();
    const dry = managedRoute("account-pool", {
      capacityPoolId: "shared:mistral",
      windows: [quotaWindow({ remaining: 0 })],
    });
    const wet = managedRoute("other-provider", { qualityScore: 60 });
    const fabric = createFreeFabric({
      managedRoutes: () => [dry, wet],
      managedPools: () => [poolFor(dry), poolFor(wet)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    const decision = fabric.decide({ requestId: "r1", userId: "alice", role: "CODER" });
    expect(decision.outcome).toBe("ADMITTED");
    const denied = decision.explanation.candidates.find((r) => r.routeId === "account-pool");
    expect(denied?.reasonCodes).toContain("PROVIDER_QUOTA_EXHAUSTED");
  });
});

describe("FreeFabric — R38 catalog churn and route re-entry", () => {
  it("a 429 rate-limited route re-enters after its window expires — no restart, no false wait", () => {
    const c = clock();
    const shared = managedRoute("flaky");
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    const fabric = createFreeFabric({
      managedRoutes: () => [shared],
      managedPools: () => [poolFor(shared)],
      health: authority,
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    authority.observe({
      kind: "call_failure",
      providerId: shared.providerId,
      modelId: shared.modelId,
      observedAt: new Date(c.now()).toISOString(),
      source: "runtime",
      reason: "RATE_LIMITED",
      status: 429,
      message: "HTTP 429",
      role: "CODER",
    });
    const parked = fabric.decide({ requestId: "r1", userId: "alice", role: "CODER" });
    expect(parked.outcome).toBe("QUEUED_FOR_CAPACITY");
    expect(parked.explanation.candidates[0]?.healthState).toBe("RATE_LIMITED");

    c.advance(DEFAULT_ROUTE_HEALTH_POLICY.rateLimitDefaultTtlMs + 1_000);
    const recovered = fabric.decide({ requestId: "r2", userId: "alice", role: "CODER" });
    expect(recovered.outcome).toBe("ADMITTED");
    expect(recovered.selected?.routeId).toBe("flaky");
  });

  it("a retired route stays excluded until catalog 'present' evidence — then re-enters", () => {
    const c = clock();
    const shared = managedRoute("churned");
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    const fabric = createFreeFabric({
      managedRoutes: () => [shared],
      managedPools: () => [poolFor(shared)],
      health: authority,
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    authority.observe({
      kind: "catalog",
      providerId: shared.providerId,
      modelId: shared.modelId,
      observedAt: new Date(c.now()).toISOString(),
      source: "catalog_refresh",
      fact: "not_found",
    });
    const parked = fabric.decide({ requestId: "r1", userId: "alice", role: "CODER" });
    expect(parked.outcome).toBe("QUEUED_FOR_CAPACITY");
    expect(parked.explanation.candidates[0]?.healthState).toBe("MODEL_RETIRED");

    // Time passing alone must NOT resurrect a permanently-retired route.
    c.advance(60 * 60_000);
    const stillParked = fabric.decide({ requestId: "r2", userId: "alice", role: "CODER" });
    expect(stillParked.outcome).toBe("QUEUED_FOR_CAPACITY");

    authority.observe({
      kind: "catalog",
      providerId: shared.providerId,
      modelId: shared.modelId,
      observedAt: new Date(c.now()).toISOString(),
      source: "catalog_refresh",
      fact: "present",
    });
    const reentered = fabric.decide({ requestId: "r3", userId: "alice", role: "CODER" });
    expect(reentered.outcome).toBe("ADMITTED");
    expect(reentered.selected?.routeId).toBe("churned");
  });
});

describe("R48 — per-role verdict floor inside fabric admission", () => {
  it("routeAdmission excludes a route measured-failed for THIS role even when its coarse product role qualifies", () => {
    const c = clock();
    // SUBAGENT covers TOOL_AGENT and EXPLORER alike in the supply plan — a route that
    // qualified TOOL_AGENT but measured-failed EXPLORER must not admit for an EXPLORER turn.
    const failedExplorer = managedRoute("failed-explorer", { roles: ["SUBAGENT"], qualityScore: 95 });
    const fabric = createFreeFabric({
      managedRoutes: () => [failedExplorer],
      managedPools: () => [poolFor(failedExplorer)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    const decide = () => fabric.decide({
      requestId: "r1", userId: "alice", role: "SUBAGENT",
      routeAdmission: (providerId, modelId) => !(providerId === failedExplorer.providerId && modelId === failedExplorer.modelId),
    });
    const denied = decide();
    expect(denied.outcome).toBe("DENIED_NO_SUPPLY");
    // A role-disqualified fleet fails closed — it must never read as a capacity wait.
    expect(denied.explanation.reasonCodes).toContain("NO_ROLE_QUALIFIED_ROUTE");
    const report = denied.explanation.candidates.find((r) => r.routeId === "failed-explorer");
    expect(report?.status).toBe("ROLE_INELIGIBLE");
    expect(report?.reasonCodes).toContain("ROLE_VERDICT_EXCLUDED");
  });

  it("admission narrows to the surviving candidate — the measured-failed sibling cannot win the reservation", () => {
    const c = clock();
    const toolQualified = managedRoute("tool-qualified", { roles: ["SUBAGENT"], qualityScore: 95 });
    const explorerQualified = managedRoute("explorer-qualified", { providerId: "managed-b", gateway: "managed-b", roles: ["SUBAGENT"], qualityScore: 40 });
    const fabric = createFreeFabric({
      managedRoutes: () => [toolQualified, explorerQualified],
      managedPools: () => [poolFor(toolQualified), poolFor(explorerQualified)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    const decision = fabric.decide({
      requestId: "r1", userId: "alice", role: "SUBAGENT",
      routeAdmission: (providerId) => providerId !== "managed-a",
    });
    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.routeId).toBe("explorer-qualified");
    const report = decision.explanation.candidates.find((r) => r.routeId === "tool-qualified");
    expect(report?.status).toBe("ROLE_INELIGIBLE");
    expect(report?.reasonCodes).toContain("ROLE_VERDICT_EXCLUDED");
  });

  it("an unmeasured route never outranks a measured-QUALIFIED peer for the same role on score alone", () => {
    const c = clock();
    const measuredQualified = managedRoute("measured-qualified", { roles: ["SUBAGENT"], qualityScore: 40 });
    const untested = managedRoute("untested", { providerId: "managed-b", gateway: "managed-b", roles: ["SUBAGENT"], qualityScore: 95 });
    const fabric = createFreeFabric({
      managedRoutes: () => [untested, measuredQualified],
      managedPools: () => [poolFor(untested), poolFor(measuredQualified)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    const decision = fabric.decide({
      requestId: "r1", userId: "alice", role: "SUBAGENT",
      roleQualificationTierFor: (_providerId, modelId) => modelId === "measured-qualified-model" ? "QUALIFIED" : "NOT_TESTED",
    });
    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.routeId).toBe("measured-qualified");
  });

  it("measured PROBATION outranks unmeasured supply when the tier callback is present", () => {
    const c = clock();
    const probation = managedRoute("probation", { roles: ["SUBAGENT"], qualityScore: 40 });
    const untested = managedRoute("untested", { providerId: "managed-b", gateway: "managed-b", roles: ["SUBAGENT"], qualityScore: 95 });
    const fabric = createFreeFabric({
      managedRoutes: () => [untested, probation],
      managedPools: () => [poolFor(untested), poolFor(probation)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    const decision = fabric.decide({
      requestId: "r1", userId: "alice", role: "SUBAGENT",
      roleQualificationTierFor: (_providerId, modelId) => modelId === "probation-model" ? "PROBATION" : "NOT_TESTED",
    });
    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.routeId).toBe("probation");
  });

  it("an absent tier callback preserves the legacy coarse probation-fallback ordering", () => {
    const c = clock();
    const qualified = managedRoute("qualified", { roles: ["SUBAGENT"], qualityScore: 50 });
    const probation = managedRoute("probation", { roles: [], fallbackRoles: ["SUBAGENT"], qualityScore: 95 });
    const fabric = createFreeFabric({
      managedRoutes: () => [probation, qualified],
      managedPools: () => [poolFor(probation), poolFor(qualified)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    const decision = fabric.decide({ requestId: "r1", userId: "alice", role: "SUBAGENT" });
    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.routeId).toBe("qualified");
  });
});

describe("FreeFabric — R59 health-recovery visibility", () => {
  it("a route hard-excluded on a transient 429 reports retryAt and the queue verdict carries the earliest recovery", () => {
    const c = clock();
    const shared = managedRoute("shared");
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    authority.observe({
      kind: "call_failure",
      providerId: shared.providerId,
      modelId: shared.modelId,
      observedAt: new Date(c.now()).toISOString(),
      source: "runtime",
      reason: "RATE_LIMITED",
      status: 429,
      retryAfterMs: 45_000,
      message: "rate limited",
    });
    const fabric = createFreeFabric({
      managedRoutes: () => [shared],
      managedPools: () => [poolFor(shared)],
      health: authority,
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    const decision = fabric.decide({ requestId: "r1", userId: "alice", role: "CODER" });
    // Health-only blocking is a wait state, not a supply absence — the verdict carries the
    // provider-stated instant the exclusion expires instead of reading as zero capacity.
    expect(decision.outcome).toBe("QUEUED_FOR_CAPACITY");
    expect(decision.explanation.reasonCodes).toContain("ALL_ELIGIBLE_ROUTES_UNHEALTHY");
    const report = decision.explanation.candidates.find((r) => r.routeId === "shared");
    expect(report?.status).toBe("HEALTH_EXCLUDED");
    expect(report?.healthState).toBe("RATE_LIMITED");
    const expected = new Date(c.now() + 45_000).toISOString();
    expect(report?.retryAt).toBe(expected);
    expect(decision.nextAvailableAt).toBe(expected);
  });

  it("a permanent health exclusion carries no retryAt and no fabricated wait horizon", () => {
    const c = clock();
    const shared = managedRoute("shared");
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
      managedPools: () => [poolFor(shared)],
      health: authority,
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    const decision = fabric.decide({ requestId: "r1", userId: "alice", role: "CODER" });
    const report = decision.explanation.candidates.find((r) => r.routeId === "shared");
    expect(report?.status).toBe("HEALTH_EXCLUDED");
    expect(report?.healthState).toBe("MODEL_RETIRED");
    expect(report?.retryAt).toBeUndefined();
    // A permanent exclusion must not invent a recovery time — QUEUED-for-health with no
    // nextAvailableAt is still honest waiting, but the verdict can never claim a reset it
    // does not have.
    expect(decision.nextAvailableAt).toBeUndefined();
  });

  it("the same fleet admits once the authority's rate-limit condition expires — no restart needed", () => {
    const c = clock();
    const shared = managedRoute("shared");
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    authority.observe({
      kind: "call_failure",
      providerId: shared.providerId,
      modelId: shared.modelId,
      observedAt: new Date(c.now()).toISOString(),
      source: "runtime",
      reason: "RATE_LIMITED",
      status: 429,
      retryAfterMs: 30_000,
      message: "rate limited",
    });
    const fabric = createFreeFabric({
      managedRoutes: () => [shared],
      managedPools: () => [poolFor(shared)],
      health: authority,
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    expect(fabric.decide({ requestId: "r1", userId: "alice", role: "CODER" }).outcome).toBe("QUEUED_FOR_CAPACITY");
    c.advance(31_000);
    const recovered = fabric.decide({ requestId: "r2", userId: "alice", role: "CODER" });
    expect(recovered.outcome).toBe("ADMITTED");
    expect(recovered.selected?.routeId).toBe("shared");
  });

  it("a policy-excluded route names the upstream admission gate behind the coarse UNHEALTHY code", () => {
    const c = clock();
    // CapacityRoute.healthy is the full ForgeAuto admission verdict; a route that fails on the
    // qualification gate is "untested supply", not sick supply — the ledger row must say so.
    const untested = managedRoute("untested", { healthy: false, healthGate: "CODEFORGE_QUALIFIED", healthReason: "NOT_TESTED" });
    const fabric = createFreeFabric({
      managedRoutes: () => [untested],
      managedPools: () => [poolFor(untested)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    const decision = fabric.decide({ requestId: "r1", userId: "alice", role: "CODER" });
    expect(decision.outcome).toBe("DENIED_NO_SUPPLY");
    const report = decision.explanation.candidates.find((r) => r.routeId === "untested");
    expect(report?.status).toBe("POLICY_EXCLUDED");
    expect(report?.reasonCodes).toContain("UNHEALTHY");
    expect(report?.reasonCodes).toContain("CODEFORGE_QUALIFIED");
  });
});
