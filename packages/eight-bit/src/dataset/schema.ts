import { z } from "zod";
import { DatasetProvenanceSchema } from "./provenance.js";

/**
 * Versioned 8-Bit specialist dataset schema (R3.5 §13). Every row is a structured observation
 * of CodeForge's own fleet/routing/capacity domain — never raw prompts, repository content or
 * third-party model output text. Missing feature values are `undefined` BY DESIGN: the fraction
 * of applicable features present is itself the `evidenceCompleteness` feature, so the model can
 * learn to abstain when evidence is insufficient rather than hallucinate confidence.
 */

export const DATASET_SCHEMA_VERSION = 1;

// --- Governance states (R3.5 §26/§27) ---------------------------------------------------------

export const EconomicsGovernanceStateSchema = z.enum([
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
]);
export type EconomicsGovernanceState = z.infer<typeof EconomicsGovernanceStateSchema>;

export const PrivacyGovernanceStateSchema = z.enum([
  "PRIVACY_APPROVED_PRIVATE",
  "PRIVACY_PUBLIC_ONLY",
  "PRIVACY_OPT_OUT_REQUIRED",
  "PRIVACY_ZDR_REQUIRED",
  "PRIVACY_BLOCKED",
  "PRIVACY_UNKNOWN",
]);
export type PrivacyGovernanceState = z.infer<typeof PrivacyGovernanceStateSchema>;

export const RouteHealthObservationSchema = z.enum([
  "HEALTHY",
  "DEGRADED",
  "RATE_LIMITED",
  "QUOTA_EXHAUSTED",
  "UNAVAILABLE",
  "HEALTH_UNKNOWN",
]);
export type RouteHealthObservation = z.infer<typeof RouteHealthObservationSchema>;

// --- Task kinds and labels ----------------------------------------------------------------------

export const DatasetTaskKindSchema = z.enum([
  "ROUTE_OUTCOME",
  "ROLE_SUITABILITY",
  "ECONOMICS_STATE",
]);
export type DatasetTaskKind = z.infer<typeof DatasetTaskKindSchema>;

export const RouteOutcomeLabelSchema = z.enum([
  "SUCCESS",
  "RATE_LIMITED",
  "QUOTA_EXHAUSTED",
  "HEALTH_MARKED_UNAVAILABLE",
  "AUTH_REQUIRED",
  "MODEL_ERROR",
  "CONTEXT_LIMIT",
]);
export type RouteOutcomeLabel = z.infer<typeof RouteOutcomeLabelSchema>;

export const RoleSuitabilityLabelSchema = z.enum([
  "QUALIFIED",
  "PROBATION",
  "NOT_QUALIFIED",
]);
export type RoleSuitabilityLabel = z.infer<typeof RoleSuitabilityLabelSchema>;

export const DatasetLabelSchema = z.object({
  routeOutcome: RouteOutcomeLabelSchema.optional(),
  roleSuitability: RoleSuitabilityLabelSchema.optional(),
  economicsState: EconomicsGovernanceStateSchema.optional(),
});
export type DatasetLabel = z.infer<typeof DatasetLabelSchema>;

// --- Features ------------------------------------------------------------------------------------

export const DatasetFeaturesSchema = z.object({
  contextLimitTokens: z.number().int().positive().optional(),
  toolSupport: z.boolean().optional(),
  structuredOutputSupport: z.boolean().optional(),
  visionSupport: z.boolean().optional(),
  advertisedRpm: z.number().positive().optional(),
  advertisedTpm: z.number().positive().optional(),
  advertisedDailyTokens: z.number().positive().optional(),
  observedRpm: z.number().min(0).optional(),
  observedTpm: z.number().min(0).optional(),
  /** Estimated fraction (0-2) of the daily token budget already consumed when observed.
   * Values above 1 are legitimate: a 429 may arrive only after the request crossed the wall. */
  dailyBudgetUsedRatio: z.number().min(0).max(2).optional(),
  /** Minutes elapsed since the provider's daily-quota window reset when observed. */
  minutesSinceDailyReset: z.number().min(0).optional(),
  requestsInObservation: z.number().int().min(0).optional(),
  inputTokensInObservation: z.number().min(0).optional(),
  outputTokensInObservation: z.number().min(0).optional(),
  role: z.string().optional(),
  taskType: z.string().optional(),
  latencyP50Ms: z.number().min(0).optional(),
  latencyP95Ms: z.number().min(0).optional(),
  errorRate: z.number().min(0).max(1).optional(),
  recentSuccessRate: z.number().min(0).max(1).optional(),
  qualificationAgeDays: z.number().min(0).optional(),
  driftScore: z.number().min(0).optional(),
  /** Deterministic policy states observed at evidence time (inputs, never learned outputs). */
  observedEconomicsState: EconomicsGovernanceStateSchema,
  observedPrivacyState: PrivacyGovernanceStateSchema,
  observedHealthState: RouteHealthObservationSchema,
  /** Fraction of applicable task features that were actually present (0-1). */
  evidenceCompleteness: z.number().min(0).max(1),
});
export type DatasetFeatures = z.infer<typeof DatasetFeaturesSchema>;

// --- Row -----------------------------------------------------------------------------------------

export const EightBitDatasetRowSchema = z.object({
  rowId: z.string().min(1),
  datasetSchemaVersion: z.literal(DATASET_SCHEMA_VERSION),
  taskKind: DatasetTaskKindSchema,
  providerId: z.string().min(1),
  providerModelId: z.string().min(1),
  canonicalModelId: z.string().min(1),
  modelFamily: z.string().min(1),
  features: DatasetFeaturesSchema,
  label: DatasetLabelSchema,
  provenance: DatasetProvenanceSchema,
});
export type EightBitDatasetRow = z.infer<typeof EightBitDatasetRowSchema>;

export function validateDatasetRow(row: unknown): EightBitDatasetRow {
  return EightBitDatasetRowSchema.parse(row);
}

/** Exactly one label dimension must be set, matching the row's task kind. */
export function rowLabelIsCoherent(row: EightBitDatasetRow): boolean {
  switch (row.taskKind) {
    case "ROUTE_OUTCOME":
      return row.label.routeOutcome !== undefined;
    case "ROLE_SUITABILITY":
      return row.label.roleSuitability !== undefined;
    case "ECONOMICS_STATE":
      return row.label.economicsState !== undefined;
  }
}
