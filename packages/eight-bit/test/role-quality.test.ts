import { describe, expect, it } from "vitest";
import {
  ForgeZero,
  CapacityReservationLedger,
  type CapacityRoute,
  type CapacityWindow,
  type ProviderCapacityPool,
} from "@codeforge/forge-zero";
import { EightBitHealthTracker } from "../src/health.js";
import { EightBitReliabilityTracker } from "../src/reliability.js";
import { EightBitRouter, type BindingScope, type SelectRouteOptions } from "../src/router.js";
import { createFreeFabric } from "../src/free-fabric.js";
import { roleQualityAdvice } from "../src/role-quality.js";
import type { ModelQualificationReceipt, RoleQualificationResult, TestCaseResult } from "../src/qualification/types.js";
import type { EightBitRole } from "../src/types.js";
import { makeModel } from "./fixtures.js";

/**
 * R41: persisted role-qualification evidence becomes a bounded advisory ranking input.
 * The advice function is the frozen scoring authority — these tests pin only the wiring
 * contract: fresher qualified evidence separates equally eligible peers, stale or
 * transient-only evidence contributes zero plus a requalification signal, and an
 * adjustment can never create eligibility or cross a supply domain.
 */

const NOW_MS = Date.parse("2026-10-01T00:00:00.000Z");
const FRESH_AT = new Date(NOW_MS - 60_000).toISOString();

let caseSeq = 0;
function tcase(passed: boolean, overrides: Partial<TestCaseResult> = {}): TestCaseResult {
  caseSeq += 1;
  return { caseId: `case-${caseSeq}`, category: "reasoning", passed, hardFailure: false, latencyMs: 50, retries: 0, ...overrides };
}

function roleResult(
  role: EightBitRole,
  status: RoleQualificationResult["status"],
  cases: TestCaseResult[],
  completedAt = FRESH_AT,
): RoleQualificationResult {
  return {
    role,
    status,
    testCases: cases,
    hardFailures: cases.filter((c) => c.hardFailure).map((c) => c.caseId),
    startedAt: completedAt,
    completedAt,
  };
}

function receipt(
  providerId: string,
  modelId: string,
  roleResults: Record<string, RoleQualificationResult>,
): ModelQualificationReceipt {
  return {
    suiteVersion: "R10_FREE_QUALIFICATION_V1",
    providerId,
    modelId,
    modelDisplayName: modelId,
    accessClass: "FREE_ROUTED",
    freeStatus: "verified_free",
    roleResults,
    startedAt: FRESH_AT,
    completedAt: FRESH_AT,
    totalLatencyMs: 1_000,
    qualificationState: "QUALIFIED",
    hardFailureRoles: [],
  };
}

function qualityHook(receipts: Map<string, ModelQualificationReceipt>, role: EightBitRole) {
  return (providerId: string, modelId: string) => {
    const advice = roleQualityAdvice(receipts.get(`${providerId}::${modelId}`), role, NOW_MS);
    return { scoreAdjustment: advice.scoreAdjustment, reasonCodes: advice.reasonCodes };
  };
}

describe("roleQualityAdvice — bounded advisory evidence", () => {
  it("a fresh fully-qualified multi-case receipt earns a bounded positive adjustment", () => {
    const advice = roleQualityAdvice(receipt("p", "m", {
      REVIEWER: roleResult("REVIEWER", "QUALIFIED", [tcase(true), tcase(true), tcase(true), tcase(true)], new Date(NOW_MS).toISOString()),
    }), "REVIEWER", NOW_MS);
    expect(advice.scoreAdjustment).toBeGreaterThan(0);
    expect(advice.scoreAdjustment).toBeLessThanOrEqual(12);
    expect(advice.needsRequalification).toBe(false);
    expect(advice.reasonCodes).toEqual(["ROLE_QUALIFIED_EVIDENCE"]);
    expect(advice.sampleCount).toBe(4);
    expect(advice.confidence).toBe(1);
  });

  it("an absent receipt and an unmeasured role both contribute zero with a requalification signal", () => {
    const absent = roleQualityAdvice(undefined, "REVIEWER", NOW_MS);
    expect(absent.scoreAdjustment).toBe(0);
    expect(absent.needsRequalification).toBe(true);
    expect(absent.reasonCodes).toEqual(["ROLE_EVIDENCE_ABSENT"]);

    const unmeasured = roleQualityAdvice(receipt("p", "m", {
      CODER: roleResult("CODER", "QUALIFIED", [tcase(true)]),
    }), "REVIEWER", NOW_MS);
    expect(unmeasured.scoreAdjustment).toBe(0);
    expect(unmeasured.needsRequalification).toBe(true);
    expect(unmeasured.reasonCodes).toEqual(["ROLE_NOT_MEASURED"]);
  });

  it("evidence older than 30 days yields zero adjustment and a requalification signal", () => {
    const staleAt = new Date(NOW_MS - 31 * 24 * 60 * 60 * 1000).toISOString();
    const advice = roleQualityAdvice(receipt("p", "m", {
      REVIEWER: roleResult("REVIEWER", "QUALIFIED", [tcase(true), tcase(true), tcase(true), tcase(true)], staleAt),
    }), "REVIEWER", NOW_MS);
    expect(advice.scoreAdjustment).toBe(0);
    expect(advice.needsRequalification).toBe(true);
    expect(advice.reasonCodes).toEqual(["ROLE_EVIDENCE_STALE"]);
  });

  it("transient 429 cases do not count toward the sample; an all-transient verdict is inconclusive", () => {
    const mixed = roleQualityAdvice(receipt("p", "m", {
      REVIEWER: roleResult("REVIEWER", "QUALIFIED", [
        tcase(true), tcase(true),
        tcase(false, { error: "HTTP 429 rate limit exceeded" }),
        tcase(false, { error: "provider returned 429" }),
      ], new Date(NOW_MS).toISOString()),
    }), "REVIEWER", NOW_MS);
    // The transient failures are filtered: a 2-case sample, not a 4-case one — the
    // positive evidence that remains still scores, just at half confidence.
    expect(mixed.sampleCount).toBe(2);
    expect(mixed.confidence).toBe(0.5);
    expect(mixed.scoreAdjustment).toBeGreaterThan(0);
    expect(mixed.scoreAdjustment).toBeLessThanOrEqual(12);

    const allTransient = roleQualityAdvice(receipt("p2", "m2", {
      REVIEWER: roleResult("REVIEWER", "NOT_QUALIFIED", [
        tcase(false, { error: "429 Too Many Requests" }),
        tcase(false, { error: "connection timed out" }),
      ]),
    }), "REVIEWER", NOW_MS);
    expect(allTransient.sampleCount).toBe(0);
    expect(allTransient.scoreAdjustment).toBe(0);
    expect(allTransient.reasonCodes).toEqual(["ROLE_INCONCLUSIVE"]);
    expect(allTransient.needsRequalification).toBe(true);
  });

  it("a hard-failure verdict is a bounded soft demotion", () => {
    const advice = roleQualityAdvice(receipt("p", "m", {
      CODER: roleResult("CODER", "HARD_FAILURE", [tcase(true), tcase(false, { hardFailure: true })]),
    }), "CODER", NOW_MS);
    expect(advice.scoreAdjustment).toBeLessThan(0);
    expect(advice.scoreAdjustment).toBeGreaterThanOrEqual(-12);
    expect(advice.reasonCodes).toEqual(["ROLE_CRITICAL_FAILURE"]);
  });

  it("a probation verdict never promotes — at best it is neutral", () => {
    const advice = roleQualityAdvice(receipt("p", "m", {
      REVIEWER: roleResult("REVIEWER", "PROBATION", [tcase(true), tcase(true), tcase(true), tcase(true)]),
    }), "REVIEWER", NOW_MS);
    expect(advice.scoreAdjustment).toBe(0);
    expect(advice.reasonCodes).toEqual(["ROLE_PROBATION_EVIDENCE"]);
  });
});

describe("roleQualityAdjustment — ranking among already-eligible routes", () => {
  const reviewerScope: BindingScope = { sessionId: "s-review", role: "REVIEWER" };
  const base: Omit<SelectRouteOptions, "scope"> = { policyMode: "adaptive", hasAdapter: () => true };

  function setup() {
    const fw = new ForgeZero();
    const health = new EightBitHealthTracker(fw);
    const reliability = new EightBitReliabilityTracker();
    const router = new EightBitRouter(fw, health, reliability);
    return { fw, health, router };
  }

  it("a fresher multi-case qualified REVIEWER outranks an equally scored weaker REVIEWER", () => {
    const { fw, router } = setup();
    // Identical capability profiles → identical ForgeRouter scores; the modelId tiebreak
    // would pick aaa-weak without the role evidence, so winning proves the adjustment.
    fw.register(makeModel({ modelId: "aaa-weak" }));
    fw.register(makeModel({ modelId: "zzz-strong" }));
    const receipts = new Map<string, ModelQualificationReceipt>([
      ["openrouter::aaa-weak", receipt("openrouter", "aaa-weak", {
        REVIEWER: roleResult("REVIEWER", "NOT_QUALIFIED", [tcase(false), tcase(false), tcase(false), tcase(false)]),
      })],
      ["openrouter::zzz-strong", receipt("openrouter", "zzz-strong", {
        REVIEWER: roleResult("REVIEWER", "QUALIFIED", [tcase(true), tcase(true), tcase(true), tcase(true)]),
      })],
    ]);
    const result = router.selectRoute({ ...base, scope: reviewerScope, roleQualityAdjustment: qualityHook(receipts, "REVIEWER") });
    expect(result.outcome).toBe("selected");
    if (result.outcome === "selected") {
      expect(result.model.modelId).toBe("zzz-strong");
      expect(result.reasons).toContain("ROLE_QUALIFIED_EVIDENCE");
    }
  });

  it("the same two routes rank differently for CODER than for REVIEWER — role evidence is role-scoped", () => {
    const { fw, router } = setup();
    fw.register(makeModel({ modelId: "aaa-reviewer-leaning" }));
    fw.register(makeModel({ modelId: "zzz-coder-leaning" }));
    const receipts = new Map<string, ModelQualificationReceipt>([
      ["openrouter::aaa-reviewer-leaning", receipt("openrouter", "aaa-reviewer-leaning", {
        REVIEWER: roleResult("REVIEWER", "QUALIFIED", [tcase(true), tcase(true), tcase(true), tcase(true)]),
        CODER: roleResult("CODER", "NOT_QUALIFIED", [tcase(false), tcase(false), tcase(false), tcase(false)]),
      })],
      ["openrouter::zzz-coder-leaning", receipt("openrouter", "zzz-coder-leaning", {
        REVIEWER: roleResult("REVIEWER", "NOT_QUALIFIED", [tcase(false), tcase(false), tcase(false), tcase(false)]),
        CODER: roleResult("CODER", "QUALIFIED", [tcase(true), tcase(true), tcase(true), tcase(true)]),
      })],
    ]);
    const review = router.selectRoute({ ...base, scope: { sessionId: "s-r", role: "REVIEWER" }, roleQualityAdjustment: qualityHook(receipts, "REVIEWER") });
    const code = router.selectRoute({ ...base, scope: { sessionId: "s-c", role: "CODER" }, roleQualityAdjustment: qualityHook(receipts, "CODER") });
    expect(review.outcome).toBe("selected");
    expect(code.outcome).toBe("selected");
    if (review.outcome === "selected") expect(review.model.modelId).toBe("aaa-reviewer-leaning");
    if (code.outcome === "selected") expect(code.model.modelId).toBe("zzz-coder-leaning");
  });

  it("an unavailable preferred route yields to the next role-qualified free candidate", () => {
    const { fw, health, router } = setup();
    // Distinct providerIds: ForgeZero marks observed failures provider-wide, so a same-
    // provider pair would both leave eligibility (that is the deliberate blast radius).
    fw.register(makeModel({ providerId: "prov-a", modelId: "preferred" }));
    fw.register(makeModel({ providerId: "prov-b", modelId: "backup" }));
    const receipts = new Map<string, ModelQualificationReceipt>([
      ["prov-a::preferred", receipt("prov-a", "preferred", {
        REVIEWER: roleResult("REVIEWER", "QUALIFIED", [tcase(true), tcase(true), tcase(true), tcase(true)]),
      })],
      ["prov-b::backup", receipt("prov-b", "backup", {
        REVIEWER: roleResult("REVIEWER", "QUALIFIED", [tcase(true), tcase(false), tcase(true), tcase(true)]),
      })],
    ]);
    const options = { ...base, scope: reviewerScope, roleQualityAdjustment: qualityHook(receipts, "REVIEWER") };

    // The stronger evidence wins while healthy.
    const first = router.selectRoute(options);
    expect(first.outcome === "selected" && first.model.modelId).toBe("preferred");

    // Cooldown (observed 429) removes the preferred route from eligibility entirely —
    // selection falls to the still-qualified backup, never to nothing while a role-qualified
    // free candidate remains.
    health.recordFailure("prov-a", "preferred", "RATE_LIMITED");
    const second = router.selectRoute({ ...options, scope: { sessionId: "s-review-2", role: "REVIEWER" } });
    expect(second.outcome).toBe("selected");
    if (second.outcome === "selected") {
      expect(second.model.providerId).toBe("prov-b");
      expect(second.model.modelId).toBe("backup");
    }
  });

  it("failover re-decision is role-aware — the qualified candidate beats an alphabetically-earlier weaker one", () => {
    const { fw, router } = setup();
    // aaa-failed is the route that just failed; of the remaining pair the modelId tiebreak
    // alone would pick bbb-weak — role evidence must land the rotation on zzz-qualified.
    fw.register(makeModel({ modelId: "aaa-failed" }));
    fw.register(makeModel({ modelId: "bbb-weak" }));
    fw.register(makeModel({ modelId: "zzz-qualified" }));
    const receipts = new Map<string, ModelQualificationReceipt>([
      ["openrouter::bbb-weak", receipt("openrouter", "bbb-weak", {
        CODER: roleResult("CODER", "NOT_QUALIFIED", [tcase(false), tcase(false), tcase(false), tcase(false)]),
      })],
      ["openrouter::zzz-qualified", receipt("openrouter", "zzz-qualified", {
        CODER: roleResult("CODER", "QUALIFIED", [tcase(true), tcase(true), tcase(true), tcase(true)]),
      })],
    ]);
    const result = router.selectReplacement(
      { ...base, scope: { sessionId: "s-fo", role: "CODER" }, roleQualityAdjustment: qualityHook(receipts, "CODER") },
      { providerId: "openrouter", modelId: "aaa-failed" },
    );
    expect(result.outcome).toBe("selected");
    if (result.outcome === "selected") {
      expect(result.model.modelId).toBe("zzz-qualified");
      expect(result.reasons).toContain("ROLE_QUALIFIED_EVIDENCE");
    }
  });

  it("role evidence never makes an ineligible candidate eligible — not even a critical-failure demotion of the alternative", () => {
    const { fw, router } = setup();
    // Tiny window fails the role's context contract → ineligible regardless of evidence.
    fw.register(makeModel({ modelId: "ineligible-tiny", contextWindow: 2_000 }));
    fw.register(makeModel({ modelId: "eligible-scarred" }));
    const receipts = new Map<string, ModelQualificationReceipt>([
      // Even a maximal positive adjustment cannot resurrect the ineligible route...
      ["openrouter::ineligible-tiny", receipt("openrouter", "ineligible-tiny", {
        REVIEWER: roleResult("REVIEWER", "QUALIFIED", [tcase(true), tcase(true), tcase(true), tcase(true), tcase(true), tcase(true)]),
      })],
      // ...and a critical-failure soft demotion does not remove an eligible route either:
      // it merely loses rank among eligible peers.
      ["openrouter::eligible-scarred", receipt("openrouter", "eligible-scarred", {
        REVIEWER: roleResult("REVIEWER", "HARD_FAILURE", [tcase(true), tcase(false, { hardFailure: true })]),
      })],
    ]);
    const result = router.selectRoute({
      ...base,
      scope: { sessionId: "s-hard", role: "REVIEWER" },
      estimatedContextTokens: 50_000,
      roleQualityAdjustment: qualityHook(receipts, "REVIEWER"),
    });
    expect(result.outcome).toBe("selected");
    if (result.outcome === "selected") {
      expect(result.model.modelId).toBe("eligible-scarred");
      expect(result.reasons).toContain("ROLE_CRITICAL_FAILURE");
    }
  });
});

describe("roleQualificationTierFor — priority ordering ahead of score", () => {
  const base: Omit<SelectRouteOptions, "scope"> = { policyMode: "adaptive", hasAdapter: () => true };

  function tierSetup(modelIds: string[]) {
    const fw = new ForgeZero();
    for (const modelId of modelIds) fw.register(makeModel({ modelId }));
    const router = new EightBitRouter(fw, new EightBitHealthTracker(fw), new EightBitReliabilityTracker());
    return { router };
  }

  it("a capacity-constrained QUALIFIED route yields to a healthy PROBATION route even with a higher score", () => {
    const { router } = tierSetup(["mmm-qualified", "nnn-probation"]);
    const result = router.selectRoute({
      ...base,
      scope: { sessionId: "s-tier-yield", role: "REVIEWER" },
      // The constrained route still leads on effectiveScore (base + 50 > base): only the
      // frozen availability tier — KNOWN_CAPACITY_EXHAUSTED — can demote it below a
      // healthy probation peer.
      capacityScoreAdjustment: (_providerId, modelId) => modelId === "mmm-qualified"
        ? { scoreAdjustment: 50, reasonCodes: ["KNOWN_CAPACITY_EXHAUSTED"] }
        : { scoreAdjustment: 0, reasonCodes: [] },
      roleQualificationTierFor: (_providerId, modelId) => modelId === "mmm-qualified" ? "QUALIFIED" : "PROBATION",
    });
    expect(result.outcome).toBe("selected");
    if (result.outcome === "selected") expect(result.model.modelId).toBe("nnn-probation");
  });

  it("a sticky QUALIFIED incumbent does not retain the binding once capacity constrained", () => {
    const { router } = tierSetup(["mmm-qualified", "nnn-probation"]);
    const scope: BindingScope = { sessionId: "s-tier-sticky", role: "REVIEWER" };
    const tierOf = (_p: string, modelId: string) => modelId === "mmm-qualified" ? "QUALIFIED" as const : "PROBATION" as const;
    const first = router.selectRoute({ ...base, scope, roleQualificationTierFor: tierOf });
    expect(first.outcome === "selected" && first.model.modelId).toBe("mmm-qualified");

    // -5 is inside the +10 promotion margin — score alone would keep the incumbent bound.
    // The constrained availability tier is what breaks the binding.
    const again = router.selectRoute({
      ...base,
      scope,
      capacityScoreAdjustment: (_providerId, modelId) => modelId === "mmm-qualified"
        ? { scoreAdjustment: -5, reasonCodes: ["KNOWN_CAPACITY_EXHAUSTED"] }
        : { scoreAdjustment: 0, reasonCodes: [] },
      roleQualificationTierFor: tierOf,
    });
    expect(again.outcome).toBe("selected");
    if (again.outcome === "selected") {
      expect(again.model.modelId).toBe("nnn-probation");
      expect(again.sticky).toBe(false);
    }
  });

  it("a healthy QUALIFIED route stays ahead of a healthy PROBATION route", () => {
    const { router } = tierSetup(["aaa-probation", "zzz-qualified"]);
    // Identical scores: the modelId tiebreak alone would pick aaa-probation — the
    // qualification tier is what keeps the qualified route first.
    const result = router.selectRoute({
      ...base,
      scope: { sessionId: "s-tier-qual", role: "REVIEWER" },
      roleQualificationTierFor: (_providerId, modelId) => modelId === "zzz-qualified" ? "QUALIFIED" : "PROBATION",
    });
    expect(result.outcome).toBe("selected");
    if (result.outcome === "selected") expect(result.model.modelId).toBe("zzz-qualified");
  });

  it("a route with no current qualification evidence ranks below a PROBATION peer", () => {
    const { router } = tierSetup(["aaa-unmeasured", "zzz-probation"]);
    const result = router.selectRoute({
      ...base,
      scope: { sessionId: "s-tier-unknown", role: "REVIEWER" },
      roleQualificationTierFor: (_providerId, modelId) => modelId === "aaa-unmeasured" ? "NOT_TESTED" : "PROBATION",
    });
    expect(result.outcome).toBe("selected");
    if (result.outcome === "selected") expect(result.model.modelId).toBe("zzz-probation");
  });

  it("failover re-decision prefers a healthy PROBATION route over a capacity-constrained QUALIFIED one", () => {
    const { router } = tierSetup(["aaa-failed", "mmm-qualified", "zzz-probation"]);
    const result = router.selectReplacement(
      {
        ...base,
        scope: { sessionId: "s-tier-fo", role: "REVIEWER" },
        capacityScoreAdjustment: (_providerId, modelId) => modelId === "mmm-qualified"
          ? { scoreAdjustment: 50, reasonCodes: ["KNOWN_CAPACITY_EXHAUSTED"] }
          : { scoreAdjustment: 0, reasonCodes: [] },
        roleQualificationTierFor: (_providerId, modelId) => modelId === "zzz-probation" ? "PROBATION" : "QUALIFIED",
      },
      { providerId: "openrouter", modelId: "aaa-failed" },
    );
    expect(result.outcome).toBe("selected");
    if (result.outcome === "selected") expect(result.model.modelId).toBe("zzz-probation");
  });
});

// --- Free Fabric: within-domain effectiveScore, after tier and health demotion --------

const OBSERVED_AT = new Date(NOW_MS - 60_000).toISOString();
const NO_RESET = "9999-12-31T23:59:59.999Z";

function quotaWindow(overrides: Partial<CapacityWindow> = {}): CapacityWindow {
  return { unit: "requests", limit: 100, remaining: 100, resetAt: NO_RESET, scope: "ORG", observedAt: OBSERVED_AT, authoritative: true, ...overrides };
}

function fabricRoute(id: string, overrides: Partial<CapacityRoute> = {}): CapacityRoute {
  return {
    routeId: `fabric:${id}`,
    providerId: id,
    modelId: `${id}-model`,
    canonicalModelId: `${id}-model`,
    family: id,
    gateway: id,
    supplyClass: "PURE_MANAGED_FREE",
    capacityPoolId: `shared:${id}`,
    capacityPoolScope: "SHARED_OWNER_POOL",
    capacityScope: "ORG",
    dataPolicyProfile: "PRIVATE_CODE_ALLOWED",
    lifecycle: "APPROVED",
    explicitZeroPrice: true,
    paidFallbackDisabled: true,
    managedMultiUserAllowed: true,
    privacyClass: "standard",
    roles: ["PRIMARY_CODING_AGENT", "PLANNER", "REVIEWER", "SUBAGENT", "FAST_REASONER"],
    qualityScore: 70,
    healthy: true,
    enabled: true,
    windows: [quotaWindow(), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 2_000_000 })],
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

describe("roleQualityAdjustment — Free Fabric effective score", () => {
  it("role evidence reorders peers inside one domain after the qualified tier and before reservation", () => {
    // Same supply domain, same qualified tier, healthy on both. The higher qualityScore
    // route carries stale evidence (zero + requalification signal); the lower-scored route
    // has fresh qualified evidence — within the ±12 bound that is enough to win.
    const hi = fabricRoute("hi-stale", { qualityScore: 74 });
    const lo = fabricRoute("lo-qualified", { qualityScore: 70 });
    const staleAt = new Date(NOW_MS - 31 * 24 * 60 * 60 * 1000).toISOString();
    const receipts = new Map<string, ModelQualificationReceipt>([
      ["hi-stale::hi-stale-model", receipt("hi-stale", "hi-stale-model", {
        REVIEWER: roleResult("REVIEWER", "QUALIFIED", [tcase(true), tcase(true), tcase(true), tcase(true)], staleAt),
      })],
      ["lo-qualified::lo-qualified-model", receipt("lo-qualified", "lo-qualified-model", {
        REVIEWER: roleResult("REVIEWER", "QUALIFIED", [tcase(true), tcase(true), tcase(true), tcase(true)]),
      })],
    ]);
    const reservations = new CapacityReservationLedger({ routes: [], pools: [], now: () => NOW_MS });
    const fabric = createFreeFabric({
      managedRoutes: () => [hi, lo],
      managedPools: () => [poolFor(hi), poolFor(lo)],
      reservations,
      now: () => NOW_MS,
    });
    const decision = fabric.decide({
      requestId: "r-roleq",
      userId: "alice",
      role: "REVIEWER",
      roleQualityAdjustment: qualityHook(receipts, "REVIEWER"),
    });
    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.routeId).toBe("fabric:lo-qualified");
    const loReport = decision.explanation.candidates.find((c) => c.routeId === "fabric:lo-qualified");
    expect(loReport?.reasonCodes).toContain("ROLE_QUALIFIED_EVIDENCE");
    const hiReport = decision.explanation.candidates.find((c) => c.routeId === "fabric:hi-stale");
    // The stale route is demoted honestly, not silently — its report carries the
    // requalification signal rather than a bare zero.
    expect(hiReport?.reasonCodes).toContain("ROLE_EVIDENCE_STALE");
  });

  it("an output-capacity-blocked high-score route yields to a qualified less-preferred route without false wait or lease leak", () => {
    // Preferred route ranks first (score 95) but its pool's output window is partially
    // spent: the 2048-token hold clamps to the 1500 limit and one already-spent token
    // (1499 remaining) denies it — a whole-window demand cannot run on a partial window.
    // The qualified 70-score route reserves the honest 1024 it will actually request and
    // serves. Outcome is ADMITTED, not QUEUED: no false wait on capacity that never applied.
    const tightOutput = quotaWindow({ unit: "output_tokens", limit: 1_500, remaining: 1_499 });
    const hi = fabricRoute("hi-blocked", { qualityScore: 95, windows: [quotaWindow(), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 2_000_000 }), tightOutput] });
    const lo = fabricRoute("lo-fits", { qualityScore: 70, windows: [quotaWindow(), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 2_000_000 }), tightOutput] });
    const receipts = new Map<string, ModelQualificationReceipt>([
      ["hi-blocked::hi-blocked-model", receipt("hi-blocked", "hi-blocked-model", {
        REVIEWER: roleResult("REVIEWER", "QUALIFIED", [tcase(true), tcase(true), tcase(true), tcase(true)]),
      })],
      ["lo-fits::lo-fits-model", receipt("lo-fits", "lo-fits-model", {
        REVIEWER: roleResult("REVIEWER", "QUALIFIED", [tcase(true), tcase(true), tcase(true), tcase(true)]),
      })],
    ]);
    const reservations = new CapacityReservationLedger({ routes: [], pools: [], now: () => NOW_MS });
    const fabric = createFreeFabric({
      managedRoutes: () => [hi, lo],
      managedPools: () => [poolFor(hi), poolFor(lo)],
      reservations,
      now: () => NOW_MS,
    });
    const decision = fabric.decide({
      requestId: "r-cap",
      userId: "alice",
      role: "REVIEWER",
      roleQualityAdjustment: qualityHook(receipts, "REVIEWER"),
      demand: {
        requests: 1,
        outputTokens: 2_048,
        outputTokensFor: (providerId) => providerId === "hi-blocked" ? 2_048 : 1_024,
      },
    });
    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.routeId).toBe("fabric:lo-fits");
    const hiReport = decision.explanation.candidates.find((c) => c.routeId === "fabric:hi-blocked");
    expect(hiReport?.status).toBe("CAPACITY_DENIED");
    expect(hiReport?.reasonCodes).toContain("PROVIDER_QUOTA_EXHAUSTED");
    // Exactly one live reservation — the denied candidate's attempt holds nothing.
    expect(reservations.snapshot().activeReservations).toBe(1);
  });

  it("role evidence cannot lift a route above the qualified tier", () => {
    // A probation-tier route (REVIEWER reachable only via fallbackRoles) carries fresh
    // glowing evidence worth the full +12; the qualified-tier route carries none. The
    // tier ordering still wins — the advice only orders within a tier, per the
    // role-quality contract.
    const probation = fabricRoute("probation", { qualityScore: 70, roles: ["PRIMARY_CODING_AGENT"], fallbackRoles: ["REVIEWER"] });
    const qualified = fabricRoute("qualified", { qualityScore: 60 });
    const receipts = new Map<string, ModelQualificationReceipt>([
      ["probation::probation-model", receipt("probation", "probation-model", {
        REVIEWER: roleResult("REVIEWER", "QUALIFIED", [tcase(true), tcase(true), tcase(true), tcase(true), tcase(true), tcase(true), tcase(true), tcase(true)]),
      })],
    ]);
    const reservations = new CapacityReservationLedger({ routes: [], pools: [], now: () => NOW_MS });
    const fabric = createFreeFabric({
      managedRoutes: () => [probation, qualified],
      managedPools: () => [poolFor(probation), poolFor(qualified)],
      reservations,
      now: () => NOW_MS,
    });
    const decision = fabric.decide({
      requestId: "r-tier",
      userId: "alice",
      role: "REVIEWER",
      roleQualityAdjustment: qualityHook(receipts, "REVIEWER"),
    });
    expect(decision.outcome).toBe("ADMITTED");
    expect(decision.selected?.routeId).toBe("fabric:qualified");
    const probationReport = decision.explanation.candidates.find((c) => c.routeId === "fabric:probation");
    expect(probationReport?.reasonCodes).toContain("ROLE_PROBATION_FALLBACK");
  });
});
