import { performance } from "node:perf_hooks";
import type { ForgeVerifyObserver, VerificationAttempt, VerificationEvidence, VerificationPlan } from "@codeforge/workflow";

/**
 * FG-12E timing primitives. Every scored span is a `performance.now()` monotonic difference —
 * never `Date.now()` (millisecond-quantized, wall-clock adjustable) — because the advisor overhead
 * being characterized is itself in the tens-of-milliseconds class and a 1 ms quantum would be a
 * material fraction of it.
 */
export function now(): number {
  return performance.now();
}

export function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Sync/async span timer returning the measured duration alongside the callee's result. */
export async function timed<T>(fn: () => Promise<T> | T): Promise<{ result: T; ms: number }> {
  const started = now();
  const result = await fn();
  return { result, ms: round(now() - started) };
}

export function timedSync<T>(fn: () => T): { result: T; ms: number } {
  const started = now();
  const result = fn();
  return { result, ms: round(now() - started) };
}

export interface TimelineAttemptMark {
  verifierId: string;
  startedAt: number;
  terminalAt?: number;
  evidenceAt?: number;
  status?: string;
  /** ForgeVerify's own child-process elapsed time for this attempt (evidence.elapsedMs). */
  elapsedMs?: number;
}

/**
 * Observer-derived timeline of one `runVerification` call. Uses ONLY the production
 * `ForgeVerifyObserver` hooks — no instrumentation is added to ForgeVerify or to Candidate D's
 * wrapper — so the marks come from the same seams a production persistence observer sees.
 */
export interface Timeline {
  planCreatedAt?: number;
  plan?: VerificationPlan;
  attempts: TimelineAttemptMark[];
  coverageReceiptAt?: number;
  /** Cumulative time spent inside a wrapped downstream observer (e.g. SQLite persistence), so a
   * persistence-on measurement can attribute its own cost without double counting it in a span. */
  downstreamObserverMs: number;
}

export function createTimelineObserver(downstream?: ForgeVerifyObserver): { observer: ForgeVerifyObserver; timeline: Timeline } {
  const timeline: Timeline = { attempts: [], downstreamObserverMs: 0 };
  const forward = async <K extends keyof ForgeVerifyObserver>(hook: K, ...args: Parameters<NonNullable<ForgeVerifyObserver[K]>>): Promise<void> => {
    const fn = downstream?.[hook] as ((...a: unknown[]) => void | Promise<void>) | undefined;
    if (!fn) return;
    const started = now();
    await fn.apply(downstream, args as unknown[]);
    timeline.downstreamObserverMs += now() - started;
  };
  const observer: ForgeVerifyObserver = {
    planCreated: async (plan: VerificationPlan) => {
      timeline.planCreatedAt = now();
      timeline.plan = plan;
      await forward("planCreated", plan);
    },
    attemptStarted: async (attempt: VerificationAttempt) => {
      timeline.attempts.push({ verifierId: attempt.verifierId, startedAt: now() });
      await forward("attemptStarted", attempt);
    },
    attemptTerminal: async (attempt: VerificationAttempt) => {
      const mark = timeline.attempts.find((a) => a.verifierId === attempt.verifierId && a.terminalAt === undefined);
      if (mark) {
        mark.terminalAt = now();
        mark.status = attempt.status;
      }
      await forward("attemptTerminal", attempt);
    },
    evidenceCreated: async (evidence: VerificationEvidence) => {
      const mark = timeline.attempts.find((a) => a.verifierId === evidence.verifierId && a.evidenceAt === undefined);
      if (mark) {
        mark.evidenceAt = now();
        mark.elapsedMs = evidence.elapsedMs;
      }
      await forward("evidenceCreated", evidence);
    },
    policyReceiptCreated: async (receipt) => forward("policyReceiptCreated", receipt),
    resolutionReceiptCreated: async (receipt) => forward("resolutionReceiptCreated", receipt),
    coverageReceiptCreated: async (receipt) => {
      timeline.coverageReceiptAt = now();
      await forward("coverageReceiptCreated", receipt);
    },
  };
  return { observer, timeline };
}

// ---------------------------------------------------------------------------------------------
// Summary statistics (spec §9/§10): never a single average; medians preferred; outliers flagged
// by a documented rule and reported with AND without exclusion, never deleted from the raw set.
// ---------------------------------------------------------------------------------------------

export interface SummaryStats {
  n: number;
  median: number;
  mean: number;
  min: number;
  max: number;
  p25: number;
  p75: number;
  stdev: number;
  /** Coefficient of variation (stdev / |mean|); `null` when mean is 0. */
  cv: number | null;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

export function summarize(values: readonly number[]): SummaryStats {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { n: 0, median: Number.NaN, mean: Number.NaN, min: Number.NaN, max: Number.NaN, p25: Number.NaN, p75: Number.NaN, stdev: Number.NaN, cv: null };
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const variance = n > 1 ? sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0;
  const stdev = Math.sqrt(variance);
  return {
    n,
    median: round(quantile(sorted, 0.5)),
    mean: round(mean),
    min: round(sorted[0]!),
    max: round(sorted[n - 1]!),
    p25: round(quantile(sorted, 0.25)),
    p75: round(quantile(sorted, 0.75)),
    stdev: round(stdev),
    cv: mean === 0 ? null : round(stdev / Math.abs(mean), 4),
  };
}

export interface OutlierAnalysis {
  /** Rule: |x - median| > 3 * MAD * 1.4826 (robust z > 3) AND |x - median| > 25 ms. Both parts
   * must hold so sub-quantum jitter on very fast spans is never flagged. */
  rule: string;
  flaggedIndices: number[];
  withOutliers: SummaryStats;
  withoutOutliers: SummaryStats;
}

export const OUTLIER_RULE = "robust-z > 3 (|x - median| > 3 * 1.4826 * MAD) AND |x - median| > 25 ms; flagged observations are retained in the raw series and reported both ways";

export function analyzeOutliers(values: readonly number[]): OutlierAnalysis {
  const withOutliers = summarize(values);
  if (values.length < 4) return { rule: OUTLIER_RULE, flaggedIndices: [], withOutliers, withoutOutliers: withOutliers };
  const median = withOutliers.median;
  const deviations = values.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = quantile(deviations, 0.5);
  const scale = 1.4826 * mad;
  const flaggedIndices = values.map((v, i) => ({ v, i })).filter(({ v }) => scale > 0 && Math.abs(v - median) > 3 * scale && Math.abs(v - median) > 25).map(({ i }) => i);
  const kept = values.filter((_, i) => !flaggedIndices.includes(i));
  return { rule: OUTLIER_RULE, flaggedIndices, withOutliers, withoutOutliers: flaggedIndices.length === 0 ? withOutliers : summarize(kept) };
}
