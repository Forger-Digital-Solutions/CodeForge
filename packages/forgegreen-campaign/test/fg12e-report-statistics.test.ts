import { describe, expect, it } from "vitest";
import { characterizeBreakEven, classifyObservedCost, classifyRollout, summarizeWorkload } from "../src/fg12e/break-even.js";
import type { ArmMeasurement, PairReceipt } from "../src/fg12e/pair-runner.js";
import { aggregateSafety, buildArtifact, renderMarkdown } from "../src/fg12e/report.js";
import type { BenchWorkload } from "../src/fg12e/workloads.js";
import type { WorkloadResult } from "../src/fg12e/workload-runner.js";

function arm(arm: ArmMeasurement["arm"], wallMs: number, verifierExecutionMs: number, reused: string[], fresh: number): ArmMeasurement {
  return {
    arm,
    wallMs,
    prePlanMs: arm === "treatment" ? 200 : 40,
    verifierExecutionMs,
    executionSpanMs: verifierExecutionMs,
    postExecutionMs: 150,
    tailMs: 1,
    downstreamObserverMs: 0,
    freshAttempts: fresh,
    reusedVerifierIds: reused,
    reusedEvidenceIds: reused.map((id) => `ev-${id}`),
    inputStateHash: "hash",
    plannedIdentity: ["v:1:d"],
    overallStatus: "passed",
    requiredPassed: true,
    verificationComplete: true,
  };
}

/** Synthetic full-reuse pair: control = base + verifier; treatment = base + reuseCheck. */
function receipt(workloadId: string, pairIndex: number, base: number, verifier: number, reuseCheck: number, safe = true): PairReceipt {
  const controlWall = base + verifier;
  const treatmentWall = base + reuseCheck;
  return {
    pairIndex,
    scored: true,
    warm: "warm",
    order: pairIndex % 2 === 0 ? "control-first" : "treatment-first",
    workloadId,
    expectedTier: "MODERATE",
    workspaceKind: "bench-fixture",
    verifierIds: ["v"],
    verifierDefinitionDigests: { v: "d" },
    control: arm("control", controlWall, verifier, [], 1),
    treatment: arm("treatment", treatmentWall, 0, ["v"], 0),
    reuseExtent: "full",
    plannedVerifierCount: 1,
    actualVerifierExecutionsAvoided: 1,
    actualChildProcessesAvoided: 1,
    referenceControlDurationMs: controlWall,
    reusePathDurationMs: treatmentWall,
    netWallClockDeltaMs: controlWall - treatmentWall,
    verificationSavedReferenceMs: verifier,
    reuseCheckMs: reuseCheck,
    advisoryDifferentialMs: reuseCheck,
    safety: {
      plannedIdentityEquivalent: true,
      outcomeEquivalent: true,
      coverageEquivalent: true,
      reusedSetAsExpected: true,
      everyReusedEvidenceCanonicallyValid: safe,
      noFailedEvidenceReused: true,
      freshAttemptsMatchUnreusedCount: true,
      passed: safe,
      failureReasons: safe ? [] : ["stale evidence reused"],
    },
  };
}

function workload(id: string, verifierMs: number, reuseCheckMs: number, pairs = 10, jitter = 0, safe = true): WorkloadResult {
  const spec: BenchWorkload = { id, label: id, expectedTier: "MODERATE", workspace: "bench-fixture", verifiers: [{ id: "v", kind: "test", command: "node --test x", label: id }], warmupRepetitions: 1, scoredRepetitions: pairs, description: "" };
  const scored = Array.from({ length: pairs }, (_, i) => receipt(id, i, 300, verifierMs + (i % 2 === 0 ? jitter : -jitter), reuseCheckMs, safe));
  return { workload: spec, baseline: { wallMs: 0, coldVerifierElapsedMs: verifierMs, evidenceIds: ["ev-v"] }, warmupReceipts: [], scoredReceipts: scored, stateDrift: { controlBefore: "a", controlAfter: "a", treatmentBefore: "b", treatmentAfter: "b", drifted: false }, valid: safe, invalidReasons: safe ? [] : ["pair 0: stale evidence reused"] };
}

const emptyExtras = { componentProfiles: [], compositions: [], invalidations: [], restart: [], fallback: { id: "fallback-advisor-throws" as const, receipts: [], freshVerificationAlwaysExecuted: true, fallbackReasons: [], passed: true, failureReasons: [] } };
const identity = { certifiedSourceStateId: "src", fg12dCampaignHarnessId: "h12d", fg12eHarnessId: "h12e" };

describe("FG-12E break-even model, cost classes, rollout classification, and report", () => {
  it("summarizeWorkload produces medians, order balance, and positive-net share", () => {
    const s = summarizeWorkload(workload("w", 500, 180), 180);
    expect(s.netWallClockDeltaMs.withOutliers.median).toBe(320);
    expect(s.reuseCheckMs.median).toBe(180);
    expect(s.positiveNetShare).toBe(1);
    expect(s.byOrder.controlFirst.n).toBe(5);
    expect(s.byOrder.treatmentFirst.n).toBe(5);
    expect(s.observedClass).toBe("MODERATE");
    expect(s.actualVerifierExecutionsAvoided).toBe(10);
  });

  it("classifyObservedCost derives CHEAP/MODERATE/EXPENSIVE relative to the measured break-even, UNKNOWN without one", () => {
    expect(classifyObservedCost(100, 180)).toBe("CHEAP");
    expect(classifyObservedCost(500, 180)).toBe("MODERATE");
    expect(classifyObservedCost(2000, 180)).toBe("EXPENSIVE");
    expect(classifyObservedCost(2000, undefined)).toBe("UNKNOWN");
  });

  it("characterizeBreakEven brackets the crossing, estimates from reuse_check, and checks the model against observation", () => {
    const results = [workload("cheap", 80, 180), workload("near", 200, 180), workload("mid", 900, 180), workload("big", 5000, 180)];
    const be = characterizeBreakEven(results);
    expect(be.points.map((p) => p.workloadId)).toEqual(["cheap", "near", "mid", "big"]);
    expect(be.bracket.lastNegative?.workloadId).toBe("cheap");
    expect(be.bracket.firstPositive?.workloadId).toBe("near");
    expect(be.estimate.overallMs).toBe(180);
    expect(be.reuseCheckMsOverall.n).toBe(40);
    expect(be.modelAgreement.disagreeing).toEqual([]);
    expect(be.residuals.every((r) => r.residualMs === 0)).toBe(true);
    expect(be.reuseCheckMsByWorkspace["repo-root"]).toBeNull();
  });

  it("break-even excludes invalid workloads and partial-reuse pairs from the model", () => {
    const invalid = workload("bad", 900, 180, 10, 0, false);
    const be = characterizeBreakEven([workload("ok", 900, 180), invalid]);
    expect(be.points.map((p) => p.workloadId)).toEqual(["ok"]);
  });

  it("rollout: ROLLOUT_COST_GATED when cheap is negative, expensive positive, threshold measurable, low noise", () => {
    const results = [workload("cheap", 80, 180), workload("mid", 900, 180), workload("big", 5000, 180)];
    const be = characterizeBreakEven(results);
    const summaries = results.map((r) => summarizeWorkload(r, be.estimate.overallMs));
    const rollout = classifyRollout(summaries, be, true);
    expect(rollout.recommendation).toBe("ROLLOUT_COST_GATED");
    expect(rollout.inputs.expensiveAllNetPositive).toBe(true);
    expect(rollout.inputs.cheapestNetPositive).toBe(false);
  });

  it("rollout: ROLLOUT_ALL_VALID_REUSE only when even the cheapest verifier is net-positive", () => {
    const results = [workload("cheap", 400, 180), workload("big", 5000, 180)];
    const be = characterizeBreakEven(results);
    const rollout = classifyRollout(results.map((r) => summarizeWorkload(r, be.estimate.overallMs)), be, true);
    expect(rollout.recommendation).toBe("ROLLOUT_ALL_VALID_REUSE");
  });

  it("rollout: DO_NOT_ROLLOUT when nothing is net-positive; KEEP_CONTROLLED_TRIAL when safety is not certified", () => {
    const negative = [workload("a", 50, 180), workload("b", 100, 180)];
    const be = characterizeBreakEven(negative);
    expect(classifyRollout(negative.map((r) => summarizeWorkload(r, be.estimate.overallMs)), be, true).recommendation).toBe("DO_NOT_ROLLOUT");
    const positive = [workload("cheap", 80, 180), workload("big", 5000, 180)];
    const be2 = characterizeBreakEven(positive);
    expect(classifyRollout(positive.map((r) => summarizeWorkload(r, be2.estimate.overallMs)), be2, false).recommendation).toBe("KEEP_CONTROLLED_TRIAL");
  });

  it("rollout: KEEP_CONTROLLED_TRIAL when reuse overhead is too noisy to gate on", () => {
    // Alternate reuse_check between 20 and 400 ms so the IQR exceeds the median.
    const noisy = workload("noisy", 900, 180);
    noisy.scoredReceipts = noisy.scoredReceipts.map((r, i) => ({ ...r, reuseCheckMs: i % 2 === 0 ? 20 : 400 }));
    const results = [workload("cheap", 80, 180), noisy, workload("big", 5000, 180)];
    const be = characterizeBreakEven(results);
    const rollout = classifyRollout(results.map((r) => summarizeWorkload(r, be.estimate.overallMs)), be, true);
    expect(rollout.inputs.noisy).toBe(true);
    expect(rollout.recommendation).toBe("KEEP_CONTROLLED_TRIAL");
  });

  it("aggregateSafety counts stale/failed reuse and actual avoided work from receipts", () => {
    const good = workload("g", 900, 180, 4);
    const bad = workload("b", 900, 180, 2, 0, false);
    const safety = aggregateSafety([...good.scoredReceipts, ...bad.scoredReceipts], []);
    expect(safety.totalScoredPairs).toBe(6);
    expect(safety.pairsFailingSafety).toBe(2);
    expect(safety.staleEvidenceReused).toBe(2);
    expect(safety.actualVerifierExecutionsAvoided).toBe(6);
    expect(safety.certified).toBe(false);
  });

  it("buildArtifact yields PERFORMANCE_CHARACTERIZED with enough valid workloads and BLOCKED on a safety failure; markdown carries every section", () => {
    const results = [workload("cheap", 80, 180), workload("near", 200, 180), workload("mid", 900, 180), workload("big", 5000, 180)];
    const artifact = buildArtifact({ identity, workloadResults: results, ...emptyExtras, generatedAt: "2026-09-11T00:00:00.000Z" });
    expect(artifact.verdict).toBe("CODEFORGE_FORGEGREEN_FG12E_PERFORMANCE_CHARACTERIZED");
    expect(artifact.safety.certified).toBe(true);
    expect(artifact.costUsd).toBe(0);
    expect(artifact.energyCarbon).toBe("INSUFFICIENT_DATA");
    expect(artifact.globalGraduationRegistryUnchanged).toBe(true);
    expect(artifact.productionCallSitesModified).toEqual([]);
    expect(artifact.historicalCostEstimation.verifierDurationRecordedToday).toBe(true);
    expect(artifact.rawPairReceipts).toHaveLength(40);
    const md = renderMarkdown(artifact);
    for (const heading of ["## Safety", "## Workloads", "## Break-even characterization", "## Per-workload timings", "## Raw scored timings", "## Reuse overhead components", "## Multi-verifier plans and partial reuse", "## Invalidation cost", "## Restart", "## Advisor failure fallback", "## Historical cost estimation", "## Rollout recommendation"]) {
      expect(md).toContain(heading);
    }
    expect(md).toContain("ROLLOUT_COST_GATED");

    const blocked = buildArtifact({ identity, workloadResults: [...results, workload("unsafe", 900, 180, 3, 0, false)], ...emptyExtras });
    expect(blocked.verdict).toBe("CODEFORGE_FORGEGREEN_FG12E_BLOCKED");
    expect(blocked.verdictReasons).toContain("safety regressed or a proof case failed");
    expect(blocked.rollout.recommendation).toBe("KEEP_CONTROLLED_TRIAL");
  });

  it("buildArtifact is BLOCKED when too few workloads exist to measure a break-even", () => {
    const artifact = buildArtifact({ identity, workloadResults: [workload("only", 900, 180)], ...emptyExtras });
    expect(artifact.verdict).toBe("CODEFORGE_FORGEGREEN_FG12E_BLOCKED");
    expect(artifact.verdictReasons.some((r) => r.includes("fewer than 4 valid workloads"))).toBe(true);
  });
});
