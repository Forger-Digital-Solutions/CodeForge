import type { R20TaskType, R20Topology } from "./r20-scale.js";

export interface R20ExecutionMetrics {
  status: "completed" | "blocked" | "failed" | "cancelled";
  correct: boolean;
  wallTimeMs: number;
  tokens: number;
  modelCalls: number;
  providerRequests: number;
  toolCalls: number;
  duplicateReads: number;
  duplicateSearches: number;
  commands: number;
  filesTouched: number;
  conflicts: number;
  reviewDefectsFound: number;
  verificationPassed: boolean;
}

export interface R20ExperimentTask {
  taskId: string;
  taskType: R20TaskType;
  repositoryDigest: string;
  modelId: string;
  topology: R20Topology;
}

export interface R20ExperimentArm {
  id: string;
  forgeGreen: boolean;
  topology: R20Topology;
  execute(task: R20ExperimentTask): Promise<R20ExecutionMetrics>;
}

export interface R20ExperimentArmResult {
  armId: string;
  forgeGreen: boolean;
  topology: R20Topology;
  metrics: R20ExecutionMetrics;
}

export interface R20MatchedExperimentResult {
  task: R20ExperimentTask;
  arms: R20ExperimentArmResult[];
  comparable: boolean;
  environmentalDifferences: string[];
}

export interface R20ForgeGreenComparison {
  correctnessDelta: number;
  completionDelta: number;
  tokenReductionPercent: number;
  modelCallReductionPercent: number;
  toolCallReductionPercent: number;
  duplicateReadReductionPercent: number;
  duplicateSearchReductionPercent: number;
  latencyChangePercent: number;
  /**
   * R37 Mission T — Verified Work Multiplier: for equal verified outcomes, baseline cost /
   * optimized cost. Cost is tokens; the multiplier exists only when both arms reached the
   * same verified outcome (a "saving" that costs correctness is not a saving). Undefined
   * when outcomes differ or the baseline spent nothing.
   */
  verifiedWorkMultiplier?: number;
  promotable: boolean;
}

export interface R20TopologyComparison {
  topology: R20Topology;
  correct: boolean;
  completed: boolean;
  tokenMultiplier: number;
  requestMultiplier: number;
  wallTimeDeltaPercent: number;
  defectDetectionDelta: number;
  benefitScore: number;
}

function reduction(baseline: number, candidate: number): number {
  if (baseline === 0) return candidate === 0 ? 0 : -100;
  return ((baseline - candidate) / baseline) * 100;
}

function change(baseline: number, candidate: number): number {
  if (baseline === 0) return candidate === 0 ? 0 : 100;
  return ((candidate - baseline) / baseline) * 100;
}

export class R20MatchedExperimentHarness {
  async run(task: R20ExperimentTask, arms: R20ExperimentArm[]): Promise<R20MatchedExperimentResult> {
    if (arms.length < 2) throw new Error("Matched experiments require at least two arms");
    const results: R20ExperimentArmResult[] = [];
    for (const arm of arms) results.push({ armId: arm.id, forgeGreen: arm.forgeGreen, topology: arm.topology, metrics: await arm.execute({ ...task, topology: arm.topology }) });
    return { task, arms: results, comparable: true, environmentalDifferences: [] };
  }

  compareForgeGreen(result: R20MatchedExperimentResult, offArmId: string, onArmId: string, correctnessTolerance = 0): R20ForgeGreenComparison {
    const off = result.arms.find((arm) => arm.armId === offArmId);
    const on = result.arms.find((arm) => arm.armId === onArmId);
    if (!off || !on) throw new Error("ForgeGreen comparison arms are missing");
    if (off.topology !== on.topology) throw new Error("ForgeGreen comparison requires identical topology");
    const correctnessDelta = Number(on.metrics.correct) - Number(off.metrics.correct);
    const completionDelta = Number(on.metrics.status === "completed") - Number(off.metrics.status === "completed");
    const equalVerifiedOutcome = correctnessDelta === 0 && completionDelta === 0 && off.metrics.correct && on.metrics.correct;
    const comparison = {
      correctnessDelta,
      completionDelta,
      tokenReductionPercent: reduction(off.metrics.tokens, on.metrics.tokens),
      modelCallReductionPercent: reduction(off.metrics.modelCalls, on.metrics.modelCalls),
      toolCallReductionPercent: reduction(off.metrics.toolCalls, on.metrics.toolCalls),
      duplicateReadReductionPercent: reduction(off.metrics.duplicateReads, on.metrics.duplicateReads),
      duplicateSearchReductionPercent: reduction(off.metrics.duplicateSearches, on.metrics.duplicateSearches),
      latencyChangePercent: change(off.metrics.wallTimeMs, on.metrics.wallTimeMs),
      ...(equalVerifiedOutcome && on.metrics.tokens > 0
        ? { verifiedWorkMultiplier: off.metrics.tokens / on.metrics.tokens }
        : {}),
      promotable: false,
    };
    comparison.promotable = correctnessDelta >= -correctnessTolerance && completionDelta >= 0 && (comparison.tokenReductionPercent > 0 || comparison.modelCallReductionPercent > 0 || comparison.toolCallReductionPercent > 0 || comparison.latencyChangePercent < 0);
    return comparison;
  }

  compareTopologies(result: R20MatchedExperimentResult, baselineArmId: string): R20TopologyComparison[] {
    const baseline = result.arms.find((arm) => arm.armId === baselineArmId);
    if (!baseline) throw new Error("Topology baseline arm is missing");
    return result.arms.filter((arm) => arm.armId !== baselineArmId).map((arm) => {
      const correctDelta = Number(arm.metrics.correct) - Number(baseline.metrics.correct);
      const completionDelta = Number(arm.metrics.status === "completed") - Number(baseline.metrics.status === "completed");
      const defectDetectionDelta = arm.metrics.reviewDefectsFound - baseline.metrics.reviewDefectsFound;
      const tokenMultiplier = baseline.metrics.tokens === 0 ? 0 : arm.metrics.tokens / baseline.metrics.tokens;
      const requestMultiplier = baseline.metrics.providerRequests === 0 ? 0 : arm.metrics.providerRequests / baseline.metrics.providerRequests;
      const wallTimeDeltaPercent = change(baseline.metrics.wallTimeMs, arm.metrics.wallTimeMs);
      const benefitScore = correctDelta * 100 + completionDelta * 50 + defectDetectionDelta * 10 - Math.max(0, tokenMultiplier - 1) * 10 - Math.max(0, requestMultiplier - 1) * 10 - Math.max(0, wallTimeDeltaPercent) / 10;
      return { topology: arm.topology, correct: arm.metrics.correct, completed: arm.metrics.status === "completed", tokenMultiplier, requestMultiplier, wallTimeDeltaPercent, defectDetectionDelta, benefitScore };
    });
  }
}
