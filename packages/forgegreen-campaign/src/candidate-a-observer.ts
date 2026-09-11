import { createDuplicateActionSupervisor, type DuplicateActionIdentity } from "@codeforge/server";
import { fingerprint } from "@codeforge/forge-green";
import type { ObservationInput } from "./observation-store.js";
import { CANDIDATE_A_POLICY_VERSION, OBSERVATION_SCHEMA_VERSION } from "./policy.js";

export interface CandidateAStep {
  tool: string;
  args: unknown;
  /** Real cost this tool call would have paid if actually re-executed — used only to report
   * ACTUAL avoided work on a genuine suppression, never combined with B/C/D's PROJECTED numbers. */
  simulatedBytes: number;
  simulatedMs: number;
  /** A real workspace-mutating action happened immediately before this step (invalidates any
   * prior identical read's suppression eligibility). */
  mutationBefore?: boolean;
}

export interface CandidateAParams {
  runId: string;
  taskId: string;
  certifiedSourceStateId: string;
  campaignHarnessId: string;
  steps: readonly CandidateAStep[];
  controlCase?: string;
  diversityDimensions?: Record<string, string>;
}

/**
 * Candidate A positive control (ACTIVE_SAFE, unaffected by FG-11): runs a real read-only tool
 * sequence through the actual `DuplicateActionSupervisor` production class — the same one
 * `agent-runtime.ts` uses — and records ACTUAL prevented duplicate work, kept in a ledger
 * entirely separate from B/C/D's PROJECTED numbers.
 */
export function observeCandidateA(params: CandidateAParams): ObservationInput[] {
  const supervisor = createDuplicateActionSupervisor({ workstreamScope: params.taskId });
  const observations: ObservationInput[] = [];

  params.steps.forEach((step, stepIndex) => {
    if (step.mutationBefore) supervisor.recordMutation();
    const identity: DuplicateActionIdentity = { tool: step.tool, canonicalArguments: step.args };
    const decision = supervisor.classify(identity);
    const executionId = `${params.runId}-${stepIndex}`;
    const productionOccurrenceId = `${supervisor.identityKey(identity)}:${stepIndex}`;
    const evidenceFingerprint = fingerprint({ tool: step.tool, args: step.args, decisionAction: decision.action });
    const isReadOnly = supervisor.isReadOnly(step.tool);

    if (decision.action === "suppress") {
      // A mutating tool must never reach "suppress" — this is the invariant proof (spec §17).
      const unsafeFalsePositive = !isReadOnly;
      observations.push({
        candidateKind: "A",
        certifiedSourceStateId: params.certifiedSourceStateId,
        campaignHarnessId: params.campaignHarnessId,
        observationSchemaVersion: OBSERVATION_SCHEMA_VERSION,
        candidatePolicyVersion: CANDIDATE_A_POLICY_VERSION,
        runId: params.runId,
        taskId: params.taskId,
        productionOccurrenceId,
        evidenceFingerprint,
        classification: "VALIDATED",
        controlCase: params.controlCase,
        diversityDimensions: { ...params.diversityDimensions, decisionAction: decision.action },
        unsafeFalsePositive,
        falsePositiveReason: unsafeFalsePositive ? "A mutating tool call was suppressed" : undefined,
        actual: { toolExecutionsPrevented: 1, bytesReplayed: step.simulatedBytes, msSaved: step.simulatedMs },
        observerOverheadMs: 0,
      });
      supervisor.recordReadResult(identity, "replayed-prior-output", true, decision.priorExecutionId);
      return;
    }

    if (decision.action === "execute" || decision.action === "execute_retry_failed") {
      if (isReadOnly) supervisor.recordReadResult(identity, "ok", true, executionId);
      else supervisor.recordMutationExecution(identity, true);
      observations.push({
        candidateKind: "A",
        certifiedSourceStateId: params.certifiedSourceStateId,
        campaignHarnessId: params.campaignHarnessId,
        observationSchemaVersion: OBSERVATION_SCHEMA_VERSION,
        candidatePolicyVersion: CANDIDATE_A_POLICY_VERSION,
        runId: params.runId,
        taskId: params.taskId,
        productionOccurrenceId,
        evidenceFingerprint,
        classification: "INVALIDATED",
        controlCase: params.controlCase,
        diversityDimensions: { ...params.diversityDimensions, decisionAction: decision.action },
        unsafeFalsePositive: false,
        observerOverheadMs: 0,
      });
      return;
    }

    // "escalate" — a no-progress loop was correctly surfaced instead of silently suppressed.
    observations.push({
      candidateKind: "A",
      certifiedSourceStateId: params.certifiedSourceStateId,
      campaignHarnessId: params.campaignHarnessId,
      observationSchemaVersion: OBSERVATION_SCHEMA_VERSION,
      candidatePolicyVersion: CANDIDATE_A_POLICY_VERSION,
      runId: params.runId,
      taskId: params.taskId,
      productionOccurrenceId,
      evidenceFingerprint,
      classification: "INCOMPLETE",
      controlCase: params.controlCase,
      diversityDimensions: { ...params.diversityDimensions, decisionAction: decision.action },
      unsafeFalsePositive: false,
      observerOverheadMs: 0,
    });
  });

  return observations;
}
