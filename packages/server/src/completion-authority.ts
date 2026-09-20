import {
  createVerificationInputStateHash,
  evaluateCompletion,
  type CompletionGateDecision,
  type FailureAnalysis,
  type ReviewDecision,
  type VerificationResult,
  type WorkflowPlan,
} from "@codeforge/workflow";

export interface AutonomousCompletionEvidence {
  runId: string;
  title: string;
  startedAt?: string;
  changedFiles: string[];
  diff: string;
  verification: VerificationResult[];
  reviewPassed: boolean;
  /**
   * R21: the workspace the verification ran in. When present, the gate recomputes the workspace
   * input-state hash at decision time and rebinds every verification result to it, so evidence
   * produced before a later edit — by any process — can never authorize completion.
   */
  workspacePath?: string;
}

export function evaluateAutonomousCompletion(evidence: AutonomousCompletionEvidence): CompletionGateDecision {
  const now = new Date().toISOString();
  const noTestsDiscovered = evidence.verification.some((result) => result.noTestsDiscovered);
  const contradictoryOutput = evidence.verification.some((result) => result.contradictoryOutput);
  // Every legacy result must have been produced against one workspace state; disagreeing hashes
  // mean the results are not one verification of one state, and the gate must not certify them.
  const verifiedHashes = [...new Set(evidence.verification.map((result) => result.inputStateHash).filter((hash): hash is string => typeof hash === "string" && hash.length > 0))];
  const verifiedInputStateHash = verifiedHashes.length === 1 ? verifiedHashes[0] : verifiedHashes.length > 1 ? "inconsistent-verification-state" : undefined;
  const currentInputStateHash = evidence.workspacePath && verifiedInputStateHash !== undefined ? createVerificationInputStateHash(evidence.workspacePath) : undefined;
  const verification: VerificationResult = evidence.verification.length > 0
    ? {
      passed: evidence.verification.reduce((sum, result) => sum + result.passed, 0),
      failed: evidence.verification.reduce((sum, result) => sum + result.failed, 0),
      skipped: evidence.verification.reduce((sum, result) => sum + result.skipped, 0),
      durationMs: evidence.verification.reduce((sum, result) => sum + result.durationMs, 0),
      output: evidence.verification.map((result) => result.output).filter(Boolean).join("\n"),
      exitCode: evidence.verification.some((result) => result.exitCode !== 0) ? 1 : 0,
      command: evidence.verification.map((result) => result.command).join(" && "),
      failures: evidence.verification.flatMap((result) => result.failures),
      ...(evidence.verification.some((result) => result.timedOut) ? { timedOut: true } : {}),
      ...(evidence.verification.some((result) => result.cancelled) ? { cancelled: true } : {}),
      ...(noTestsDiscovered ? { noTestsDiscovered: true } : {}),
      ...(contradictoryOutput ? { contradictoryOutput: true } : {}),
      ...(verifiedInputStateHash !== undefined ? { inputStateHash: verifiedInputStateHash } : {}),
    }
    : {
      passed: 0,
      failed: 0,
      skipped: 0,
      durationMs: 0,
      output: "No verification command was configured.",
      exitCode: 0,
      command: "",
      failures: [],
      notConfigured: true,
    };
  const plan: WorkflowPlan = {
    id: `completion-${evidence.runId}`,
    title: evidence.title,
    taskId: evidence.runId,
    status: "completed",
    createdAt: evidence.startedAt ?? now,
    updatedAt: now,
    steps: [
      { id: `${evidence.runId}-implement`, description: "Autonomous implementation", status: "completed", kind: "edit", risk: "moderate", requiresApproval: false, targetPath: evidence.changedFiles[0] ?? "workspace" },
      { id: `${evidence.runId}-review`, description: "Independent review", status: evidence.reviewPassed ? "completed" : "blocked", kind: "review", risk: "safe", requiresApproval: false },
      { id: `${evidence.runId}-verify`, description: "ForgeVerify", status: evidence.verification.length > 0 ? "completed" : "blocked", kind: "verify", risk: "safe", requiresApproval: false },
    ],
  };
  const analysis: FailureAnalysis = {
    hasFailures: verification.failed > 0,
    summary: verification.output,
    diagnostics: verification.failures.map((failure) => failure.message),
    suggestedRepairs: [],
    isRepairable: false,
  };
  const review: ReviewDecision = {
    approved: evidence.reviewPassed,
    issues: evidence.reviewPassed ? [] : ["Independent review did not pass."],
    findings: evidence.reviewPassed ? [] : [{ code: "sensitive_file", severity: "blocking", path: "workspace", message: "Independent review did not pass." }],
    diffs: evidence.changedFiles.map((filePath) => ({
      path: filePath,
      changeType: "modified" as const,
      additions: 0,
      deletions: 0,
      diff: evidence.diff,
      beforeHash: "base",
      afterHash: "worktree",
    })),
    summary: evidence.changedFiles.length > 0 ? `${evidence.changedFiles.length} file(s) changed` : "No effective change",
  };
  return evaluateCompletion({
    plan,
    verification,
    analysis,
    review,
    ...(verifiedInputStateHash !== undefined ? { verifiedVerificationInputStateHash: verifiedInputStateHash } : {}),
    ...(currentInputStateHash !== undefined ? { currentVerificationInputStateHash: currentInputStateHash } : {}),
  });
}
