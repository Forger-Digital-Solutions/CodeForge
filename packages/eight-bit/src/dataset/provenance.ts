import { z } from "zod";

/**
 * Training-rights gate for the 8-Bit learned specialist (R3.5 §11). Legal permission to CALL a
 * model is not permission to TRAIN on its output; a row may only enter the 8-Bit training corpus
 * when its provenance proves an approved training-use state. The gate is enforced at build time
 * (row creation) and re-enforced at split-freeze time so no later pipeline stage can bypass it.
 */

export const TrainingUseStateSchema = z.enum([
  "TRAINING_USE_APPROVED",
  "TRAINING_USE_RESTRICTED",
  "TRAINING_USE_UNKNOWN",
  "TRAINING_USE_BLOCKED",
]);
export type TrainingUseState = z.infer<typeof TrainingUseStateSchema>;

export const DatasetSourceTypeSchema = z.enum([
  "R3_CORPUS_ATTEMPT",
  "QUALIFICATION_PROBE",
  "LIVE_CERTIFICATION",
  "FLEET_OBSERVATION",
  "FAILURE_REGISTRY",
  "DRIFT_EVENT",
  "DISCOVERY_CATALOG",
  "DERIVED_SIMULATION",
]);
export type DatasetSourceType = z.infer<typeof DatasetSourceTypeSchema>;

export const DatasetProvenanceSchema = z.object({
  sourceType: DatasetSourceTypeSchema,
  /** Repo-relative evidence paths and stable record ids that reproduce this row. */
  sourceRefs: z.array(z.string().min(1)).min(1),
  /** Provider whose API produced the underlying observation, if any (metadata provenance only). */
  originatingProvider: z.string().optional(),
  /** True when any third-party model OUTPUT CONTENT is embedded in the row. Structured metadata
   * (statuses, latencies, token counts) is not model output content. */
  containsModelOutputContent: z.boolean(),
  /** True when the row embeds content served by a provider whose terms forbid training use. */
  providerTermsRestrictTraining: z.boolean(),
  trainingUse: TrainingUseStateSchema,
  trainingUseRationale: z.string().min(1),
  containsPrivateSourceCode: z.boolean(),
  containsCredentials: z.boolean(),
  containsPersonalData: z.boolean(),
  /** Row ids this row was derived from (required for DERIVED_SIMULATION). */
  derivedFrom: z.array(z.string()).optional(),
  /** ISO timestamp of the evidence the row was extracted from (drives temporal splits). */
  evidenceObservedAt: z.string().datetime(),
});
export type DatasetProvenance = z.infer<typeof DatasetProvenanceSchema>;

export class TrainingUseViolationError extends Error {
  constructor(readonly rowId: string, readonly state: TrainingUseState) {
    super(`row ${rowId} has training-use state ${state} and may not enter the 8-Bit corpus`);
    this.name = "TrainingUseViolationError";
  }
}

/** Rows that may enter the training corpus: approved rights, no secrets, no private code. */
export function assertTrainingUseAllowed(row: {
  rowId: string;
  provenance: DatasetProvenance;
}): void {
  const p = row.provenance;
  if (p.trainingUse !== "TRAINING_USE_APPROVED") {
    throw new TrainingUseViolationError(row.rowId, p.trainingUse);
  }
  if (p.containsCredentials) {
    throw new TrainingUseViolationError(row.rowId, p.trainingUse);
  }
  if (p.containsPrivateSourceCode) {
    throw new TrainingUseViolationError(row.rowId, p.trainingUse);
  }
  if (p.containsModelOutputContent && p.providerTermsRestrictTraining) {
    throw new TrainingUseViolationError(row.rowId, p.trainingUse);
  }
}

/**
 * Default provenance for CodeForge-owned structured metadata: statuses, counters, latencies and
 * pass/fail outcomes observed by CodeForge's own certified pipeline. No third-party model output
 * content is embedded, so no provider-output training-rights question arises.
 */
export function structuredMetadataProvenance(input: {
  sourceType: DatasetSourceType;
  sourceRefs: string[];
  evidenceObservedAt: string;
  originatingProvider?: string;
  derivedFrom?: string[];
}): DatasetProvenance {
  return {
    sourceType: input.sourceType,
    sourceRefs: input.sourceRefs,
    originatingProvider: input.originatingProvider,
    containsModelOutputContent: false,
    providerTermsRestrictTraining: false,
    trainingUse: "TRAINING_USE_APPROVED",
    trainingUseRationale:
      "CodeForge-owned structured metadata only (statuses, counters, latencies, pass/fail); no third-party model output content embedded.",
    containsPrivateSourceCode: false,
    containsCredentials: false,
    containsPersonalData: false,
    derivedFrom: input.derivedFrom,
    evidenceObservedAt: input.evidenceObservedAt,
  };
}
