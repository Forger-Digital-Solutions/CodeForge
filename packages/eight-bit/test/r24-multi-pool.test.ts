import { describe, expect, it } from "vitest";
import { CapacityReservationLedger, DEFAULT_FREE_CAPACITY_POLICY, type CapacityRoute, type CapacityWindow, type ProviderCapacityPool } from "@codeforge/forge-zero";
import { createFreeFabric, type FreeFabric } from "../src/free-fabric.js";
import { DEFAULT_ROUTE_HEALTH_POLICY, EightBitRouteHealthAuthority } from "../src/route-health-authority.js";

/**
 * R24 Phase 11 — multi-pool scenario matrix. The single-decide semantics are already proven
 * (free-fabric.test.ts); these scenarios prove the properties that only emerge when several
 * pools and several users interact at once:
 *
 *   - conservation order shared → sponsored → user entitlement across a real exhaustion chain
 *   - owner-development and unauthorized supply classes never reach a user request
 *   - shared-pool windows are global across users (contention, not per-user copies)
 *   - the per-user concurrency cap is per-user — one capped user never starves another
 *   - two routes backed by one provider account contend for the same budget
 *   - user entitlements stay isolated while contention pressure is on
 *   - the data-policy boundary binds alongside capacity, not instead of it
 */

const NOW = Date.parse("2026-10-06T00:00:00.000Z");
const OBSERVED_AT = "2026-10-05T23:00:00.000Z";
const RESET = "2026-10-07T00:00:00.000Z";

function clock(start = NOW) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

function quotaWindow(overrides: Partial<CapacityWindow> = {}): CapacityWindow {
  return { unit: "requests", limit: 1000, remaining: 900, resetAt: RESET, scope: "ORG", observedAt: OBSERVED_AT, authoritative: true, period: "DAILY_RESET", ...overrides };
}

function route(id: string, overrides: Partial<CapacityRoute> = {}): CapacityRoute {
  return {
    routeId: id,
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
    roles: ["CODER"],
    qualityScore: 70,
    healthy: true,
    enabled: true,
    windows: [quotaWindow(), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 1_500_000 }), quotaWindow({ unit: "concurrency", limit: 8, remaining: 8 })],
    ...overrides,
  };
}

function userRoute(identity: string, overrides: Partial<CapacityRoute> = {}): CapacityRoute {
  return {
    ...route(`user-${identity}`, {
      providerId: "ollama-cloud",
      modelId: "gemma4",
      canonicalModelId: "gemma4",
      gateway: "ollama-cloud",
      supplyClass: "USER_CONNECTED_FREE",
      capacityPoolId: `ollama-cloud:user:${identity}`,
      capacityPoolScope: "PER_USER_POOL",
      capacityScope: "USER_ACCOUNT",
      explicitZeroPrice: false,
      freeOnlyAdmissionProven: true,
      windows: [quotaWindow({ unit: "credits", scope: "USER_ACCOUNT", limit: 5, remaining: 5, period: "MONTHLY_RESET", resetAt: "2026-11-01T00:00:00.000Z" })],
      capacityIdentity: identity,
    }),
    ...overrides,
  };
}

function poolFor(r: CapacityRoute, overrides: Partial<ProviderCapacityPool> = {}): ProviderCapacityPool {
  return { poolId: r.capacityPoolId, providerId: r.providerId, scope: r.capacityPoolScope, supplyClass: r.supplyClass, windows: r.windows, observedAt: OBSERVED_AT, authoritative: true, capacityIdentity: r.capacityIdentity, ...overrides };
}

function fabricWith(
  routes: CapacityRoute[],
  opts: {
    userSources?: Array<{ routesForUser: (userId: string) => readonly CapacityRoute[]; poolsForUser: (userId: string) => readonly ProviderCapacityPool[] }>;
    policy?: typeof DEFAULT_FREE_CAPACITY_POLICY;
    reservations?: CapacityReservationLedger;
    now?: () => number;
  } = {},
): { fabric: FreeFabric; reservations: CapacityReservationLedger } {
  const now = opts.now ?? (() => NOW);
  const reservations = opts.reservations ?? new CapacityReservationLedger({ routes: [], now, policy: opts.policy, maxActiveReservationsPerUser: 8 });
  const fabric = createFreeFabric({
    managedRoutes: () => routes.filter((r) => r.capacityPoolScope === "SHARED_OWNER_POOL"),
    managedPools: () => routes.filter((r) => r.capacityPoolScope === "SHARED_OWNER_POOL").map((r) => poolFor(r)),
    userSources: opts.userSources,
    health: new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, now),
    reservations,
    policy: opts.policy,
    now,
  });
  return { fabric, reservations };
}

describe("R24 multi-pool — conservation order across all three supply domains", () => {
  it("shared exhausts → sponsored serves → sponsored exhausts → only then the user's own quota", () => {
    const c = clock();
    const shared = route("shared", { windows: [quotaWindow({ remaining: 0 }), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 1_500_000 })] });
    const sponsored = route("sponsor", { supplyClass: "SPONSORED_FREE", capacityScope: "SPONSORED" });
    const alice = userRoute("alicehash");
    const policy = { ...DEFAULT_FREE_CAPACITY_POLICY, allowSponsoredFree: true };
    const { fabric } = fabricWith([shared, sponsored], {
      policy,
      userSources: [{ routesForUser: () => [alice], poolsForUser: () => [poolFor(alice)] }],
      now: c.now,
    });

    const first = fabric.decide({ requestId: "d1", userId: "alice", userIdentities: ["alicehash"], role: "CODER" });
    expect(first.outcome).toBe("ADMITTED");
    expect(first.selected?.routeId).toBe("sponsor");
    expect(first.selected?.quotaOwner).toBe("SPONSORED");
    // The user's own pool was eligible but conserved — sponsored ranks before entitlement.
    const aliceReport = first.explanation.candidates.find((x) => x.routeId === alice.routeId);
    expect(aliceReport?.status).toBe("STANDBY");
    fabric.release("d1");

    // Sponsored supply now exhausted too: the same user falls through to her own entitlement.
    const exhaustedSponsor = { ...sponsored, windows: [quotaWindow({ remaining: 0 }), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 1_500_000 })] };
    const { fabric: fabric2 } = fabricWith([shared, exhaustedSponsor], {
      policy,
      userSources: [{ routesForUser: () => [alice], poolsForUser: () => [poolFor(alice)] }],
      now: c.now,
    });
    const second = fabric2.decide({ requestId: "d2", userId: "alice", userIdentities: ["alicehash"], role: "CODER" });
    expect(second.outcome).toBe("ADMITTED");
    expect(second.selected?.quotaOwner).toBe("USER_ENTITLEMENT");
  });

  it("sponsored supply is policy-gated: disabled by default, it reports excluded rather than served", () => {
    const c = clock();
    const sponsored = route("sponsor", { supplyClass: "SPONSORED_FREE", capacityScope: "SPONSORED" });
    const { fabric } = fabricWith([sponsored], { now: c.now });
    const decision = fabric.decide({ requestId: "d1", userId: "alice", role: "CODER" });
    expect(decision.outcome).toBe("DENIED_NO_SUPPLY");
    const report = decision.explanation.candidates.find((x) => x.routeId === "sponsor");
    expect(report?.status).toBe("POLICY_EXCLUDED");
    expect(report?.reasonCodes).toContain("SPONSORED_FREE_NOT_AUTHORIZED");
  });

  it("owner-development supply never reaches a user request — even as the only route", () => {
    const c = clock();
    const dev = route("ownerdev", { supplyClass: "OWNER_DEV_FREE" });
    const { fabric } = fabricWith([dev], { now: c.now });
    const decision = fabric.decide({ requestId: "d1", userId: "alice", role: "CODER" });
    expect(decision.outcome).toBe("DENIED_NO_SUPPLY");
    const report = decision.explanation.candidates.find((x) => x.routeId === "ownerdev");
    expect(report?.status).toBe("POLICY_EXCLUDED");
    expect(report?.reasonCodes).toContain("OWNER_DEV_FREE_NOT_PRODUCT_FREE");
  });
});

describe("R24 multi-pool — shared-pool fairness under multi-user contention", () => {
  it("a shared concurrency window is global: two users fill it, a third queues, a release admits them", () => {
    const c = clock();
    const tight = route("shared", {
      windows: [quotaWindow(), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 1_500_000 }), quotaWindow({ unit: "concurrency", limit: 2, remaining: 2 })],
    });
    const { fabric, reservations } = fabricWith([tight], { now: c.now });

    expect(fabric.decide({ requestId: "a1", userId: "alice", role: "CODER" }).outcome).toBe("ADMITTED");
    expect(fabric.decide({ requestId: "b1", userId: "bob", role: "CODER" }).outcome).toBe("ADMITTED");

    const carol = fabric.decide({ requestId: "c1", userId: "carol", role: "CODER" });
    expect(carol.outcome).toBe("QUEUED_FOR_CAPACITY");
    expect(carol.explanation.reasonCodes).toContain("CAPACITY_EXHAUSTED");
    expect(reservations.snapshot().activeReservations).toBe(2);

    // A release anywhere in the pool frees capacity for whoever asks next — the window
    // belongs to the pool, not to a user.
    fabric.release("a1");
    const retry = fabric.decide({ requestId: "c1", userId: "carol", role: "CODER" });
    expect(retry.outcome).toBe("ADMITTED");
    expect(reservations.snapshot().byUser["carol"]).toBe(1);
  });

  it("the per-user concurrency cap limits that user only — another user still admits on the same pool", () => {
    const c = clock();
    const shared = route("shared");
    const reservations = new CapacityReservationLedger({ routes: [], now: c.now, maxActiveReservationsPerUser: 1 });
    const { fabric } = fabricWith([shared], { reservations, now: c.now });

    expect(fabric.decide({ requestId: "a1", userId: "alice", role: "CODER" }).outcome).toBe("ADMITTED");
    const aliceSecond = fabric.decide({ requestId: "a2", userId: "alice", role: "CODER" });
    expect(aliceSecond.outcome).toBe("QUEUED_FOR_CAPACITY");
    expect(aliceSecond.explanation.reasonCodes).toContain("USER_CONCURRENCY_LIMIT");

    // Alice's cap consumed no pool capacity: bob admits on the same window.
    const bob = fabric.decide({ requestId: "b1", userId: "bob", role: "CODER" });
    expect(bob.outcome).toBe("ADMITTED");
    expect(bob.selected?.routeId).toBe("shared");
  });

  it("the shared request budget depletes across users — the third requester queues until reset", () => {
    const c = clock();
    const thin = route("shared", {
      windows: [quotaWindow({ remaining: 10 }), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 1_500_000 })],
    });
    const { fabric } = fabricWith([thin], { now: c.now });
    const demand = { requests: 4, inputTokens: 1_000, outputTokens: 500 };

    expect(fabric.decide({ requestId: "a1", userId: "alice", role: "CODER", demand }).outcome).toBe("ADMITTED");
    expect(fabric.decide({ requestId: "b1", userId: "bob", role: "CODER", demand }).outcome).toBe("ADMITTED");

    const carol = fabric.decide({ requestId: "c1", userId: "carol", role: "CODER", demand });
    expect(carol.outcome).toBe("QUEUED_FOR_CAPACITY");
    expect(carol.explanation.reasonCodes).toContain("CAPACITY_EXHAUSTED");
    // The wait is honest: the window can hold the demand (4 ≤ 10 remaining) — the shortage
    // is the 8 live holds, so the horizon is when those leases free (the default 10-minute
    // lease), which arrives well before the window's own reset.
    expect(carol.nextAvailableAt).toBe("2026-10-06T00:10:00.000Z");
  });

  it("two routes backed by one provider account contend for the same reservation budget", () => {
    const c = clock();
    const sharedPool = "acct-1-pool";
    const sharedWindows = [quotaWindow(), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 1_500_000 }), quotaWindow({ unit: "concurrency", limit: 1, remaining: 1 })];
    // Two model routes on ONE provider account — same providerId, same backing pool.
    const modelA = route("modela", { providerId: "sharedacct", capacityPoolId: sharedPool, windows: sharedWindows });
    const modelB = route("modelb", { providerId: "sharedacct", capacityPoolId: sharedPool, windows: sharedWindows });
    const reservations = new CapacityReservationLedger({ routes: [], now: c.now, maxActiveReservationsPerUser: 8 });
    const fabric = createFreeFabric({
      managedRoutes: () => [modelA, modelB],
      // One physical pool object behind both routes — the account's real budget.
      managedPools: () => [{ poolId: sharedPool, providerId: "sharedacct", scope: "SHARED_OWNER_POOL", supplyClass: "PURE_MANAGED_FREE", windows: sharedWindows, observedAt: OBSERVED_AT, authoritative: true }],
      health: new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now),
      reservations,
      now: c.now,
    });

    const first = fabric.decide({ requestId: "a1", userId: "alice", role: "CODER" });
    expect(first.outcome).toBe("ADMITTED");
    // The second request — even from another user on the sibling route — sees one budget.
    const second = fabric.decide({ requestId: "b1", userId: "bob", role: "CODER" });
    expect(second.outcome).toBe("QUEUED_FOR_CAPACITY");
    expect(reservations.snapshot().byPool[sharedPool]).toBe(1);
  });
});

describe("R24 multi-pool — user-owned isolation holds under contention", () => {
  it("shared pressure pushes the owner to her pool while the identity-less user queues — never into hers", () => {
    const c = clock();
    const exhaustedShared = route("shared", { windows: [quotaWindow({ remaining: 0 }), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 1_500_000 })] });
    const alice = userRoute("alicehash");
    const { fabric } = fabricWith([exhaustedShared], {
      // A leaky source returns alice's route for every query — the ownership check inside
      // the supply plan is the boundary, not the source's honesty.
      userSources: [{ routesForUser: () => [alice], poolsForUser: () => [poolFor(alice)] }],
      now: c.now,
    });

    const aliceDecision = fabric.decide({ requestId: "a1", userId: "alice", userIdentities: ["alicehash"], role: "CODER" });
    expect(aliceDecision.outcome).toBe("ADMITTED");
    expect(aliceDecision.selected?.quotaOwner).toBe("USER_ENTITLEMENT");

    const bob = fabric.decide({ requestId: "b1", userId: "bob", userIdentities: [], role: "CODER" });
    expect(bob.outcome).toBe("QUEUED_FOR_CAPACITY");
    expect(bob.selected).toBeUndefined();
    // Alice's route was visible as a candidate but unreachable — reported, not silently used.
    const aliceReport = bob.explanation.candidates.find((x) => x.routeId === alice.routeId);
    expect(aliceReport?.status).toBe("NOT_USER_OWNED");
  });

  it("owning an identity is required: the same request without userIdentities cannot touch the pool", () => {
    const c = clock();
    const alice = userRoute("alicehash");
    const { fabric } = fabricWith([], {
      userSources: [{ routesForUser: () => [alice], poolsForUser: () => [poolFor(alice)] }],
      now: c.now,
    });
    // The source returns alice's route for alice — but without her identity claim the
    // supply plan treats it as someone else's entitlement.
    const decision = fabric.decide({ requestId: "a1", userId: "alice", role: "CODER" });
    expect(decision.outcome).toBe("DENIED_NO_SUPPLY");
    expect(decision.explanation.candidates.find((x) => x.routeId === alice.routeId)?.status).toBe("NOT_USER_OWNED");
  });
});

describe("R24 multi-pool — policy boundaries bind alongside capacity", () => {
  it("a PUBLIC_CODE_ONLY route cannot take PRIVATE_CODE work, but serves PUBLIC_CODE work", () => {
    const c = clock();
    const publicOnly = route("pub", { dataPolicyProfile: "PUBLIC_CODE_ONLY" });
    const { fabric } = fabricWith([publicOnly], { now: c.now });

    const priv = fabric.decide({ requestId: "p1", userId: "alice", role: "CODER" });
    expect(priv.outcome).toBe("DENIED_NO_SUPPLY");
    expect(priv.explanation.candidates[0]?.reasonCodes).toContain("DATA_POLICY_PUBLIC_CODE_ONLY");

    const pub = fabric.decide({ requestId: "p2", userId: "alice", role: "CODER", dataContext: { dataClass: "PUBLIC_CODE" } });
    expect(pub.outcome).toBe("ADMITTED");
    expect(pub.selected?.routeId).toBe("pub");
  });

  it("deposit-unlocked supply is opt-in: gated by default, admitted when policy authorizes it", () => {
    const c = clock();
    const deposit = route("dep", { supplyClass: "DEPOSIT_UNLOCKED_FREE" });
    const { fabric: closed } = fabricWith([deposit], { now: c.now });
    const denied = closed.decide({ requestId: "x1", userId: "alice", role: "CODER" });
    expect(denied.outcome).toBe("DENIED_NO_SUPPLY");
    expect(denied.explanation.candidates[0]?.reasonCodes).toContain("DEPOSIT_UNLOCKED_FREE_NOT_AUTHORIZED");

    const policy = { ...DEFAULT_FREE_CAPACITY_POLICY, allowDepositUnlockedFree: true };
    const { fabric: open } = fabricWith([deposit], { policy, now: c.now });
    const admitted = open.decide({ requestId: "x2", userId: "alice", role: "CODER" });
    expect(admitted.outcome).toBe("ADMITTED");
    expect(admitted.selected?.quotaOwner).toBe("SHARED_CODEFORGE_POOL");
  });
});

describe("FreeFabric — independent reviewer quota pools", () => {
  function reviewerFabric(routes: CapacityRoute[], pools: ProviderCapacityPool[]): FreeFabric {
    return createFreeFabric({
      managedRoutes: () => routes,
      managedPools: () => pools,
      reservations: new CapacityReservationLedger({ routes: [], now: () => NOW, maxActiveReservationsPerUser: 8 }),
      now: () => NOW,
    });
  }

  it("prefers an independent pool when its Reviewer quality is comparable", () => {
    const implementation = route("implementation", { providerId: "provider-a", capacityPoolId: "account-a", roles: ["REVIEWER"], qualityScore: 95 });
    const sibling = route("sibling", { providerId: "provider-a", capacityPoolId: "account-a", roles: ["REVIEWER"], qualityScore: 90 });
    const independent = route("independent", { providerId: "provider-b", capacityPoolId: "account-b", roles: ["REVIEWER"], qualityScore: 90 });
    const fabric = reviewerFabric([implementation, sibling, independent], [poolFor(implementation), poolFor(independent)]);

    const decision = fabric.decide({ requestId: "review-1", userId: "alice", role: "REVIEWER", preferIndependentFromPoolId: "account-a" });
    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.routeId).toBe("independent");
    expect(decision.explanation.reasonCodes).toContain("INDEPENDENT_POOL_PREFERRED");
    expect(decision.explanation.candidates.find((candidate) => candidate.routeId === "sibling")?.status).toBe("STANDBY");
  });

  it("keeps a much stronger same-pool Reviewer ahead of a weak independent candidate", () => {
    const samePool = route("same-pool", { providerId: "provider-a", capacityPoolId: "account-a", roles: ["REVIEWER"], qualityScore: 95 });
    const weakIndependent = route("weak-independent", { providerId: "provider-b", capacityPoolId: "account-b", roles: ["REVIEWER"], qualityScore: 50 });
    const fabric = reviewerFabric([samePool, weakIndependent], [poolFor(samePool), poolFor(weakIndependent)]);
    const decision = fabric.decide({ requestId: "review-quality", userId: "alice", role: "REVIEWER", preferIndependentFromPoolId: "account-a" });
    expect(decision.selected?.routeId).toBe("same-pool");
    expect(decision.explanation.reasonCodes).toContain("SAME_POOL_FALLBACK");
  });

  it("never lets independent probation displace a qualified Reviewer", () => {
    const qualified = route("qualified", { providerId: "provider-a", capacityPoolId: "account-a", roles: ["REVIEWER"], qualityScore: 70 });
    const probation = route("probation", { providerId: "provider-b", capacityPoolId: "account-b", roles: ["REVIEWER"], qualityScore: 99 });
    const fabric = reviewerFabric([qualified, probation], [poolFor(qualified), poolFor(probation)]);
    const decision = fabric.decide({ requestId: "review-tier", userId: "alice", role: "REVIEWER", preferIndependentFromPoolId: "account-a", roleQualificationTierFor: (providerId) => providerId === "provider-a" ? "QUALIFIED" : "PROBATION" });
    expect(decision.selected?.routeId).toBe("qualified");
  });

  it("tries every independent pool before falling back to the implementation pool", () => {
    const implementation = route("implementation", { providerId: "provider-a", capacityPoolId: "account-a", roles: ["REVIEWER"], qualityScore: 95 });
    const exhausted = route("exhausted", { providerId: "provider-b", capacityPoolId: "account-b", roles: ["REVIEWER"], qualityScore: 94, windows: [quotaWindow({ remaining: 0 })] });
    const available = route("available", { providerId: "provider-c", capacityPoolId: "account-c", roles: ["REVIEWER"], qualityScore: 90 });
    const fabric = reviewerFabric([implementation, exhausted, available], [poolFor(implementation), poolFor(exhausted), poolFor(available)]);

    const decision = fabric.decide({ requestId: "review-2", userId: "alice", role: "REVIEWER", preferIndependentFromPoolId: "account-a" });
    expect(decision.selected?.routeId).toBe("available");
    expect(decision.explanation.candidates.find((candidate) => candidate.routeId === "exhausted")?.status).toBe("CAPACITY_DENIED");
    expect(decision.explanation.candidates.find((candidate) => candidate.routeId === "implementation")?.status).toBe("STANDBY");
  });

  it("admits the same pool deterministically after independent capacity is denied", () => {
    const implementation = route("implementation", { providerId: "provider-a", capacityPoolId: "account-a", roles: ["REVIEWER"], qualityScore: 90 });
    const sibling = route("sibling", { providerId: "provider-a", capacityPoolId: "account-a", roles: ["REVIEWER"], qualityScore: 90 });
    const exhausted = route("exhausted", { providerId: "provider-b", capacityPoolId: "account-b", roles: ["REVIEWER"], qualityScore: 95, windows: [quotaWindow({ remaining: 0 })] });
    const fabric = reviewerFabric([sibling, exhausted, implementation], [poolFor(implementation), poolFor(exhausted)]);

    const decision = fabric.decide({ requestId: "review-3", userId: "alice", role: "REVIEWER", preferIndependentFromPoolId: "account-a" });
    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.routeId).toBe("implementation");
    expect(decision.explanation.reasonCodes).toContain("SAME_POOL_FALLBACK");
    expect(decision.explanation.candidates.find((candidate) => candidate.routeId === "exhausted")?.status).toBe("CAPACITY_DENIED");
  });
});
