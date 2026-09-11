import crypto from "node:crypto";
import type {
  BaselineComparison,
  ContextComparisonPopulation,
  NormalizedMeasurementInput,
} from "./sustainability-types.js";

/**
 * FG-8 baseline / counterfactual framework (spec §5, hardening #2/#3). All comparisons are
 * deterministic — computed from already-recorded events, never from a live paid/free model call
 * made just to manufacture a baseline. Every comparison persists enough to reconstruct the claim
 * (hardening #2): kind, policy version, basis, an input-evidence hash, assumptions, numerator,
 * denominator, units, confidence, and a creation timestamp. A savings percentage is never the
 * only fact stored — `derivedSavingsPercent()` computes it on demand and only when both
 * numerator and denominator are defensible.
 */
export const BASELINE_POLICY_VERSION = "fg8-baseline-1";

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`).join(",")}}`;
}

function hashEvidence(value: unknown): string {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 32);
}

/**
 * Baseline A — "no smart routing": a single fixed-model deployment has no rotation mechanism, so
 * every actual fallback this run needed represents a request a fixed-model baseline could not
 * have continued past without outright failure or manual restart. Numerator/denominator are both
 * real recorded counts; only the counterfactual FRAMING ("what would a fixed-model policy have
 * done") is simulated, never the underlying numbers.
 */
export function simulateBaselineA(input: NormalizedMeasurementInput): BaselineComparison | undefined {
  const { fallbackEvents } = input.routing;
  const { requestCount } = input.tokens;
  if (fallbackEvents === undefined || requestCount === undefined || requestCount <= 0) return undefined;
  return {
    baselineKind: "A_FIXED_MODEL_NO_SMART_ROUTING",
    baselinePolicyVersion: BASELINE_POLICY_VERSION,
    comparisonBasis: "simulated",
    inputEvidenceHash: hashEvidence({ fallbackEvents, requestCount, runId: input.identity.runId }),
    assumptions: [
      "A fixed single-model deployment has no rotation/failover mechanism.",
      "Every actual fallback event this run needed is treated as a request a fixed-model baseline could not have continued past.",
    ],
    numerator: fallbackEvents,
    denominator: requestCount,
    units: "requests_continued_past_dead_end / total_requests",
    confidence: "HIGH_CONFIDENCE_ESTIMATE",
    createdAt: new Date().toISOString(),
    executionRevision: input.identity.executionRevision,
    description:
      "Share of this run's requests that smart routing carried past a provider failure that a fixed single-model deployment could not have continued past.",
  };
}

/**
 * Baseline B — naive full-context. NEVER equates total repository size with eligible model
 * context (hardening #3): the caller must supply the exact comparison population (eligible vs
 * excluded files, with exclusion reasons, and eligible/actual/naive byte-or-token counts). If a
 * defensible population isn't available, this returns `undefined` rather than fabricating one —
 * "no baseline means no savings claim".
 */
export function simulateBaselineB(
  input: NormalizedMeasurementInput,
  population: ContextComparisonPopulation,
): BaselineComparison | undefined {
  const { actualTransmittedBytes, naivePolicyBytes } = population;
  if (actualTransmittedBytes === undefined || naivePolicyBytes === undefined || naivePolicyBytes <= 0) return undefined;
  if (!Number.isFinite(actualTransmittedBytes) || !Number.isFinite(naivePolicyBytes)) return undefined;
  if (actualTransmittedBytes < 0) return undefined; // malformed/impossible input — never a fabricated comparison
  if (actualTransmittedBytes > naivePolicyBytes) return undefined; // never claim negative savings via this path
  return {
    baselineKind: "B_NAIVE_FULL_CONTEXT",
    baselinePolicyVersion: BASELINE_POLICY_VERSION,
    comparisonBasis: "simulated",
    inputEvidenceHash: hashEvidence({ population, runId: input.identity.runId }),
    assumptions: [
      population.fullContextDefinition,
      "Naive policy bytes/tokens are computed structurally from the same eligible population, not a live call.",
    ],
    numerator: naivePolicyBytes - actualTransmittedBytes,
    denominator: naivePolicyBytes,
    units: "bytes_avoided / naive_full_context_bytes",
    confidence: "HIGH_CONFIDENCE_ESTIMATE",
    createdAt: new Date().toISOString(),
    executionRevision: input.identity.executionRevision,
    description: "Bytes avoided by progressive/pull-based context delivery versus an explicit naive full-context policy for the stated eligible population.",
    contextPopulation: population,
  };
}

/**
 * Baseline C — naive sequential retry. Compares requests the system skipped outright (because
 * health tracking already knew a route was ineligible/unhealthy) against what a naive
 * retry-until-something-works strategy would have attempted (including the doomed calls that
 * health-aware routing skipped).
 */
export function simulateBaselineC(input: NormalizedMeasurementInput): BaselineComparison | undefined {
  const { modelFailoverBlockedDispatches } = input.routing;
  const { requestCount } = input.tokens;
  if (modelFailoverBlockedDispatches === undefined || requestCount === undefined) return undefined;
  const naiveAttempts = requestCount + modelFailoverBlockedDispatches;
  if (naiveAttempts <= 0) return undefined;
  return {
    baselineKind: "C_NAIVE_SEQUENTIAL_RETRY",
    baselinePolicyVersion: BASELINE_POLICY_VERSION,
    comparisonBasis: "simulated",
    inputEvidenceHash: hashEvidence({ modelFailoverBlockedDispatches, requestCount, runId: input.identity.runId }),
    assumptions: [
      "A naive sequential-retry strategy has no health/eligibility pre-check and would attempt every blocked dispatch anyway.",
      "Blocked-dispatch count is the FG-8 `modelFailoverBlockedDispatches` ledger counter — a real recorded refusal, not a guess.",
    ],
    numerator: modelFailoverBlockedDispatches,
    denominator: naiveAttempts,
    units: "doomed_calls_skipped / naive_total_attempts",
    confidence: "HIGH_CONFIDENCE_ESTIMATE",
    createdAt: new Date().toISOString(),
    executionRevision: input.identity.executionRevision,
    description: "Share of a naive sequential-retry strategy's attempts that health-aware routing skipped outright instead of dispatching to a known-ineligible route.",
  };
}

/**
 * Baseline D — verification overhead, reported for transparency ONLY. Numerator/denominator are
 * always left `undefined` so `derivedSavingsPercent()` can never produce a number from it:
 * verification cost is never a savings source, and removing verification is never representable
 * as an optimization baseline.
 */
export function describeBaselineD(input: NormalizedMeasurementInput): BaselineComparison | undefined {
  const { obligationsGenerated, targetedSuitesUsed, fullSuitesRequired } = input.verification;
  if (obligationsGenerated === undefined) return undefined;
  return {
    baselineKind: "D_VERIFICATION_OVERHEAD_COMPARISON",
    baselinePolicyVersion: BASELINE_POLICY_VERSION,
    comparisonBasis: "measured",
    inputEvidenceHash: hashEvidence({ obligationsGenerated, targetedSuitesUsed, fullSuitesRequired, runId: input.identity.runId }),
    assumptions: [
      "Verification overhead is reported for transparency only.",
      "This is never a savings source: removing or weakening verification can never be represented as an optimization baseline.",
    ],
    numerator: undefined,
    denominator: undefined,
    units: "count",
    confidence: obligationsGenerated > 0 ? "DIRECT" : "INSUFFICIENT_DATA",
    createdAt: new Date().toISOString(),
    executionRevision: input.identity.executionRevision,
    description: `Verification obligations generated this run: ${obligationsGenerated} (targeted suites used: ${targetedSuitesUsed ?? "unknown"}, full suites required: ${fullSuitesRequired ?? "unknown"}). Informational only — not a savings baseline.`,
  };
}

export function generateAllBaselines(
  input: NormalizedMeasurementInput,
  contextPopulation?: ContextComparisonPopulation,
): BaselineComparison[] {
  const results: (BaselineComparison | undefined)[] = [
    simulateBaselineA(input),
    contextPopulation ? simulateBaselineB(input, contextPopulation) : undefined,
    simulateBaselineC(input),
    describeBaselineD(input),
  ];
  return results.filter((r): r is BaselineComparison => r !== undefined);
}
