import type { FreeModelRecord } from "@codeforge/forge-zero";
import type { EightBitRole } from "../types.js";
import { createSampleFromModel, type TrainingSample } from "./dataset.js";

export type EightBitEvidenceSource = "qualification_receipt" | "health_record" | "capability_probe" | "benchmark";

/**
 * The training boundary accepts only structured, operator-authorized model evidence. Prompt
 * content, source files, credentials, and provider transcripts are intentionally not part of
 * this type, so the roster model cannot become a covert corpus for user data.
 */
export interface AuthorizedEightBitEvidence {
  model: FreeModelRecord;
  source: EightBitEvidenceSource;
  authorized: boolean;
  qualificationState?: "QUALIFIED" | "PROBATION" | "HARD_FAILURE" | "NOT_TESTED";
  roleSuitability?: Partial<Record<EightBitRole, number>>;
}

export function samplesFromAuthorizedEvidence(records: readonly AuthorizedEightBitEvidence[]): TrainingSample[] {
  const seen = new Set<string>();
  const samples: TrainingSample[] = [];
  for (const record of records) {
    if (!record.authorized) continue;
    const id = `${record.model.providerId}::${record.model.modelId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const sample = createSampleFromModel(
      record.model,
      record.qualificationState === "QUALIFIED",
      record.roleSuitability,
    );
    samples.push({
      ...sample,
      metadata: {
        ...sample.metadata,
        provenance: `authorized_${record.source}`,
      },
    });
  }
  return samples;
}
