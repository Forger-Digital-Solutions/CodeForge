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

describe("FreeFabric — R34 measured demand (Mission E)", () => {
  /** Groq's measured per-model pool shape: 1k req + 8k TPM — the pool a flat 16k demand
   *  could never use. */
  function narrowPoolRoute(id: string): CapacityRoute {
    return managedRoute(id, {
      windows: [quotaWindow(), quotaWindow({ unit: "input_tokens", limit: 8_000, remaining: 8_000 })],
    });
  }

  it("a small measured turn admits an 8k-TPM pool a flat 16k demand would deny", () => {
    const c = clock();
    const groqLike = narrowPoolRoute("groq-small");
    const fabric = createFreeFabric({
      managedRoutes: () => [groqLike],
      managedPools: () => [poolFor(groqLike)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    const flat = fabric.decide({ requestId: "r1", userId: "alice", role: "CODER", demand: { requests: 1, inputTokens: 16_000 } });
    expect(flat.outcome).toBe("QUEUED_FOR_CAPACITY");
    // The measured trivial-turn request (~3k serialized) at the unlearned 1.5 floor × 1.15
    // reserves ~5.2k — inside the 8k pool the flat ceiling could never touch.
    const measured = fabric.decide({ requestId: "r2", userId: "alice", role: "CODER", demand: { requests: 1, estimatedPromptTokens: 3_000, outputTokens: 2_048 } });
    expect(measured.outcome).toBe("ADMITTED");
    expect(measured.selected?.routeId).toBe("groq-small");
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
    // 5k measured × 1.8 learned × 1.15 = 10 350 > 8 000: the same prompt that fits a sparse
    // provider is honestly too big for this pool once its dense tokenizer is known.
    const decision = fabric.decide({ requestId: "r1", userId: "alice", role: "CODER", demand: { requests: 1, estimatedPromptTokens: 5_000 } });
    expect(decision.outcome).toBe("QUEUED_FOR_CAPACITY");
  });

  it("reserves exactly estimate × ratio × margin — boundary admits at the computed value, denies one under", () => {
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
    const short = managedRoute("short", {
      windows: [quotaWindow(), quotaWindow({ unit: "input_tokens", limit: 5_174, remaining: 5_174 })],
    });
    const fabric2 = createFreeFabric({
      managedRoutes: () => [short],
      managedPools: () => [poolFor(short)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    expect(fabric2.decide({ requestId: "r1", userId: "alice", role: "CODER", demand: { requests: 1, estimatedPromptTokens: 3_000 } }).outcome).toBe("QUEUED_FOR_CAPACITY");
  });

  it("never under-reserves when the learned ratio is known — demand ≥ estimate × ratio", () => {
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
    expect(fabric.decide({ requestId: "r1", userId: "alice", role: "CODER", demand: { requests: 1, estimatedPromptTokens: 3_000 } }).outcome).toBe("QUEUED_FOR_CAPACITY");
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

  it("a genuinely large grown-context turn still fails closed against a small pool", () => {
    const c = clock();
    const groqLike = narrowPoolRoute("groq-small");
    const fabric = createFreeFabric({
      managedRoutes: () => [groqLike],
      managedPools: () => [poolFor(groqLike)],
      reservations: new CapacityReservationLedger({ routes: [], now: c.now }),
      now: c.now,
    });
    // A mid-turn continuation measuring 20k serialized tokens honestly cannot fit an 8k
    // TPM pool — measurement must tighten admission, not loosen it.
    const decision = fabric.decide({ requestId: "r1", userId: "alice", role: "CODER", demand: { requests: 1, estimatedPromptTokens: 20_000 } });
    expect(decision.outcome).toBe("QUEUED_FOR_CAPACITY");
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
  });
});
