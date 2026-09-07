import type {
  DiffEntry,
  FailureAnalysis,
  ReviewDecision,
  VerificationResult,
  WorkflowPlan,
} from "./types.js";
import { verificationFailed } from "./verification-service.js";
import type { VerificationSummary } from "./forge-verify.js";
import {
  FORGE_GREEN_VERIFICATION_POLICY_VERSION,
  type VerificationPolicyDecision,
  type VerificationPolicyReceipt,
} from "@codeforge/forge-green";

/**
 * Completion is a lifecycle transition subject to enforcement, not a claim the agent gets to make.
 * Every reason a run may not call itself done is enumerated here so the decision is inspectable,
 * testable, and reachable without a model in the loop.
 */
export type CompletionBlockerCode =
  | "verification_not_run"
  | "verification_failed"
  | "verification_policy_insufficient"
  | "review_rejected"
  | "no_effective_change"
  | "budget_exhausted"
  | "plan_steps_unfinished"
  | "verification_not_current"
  | "approval_pending"
  | "question_pending";

export type CompletionBlockerSeverity = "blocking" | "advisory";

export interface CompletionBlocker {
  code: CompletionBlockerCode;
  severity: CompletionBlockerSeverity;
  message: string;
  evidence?: string;
}

export interface CompletionPolicy {
  /** A run that verified nothing has proven nothing; it may not report success. */
  requireVerification: boolean;
  /** Review findings marked `blocking` (e.g. a modified secret file) hold the run open. */
  requireCleanReview: boolean;
  /** Edit steps reported complete must correspond to a real diff. */
  requireEffectiveChange: boolean;
  /** Every non-skipped plan step must have reached a terminal, non-failed state. */
  requireFinishedPlan: boolean;
}

export const DEFAULT_COMPLETION_POLICY: CompletionPolicy = {
  requireVerification: true,
  requireCleanReview: true,
  requireEffectiveChange: true,
  requireFinishedPlan: true,
};

export interface CompletionGateInput {
  plan: WorkflowPlan;
  verification: VerificationResult;
  analysis: FailureAnalysis;
  review: ReviewDecision;
  policy?: Partial<CompletionPolicy>;
  /**
   * The executor stopped because it ran out of iterations, time, or repair attempts rather than
   * because it finished. Exhausting a budget is never success.
   */
  budgetExhausted?: boolean;
  budgetDetail?: string;
  /** ForgeVerify evidence is evaluated before legacy reports and remains distinct from completion. */
  verificationSummary?: VerificationSummary;
  /** FG-5 verification policy decision or receipt evaluating obligation sufficiency. */
  verificationPolicyDecision?: VerificationPolicyDecision | VerificationPolicyReceipt;
  /**
   * CF-17 completion binding: `verifiedExecutionRevision` is the execution/plan revision the
   * ForgeVerify evidence was produced for; `currentExecutionRevision` is the authoritative
   * revision after any steering. Verification of revision N can never authorize completion of
   * revision N+1 — the gate blocks instead of silently reusing stale authority.
   */
  currentExecutionRevision?: number;
  verifiedExecutionRevision?: number;
  /** Current workspace identity used to independently reject a stale sufficient decision. */
  currentVerificationInputStateHash?: string;
  /** Independent lifecycle authorities remain blocking even after verification is sufficient. */
  approvalPending?: boolean;
  questionPending?: boolean;
}

/**
 * `failed` means something ran and broke. `blocked` means the work may be fine but the runtime
 * cannot prove it — the honest terminal state for "done, unverified", which must never be reported
 * to a caller as success.
 */
export type CompletionOutcome = "completed" | "blocked" | "failed";

export interface CompletionGateDecision {
  outcome: CompletionOutcome;
  blockers: CompletionBlocker[];
  advisories: CompletionBlocker[];
  rationale: string;
}

function resolvePolicy(policy?: Partial<CompletionPolicy>): CompletionPolicy {
  return { ...DEFAULT_COMPLETION_POLICY, ...(policy ?? {}) };
}

function truncate(value: string, max = 400): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function collectVerificationBlockers(
  verification: VerificationResult,
  analysis: FailureAnalysis,
  policy: CompletionPolicy,
): CompletionBlocker[] {
  const report = verification as unknown as import("./types.js").VerificationReport;
  if (report.forgeVerify) {
    return report.verifiers.filter((verifier) => !verifier.required && verifier.status !== "passed").map((verifier) => ({
      code: "verification_failed" as const,
      severity: "advisory" as const,
      message: `Advisory verifier '${verifier.id}' (${verifier.kind}) failed: ${verifier.command} (exit ${verifier.exitCode}).`,
      evidence: truncate(verifier.output),
    }));
  }
  if (report.verifiers && Array.isArray(report.verifiers)) {
    const blockers: CompletionBlocker[] = [];
    const failedRequired = report.verifiers.filter(
      (v) => v.required && (v.status === "failed" || v.exitCode !== 0 || v.failed > 0),
    );
    const failedAdvisory = report.verifiers.filter(
      (v) => !v.required && (v.status === "failed" || v.exitCode !== 0 || v.failed > 0),
    );

    for (const v of failedRequired) {
      blockers.push({
        code: "verification_failed",
        severity: "blocking",
        message: `Required verifier '${v.id}' (${v.kind}) failed: ${v.command} (exit ${v.exitCode}, ${v.failed} failures).`,
        evidence: truncate(v.failures?.map((f) => f.message).join("\n") || v.output),
      });
    }

    for (const v of failedAdvisory) {
      blockers.push({
        code: "verification_failed",
        severity: "advisory",
        message: `Advisory verifier '${v.id}' (${v.kind}) failed: ${v.command} (exit ${v.exitCode}).`,
        evidence: truncate(v.output),
      });
    }

    if (report.notConfigured || report.verifiers.length === 0) {
      blockers.push({
        code: "verification_not_run",
        severity: policy.requireVerification ? "blocking" : "advisory",
        message:
          "No verification command ran in this workspace, so the change is unproven. Configure a verification command or accept the result explicitly.",
        evidence: report.output,
      });
    }

    return blockers;
  }

  if (verificationFailed(verification)) {
    return [
      {
        code: "verification_failed",
        severity: "blocking",
        message: `Verification failed: ${verification.failed} failed, exit ${verification.exitCode}.`,
        evidence: truncate(analysis.summary || verification.output),
      },
    ];
  }

  if (verification.notConfigured) {
    const blocker: CompletionBlocker = {
      code: "verification_not_run",
      severity: policy.requireVerification ? "blocking" : "advisory",
      message:
        "No verification command ran in this workspace, so the change is unproven. Configure a verification command or accept the result explicitly.",
      evidence: verification.command ? `Attempted: ${verification.command}` : undefined,
    };
    return [blocker];
  }

  return [];
}

function collectForgeVerifyBlockers(summary: VerificationSummary | undefined, verification: VerificationResult): CompletionBlocker[] {
  if (!summary) return [];
  if (summary.verificationComplete) return [];
  const reason = summary.reasons[0] ?? "missing";
  const code: CompletionBlockerCode = reason === "failed" ? "verification_failed" : "verification_not_run";
  const report = verification as import("./types.js").VerificationReport;
  const failed = report.verifiers?.find((verifier) => verifier.required && verifier.status !== "passed");
  return [{
    code,
    severity: "blocking",
    message: failed
      ? `Required verifier '${failed.id}' (${failed.kind}) did not produce current PASS evidence (${failed.status}).`
      : `ForgeVerify has not satisfied ${summary.missingCount} required verifier obligation(s): ${summary.missingRequiredVerifiers.join(", ") || "none"}.`,
    evidence: `plan=${summary.planId}; reasons=${summary.reasons.join(",") || "missing"}`,
  }];
}

function collectVerificationPolicyBlockers(
  policyDecision: VerificationPolicyDecision | VerificationPolicyReceipt | undefined,
  policy: CompletionPolicy,
  currentExecutionRevision?: number,
  currentVerificationInputStateHash?: string,
): CompletionBlocker[] {
  if (!policyDecision) return [];
  const outcome = "outcome" in policyDecision ? policyDecision.outcome : policyDecision.decision;
  const receipt = "receipt" in policyDecision ? policyDecision.receipt : policyDecision;
  const staleIdentity =
    receipt.policyVersion !== FORGE_GREEN_VERIFICATION_POLICY_VERSION ||
    (currentExecutionRevision !== undefined && receipt.revision !== undefined && receipt.revision !== currentExecutionRevision) ||
    (currentVerificationInputStateHash !== undefined && receipt.inputStateHash !== undefined && receipt.inputStateHash !== currentVerificationInputStateHash);
  if (outcome === "SUFFICIENT" && !staleIdentity) return [];
  if (staleIdentity) {
    return [{
      code: "verification_not_current",
      severity: "blocking",
      message: "Verification policy evidence does not match the current policy, execution revision, or workspace content.",
      evidence: `policy=${receipt.policyVersion}; revision=${receipt.revision ?? "none"}; input=${receipt.inputStateHash ?? "none"}`,
    }];
  }
  if (outcome === "FAILED") {
    return [{
      code: "verification_failed",
      severity: "blocking",
      message: `Verification policy evaluation failed: ${"rationale" in policyDecision ? policyDecision.rationale : "failed obligations"}`,
      evidence: `level=${policyDecision.level}; reasons=${policyDecision.reasonCodes.join(",")}`,
    }];
  }
  if (outcome === "STALE") {
    return [{
      code: "verification_not_current",
      severity: "blocking",
      message: `Verification policy decision is stale: ${"rationale" in policyDecision ? policyDecision.rationale : "stale evidence"}`,
      evidence: `level=${policyDecision.level}; reasons=${policyDecision.reasonCodes.join(",")}`,
    }];
  }
  if (outcome === "BLOCKED") {
    return [{
      code: "verification_not_run",
      severity: policy.requireVerification ? "blocking" : "advisory",
      message: `Verification was blocked: ${"rationale" in policyDecision ? policyDecision.rationale : "blocked execution"}`,
      evidence: `level=${policyDecision.level}; reasons=${policyDecision.reasonCodes.join(",")}`,
    }];
  }
  return [{
    code: "verification_not_run",
    severity: policy.requireVerification ? "blocking" : "advisory",
    message: `Verification is insufficient for required level ${policyDecision.level}: ${"rationale" in policyDecision ? policyDecision.rationale : "missing required evidence"}`,
    evidence: `level=${policyDecision.level}; reasons=${policyDecision.reasonCodes.join(",")}`,
  }];
}

function collectReviewBlockers(review: ReviewDecision, policy: CompletionPolicy): CompletionBlocker[] {
  const findings = review.findings ?? [];
  const blocking = findings.filter((f) => f.severity === "blocking");
  const advisory = findings.filter((f) => f.severity !== "blocking");

  const blockers: CompletionBlocker[] = [];

  if (blocking.length > 0) {
    blockers.push({
      code: "review_rejected",
      severity: policy.requireCleanReview ? "blocking" : "advisory",
      message: `Independent diff review raised ${blocking.length} blocking finding(s).`,
      evidence: truncate(blocking.map((f) => f.message).join(" | ")),
    });
  }

  if (advisory.length > 0) {
    blockers.push({
      code: "review_rejected",
      severity: "advisory",
      message: `Independent diff review raised ${advisory.length} advisory finding(s).`,
      evidence: truncate(advisory.map((f) => f.message).join(" | ")),
    });
  }

  return blockers;
}

function collectChangeBlockers(
  plan: WorkflowPlan,
  review: ReviewDecision,
  policy: CompletionPolicy,
): CompletionBlocker[] {
  if (!policy.requireEffectiveChange) return [];

  const claimedEdits = plan.steps.filter(
    (s) => (s.kind === "edit" || s.kind === "write") && s.status === "completed",
  );
  const diffCount = (review.diffs ?? (review as unknown as { diffEntries?: DiffEntry[] }).diffEntries ?? []).length;
  if (claimedEdits.length === 0 || diffCount > 0) return [];

  return [
    {
      code: "no_effective_change",
      severity: "blocking",
      message: `Workflow reported ${claimedEdits.length} edit step(s) complete, but the review produced no diff. An edit that changed nothing cannot complete.`,
      evidence: claimedEdits.map((s) => s.targetPath ?? s.id).join(", "),
    },
  ];
}

function collectPlanBlockers(plan: WorkflowPlan, policy: CompletionPolicy): CompletionBlocker[] {
  const unfinished = plan.steps.filter((s) => s.status === "failed" || s.status === "blocked");
  if (unfinished.length === 0) return [];

  return [
    {
      code: "plan_steps_unfinished",
      severity: policy.requireFinishedPlan ? "blocking" : "advisory",
      message: `${unfinished.length} plan step(s) did not finish successfully.`,
      evidence: unfinished.map((s) => `${s.id}:${s.status}`).join(", "),
    },
  ];
}

/**
 * The single completion authority for an autonomous run. Pure and deterministic: given the same
 * evidence it always returns the same verdict, and no model output can influence it.
 */
export function evaluateCompletion(input: CompletionGateInput): CompletionGateDecision {
  const policy = resolvePolicy(input.policy);
  const candidates: CompletionBlocker[] = [];

  if (input.budgetExhausted) {
    candidates.push({
      code: "budget_exhausted",
      severity: "blocking",
      message: "The run stopped because it exhausted its execution budget, not because it finished.",
      evidence: input.budgetDetail,
    });
  }

  if (input.approvalPending) {
    candidates.push({
      code: "approval_pending",
      severity: "blocking",
      message: "Completion is waiting for the required approval; verification cannot grant approval.",
    });
  }
  if (input.questionPending) {
    candidates.push({
      code: "question_pending",
      severity: "blocking",
      message: "Completion is waiting for an answer to a required user question; verification cannot resolve it.",
    });
  }

  const report = input.verification as import("./types.js").VerificationReport;
  const policyDecision = input.verificationPolicyDecision ?? (report as unknown as { policyDecision?: VerificationPolicyDecision })?.policyDecision ?? report.forgeVerify?.policyDecision;
  candidates.push(...collectVerificationPolicyBlockers(
    policyDecision,
    policy,
    input.currentExecutionRevision,
    input.currentVerificationInputStateHash,
  ));
  candidates.push(...collectForgeVerifyBlockers(input.verificationSummary ?? report.forgeVerify?.summary, input.verification));
  candidates.push(...collectVerificationBlockers(input.verification, input.analysis, policy));
  candidates.push(...collectReviewBlockers(input.review, policy));
  candidates.push(...collectChangeBlockers(input.plan, input.review, policy));
  candidates.push(...collectPlanBlockers(input.plan, policy));

  if (
    input.currentExecutionRevision !== undefined &&
    input.verifiedExecutionRevision !== undefined &&
    input.currentExecutionRevision !== input.verifiedExecutionRevision
  ) {
    candidates.push({
      code: "verification_not_current",
      severity: "blocking",
      message: `Verification covers execution revision ${input.verifiedExecutionRevision}, but the authoritative plan revision is ${input.currentExecutionRevision}. The revision change requires fresh verification before completion.`,
    });
  }

  const blockers = candidates.filter((b) => b.severity === "blocking");
  const advisories = candidates.filter((b) => b.severity === "advisory");

  if (blockers.length === 0) {
    return {
      outcome: "completed",
      blockers,
      advisories,
      rationale: "All required completion checks passed.",
    };
  }

  const outcome: CompletionOutcome = blockers.some((b) => b.code === "verification_failed")
    ? "failed"
    : "blocked";

  return {
    outcome,
    blockers,
    advisories,
    rationale: blockers.map((b) => `${b.code}: ${b.message}`).join(" "),
  };
}

export function formatCompletionDecision(decision: CompletionGateDecision): string {
  const lines: string[] = [`Completion gate: ${decision.outcome.toUpperCase()}`];
  for (const b of decision.blockers) lines.push(`- BLOCKING ${b.code}: ${b.message}`);
  for (const a of decision.advisories) lines.push(`- advisory ${a.code}: ${a.message}`);
  return lines.join("\n");
}
