import { detectOptionalPrefetchSuppression, fingerprint, type OptionalPrefetchCandidate } from "@codeforge/forge-green";
import type { ObservationInput } from "./observation-store.js";
import { CANDIDATE_C_POLICY_VERSION, OBSERVATION_SCHEMA_VERSION } from "./policy.js";
import type { TurnPlanResult } from "./candidate-b-observer.js";

export interface CandidateCParams {
  runId: string;
  taskId: string;
  certifiedSourceStateId: string;
  campaignHarnessId: string;
  turns: readonly TurnPlanResult[];
  controlCase?: string;
  diversityDimensions?: Record<string, string>;
  observerOverheadMs?: number;
}

/**
 * Builds real Candidate C observations directly from the planner's own `pageClassifications`
 * (FG-11 hardening amendment §3 — ForgeGreen observes optionality, it never decides it). A
 * classification of `INSUFFICIENT` never gets forced into a detector call at all: it is recorded
 * as `INSUFFICIENT_EVIDENCE` outright, since the detector has no representation for "unknown."
 */
export function observeCandidateC(params: CandidateCParams): ObservationInput[] {
  const observations: ObservationInput[] = [];
  for (const turn of params.turns) {
    for (const cls of turn.plan.pageClassifications) {
      const dims = {
        ...params.diversityDimensions,
        optionality: cls.optionality,
        availability: cls.availability,
      };
      const productionOccurrenceId = `${cls.pageId}:${turn.turnIndex}`;
      const evidenceFingerprint = fingerprint({ pageId: cls.pageId, optionality: cls.optionality, availability: cls.availability, contentHash: cls.contentHash });

      if (cls.optionality === "INSUFFICIENT") {
        observations.push({
          candidateKind: "C",
          certifiedSourceStateId: params.certifiedSourceStateId,
          campaignHarnessId: params.campaignHarnessId,
          observationSchemaVersion: OBSERVATION_SCHEMA_VERSION,
          candidatePolicyVersion: CANDIDATE_C_POLICY_VERSION,
          runId: params.runId,
          taskId: params.taskId,
          productionOccurrenceId,
          evidenceFingerprint,
          classification: "INSUFFICIENT_EVIDENCE",
          controlCase: params.controlCase,
          diversityDimensions: dims,
          unsafeFalsePositive: false,
          observerOverheadMs: params.observerOverheadMs ?? 0,
        });
        continue;
      }

      const candidate: OptionalPrefetchCandidate = {
        pageId: cls.pageId,
        required: cls.optionality === "REQUIRED",
        alreadyValidlyAvailable: cls.availability === "REUSED",
      };
      const decision = detectOptionalPrefetchSuppression({
        runId: params.runId,
        sessionId: params.runId,
        sustainabilityReceiptId: undefined,
        candidates: [candidate],
      });
      const validated = decision.status === "PROPOSED" && decision.sourceEvidenceIds.length > 0;
      // Structural invariant: VALIDATED can only ever come from required=false. A VALIDATED
      // decision built on a REQUIRED page would be an unsafe suppressible classification.
      const unsafeFalsePositive = validated && candidate.required;
      const invalidationReason = !validated
        ? candidate.required
          ? "REQUIRED"
          : "NOT_YET_VALIDLY_AVAILABLE"
        : undefined;

      observations.push({
        candidateKind: "C",
        certifiedSourceStateId: params.certifiedSourceStateId,
        campaignHarnessId: params.campaignHarnessId,
        observationSchemaVersion: OBSERVATION_SCHEMA_VERSION,
        candidatePolicyVersion: CANDIDATE_C_POLICY_VERSION,
        runId: params.runId,
        taskId: params.taskId,
        productionOccurrenceId,
        evidenceFingerprint,
        classification: validated ? "VALIDATED" : "INVALIDATED",
        controlCase: params.controlCase,
        diversityDimensions: { ...dims, ...(invalidationReason ? { invalidationReason } : {}) },
        unsafeFalsePositive,
        falsePositiveReason: unsafeFalsePositive ? "Declared suppressible while the planner classified the page REQUIRED" : undefined,
        projected: validated ? { prefetchToolExecutions: 1 } : undefined,
        observerOverheadMs: params.observerOverheadMs ?? 0,
      });
    }
  }
  return observations;
}
