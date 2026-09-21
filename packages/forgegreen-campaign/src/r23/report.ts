import type { RunRecord } from "./run-record.js";

/**
 * R23 analysis (protocol §8): every summary number is recomputed from raw run records. Tasks are
 * paired; inference is on paired per-task differences (optimized − control) and on ratios of
 * per-arm totals, with bootstrap confidence intervals that resample PAIRS. Nothing here selects
 * or excludes runs — exclusions are the harness's append-only `exclusions.jsonl`, applied by the
 * caller before these functions see the records.
 */

export interface PairedTask {
  taskId: string;
  taskClass: string;
  repetition: number;
  control: RunRecord;
  optimized: RunRecord;
}

/** Group records into complete pairs (same task, same repetition, both arms). Incomplete pairs are reported, not silently dropped. */
export function pairRecords(records: readonly RunRecord[]): { pairs: PairedTask[]; unpaired: RunRecord[] } {
  const byKey = new Map<string, { control?: RunRecord; optimized?: RunRecord }>();
  for (const record of records) {
    const key = `${record.identity.taskId}\0${record.identity.repetition}\0${record.identity.pairId}`;
    const entry = byKey.get(key) ?? {};
    entry[record.identity.arm] = record;
    byKey.set(key, entry);
  }
  const pairs: PairedTask[] = [];
  const unpaired: RunRecord[] = [];
  for (const entry of byKey.values()) {
    if (entry.control && entry.optimized) pairs.push({ taskId: entry.control.identity.taskId, taskClass: entry.control.identity.taskClass, repetition: entry.control.identity.repetition, control: entry.control, optimized: entry.optimized });
    else unpaired.push(...[entry.control, entry.optimized].filter((r): r is RunRecord => r !== undefined));
  }
  pairs.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.repetition - b.repetition);
  return { pairs, unpaired };
}

export interface DescriptiveStats {
  n: number;
  mean: number;
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
  stdDev: number;
}

export function describe(values: readonly number[]): DescriptiveStats | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  const q = (p: number) => {
    const index = (sorted.length - 1) * p;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
  };
  const variance = sorted.length > 1 ? sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / (sorted.length - 1) : 0;
  return { n: sorted.length, mean, median: q(0.5), p25: q(0.25), p75: q(0.75), min: sorted[0]!, max: sorted[sorted.length - 1]!, stdDev: Math.sqrt(variance) };
}

/** Deterministic PRNG (mulberry32) so bootstrap intervals are reproducible from the recorded seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapInterval {
  estimate: number;
  lower: number;
  upper: number;
  resamples: number;
  seed: number;
  level: number;
}

/**
 * Percentile bootstrap of a statistic over pairs. `statistic` receives a resampled list of pairs
 * and returns a number (or undefined when undefined for that resample, e.g. 0 verified tasks).
 */
export function bootstrapPairs<T>(pairs: readonly T[], statistic: (sample: readonly T[]) => number | undefined, options: { resamples?: number; seed?: number; level?: number } = {}): BootstrapInterval | undefined {
  const resamples = options.resamples ?? 10_000;
  const seed = options.seed ?? 20260921;
  const level = options.level ?? 0.95;
  const estimate = statistic(pairs);
  if (estimate === undefined || pairs.length === 0) return undefined;
  const random = seededRandom(seed);
  const values: number[] = [];
  for (let i = 0; i < resamples; i += 1) {
    const sample: T[] = [];
    for (let j = 0; j < pairs.length; j += 1) sample.push(pairs[Math.floor(random() * pairs.length)]!);
    const value = statistic(sample);
    if (value !== undefined && Number.isFinite(value)) values.push(value);
  }
  values.sort((a, b) => a - b);
  const alpha = (1 - level) / 2;
  const at = (p: number) => values[Math.min(values.length - 1, Math.max(0, Math.floor(p * values.length)))] ?? estimate;
  return { estimate, lower: at(alpha), upper: at(1 - alpha), resamples, seed, level };
}

/** Wilcoxon signed-rank statistic on paired differences (secondary check, protocol §8.3). Returns the normal approximation p-value (two-sided) for n ≥ 10, else undefined. */
export function wilcoxonSignedRank(differences: readonly number[]): { n: number; wPlus: number; wMinus: number; z?: number; pTwoSided?: number } {
  const nonZero = differences.filter((d) => d !== 0);
  const ranked = nonZero.map((d) => ({ d, abs: Math.abs(d) })).sort((a, b) => a.abs - b.abs);
  const ranks: number[] = Array.from({ length: ranked.length }, () => 0);
  for (let i = 0; i < ranked.length;) {
    let j = i;
    while (j + 1 < ranked.length && ranked[j + 1]!.abs === ranked[i]!.abs) j += 1;
    const average = (i + j + 2) / 2;
    for (let k = i; k <= j; k += 1) ranks[k] = average;
    i = j + 1;
  }
  let wPlus = 0;
  let wMinus = 0;
  ranked.forEach((entry, index) => {
    if (entry.d > 0) wPlus += ranks[index]!;
    else wMinus += ranks[index]!;
  });
  const n = nonZero.length;
  if (n < 10) return { n, wPlus, wMinus };
  const mean = (n * (n + 1)) / 4;
  const sd = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24);
  const z = (Math.min(wPlus, wMinus) - mean) / sd;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { n, wPlus, wMinus, z, pTwoSided: p };
}

function normalCdf(x: number): number {
  // Abramowitz–Stegun 7.1.26 approximation of erf.
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return 0.5 * (1 + (x < 0 ? -y : y));
}

export type ArmTotals = {
  runs: number;
  verified: number;
  claimed: number;
  falseComplete: number;
  verificationFailed: number;
  severeFailures: number;
  budgetExhausted: number;
  providerFailures: number;
  runsWithKnownTokens: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number | undefined;
  modelCalls: number;
  failedCalls: number;
  retriedCalls: number;
  rateLimitedCalls: number;
  toolCalls: number;
  avoidableDuplicateBytes: number;
  transmittedContextBytes: number;
  wallClockMs: number;
  activeAgentMs: number;
  modelWaitMs: number;
  rateLimitWaitMs: number;
  actualCostUsd: number | undefined;
  equivalentPublicApiCostUsd: number | undefined;
  equivalentMarketCostUsd: number | undefined;
  cpuMs: number | undefined;
};

export function armTotals(records: readonly RunRecord[]): ArmTotals {
  const known = records.filter((r) => r.inference.totalTokens.value !== undefined);
  const sumMeasured = (pick: (r: RunRecord) => number | undefined): number | undefined => {
    let total = 0;
    for (const r of records) {
      const v = pick(r);
      if (v === undefined) return undefined;
      total += v;
    }
    return total;
  };
  return {
    runs: records.length,
    verified: records.filter((r) => r.outcome.verifiedComplete).length,
    claimed: records.filter((r) => r.outcome.claimedComplete).length,
    falseComplete: records.filter((r) => r.outcome.falseComplete).length,
    verificationFailed: records.filter((r) => r.outcome.classification === "verification_failed").length,
    severeFailures: records.filter((r) => ["security_blocked", "tool_failure", "harness_error"].includes(r.outcome.classification)).length,
    budgetExhausted: records.filter((r) => r.outcome.classification === "budget_exhausted").length,
    providerFailures: records.filter((r) => r.outcome.classification === "provider_failure" || r.outcome.classification === "infrastructure_void").length,
    runsWithKnownTokens: known.length,
    totalTokens: known.reduce((s, r) => s + (r.inference.totalTokens.value ?? 0), 0),
    inputTokens: known.reduce((s, r) => s + (r.inference.totalInputTokens.value ?? 0), 0),
    outputTokens: known.reduce((s, r) => s + (r.inference.totalOutputTokens.value ?? 0), 0),
    cachedTokens: sumMeasured((r) => r.inference.cachedInputTokens.value),
    modelCalls: records.reduce((s, r) => s + r.inference.modelCalls, 0),
    failedCalls: records.reduce((s, r) => s + r.inference.failedModelCalls, 0),
    retriedCalls: records.reduce((s, r) => s + r.inference.retriedModelCalls, 0),
    rateLimitedCalls: records.reduce((s, r) => s + r.inference.rateLimitedCalls, 0),
    toolCalls: records.reduce((s, r) => s + r.activity.toolCallsRequested, 0),
    avoidableDuplicateBytes: records.reduce((s, r) => s + r.context.avoidableDuplicateBytes, 0),
    transmittedContextBytes: records.reduce((s, r) => s + r.context.transmittedContextBytes, 0),
    wallClockMs: records.reduce((s, r) => s + r.time.wallClockMs, 0),
    activeAgentMs: records.reduce((s, r) => s + r.time.activeAgentMs, 0),
    modelWaitMs: records.reduce((s, r) => s + r.time.modelWaitMs, 0),
    rateLimitWaitMs: records.reduce((s, r) => s + r.time.rateLimitWaitMs, 0),
    actualCostUsd: sumMeasured((r) => r.economics.actualCostUsd.value),
    equivalentPublicApiCostUsd: sumMeasured((r) => r.economics.equivalentPublicApiCostUsd.value),
    equivalentMarketCostUsd: sumMeasured((r) => r.economics.equivalentMarketCostUsd.value),
    cpuMs: sumMeasured((r) => (r.resources.cpuUserMs.value !== undefined && r.resources.cpuSystemMs.value !== undefined ? r.resources.cpuUserMs.value + r.resources.cpuSystemMs.value : undefined)),
  };
}

export interface HeadlineMetrics {
  verifiedTasksPer1MTokens: number | undefined;
  tokensPerVerifiedTask: number | undefined;
  verifiedSuccessRate: number;
  falseCompletionRate: number;
  verifiedTasksPer100Calls: number | undefined;
  verifiedTasksPerDollarEquivalent: number | undefined;
  equivalentCostPerVerifiedTask: number | undefined;
  wallMsPerVerifiedTask: number | undefined;
}

export function headline(totals: ArmTotals): HeadlineMetrics {
  const tokensKnown = totals.runsWithKnownTokens === totals.runs && totals.runs > 0;
  return {
    verifiedTasksPer1MTokens: tokensKnown && totals.totalTokens > 0 ? totals.verified / (totals.totalTokens / 1_000_000) : undefined,
    tokensPerVerifiedTask: tokensKnown && totals.verified > 0 ? totals.totalTokens / totals.verified : undefined,
    verifiedSuccessRate: totals.runs > 0 ? totals.verified / totals.runs : 0,
    falseCompletionRate: totals.runs > 0 ? totals.falseComplete / totals.runs : 0,
    verifiedTasksPer100Calls: totals.modelCalls > 0 ? totals.verified / (totals.modelCalls / 100) : undefined,
    verifiedTasksPerDollarEquivalent: totals.equivalentPublicApiCostUsd !== undefined && totals.equivalentPublicApiCostUsd > 0 ? totals.verified / totals.equivalentPublicApiCostUsd : undefined,
    equivalentCostPerVerifiedTask: totals.equivalentPublicApiCostUsd !== undefined && totals.verified > 0 ? totals.equivalentPublicApiCostUsd / totals.verified : undefined,
    wallMsPerVerifiedTask: totals.verified > 0 ? totals.wallClockMs / totals.verified : undefined,
  };
}

export interface PairedComparison {
  pairs: number;
  pairsWithKnownTokens: number;
  control: { totals: ArmTotals; headline: HeadlineMetrics };
  optimized: { totals: ArmTotals; headline: HeadlineMetrics };
  differences: {
    /** optimized − control, per pair. Negative = optimized used fewer. */
    totalTokens: DescriptiveStats | undefined;
    totalTokensPct: DescriptiveStats | undefined;
    modelCalls: DescriptiveStats | undefined;
    wallClockMs: DescriptiveStats | undefined;
    avoidableDuplicateBytes: DescriptiveStats | undefined;
    verified: { both: number; onlyControl: number; onlyOptimized: number; neither: number };
  };
  intervals: {
    meanTokenDifference: BootstrapInterval | undefined;
    tokenRatioOfTotals: BootstrapInterval | undefined;
    verifiedRateDifference: BootstrapInterval | undefined;
    verifiedPer1MTokensRatio: BootstrapInterval | undefined;
  };
  wilcoxonTokens: ReturnType<typeof wilcoxonSignedRank>;
  byClass: Record<string, { pairs: number; controlVerified: number; optimizedVerified: number; meanTokenDifference: number | undefined }>;
  verdictInputs: {
    nonInferiority: { rateDifference: number; lowerBound: number | undefined; passes: boolean | undefined };
    falseCompletionGuard: { control: number; optimized: number; passes: boolean };
    tokenSaving: { intervalExcludesZero: boolean | undefined; direction: "optimized_fewer" | "optimized_more" | "none" };
  };
}

export function comparePairs(pairs: readonly PairedTask[], options: { resamples?: number; seed?: number } = {}): PairedComparison {
  const controlRecords = pairs.map((p) => p.control);
  const optimizedRecords = pairs.map((p) => p.optimized);
  const controlTotals = armTotals(controlRecords);
  const optimizedTotals = armTotals(optimizedRecords);
  const known = pairs.filter((p) => p.control.inference.totalTokens.value !== undefined && p.optimized.inference.totalTokens.value !== undefined);
  const tokenDiff = known.map((p) => p.optimized.inference.totalTokens.value! - p.control.inference.totalTokens.value!);
  const tokenPct = known.map((p) => (100 * (p.optimized.inference.totalTokens.value! - p.control.inference.totalTokens.value!)) / Math.max(1, p.control.inference.totalTokens.value!));
  const verifiedPattern = { both: 0, onlyControl: 0, onlyOptimized: 0, neither: 0 };
  for (const p of pairs) {
    const c = p.control.outcome.verifiedComplete;
    const o = p.optimized.outcome.verifiedComplete;
    if (c && o) verifiedPattern.both += 1;
    else if (c) verifiedPattern.onlyControl += 1;
    else if (o) verifiedPattern.onlyOptimized += 1;
    else verifiedPattern.neither += 1;
  }
  const byClass: PairedComparison["byClass"] = {};
  for (const p of pairs) {
    const entry = byClass[p.taskClass] ?? { pairs: 0, controlVerified: 0, optimizedVerified: 0, diffs: [] as number[] };
    entry.pairs += 1;
    if (p.control.outcome.verifiedComplete) entry.controlVerified += 1;
    if (p.optimized.outcome.verifiedComplete) entry.optimizedVerified += 1;
    if (p.control.inference.totalTokens.value !== undefined && p.optimized.inference.totalTokens.value !== undefined) (entry as { diffs: number[] }).diffs.push(p.optimized.inference.totalTokens.value - p.control.inference.totalTokens.value);
    byClass[p.taskClass] = entry as never;
  }
  for (const [key, entry] of Object.entries(byClass)) {
    const diffs = (entry as unknown as { diffs: number[] }).diffs;
    byClass[key] = { pairs: entry.pairs, controlVerified: entry.controlVerified, optimizedVerified: entry.optimizedVerified, meanTokenDifference: diffs.length > 0 ? diffs.reduce((s, v) => s + v, 0) / diffs.length : undefined };
  }
  const meanTokenDifference = bootstrapPairs(known, (sample) => sample.length > 0 ? sample.reduce((s, p) => s + (p.optimized.inference.totalTokens.value! - p.control.inference.totalTokens.value!), 0) / sample.length : undefined, options);
  const tokenRatioOfTotals = bootstrapPairs(known, (sample) => {
    const c = sample.reduce((s, p) => s + p.control.inference.totalTokens.value!, 0);
    const o = sample.reduce((s, p) => s + p.optimized.inference.totalTokens.value!, 0);
    return c > 0 ? o / c : undefined;
  }, options);
  const verifiedRateDifference = bootstrapPairs(pairs, (sample) => sample.length > 0 ? (sample.filter((p) => p.optimized.outcome.verifiedComplete).length - sample.filter((p) => p.control.outcome.verifiedComplete).length) / sample.length : undefined, options);
  const verifiedPer1MTokensRatio = bootstrapPairs(known, (sample) => {
    const cTokens = sample.reduce((s, p) => s + p.control.inference.totalTokens.value!, 0);
    const oTokens = sample.reduce((s, p) => s + p.optimized.inference.totalTokens.value!, 0);
    const cVerified = sample.filter((p) => p.control.outcome.verifiedComplete).length;
    const oVerified = sample.filter((p) => p.optimized.outcome.verifiedComplete).length;
    if (cVerified === 0 || cTokens === 0 || oTokens === 0) return undefined;
    return (oVerified / oTokens) / (cVerified / cTokens);
  }, options);
  const rateDifference = optimizedTotals.runs > 0 ? optimizedTotals.verified / optimizedTotals.runs - controlTotals.verified / controlTotals.runs : 0;
  return {
    pairs: pairs.length,
    pairsWithKnownTokens: known.length,
    control: { totals: controlTotals, headline: headline(controlTotals) },
    optimized: { totals: optimizedTotals, headline: headline(optimizedTotals) },
    differences: {
      totalTokens: describe(tokenDiff),
      totalTokensPct: describe(tokenPct),
      modelCalls: describe(pairs.map((p) => p.optimized.inference.modelCalls - p.control.inference.modelCalls)),
      wallClockMs: describe(pairs.map((p) => p.optimized.time.wallClockMs - p.control.time.wallClockMs)),
      avoidableDuplicateBytes: describe(pairs.map((p) => p.optimized.context.avoidableDuplicateBytes - p.control.context.avoidableDuplicateBytes)),
      verified: verifiedPattern,
    },
    intervals: { meanTokenDifference, tokenRatioOfTotals, verifiedRateDifference, verifiedPer1MTokensRatio },
    wilcoxonTokens: wilcoxonSignedRank(tokenDiff),
    byClass,
    verdictInputs: {
      nonInferiority: { rateDifference, lowerBound: verifiedRateDifference?.lower, passes: verifiedRateDifference ? rateDifference >= -0.05 && verifiedRateDifference.lower > -0.10 : undefined },
      falseCompletionGuard: { control: controlTotals.falseComplete, optimized: optimizedTotals.falseComplete, passes: optimizedTotals.runs === 0 || optimizedTotals.falseComplete / optimizedTotals.runs <= controlTotals.falseComplete / Math.max(1, controlTotals.runs) + 0.02 },
      tokenSaving: {
        intervalExcludesZero: meanTokenDifference ? meanTokenDifference.upper < 0 || meanTokenDifference.lower > 0 : undefined,
        direction: meanTokenDifference ? (meanTokenDifference.upper < 0 ? "optimized_fewer" : meanTokenDifference.lower > 0 ? "optimized_more" : "none") : "none",
      },
    },
  };
}
