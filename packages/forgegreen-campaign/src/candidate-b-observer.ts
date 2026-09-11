import { detectDuplicateContextPageTransmission, fingerprint, type ContextPageTransmissionEvent } from "@codeforge/forge-green";
import type { ContextPlanResult } from "@codeforge/context";
import type { ObservationInput } from "./observation-store.js";
import { CANDIDATE_B_POLICY_VERSION, OBSERVATION_SCHEMA_VERSION } from "./policy.js";

/** One real `planNarrow` call, in turn order, within a simulated session. */
export interface TurnPlanResult {
  turnIndex: number;
  plan: ContextPlanResult;
}

export interface CandidateBParams {
  runId: string;
  taskId: string;
  certifiedSourceStateId: string;
  campaignHarnessId: string;
  turns: readonly TurnPlanResult[];
  controlCase?: string;
  diversityDimensions?: Record<string, string>;
  /** Observer-side cost of building/classifying these events, distinct from the real planner
   * call that produced them. Defaults to 0 (sub-millisecond in-process work). */
  observerOverheadMs?: number;
}

/**
 * Builds real Candidate B observations from consecutive `ContextPlanner.planNarrow` turns
 * (FG-11 amendment: no candidate-only synthetic evidence — every event comes from
 * `plan.pageClassifications`, the planner's own real output). Emits one observation per real
 * candidate pair (a page transmitted more than once across turns) by calling the existing,
 * unmodified `detectDuplicateContextPageTransmission` on that pair alone.
 */
export function observeCandidateB(params: CandidateBParams): ObservationInput[] {
  const events: ContextPageTransmissionEvent[] = [];
  for (const turn of params.turns) {
    for (const cls of turn.plan.pageClassifications) {
      if (cls.availability === "OMITTED") continue; // never transmitted — not a B candidate
      events.push({ pageId: cls.pageId, contentHash: cls.contentHash, workspaceRevision: turn.plan.receipt.repositoryGeneration, turnIndex: turn.turnIndex });
    }
  }

  const byPage = new Map<string, ContextPageTransmissionEvent[]>();
  for (const event of events) {
    const list = byPage.get(event.pageId) ?? [];
    list.push(event);
    byPage.set(event.pageId, list);
  }

  const observations: ObservationInput[] = [];
  for (const [pageId, occurrences] of byPage) {
    if (occurrences.length < 2) continue; // no real candidate pair — nothing to observe
    const sorted = [...occurrences].sort((a, b) => a.turnIndex - b.turnIndex);
    const first = sorted[0]!;
    for (const later of sorted.slice(1)) {
      const decision = detectDuplicateContextPageTransmission({
        runId: params.runId,
        sessionId: params.runId,
        sustainabilityReceiptId: undefined,
        events: [first, later],
      });
      const validated = decision.status === "PROPOSED" && decision.sourceEvidenceIds.length > 0;
      const identicalEvidence = later.contentHash === first.contentHash && later.workspaceRevision === first.workspaceRevision;
      // Independent recomputation of the same ground truth the detector itself reads — a
      // disagreement means the detector made an unsafe call, not that the campaign invented one.
      const unsafeFalsePositive = validated && !identicalEvidence;
      const invalidationReason = !validated
        ? later.contentHash !== first.contentHash
          ? "CONTENT_HASH_CHANGED"
          : later.workspaceRevision !== first.workspaceRevision
            ? "WORKSPACE_REVISION_CHANGED"
            : "UNKNOWN"
        : undefined;

      observations.push({
        candidateKind: "B",
        certifiedSourceStateId: params.certifiedSourceStateId,
        campaignHarnessId: params.campaignHarnessId,
        observationSchemaVersion: OBSERVATION_SCHEMA_VERSION,
        candidatePolicyVersion: CANDIDATE_B_POLICY_VERSION,
        runId: params.runId,
        taskId: params.taskId,
        productionOccurrenceId: `${pageId}:${later.turnIndex}`,
        evidenceFingerprint: fingerprint({ pageId, firstHash: first.contentHash, laterHash: later.contentHash, firstRev: first.workspaceRevision, laterRev: later.workspaceRevision }),
        classification: validated ? "VALIDATED" : "INVALIDATED",
        controlCase: params.controlCase,
        diversityDimensions: { ...params.diversityDimensions, ...(invalidationReason ? { invalidationReason } : {}) },
        unsafeFalsePositive,
        falsePositiveReason: unsafeFalsePositive ? "Declared duplicate when transmitted context actually differed" : undefined,
        projected: validated ? { pageTransmissions: 1 } : undefined,
        observerOverheadMs: params.observerOverheadMs ?? 0,
      });
    }
  }
  return observations;
}
