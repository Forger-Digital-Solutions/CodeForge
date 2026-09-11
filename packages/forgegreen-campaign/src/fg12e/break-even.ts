import type { PairReceipt } from "./pair-runner.js";
import { analyzeOutliers, round, summarize, type OutlierAnalysis, type SummaryStats } from "./timing.js";
import type { CostTier, WorkspaceKind } from "./workloads.js";
import type { WorkloadResult } from "./workload-runner.js";

/**
 * FG-12E break-even model (spec §12/§14/§18/§20/§26). Purely descriptive: it derives thresholds
 * and classes FROM the measurements and never feeds anything back into validity. Safety stays
 * ForgeVerify's; this is ForgeGreen cost characterization only.
 */

export interface WorkloadSummary {
  workloadId: string;
  label: string;
  expectedTier: CostTier;
  observedClass: ObservedCostClass;
  workspaceKind: WorkspaceKind;
  verifierIds: string[];
  scoredPairs: number;
  valid: boolean;
  invalidReasons: string[];
  coldVerifierElapsedMs: number;
  control: { wallMs: OutlierAnalysis; verifierExecutionMs: SummaryStats; nonVerifierMs: SummaryStats; prePlanMs: SummaryStats };
  treatment: { wallMs: OutlierAnalysis; prePlanMs: SummaryStats; postExecutionMs: SummaryStats };
  netWallClockDeltaMs: OutlierAnalysis;
  reuseCheckMs: SummaryStats;
  advisoryDifferentialMs: SummaryStats;
  verificationSavedReferenceMs: SummaryStats;
  actualVerifierExecutionsAvoided: number;
  /** Fraction of scored pairs whose net delta was positive. */
  positiveNetShare: number;
  byOrder: { controlFirst: { n: number; medianNetMs: number }; treatmentFirst: { n: number; medianNetMs: number } };
}

export type ObservedCostClass = "CHEAP" | "MODERATE" | "EXPENSIVE" | "UNKNOWN";

export function summarizeWorkload(result: WorkloadResult, breakEvenMs: number | undefined): WorkloadSummary {
  const scored = result.scoredReceipts;
  const controlWall = scored.map((r) => r.control.wallMs);
  const netDelta = scored.map((r) => r.netWallClockDeltaMs);
  const controlExec = summarize(scored.map((r) => r.control.verifierExecutionMs));
  const byOrder = (order: PairReceipt["order"]) => {
    const subset = scored.filter((r) => r.order === order);
    return { n: subset.length, medianNetMs: summarize(subset.map((r) => r.netWallClockDeltaMs)).median };
  };
  return {
    workloadId: result.workload.id,
    label: result.workload.label,
    expectedTier: result.workload.expectedTier,
    observedClass: classifyObservedCost(controlExec.median, breakEvenMs),
    workspaceKind: result.workload.workspace,
    verifierIds: result.workload.verifiers.map((v) => v.id),
    scoredPairs: scored.length,
    valid: result.valid,
    invalidReasons: result.invalidReasons,
    coldVerifierElapsedMs: result.baseline.coldVerifierElapsedMs,
    control: {
      wallMs: analyzeOutliers(controlWall),
      verifierExecutionMs: controlExec,
      nonVerifierMs: summarize(scored.map((r) => round(r.control.wallMs - r.control.verifierExecutionMs))),
      prePlanMs: summarize(scored.map((r) => r.control.prePlanMs)),
    },
    treatment: {
      wallMs: analyzeOutliers(scored.map((r) => r.treatment.wallMs)),
      prePlanMs: summarize(scored.map((r) => r.treatment.prePlanMs)),
      postExecutionMs: summarize(scored.map((r) => r.treatment.postExecutionMs)),
    },
    netWallClockDeltaMs: analyzeOutliers(netDelta),
    reuseCheckMs: summarize(scored.map((r) => r.reuseCheckMs)),
    advisoryDifferentialMs: summarize(scored.map((r) => r.advisoryDifferentialMs)),
    verificationSavedReferenceMs: summarize(scored.map((r) => r.verificationSavedReferenceMs)),
    actualVerifierExecutionsAvoided: scored.reduce((s, r) => s + r.actualVerifierExecutionsAvoided, 0),
    positiveNetShare: scored.length === 0 ? 0 : round(scored.filter((r) => r.netWallClockDeltaMs > 0).length / scored.length, 4),
    byOrder: { controlFirst: byOrder("control-first"), treatmentFirst: byOrder("treatment-first") },
  };
}

/**
 * Non-authoritative observed cost class (spec §20), relative to the measured break-even
 * overhead `b`: CHEAP = verifier cost below b (reuse expected net-negative), MODERATE = [b, 5b)
 * (near break-even to modest gains), EXPENSIVE = >= 5b. UNKNOWN when no break-even exists yet.
 */
export function classifyObservedCost(verifierExecutionMedianMs: number, breakEvenMs: number | undefined): ObservedCostClass {
  if (breakEvenMs === undefined || !Number.isFinite(verifierExecutionMedianMs) || !Number.isFinite(breakEvenMs)) return "UNKNOWN";
  if (verifierExecutionMedianMs < breakEvenMs) return "CHEAP";
  if (verifierExecutionMedianMs < 5 * breakEvenMs) return "MODERATE";
  return "EXPENSIVE";
}

export interface BreakEvenPoint {
  workloadId: string;
  workspaceKind: WorkspaceKind;
  controlWallMedianMs: number;
  verifierExecutionMedianMs: number;
  treatmentWallMedianMs: number;
  netMedianMs: number;
  reuseCheckMedianMs: number;
  positiveNetShare: number;
}

export interface BreakEvenCharacterization {
  /** Model: net_savings = verifier_execution_ms - reuse_check_ms, where reuse_check_ms is the
   * measured marginal cost of the reuse path over the fresh path's non-verifier base. */
  model: string;
  /** Per-workspace-kind reuse_check_ms (git hashing dominates it and scales with repo size). */
  reuseCheckMsByWorkspace: Record<WorkspaceKind, SummaryStats | null>;
  /** Overall (all valid full-reuse pairs). */
  reuseCheckMsOverall: SummaryStats;
  /** Empirical crossing: the most expensive workload with median net <= 0 and the cheapest with
   * median net > 0, by verifier execution cost. The break-even lies between them. */
  bracket: { lastNegative: BreakEvenPoint | null; firstPositive: BreakEvenPoint | null };
  /** Break-even estimate: median reuse_check_ms (p25..p75 range) — the verifier cost below
   * which reuse is unlikely to pay. Reported per workspace kind and overall. */
  estimate: { overallMs: number; rangeMs: [number, number]; byWorkspace: Record<WorkspaceKind, { ms: number; rangeMs: [number, number] } | null> };
  /** Consistency: does the sign of the measured median net agree with the model's prediction
   * (verifierExec > reuseCheck) for every valid workload? */
  modelAgreement: { agreeing: string[]; disagreeing: string[] };
  /** Linearity check: net - (verifierExec - reuseCheck) residual per workload; if residuals grow
   * with cost the relationship is not linear and the report says so. */
  residuals: Array<{ workloadId: string; residualMs: number; relativeToNet: number | null }>;
  points: BreakEvenPoint[];
}

export function characterizeBreakEven(results: WorkloadResult[]): BreakEvenCharacterization {
  const valid = results.filter((r) => r.valid && r.scoredReceipts.length > 0 && r.scoredReceipts.every((p) => p.reuseExtent === "full"));
  const points: BreakEvenPoint[] = valid
    .map((r) => {
      const s = r.scoredReceipts;
      return {
        workloadId: r.workload.id,
        workspaceKind: r.workload.workspace,
        controlWallMedianMs: summarize(s.map((p) => p.control.wallMs)).median,
        verifierExecutionMedianMs: summarize(s.map((p) => p.control.verifierExecutionMs)).median,
        treatmentWallMedianMs: summarize(s.map((p) => p.treatment.wallMs)).median,
        netMedianMs: summarize(s.map((p) => p.netWallClockDeltaMs)).median,
        reuseCheckMedianMs: summarize(s.map((p) => p.reuseCheckMs)).median,
        positiveNetShare: round(s.filter((p) => p.netWallClockDeltaMs > 0).length / s.length, 4),
      };
    })
    .sort((a, b) => a.verifierExecutionMedianMs - b.verifierExecutionMedianMs);

  const allReuseChecks = valid.flatMap((r) => r.scoredReceipts.map((p) => p.reuseCheckMs));
  const byKind = (kind: WorkspaceKind) => {
    const values = valid.filter((r) => r.workload.workspace === kind).flatMap((r) => r.scoredReceipts.map((p) => p.reuseCheckMs));
    return values.length > 0 ? summarize(values) : null;
  };
  const reuseCheckMsByWorkspace: Record<WorkspaceKind, SummaryStats | null> = { "bench-fixture": byKind("bench-fixture"), "repo-root": byKind("repo-root") };
  const reuseCheckMsOverall = summarize(allReuseChecks);

  const negatives = points.filter((p) => p.netMedianMs <= 0);
  const positives = points.filter((p) => p.netMedianMs > 0);
  const lastNegative = negatives.length > 0 ? negatives[negatives.length - 1]! : null;
  const firstPositive = positives.length > 0 ? positives[0]! : null;

  const agreeing: string[] = [];
  const disagreeing: string[] = [];
  const residuals = points.map((p) => {
    const predicted = p.verifierExecutionMedianMs - p.reuseCheckMedianMs;
    const residual = round(p.netMedianMs - predicted);
    (Math.sign(predicted) === Math.sign(p.netMedianMs) || (Math.abs(predicted) < 5 && Math.abs(p.netMedianMs) < 5) ? agreeing : disagreeing).push(p.workloadId);
    return { workloadId: p.workloadId, residualMs: residual, relativeToNet: p.netMedianMs === 0 ? null : round(residual / Math.abs(p.netMedianMs), 4) };
  });

  const est = (stats: SummaryStats | null) => (stats && stats.n > 0 ? { ms: stats.median, rangeMs: [stats.p25, stats.p75] as [number, number] } : null);
  return {
    model: "net_savings_ms = verifier_execution_ms (control child-process time of the avoided verifiers) - reuse_check_ms (treatment wall - control non-verifier wall, measured per pair). Break-even verifier cost ~= reuse_check_ms. Linearity is checked, not assumed (see residuals).",
    reuseCheckMsByWorkspace,
    reuseCheckMsOverall,
    bracket: { lastNegative, firstPositive },
    estimate: {
      overallMs: reuseCheckMsOverall.median,
      rangeMs: [reuseCheckMsOverall.p25, reuseCheckMsOverall.p75],
      byWorkspace: { "bench-fixture": est(reuseCheckMsByWorkspace["bench-fixture"]), "repo-root": est(reuseCheckMsByWorkspace["repo-root"]) },
    },
    modelAgreement: { agreeing, disagreeing },
    residuals,
    points,
  };
}

export type RolloutRecommendation = "ROLLOUT_ALL_VALID_REUSE" | "ROLLOUT_COST_GATED" | "KEEP_CONTROLLED_TRIAL" | "DO_NOT_ROLLOUT";

export interface RolloutClassification {
  recommendation: RolloutRecommendation;
  rationale: string[];
  /** Inputs the classification was computed from, so it is auditable. */
  inputs: {
    validWorkloads: number;
    cheapestNetPositive: boolean;
    anyNetPositive: boolean;
    expensiveAllNetPositive: boolean;
    thresholdMeasurable: boolean;
    noisy: boolean;
    safetyCertified: boolean;
  };
}

/**
 * Spec §26. Separate from safety certification. Requires safety to hold for any rollout class
 * at all; then: every workload net-positive (incl. cheapest) -> ROLLOUT_ALL_VALID_REUSE; a
 * measurable threshold with cheap negative and expensive positive -> ROLLOUT_COST_GATED; nothing
 * positive -> DO_NOT_ROLLOUT; otherwise (noisy or inconsistent) -> KEEP_CONTROLLED_TRIAL.
 */
export function classifyRollout(summaries: WorkloadSummary[], breakEven: BreakEvenCharacterization, safetyCertified: boolean): RolloutClassification {
  const valid = summaries.filter((s) => s.valid);
  const points = breakEven.points;
  const cheapest = points[0];
  const cheapestNetPositive = Boolean(cheapest && cheapest.netMedianMs > 0 && cheapest.positiveNetShare >= 0.8);
  const anyNetPositive = points.some((p) => p.netMedianMs > 0 && p.positiveNetShare >= 0.8);
  const expensive = valid.filter((s) => s.observedClass === "EXPENSIVE");
  const expensiveAllNetPositive = expensive.length > 0 && expensive.every((s) => s.netWallClockDeltaMs.withOutliers.median > 0 && s.positiveNetShare >= 0.8);
  const thresholdMeasurable = breakEven.reuseCheckMsOverall.n >= 10 && Number.isFinite(breakEven.estimate.overallMs) && breakEven.modelAgreement.disagreeing.length === 0;
  // Noise: the reuse-check overhead's interquartile range exceeding its median (pooled, or
  // within any single valid workload), a workload whose net sign is inconsistent across its own
  // pairs, or the sign of net disagreeing with the model anywhere.
  const iqr = breakEven.reuseCheckMsOverall.p75 - breakEven.reuseCheckMsOverall.p25;
  const workloadNoisy = valid.some((s) => s.reuseCheckMs.n > 0 && s.reuseCheckMs.p75 - s.reuseCheckMs.p25 > Math.abs(s.reuseCheckMs.median));
  const signInconsistent = valid.some((s) => s.positiveNetShare > 0.2 && s.positiveNetShare < 0.8);
  const noisy = !Number.isFinite(iqr) || iqr > breakEven.reuseCheckMsOverall.median || workloadNoisy || signInconsistent || breakEven.modelAgreement.disagreeing.length > 0;

  const inputs = { validWorkloads: valid.length, cheapestNetPositive, anyNetPositive, expensiveAllNetPositive, thresholdMeasurable, noisy, safetyCertified };
  const rationale: string[] = [];
  let recommendation: RolloutRecommendation;
  if (!safetyCertified) {
    recommendation = "KEEP_CONTROLLED_TRIAL";
    rationale.push("Safety did not remain certified in this run; performance results cannot promote anything.");
  } else if (valid.length === 0 || !anyNetPositive) {
    recommendation = "DO_NOT_ROLLOUT";
    rationale.push("No valid workload showed a consistently positive net wall-clock delta.");
  } else if (cheapestNetPositive && points.every((p) => p.netMedianMs > 0)) {
    recommendation = "ROLLOUT_ALL_VALID_REUSE";
    rationale.push("Even the cheapest measured verifier is net-positive under reuse.");
  } else if (thresholdMeasurable && expensiveAllNetPositive && !noisy) {
    recommendation = "ROLLOUT_COST_GATED";
    rationale.push(`Reuse is net-negative below ~${round(breakEven.estimate.overallMs, 1)} ms of verifier cost and consistently net-positive for expensive verifiers; a cost gate at the measured threshold captures the benefit without the cheap-verifier loss.`);
  } else {
    recommendation = "KEEP_CONTROLLED_TRIAL";
    rationale.push(noisy ? "Reuse overhead is too noisy or the model disagrees with observation somewhere; more data needed." : "Expensive verifiers are not consistently net-positive.");
  }
  return { recommendation, rationale, inputs };
}
