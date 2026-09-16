import { createHash } from "node:crypto";
import type { DatasetFeatures, EightBitDatasetRow } from "./schema.js";

/**
 * Deterministic feature vectorization — the frozen contract between the TypeScript dataset
 * layer and the Python GPU trainer. The trainer consumes the vectorized rows verbatim and
 * never re-derives features, so TS remains the single source of truth for encoding. Missing
 * features occupy a reserved `missing` slot per channel (value 1.0) rather than a zero, so
 * "absent evidence" is representable and learnable (abstention signal).
 */

export interface VectorizationSpec {
  version: 1;
  featureNames: string[];
  /** Categorical channel vocabulary (feature name -> sorted values). Values map to index. */
  categorical: Record<string, string[]>;
  routeOutcomeLabels: string[];
  roleSuitabilityLabels: string[];
  economicsStateLabels: string[];
}

export const ROUTE_OUTCOME_LABELS = [
  "SUCCESS",
  "RATE_LIMITED",
  "QUOTA_EXHAUSTED",
  "HEALTH_MARKED_UNAVAILABLE",
  "AUTH_REQUIRED",
  "MODEL_ERROR",
  "CONTEXT_LIMIT",
] as const;

export const ROLE_SUITABILITY_LABELS = ["QUALIFIED", "PROBATION", "NOT_QUALIFIED"] as const;

export const ECONOMICS_STATE_LABELS = [
  "FREE_CONFIRMED",
  "FREE_LIMITED",
  "FREE_CREDIT",
  "FREE_EXHAUSTED",
  "PAID_REQUIRED",
  "PLAN_REQUIRED",
  "BILLING_REQUIRED",
  "TERMS_CHANGED",
  "TERMS_UNKNOWN",
  "ECONOMICS_UNKNOWN",
] as const;

export const ROLE_VOCABULARY = [
  "CODER",
  "REASONER",
  "PLANNER",
  "REVIEWER",
  "FAST_WORKER",
  "LONG_CONTEXT",
  "VISION",
  "TOOL_AGENT",
  "ANALYST",
  "AUTONOMOUS_RUN",
  "Repository Explorer",
  "Task Planner",
  "Autonomous Builder",
  "Independent Code Reviewer",
  "unknown",
] as const;

export const HEALTH_STATE_VOCABULARY = [
  "HEALTHY",
  "DEGRADED",
  "RATE_LIMITED",
  "QUOTA_EXHAUSTED",
  "UNAVAILABLE",
  "HEALTH_UNKNOWN",
] as const;

export const PRIVACY_STATE_VOCABULARY = [
  "PRIVACY_APPROVED_PRIVATE",
  "PRIVACY_PUBLIC_ONLY",
  "PRIVACY_OPT_OUT_REQUIRED",
  "PRIVACY_ZDR_REQUIRED",
  "PRIVACY_BLOCKED",
  "PRIVACY_UNKNOWN",
] as const;

const CONTINUOUS_FEATURES = [
  "contextLimitTokens",
  "advertisedRpm",
  "advertisedTpm",
  "advertisedDailyTokens",
  "observedRpm",
  "observedTpm",
  "dailyBudgetUsedRatio",
  "minutesSinceDailyReset",
  "requestsInObservation",
  "inputTokensInObservation",
  "outputTokensInObservation",
  "latencyP50Ms",
  "latencyP95Ms",
  "errorRate",
  "recentSuccessRate",
  "qualificationAgeDays",
  "driftScore",
  "evidenceCompleteness",
] as const;

const BOOLEAN_FEATURES = ["toolSupport", "structuredOutputSupport", "visionSupport"] as const;

const CATEGORICAL_FEATURES: Record<string, readonly string[]> = {
  role: ROLE_VOCABULARY,
  observedHealthState: HEALTH_STATE_VOCABULARY,
  observedPrivacyState: PRIVACY_STATE_VOCABULARY,
};

const ECONOMICS_VOCABULARY = [
  "FREE_CONFIRMED",
  "FREE_LIMITED",
  "FREE_CREDIT",
  "FREE_EXHAUSTED",
  "PAID_REQUIRED",
  "PLAN_REQUIRED",
  "BILLING_REQUIRED",
  "TERMS_CHANGED",
  "TERMS_UNKNOWN",
  "ECONOMICS_UNKNOWN",
] as const;

/**
 * Vector layout per row: [continuous (missing-flagged), booleans, categoricals as index slots,
 * observed economics state index]. Deterministic order defined by the spec object below.
 */
export function vectorizationSpec(): VectorizationSpec {
  return {
    version: 1,
    featureNames: [
      ...CONTINUOUS_FEATURES,
      ...BOOLEAN_FEATURES,
      ...Object.keys(CATEGORICAL_FEATURES),
      "observedEconomicsState",
    ],
    categorical: Object.fromEntries(
      Object.entries(CATEGORICAL_FEATURES).map(([k, v]) => [k, [...v, "__MISSING__"]]),
    ),
    routeOutcomeLabels: [...ROUTE_OUTCOME_LABELS],
    roleSuitabilityLabels: [...ROLE_SUITABILITY_LABELS],
    economicsStateLabels: [...ECONOMICS_STATE_LABELS],
  };
}

const CONTINUOUS_CLAMP_MAX: Record<string, number> = {
  contextLimitTokens: 2_000_000,
  advertisedRpm: 10_000,
  advertisedTpm: 2_000_000,
  advertisedDailyTokens: 10_000_000,
  observedRpm: 1_000,
  observedTpm: 1_000_000,
  dailyBudgetUsedRatio: 1,
  minutesSinceDailyReset: 1_440,
  requestsInObservation: 1_000,
  inputTokensInObservation: 500_000,
  outputTokensInObservation: 100_000,
  latencyP50Ms: 60_000,
  latencyP95Ms: 300_000,
  errorRate: 1,
  recentSuccessRate: 1,
  qualificationAgeDays: 365,
  driftScore: 1,
  evidenceCompleteness: 1,
};

function normalizeContinuous(name: string, value: number): number {
  const max = CONTINUOUS_CLAMP_MAX[name] ?? 1;
  return Math.max(0, Math.min(1, value / max));
}

export interface VectorizedRow {
  rowId: string;
  taskKind: EightBitDatasetRow["taskKind"];
  canonicalModelId: string;
  modelFamily: string;
  providerId: string;
  /** Continuous features in spec order; -1.0 marks a missing value (reserved embedding slot). */
  continuous: number[];
  /** Categorical index per channel in spec order; -1 marks missing. */
  categoricalIndex: number[];
  labelIndex: number;
  splitEligible: boolean;
}

export function vectorizeRow(row: EightBitDatasetRow, spec: VectorizationSpec): VectorizedRow {
  const features: DatasetFeatures = row.features;
  const continuous = CONTINUOUS_FEATURES.map((name) => {
    const raw = features[name];
    return typeof raw === "number" ? normalizeContinuous(name, raw) : -1;
  });
  for (const name of BOOLEAN_FEATURES) {
    const raw = features[name];
    continuous.push(raw === undefined ? -1 : raw ? 1 : 0);
  }
  const categoricalIndex = Object.keys(CATEGORICAL_FEATURES).map((name) => {
    const raw = (features as Record<string, unknown>)[name];
    if (typeof raw !== "string") return -1;
    const vocab = spec.categorical[name] ?? [];
    const index = vocab.indexOf(raw);
    return index;
  });
  const economicsIndex = ECONOMICS_VOCABULARY.indexOf(features.observedEconomicsState);
  continuous.push(economicsIndex === -1 ? -1 : economicsIndex / (ECONOMICS_VOCABULARY.length - 1));

  let labelIndex: number;
  if (row.taskKind === "ROUTE_OUTCOME") {
    labelIndex = spec.routeOutcomeLabels.indexOf(row.label.routeOutcome ?? "");
  } else if (row.taskKind === "ROLE_SUITABILITY") {
    labelIndex = spec.roleSuitabilityLabels.indexOf(row.label.roleSuitability ?? "");
  } else {
    labelIndex = spec.economicsStateLabels.indexOf(row.label.economicsState ?? "");
  }
  if (labelIndex === -1) {
    throw new Error(`row ${row.rowId} has no label index for task kind ${row.taskKind}`);
  }

  return {
    rowId: row.rowId,
    taskKind: row.taskKind,
    canonicalModelId: row.canonicalModelId,
    modelFamily: row.modelFamily,
    providerId: row.providerId,
    continuous,
    categoricalIndex,
    labelIndex,
    splitEligible: row.provenance.sourceType !== "DERIVED_SIMULATION",
  };
}

export function manifestHashOf(parts: {
  spec: VectorizationSpec;
  vectorizedRows: VectorizedRow[];
  sourceRowHashes: Record<string, string>;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex");
}
