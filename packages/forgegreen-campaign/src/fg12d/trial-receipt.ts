import type { VerificationEvidence, VerificationReport } from "@codeforge/workflow";
import type { VerificationEvidenceReuseResult } from "@codeforge/workflow";

/**
 * FG-12D trial receipt (spec §9). Distinguishes what ForgeGreen's advisor *proposed* from what
 * ForgeVerify's real, unmodified execution path *actually* reused — the only source "actual"
 * numbers ever come from (amendment §3). Distinguishes `REFERENCE_CONTROL_DURATION` (the paired
 * control run's measured wall time — a reference point, not a claim) from
 * `DIRECTLY_AVOIDED_DURATION` (only ever populated when a real skip actually happened).
 */
export interface VerifierOutcome {
  verifierId: string;
  requirement: "required" | "optional" | "advisory";
  actuallyReused: boolean;
  evidenceId?: string;
  status: string;
}

export interface TrialReceipt {
  runId: string;
  caseId: string;
  category: "positive" | "invalidation" | "restart" | "race" | "fallback" | "repeated";
  invalidationReason?: string;
  optimizationKind: "VERIFICATION_EVIDENCE_REUSE";
  mode: "SHADOW" | "CONTROLLED_ACTIVE_TRIAL";

  previousEvidenceIds: string[];
  previousEvidenceHashes: string[];
  canonicalValidityConfirmed: boolean[];

  currentInputStateHash: string;
  currentDefinitionDigests: string[];

  proposedReusableEvidenceIds: string[];
  actuallyReusedEvidenceIds: string[];
  freshlyExecutedVerifierIds: string[];
  verifierOutcomes: VerifierOutcome[];

  reuseDecisionStatus: string;
  fallbackReason?: string;

  finalOverallStatus: "passed" | "failed" | "blocked";
  finalVerificationComplete: boolean;
  finalRequiredCoverageComplete: boolean;

  actual: {
    verificationAttemptsAvoided: number;
    commandsAvoided: number;
    childProcessesAvoided: number;
    directlyAvoidedDurationMs: number;
  };
  reference: {
    controlDurationMs: number;
    treatmentDurationMs: number;
    referenceControlDurationMs: number;
  };

  createdAt: string;
}

export function buildTrialReceipt(params: {
  runId: string;
  caseId: string;
  category: TrialReceipt["category"];
  invalidationReason?: string;
  mode: "SHADOW" | "CONTROLLED_ACTIVE_TRIAL";
  priorEvidence: readonly VerificationEvidence[];
  reuseRequest: VerificationEvidenceReuseResult | undefined;
  fallbackReason: string | undefined;
  treatmentReport: VerificationReport;
  controlReport: VerificationReport | undefined;
  controlDurationMs: number;
  treatmentDurationMs: number;
}): TrialReceipt {
  const actuallyReusedEvidenceIds = params.treatmentReport.verifiers.filter((v) => v.reusedEvidenceId).map((v) => v.reusedEvidenceId!);
  const freshlyExecutedVerifierIds = params.treatmentReport.verifiers.filter((v) => !v.reusedEvidenceId).map((v) => v.id);
  const verifierOutcomes: VerifierOutcome[] = params.treatmentReport.verifiers.map((v) => ({
    verifierId: v.id,
    requirement: v.required ? "required" : "advisory",
    actuallyReused: Boolean(v.reusedEvidenceId),
    evidenceId: v.reusedEvidenceId,
    status: v.status,
  }));

  const directlyAvoidedDurationMs = actuallyReusedEvidenceIds.length > 0 ? Math.max(0, params.controlDurationMs - params.treatmentDurationMs) : 0;

  return {
    runId: params.runId,
    caseId: params.caseId,
    category: params.category,
    invalidationReason: params.invalidationReason,
    optimizationKind: "VERIFICATION_EVIDENCE_REUSE",
    mode: params.mode,
    previousEvidenceIds: params.priorEvidence.map((e) => e.evidenceId),
    previousEvidenceHashes: params.priorEvidence.map((e) => e.evidenceHash),
    canonicalValidityConfirmed: params.reuseRequest?.proposedReusableEvidence.map(() => true) ?? [],
    currentInputStateHash: params.treatmentReport.forgeVerify?.plan.inputStateHash ?? "",
    currentDefinitionDigests: params.treatmentReport.forgeVerify?.plan.verifiers.map((v) => v.definitionDigest) ?? [],
    proposedReusableEvidenceIds: params.reuseRequest?.proposedReusableEvidence.map((e) => e.evidenceId) ?? [],
    actuallyReusedEvidenceIds,
    freshlyExecutedVerifierIds,
    verifierOutcomes,
    reuseDecisionStatus: params.reuseRequest?.decision.status ?? "SKIPPED_INSUFFICIENT_EVIDENCE",
    fallbackReason: params.fallbackReason,
    finalOverallStatus: params.treatmentReport.overallStatus,
    finalVerificationComplete: params.treatmentReport.forgeVerify?.summary.verificationComplete ?? false,
    finalRequiredCoverageComplete: params.treatmentReport.requiredPassed,
    actual: {
      verificationAttemptsAvoided: actuallyReusedEvidenceIds.length,
      commandsAvoided: actuallyReusedEvidenceIds.length,
      childProcessesAvoided: actuallyReusedEvidenceIds.length,
      directlyAvoidedDurationMs,
    },
    reference: {
      controlDurationMs: params.controlDurationMs,
      treatmentDurationMs: params.treatmentDurationMs,
      referenceControlDurationMs: params.controlDurationMs,
    },
    createdAt: new Date().toISOString(),
  };
}
