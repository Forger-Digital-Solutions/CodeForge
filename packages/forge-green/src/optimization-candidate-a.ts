import { createOptimizationDecision, createOptimizationReceipt, finalizeOptimizationDecision, finalizeOptimizationReceipt } from "./optimization-decision.js";
import type { ForgeGreenOptimizationDecision, ForgeGreenOptimizationReceipt } from "./optimization-types.js";

/**
 * Candidate A — duplicate read-only tool reuse. Composes the ALREADY ACTIVE, already-certified
 * FG-1C `DuplicateActionSupervisor` (`packages/server/src/duplicate-suppression.ts`): this file
 * builds NO new suppression logic and introduces NO new execution-path risk. It only wraps
 * suppressions that already happened into the FG-9 decision/receipt provenance framework. This
 * is why Candidate A, alone among the four Phase 4 candidate classes, is safe to graduate to
 * `ACTIVE_SAFE` this phase — "active" here describes governance/accounting, not new runtime
 * behavior.
 */
export interface DuplicateToolSuppressionEvent {
  tool: string;
  /** `DuplicateActionSupervisor.identityKey(...)` — a hash, never raw arguments. */
  identityKeyHash: string;
  /** `DuplicateDecision.priorExecutionId` when the "suppress" branch fired — an id reference,
   * never the replayed content itself. */
  priorExecutionId: string;
  /**
   * Byte length of the replayed prior output, when known — a SIZE, never the content.
   *
   * R21 correction: these bytes are NOT avoided model context. FG-1C replays the prior
   * authoritative result to the model (with a provenance prefix), so the model receives them
   * again; what is avoided is the tool dispatch (the disk read / search) that would have produced
   * them. The controlled A/B (docs/evidence/r21-intelligence-closure/02-forgegreen) measured
   * model-visible bytes ON >= OFF for every task with suppressions. The field keeps its name for
   * event compatibility but is accounted below as `replayedBytes`, never as `bytesAvoided`.
   */
  avoidedBytes: number | undefined;
}

export interface BuildDuplicateToolReuseResult {
  decision: ForgeGreenOptimizationDecision;
  receipt: ForgeGreenOptimizationReceipt;
}

/** Returns `undefined` when there is nothing to report (no suppression occurred this run) —
 * never a zero-value "applied" decision standing in for "nothing happened". */
export function buildDuplicateToolReuseDecision(params: {
  runId: string;
  sessionId: string | undefined;
  sustainabilityReceiptId: string | undefined;
  events: DuplicateToolSuppressionEvent[];
}): BuildDuplicateToolReuseResult | undefined {
  if (params.events.length === 0) return undefined;

  const replayedBytesValues = params.events.map((e) => e.avoidedBytes).filter((v): v is number => typeof v === "number");
  const replayedBytes = replayedBytesValues.length === params.events.length ? replayedBytesValues.reduce((a, b) => a + b, 0) : undefined;

  const decision = createOptimizationDecision({
    runId: params.runId,
    sessionId: params.sessionId,
    kind: "DUPLICATE_READ_ONLY_TOOL_REUSE",
    targetResource: "read_only_tool_dispatch",
    sourceEvidenceIds: params.events.map((e) => `${e.identityKeyHash}:${e.priorExecutionId}`),
    sustainabilityReceiptId: params.sustainabilityReceiptId,
    expectedEffect: {
      avoidedRequests: undefined,
      avoidedTokens: undefined,
      // The replay retransmits the prior output to the model: no context bytes are avoided.
      avoidedBytes: undefined,
      avoidedToolExecutions: params.events.length,
      avoidedVerificationReruns: undefined,
      timeReductionMs: undefined,
    },
    confidence: "DIRECT",
    safetyGuards: {
      redundancyRationale:
        "Identical read-only tool call (same tool + canonical arguments + workstream scope) detected against unchanged workspace state by the FG-1C DuplicateActionSupervisor's state-version-bound identity key.",
      invariant:
        "The workspace state version must not have advanced (no mutating action executed, no steer consumed) between the original call and the suppressed duplicate; FG-1C enforces this identity binding, not FG-9.",
      verificationProof: undefined,
      reasonCodes: ["FG1C_STATE_VERSION_BOUND_IDENTITY_MATCH", ...(replayedBytes === undefined ? [] : [`REPLAYED_TO_MODEL_BYTES=${replayedBytes}`])],
    },
  });
  const finalizedDecision = finalizeOptimizationDecision(decision);

  const receipt = createOptimizationReceipt({
    decision: finalizedDecision,
    beforeSustainabilityReceiptId: undefined,
    afterSustainabilityReceiptId: params.sustainabilityReceiptId,
    resourceDelta: {
      basis: "simulated",
      requestsAvoided: undefined,
      tokensAvoided: undefined,
      bytesAvoided: undefined,
      toolExecutionsAvoided: params.events.length,
      verificationRerunsAvoided: undefined,
      wallClockMsDelta: undefined,
    },
    verificationEvidenceRef: undefined,
    qualityResult: "EQUIVALENT",
    survivedValidation: true,
    rollbackStatus: "NOT_APPLICABLE",
  });

  return { decision: finalizedDecision, receipt: finalizeOptimizationReceipt(receipt) };
}
