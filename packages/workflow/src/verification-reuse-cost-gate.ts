import {
  estimateVerifierReuseBenefit,
  isVerifierReuseCostEligible,
  FG12F_VERIFICATION_REUSE_COST_POLICY,
  FG12F_REUSE_COST_POLICY_VERSION,
  resolveOptimizationMode,
  detectReusableVerificationEvidence,
  type ForgeGreenOptimizationDecision,
  type GenericVerificationEvidence,
} from "@codeforge/forge-green";
import { isEvidenceCurrentlyValid, type VerificationEvidence, type VerificationPlan } from "./forge-verify.js";
import { narrowToStrictEvidence } from "./verification-evidence-reuse.js";

/**
 * FG-12F cost-gated reuse advisor — Candidate D's ACTIVE_SAFE execution policy, invoked by the
 * shared verification service (`runVerification`) between authoritative plan construction and
 * `executeVerificationPlan`. Evaluation order is fixed (spec §13): narrow candidate evidence,
 * canonical ForgeVerify validity FIRST, cost eligibility SECOND — cost never rescues invalid
 * evidence, and unknown cost always falls back to fresh verification (fail closed, §6).
 *
 * ForgeVerify answers "is this evidence still valid?"; this module only answers "is reusing the
 * valid evidence worth it?" (threshold policy `fg12f-verification-reuse-cost-gated-1`). It never
 * executes anything and never reports validity itself — the final authority remains
 * `executeVerificationPlan`'s own pre-existing reuse check at the authoritative boundary.
 */
export const FG12F_COST_GATE_RECEIPT_SCHEMA_VERSION = "fg12f-cost-gate-receipt-1";

/** The optimization state this receipt was produced under. `ACTIVE_SAFE_COST_GATED` is the
 * repository-conventional name for Candidate D's graduated mode: registry `ACTIVE_SAFE` narrowed
 * by the FG-12F cost policy — never an unconditional reuse. */
export type CostGateExecutionState = "ACTIVE_SAFE_COST_GATED" | "SHADOW_OBSERVING" | "DISABLED_OFF";

export type CostGateValidityResult = "valid" | "invalid" | "no_prior_evidence";

export type CostGateRejectionReason = "below_threshold" | "unknown_cost";

export type CostGateEntryOutcome =
  | "reused"
  | "fresh_executed"
  | "rejected_by_validity"
  | "rejected_by_cost"
  | "rejected_by_final_authoritative_boundary"
  | "observed_only";

/** Per-verifier production receipt (spec §17). Privacy: ids, digests, durations and statuses
 * only — never command output or workspace content. */
export interface VerificationReuseCostGateEntry {
  verifierId: string;
  verifierVersion: string | undefined;
  definitionDigest: string | undefined;
  /** The prior evidence record the canonical validity decision was made from. */
  validityEvidenceId: string | undefined;
  validityResult: CostGateValidityResult;
  costHistorySource: typeof FG12F_VERIFICATION_REUSE_COST_POLICY["costHistorySource"] | "unavailable";
  durationSampleCount: number;
  /** The validity candidate record's own measured historical duration (§17 "prior elapsedMs"). */
  priorElapsedMs: number | undefined;
  /** Median of the trusted recent historical samples — the estimated fresh execution cost. */
  estimatedFreshMs: number | undefined;
  estimatedReuseOverheadMs: number;
  expectedNetBenefitMs: number | undefined;
  costConfidence: "NO_DATA" | "SINGLE_SAMPLE" | "MULTI_SAMPLE";
  configuredThresholdMs: number;
  costEligible: boolean;
  costRejectionReason: CostGateRejectionReason | undefined;
  /** Valid AND cost-eligible — what was (or in SHADOW, would have been) handed to ForgeVerify. */
  proposedReuse: boolean;
  /** ForgeVerify's real `reusedEvidenceId` after execution — the only actual-reuse truth (§16). */
  actualReusedEvidenceId: string | undefined;
  freshExecutionStatus: string | undefined;
  actualFreshElapsedMs: number | undefined;
  /** Reference prevented time for ACTUAL reuse only: the reused record's own measured
   * `elapsedMs` — an estimate/reference, never claimed as a measured delta (§32). */
  referencePreventedTimeMs: number | undefined;
  outcome: CostGateEntryOutcome;
}

export interface VerificationReuseCostGateReceipt {
  receiptSchemaVersion: typeof FG12F_COST_GATE_RECEIPT_SCHEMA_VERSION;
  costPolicyVersion: typeof FG12F_REUSE_COST_POLICY_VERSION;
  optimizationPolicyVersion: string;
  executionState: CostGateExecutionState;
  runId: string;
  planId: string;
  workspacePath: string;
  createdAt: string;
  configuredThresholdMs: number;
  unknownCostBehavior: "FRESH_VERIFY";
  entries: readonly VerificationReuseCostGateEntry[];
  counts: {
    proposed: number;
    costEligible: number;
    actuallyReused: number;
    rejectedByValidity: number;
    rejectedByCost: number;
    rejectedByFinalAuthoritativeBoundary: number;
    freshlyExecuted: number;
  };
  /** Set when the advisor itself failed and verification fell back to fresh (§27). */
  fallbackReason: string | undefined;
  /** The ForgeGreen decision for the proposed (valid) candidates, cost-gate aware. */
  decision: ForgeGreenOptimizationDecision | undefined;
}

export interface CostGatedReuseAdvice {
  /** Evidence that may be handed to `executeVerificationPlan` — empty unless the kind resolved
   * to `ACTIVE_SAFE` and every element passed validity AND the cost gate. */
  reusableEvidence: readonly VerificationEvidence[];
  receipt: VerificationReuseCostGateReceipt;
}

interface PriorSample {
  evidence: VerificationEvidence;
  elapsedMs: number | undefined;
}

function collectDurationSamples(prior: readonly PriorSample[], plannedVerifierId: string): number[] {
  // §7: only durations from a materially identical verifier (id + version + definition digest)
  // and only successful executions (§4 "previous successful verifier elapsedMs") are trusted.
  // Workspace-wide recency is enforced by the most-recent-N window in the policy, and in
  // production the sample pool is session-scoped by the evidence source itself.
  const planned = prior.find((entry) => entry.evidence.verifierId === plannedVerifierId);
  const samples: Array<{ createdAt: string; elapsedMs: number }> = [];
  for (const entry of prior) {
    const evidence = entry.evidence;
    if (evidence.verifierId !== plannedVerifierId) continue;
    if (evidence.verifierVersion !== planned?.evidence.verifierVersion) continue;
    if (evidence.definitionDigest !== planned?.evidence.definitionDigest) continue;
    if (evidence.status !== "passed") continue;
    if (typeof entry.elapsedMs !== "number" || !Number.isFinite(entry.elapsedMs) || entry.elapsedMs < 0) continue;
    samples.push({ createdAt: typeof evidence.createdAt === "string" ? evidence.createdAt : "", elapsedMs: entry.elapsedMs });
  }
  samples.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return samples.map((sample) => sample.elapsedMs);
}

/**
 * Builds the FG-12F cost-gate receipt and (under ACTIVE_SAFE) the eligible reuse set. Never
 * throws: any internal failure is captured as `fallbackReason` with an empty reusable set, so an
 * optimization-infrastructure failure can never prevent verification (§27).
 */
export function adviseCostGatedReuse(params: {
  plan: VerificationPlan;
  priorEvidence: readonly GenericVerificationEvidence[];
  optimizationPolicyVersion?: string;
}): CostGatedReuseAdvice {
  const { plan } = params;
  const createdAt = new Date().toISOString();
  // Resolved outside the guarded body so the fallback receipt never has to guess the mode.
  const resolvedMode = resolveOptimizationMode("VERIFICATION_EVIDENCE_REUSE");
  const baseReceipt = {
    receiptSchemaVersion: FG12F_COST_GATE_RECEIPT_SCHEMA_VERSION,
    costPolicyVersion: FG12F_REUSE_COST_POLICY_VERSION,
    optimizationPolicyVersion: params.optimizationPolicyVersion ?? "fg9-optimization-1",
    runId: plan.runId,
    planId: plan.planId,
    workspacePath: plan.workspacePath,
    createdAt,
    configuredThresholdMs: FG12F_VERIFICATION_REUSE_COST_POLICY.costThresholdMs,
    unknownCostBehavior: FG12F_VERIFICATION_REUSE_COST_POLICY.unknownCostBehavior,
  } satisfies Omit<VerificationReuseCostGateReceipt, "entries" | "counts" | "executionState" | "decision" | "fallbackReason">;

  try {
    const mode = resolvedMode;
    if (mode === "OFF") {
      // §10: global OFF disables Candidate D immediately and cheaply — no evidence loading
      // happened on this path, and no receipt is produced.
      return {
        reusableEvidence: [],
        receipt: {
          ...baseReceipt,
          executionState: "DISABLED_OFF",
          entries: [],
          counts: emptyCounts(),
          fallbackReason: undefined,
          decision: undefined,
        },
      };
    }
    const executionState: CostGateExecutionState = mode === "ACTIVE_SAFE" ? "ACTIVE_SAFE_COST_GATED" : "SHADOW_OBSERVING";

    // §13 steps 1–2: obtain candidate evidence, strict narrowing (fail closed on malformed).
    const prior: PriorSample[] = [];
    const narrowedByVerifierId = new Map<string, VerificationEvidence>();
    const priorElapsedById = new Map<string, number>();
    for (const generic of params.priorEvidence) {
      const strict = narrowToStrictEvidence(generic);
      if (!strict) continue;
      prior.push({ evidence: strict, elapsedMs: typeof (generic as { elapsedMs?: unknown }).elapsedMs === "number" ? (generic as { elapsedMs: number }).elapsedMs : undefined });
      if (typeof prior[prior.length - 1]!.elapsedMs === "number") priorElapsedById.set(strict.evidenceId, prior[prior.length - 1]!.elapsedMs!);
      // First narrowed record wins as the validity candidate for its verifier — matching
      // `executeVerificationPlan`'s first-match reuse lookup.
      if (!narrowedByVerifierId.has(strict.verifierId)) narrowedByVerifierId.set(strict.verifierId, strict);
    }

    const reusableEvidence: VerificationEvidence[] = [];
    const entries: VerificationReuseCostGateEntry[] = [];
    const costEligibleEvidenceIds: string[] = [];
    const costRejectedEvidenceIds: string[] = [];

    for (const planned of plan.verifiers) {
      const candidate = narrowedByVerifierId.get(planned.verifierId);
      if (!candidate) {
        entries.push({
          verifierId: planned.verifierId,
          verifierVersion: planned.verifierVersion,
          definitionDigest: planned.definitionDigest,
          validityEvidenceId: undefined,
          validityResult: "no_prior_evidence",
          costHistorySource: "unavailable",
          durationSampleCount: 0,
          priorElapsedMs: undefined,
          estimatedFreshMs: undefined,
          estimatedReuseOverheadMs: FG12F_VERIFICATION_REUSE_COST_POLICY.estimatedReuseOverheadMs,
          expectedNetBenefitMs: undefined,
          costConfidence: "NO_DATA",
          configuredThresholdMs: FG12F_VERIFICATION_REUSE_COST_POLICY.costThresholdMs,
          costEligible: false,
          costRejectionReason: undefined,
          proposedReuse: false,
          actualReusedEvidenceId: undefined,
          freshExecutionStatus: undefined,
          actualFreshElapsedMs: undefined,
          referencePreventedTimeMs: undefined,
          outcome: "fresh_executed",
        });
        continue;
      }

      // §13 step 3: canonical ForgeVerify validity — authoritative, unmodified.
      const valid = isEvidenceCurrentlyValid(candidate, {
        workspacePath: plan.workspacePath,
        inputStateHash: plan.inputStateHash,
        definitionDigest: planned.definitionDigest,
      });
      if (!valid) {
        entries.push({
          verifierId: planned.verifierId,
          verifierVersion: planned.verifierVersion,
          definitionDigest: planned.definitionDigest,
          validityEvidenceId: candidate.evidenceId,
          validityResult: "invalid",
          costHistorySource: "unavailable",
          durationSampleCount: 0,
          priorElapsedMs: undefined,
          estimatedFreshMs: undefined,
          estimatedReuseOverheadMs: FG12F_VERIFICATION_REUSE_COST_POLICY.estimatedReuseOverheadMs,
          expectedNetBenefitMs: undefined,
          costConfidence: "NO_DATA",
          configuredThresholdMs: FG12F_VERIFICATION_REUSE_COST_POLICY.costThresholdMs,
          costEligible: false,
          costRejectionReason: undefined,
          proposedReuse: false,
          actualReusedEvidenceId: undefined,
          freshExecutionStatus: undefined,
          actualFreshElapsedMs: undefined,
          referencePreventedTimeMs: undefined,
          outcome: "rejected_by_validity",
        });
        continue;
      }

      // §13 step 4: performance eligibility — only ever asked about already-valid evidence.
      const samples = collectDurationSamples(prior, planned.verifierId);
      const estimate = estimateVerifierReuseBenefit({ priorElapsedMsSamples: samples });
      const costEligible = isVerifierReuseCostEligible(estimate);
      const costRejectionReason: CostGateRejectionReason | undefined = costEligible
        ? undefined
        : estimate.estimatedFreshMs === undefined
          ? "unknown_cost"
          : "below_threshold";
      const proposedReuse = costEligible;
      if (costEligible) {
        costEligibleEvidenceIds.push(candidate.evidenceId);
        if (executionState === "ACTIVE_SAFE_COST_GATED") reusableEvidence.push(candidate);
      } else {
        costRejectedEvidenceIds.push(candidate.evidenceId);
      }
      entries.push({
        verifierId: planned.verifierId,
        verifierVersion: planned.verifierVersion,
        definitionDigest: planned.definitionDigest,
        validityEvidenceId: candidate.evidenceId,
          validityResult: "valid",
          costHistorySource: estimate.costHistorySource,
          durationSampleCount: estimate.sampleCount,
          priorElapsedMs: priorElapsedById.get(candidate.evidenceId),
          estimatedFreshMs: estimate.estimatedFreshMs,
        estimatedReuseOverheadMs: estimate.estimatedReuseOverheadMs,
        expectedNetBenefitMs: estimate.expectedNetBenefitMs,
        costConfidence: estimate.confidence,
        configuredThresholdMs: FG12F_VERIFICATION_REUSE_COST_POLICY.costThresholdMs,
        costEligible,
        costRejectionReason,
        proposedReuse,
        actualReusedEvidenceId: undefined,
        freshExecutionStatus: undefined,
        actualFreshElapsedMs: undefined,
        referencePreventedTimeMs: undefined,
        outcome: proposedReuse ? (executionState === "ACTIVE_SAFE_COST_GATED" ? "reused" : "observed_only") : "rejected_by_cost",
      });
    }

    const decision = detectReusableVerificationEvidence({
      runId: plan.runId,
      sessionId: undefined,
      sustainabilityReceiptId: undefined,
      candidates: [...narrowedByVerifierId.values()]
        .filter((candidate) => plan.verifiers.some((planned) => planned.verifierId === candidate.verifierId))
        .map((candidate) => {
          const planned = plan.verifiers.find((entry) => entry.verifierId === candidate.verifierId)!;
          return {
            evidenceId: candidate.evidenceId,
            workspaceContentHash: candidate.inputStateHash,
            policyRevision: plan.policyVersion,
            command: candidate.commandDigest,
            dependencyStateHash: candidate.definitionDigest,
            forgeVerifyConfirmedValid: isEvidenceCurrentlyValid(candidate, {
              workspacePath: plan.workspacePath,
              inputStateHash: plan.inputStateHash,
              definitionDigest: planned.definitionDigest,
            }),
          };
        }),
      costGate: { costEligibleEvidenceIds, costRejectedEvidenceIds },
    });

    return {
      reusableEvidence,
      receipt: {
        ...baseReceipt,
        executionState,
        entries,
        counts: computeCounts(entries),
        fallbackReason: undefined,
        decision,
      },
    };
  } catch (error) {
    return {
      reusableEvidence: [],
      receipt: {
        ...baseReceipt,
        executionState: resolvedMode === "ACTIVE_SAFE" ? "ACTIVE_SAFE_COST_GATED" : resolvedMode === "SHADOW" ? "SHADOW_OBSERVING" : "DISABLED_OFF",
        entries: [],
        counts: emptyCounts(),
        fallbackReason: error instanceof Error ? error.message : String(error),
        decision: undefined,
      },
    };
  }
}

function emptyCounts(): VerificationReuseCostGateReceipt["counts"] {
  return { proposed: 0, costEligible: 0, actuallyReused: 0, rejectedByValidity: 0, rejectedByCost: 0, rejectedByFinalAuthoritativeBoundary: 0, freshlyExecuted: 0 };
}

function computeCounts(entries: readonly VerificationReuseCostGateEntry[]): VerificationReuseCostGateReceipt["counts"] {
  return {
    proposed: entries.filter((entry) => entry.proposedReuse).length,
    costEligible: entries.filter((entry) => entry.costEligible).length,
    actuallyReused: entries.filter((entry) => entry.actualReusedEvidenceId !== undefined).length,
    rejectedByValidity: entries.filter((entry) => entry.outcome === "rejected_by_validity").length,
    rejectedByCost: entries.filter((entry) => entry.outcome === "rejected_by_cost").length,
    rejectedByFinalAuthoritativeBoundary: entries.filter((entry) => entry.outcome === "rejected_by_final_authoritative_boundary").length,
    freshlyExecuted: entries.filter((entry) => entry.outcome === "fresh_executed").length,
  };
}

/**
 * Reconciles the pre-execution receipt with what ForgeVerify actually did (§16): the real
 * `reusedEvidenceId` from `VerifierRunResult` is the only actual-reuse truth — an advisor
 * proposal that the authoritative boundary did not accept is recorded as
 * `rejected_by_final_authoritative_boundary`, never as reuse. `runResultsByKey` maps the planned
 * structured verifierId to that verifier's run result.
 */
export function reconcileCostGateReceipt(
  receipt: VerificationReuseCostGateReceipt,
  runResultsByKey: ReadonlyMap<string, { reusedEvidenceId?: string; status: string; durationMs: number }>,
  freshElapsedMsByKey: ReadonlyMap<string, number | undefined>,
): VerificationReuseCostGateReceipt {
  const entries = receipt.entries.map((entry) => {
    const runResult = runResultsByKey.get(entry.verifierId);
    const actualReusedEvidenceId = runResult?.reusedEvidenceId;
    const actualFreshElapsedMs = actualReusedEvidenceId ? undefined : freshElapsedMsByKey.get(entry.verifierId);
    let outcome = entry.outcome;
    if (receipt.executionState === "ACTIVE_SAFE_COST_GATED") {
      if (entry.proposedReuse) {
        outcome = actualReusedEvidenceId ? "reused" : "rejected_by_final_authoritative_boundary";
      } else if (runResult) {
        outcome = entry.outcome; // rejected_by_validity / rejected_by_cost / fresh_executed stand
      }
    } else {
      outcome = entry.outcome; // SHADOW/OFF receipts stay observational
    }
    return {
      ...entry,
      actualReusedEvidenceId,
      freshExecutionStatus: actualReusedEvidenceId ? undefined : runResult?.status,
      actualFreshElapsedMs,
      // Reference prevented time for ACTUAL reuse: the reused record's own measured historical
      // duration — a reference, never claimed as a measured before/after delta (§17/§32).
      referencePreventedTimeMs: actualReusedEvidenceId ? entry.priorElapsedMs : undefined,
      outcome,
    } satisfies VerificationReuseCostGateEntry;
  });
  return { ...receipt, entries, counts: computeCounts(entries) };
}
