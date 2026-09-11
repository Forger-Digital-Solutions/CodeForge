import type { WorkspaceEvent } from "@codeforge/protocol";
import type { EventStore, ISessionPersistence } from "@codeforge/sessions";
import { redactSecrets } from "@codeforge/secrets";

const MAX_SAFE_EVENT_TEXT = 32 * 1024;

function safeEventText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const redacted = redactSecrets(value);
  return redacted.length <= MAX_SAFE_EVENT_TEXT ? redacted : `${redacted.slice(0, MAX_SAFE_EVENT_TEXT)}\n[truncated]`;
}

export interface WorkspaceEventAdapterOptions {
  sessionId: string;
  /** Present only for a bounded autonomous workflow/agent run. */
  runId?: string;
  eventStore: EventStore;
  persistence: ISessionPersistence;
}

export class WorkspaceEventAdapter {
  private readonly sessionId: string;
  private readonly runId?: string;
  private readonly eventStore: EventStore;
  private readonly persistence: ISessionPersistence;

  constructor(options: WorkspaceEventAdapterOptions) {
    this.sessionId = options.sessionId;
    this.runId = options.runId;
    this.eventStore = options.eventStore;
    this.persistence = options.persistence;
  }

  /**
   * Durable events use a real awaited persistence write (needed so a process can be killed right
   * after a durability-sensitive HTTP response and a fresh process reading the same database is
   * guaranteed to observe it — CF-17R5's core restart invariant). High-frequency telemetry wrapper
   * methods below intentionally do NOT await this and instead fire-and-forget with a logged
   * failure, so the vast majority of call sites across the codebase are unaffected by PostgreSQL
   * becoming a real network round trip.
   */
  async emit(event: Omit<WorkspaceEvent, "seq" | "sessionId" | "timestamp">): Promise<void> {
    // EventStore owns the process-wide sequence. Persisting a per-adapter counter made a reload
    // ambiguous as soon as a session had more than one turn; reserve the same next sequence that
    // EventStore will assign synchronously so SSE and durable replay are identical.
    const fullEvent: WorkspaceEvent = {
      ...event,
      seq: this.eventStore.getLastSeq() + 1,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      ...(this.runId ? { runId: this.runId } : {}),
    } as WorkspaceEvent;

    this.eventStore.append(fullEvent);
    await this.persistence.appendEvent(fullEvent);
  }

  /** Fire-and-forget variant for high-frequency telemetry that does not gate CF-17 durability. */
  private emitBestEffort(event: Omit<WorkspaceEvent, "seq" | "sessionId" | "timestamp">): void {
    void this.emit(event).catch((error) => {
      console.error("[workspace-event-adapter] best-effort event persistence failed", error);
    });
  }

  emitTurnStarted(turnId: string, userMessage: string, agentId?: string): Promise<void> {
    return this.emit({
      type: "turn.started",
      payload: { turnId, userMessage, agentId },
    } as WorkspaceEvent);
  }

  emitTurnSteered(turnId: string, steering: string): Promise<void> {
    return this.emit({
      type: "turn.steered",
      payload: { turnId, steering },
    } as WorkspaceEvent);
  }

  emitTurnPaused(turnId: string): Promise<void> {
    return this.emit({
      type: "turn.paused",
      payload: { turnId },
    } as WorkspaceEvent);
  }

  emitTurnResumed(turnId: string): Promise<void> {
    return this.emit({
      type: "turn.resumed",
      payload: { turnId },
    } as WorkspaceEvent);
  }

  emitTurnRecovery(
    turnId: string,
    phase: "hydrated" | "stale_execution_invalidated" | "replan_required" | "replan_started" | "resumed" | "blocked",
    generation: number,
    detail?: string,
  ): Promise<void> {
    return this.emit({
      type: "turn.recovery",
      payload: { turnId, phase, generation, ...(detail ? { detail: safeEventText(detail) } : {}) },
    } as WorkspaceEvent);
  }

  emitTurnCancelled(turnId: string, reason?: string): Promise<void> {
    return this.emit({
      type: "turn.cancelled",
      payload: { turnId, reason },
    } as WorkspaceEvent);
  }

  emitTurnFailed(turnId: string, error: string): Promise<void> {
    return this.emit({
      type: "turn.failed",
      payload: { turnId, error },
    } as WorkspaceEvent);
  }

  emitTurnCompleted(turnId: string, result?: string): Promise<void> {
    return this.emit({
      type: "turn.completed",
      payload: { turnId, result },
    } as WorkspaceEvent);
  }

  emitUserIntentHoldEntered(runId: string, generation: number, reason: "user_composer_active" | "user_steer_queued" | "awaiting_inflight_completion", turnId?: string): Promise<void> {
    return this.emit({ type: "user_intent_hold.entered", payload: { runId, generation, reason, ...(turnId ? { turnId } : {}) } } as WorkspaceEvent);
  }

  emitUserIntentHoldReleased(runId: string, generation: number, reason: "draft_cleared" | "user_intent_hold_disabled" | "reconciled" | "stale_lease" | "terminal"): Promise<void> {
    return this.emit({ type: "user_intent_hold.released", payload: { runId, generation, reason } } as WorkspaceEvent);
  }

  emitUserIntentSteerQueued(runId: string, turnId: string, steerId: string, position: number): Promise<void> {
    return this.emit({ type: "user_intent_steer.queued", payload: { runId, turnId, steerId, position } } as WorkspaceEvent);
  }

  emitUserIntentReconciliationStarted(runId: string, turnId: string, steerIds: string[]): Promise<void> {
    return this.emit({ type: "user_intent_steer.reconciliation_started", payload: { runId, turnId, steerIds } } as WorkspaceEvent);
  }

  emitUserIntentReconciliationCompleted(runId: string, turnId: string, steerIds: string[]): Promise<void> {
    return this.emit({ type: "user_intent_steer.reconciliation_completed", payload: { runId, turnId, steerIds } } as WorkspaceEvent);
  }

  emitAgentStarted(agentId: string, role: string, taskId: string): void {
    this.emitBestEffort({
      type: "agent.started",
      payload: { agentId, role, taskId },
    } as WorkspaceEvent);
  }

  emitAgentCompleted(agentId: string, taskId: string): void {
    this.emitBestEffort({
      type: "agent.completed",
      payload: { agentId, taskId },
    } as WorkspaceEvent);
  }

  emitSubagentStarted(
    agentId: string,
    role: string,
    task: string,
    parentAgentId?: string,
  ): void {
    this.emitBestEffort({
      type: "subagent.started",
      payload: { agentId, role, task, parentAgentId },
    } as WorkspaceEvent);
  }

  emitSubagentProgress(agentId: string, message: string, percent?: number): void {
    this.emitBestEffort({
      type: "subagent.progress",
      payload: { agentId, message, percent },
    } as WorkspaceEvent);
  }

  emitSubagentCompleted(agentId: string, result?: string): void {
    this.emitBestEffort({
      type: "subagent.completed",
      payload: { agentId, result },
    } as WorkspaceEvent);
  }

  emitSubagentFailed(agentId: string, error: string): void {
    this.emitBestEffort({
      type: "subagent.failed",
      payload: { agentId, error },
    } as WorkspaceEvent);
  }

  emitFileRead(fileCallId: string, path: string, lines?: number): void {
    this.emitBestEffort({
      type: "file.read",
      payload: { fileCallId, path, lines },
    } as WorkspaceEvent);
  }

  emitFileChangeProposed(
    changeId: string,
    path: string,
    changeType: "created" | "modified" | "deleted",
    additions: number,
    deletions: number,
    description?: string,
    diff?: string,
  ): void {
    const safeDescription = safeEventText(description);
    const safeDiff = safeEventText(diff);
    this.emitBestEffort({
      type: "file.change_proposed",
      payload: {
        changeId,
        path,
        changeType,
        additions,
        deletions,
        ...(safeDescription !== undefined ? { description: safeDescription } : {}),
        ...(safeDiff !== undefined ? { diff: safeDiff } : {}),
      },
    } as WorkspaceEvent);
  }

  emitFileChangeApplied(changeId: string, path: string): void {
    this.emitBestEffort({
      type: "file.change_applied",
      payload: { changeId, path },
    } as WorkspaceEvent);
  }

  emitFileChangeReverted(changeId: string, path: string): void {
    this.emitBestEffort({
      type: "file.change_reverted",
      payload: { changeId, path },
    } as WorkspaceEvent);
  }

  emitCommandStarted(commandId: string, command: string, workingDirectory?: string): void {
    this.emitBestEffort({
      type: "command.started",
      payload: { commandId, command, workingDirectory },
    } as WorkspaceEvent);
  }

  emitCommandOutput(commandId: string, output: string, stream?: "stdout" | "stderr"): void {
    this.emitBestEffort({
      type: "command.output",
      payload: { commandId, output, stream },
    } as WorkspaceEvent);
  }

  emitCommandCompleted(commandId: string, exitCode: number, durationMs: number): void {
    this.emitBestEffort({
      type: "command.completed",
      payload: { commandId, exitCode, durationMs },
    } as WorkspaceEvent);
  }

  emitApprovalRequested(
    approvalId: string,
    tool: string,
    action: string,
    description: string,
    risk: "safe" | "moderate" | "high" | "critical",
    scope?: string,
  ): Promise<void> {
    return this.emit({
      type: "approval.requested",
      payload: { approvalId, tool, action, description, risk, scope },
    } as WorkspaceEvent);
  }

  emitApprovalResolved(
    approvalId: string,
    decision: "allow_once" | "allow_session" | "deny",
  ): Promise<void> {
    return this.emit({
      type: "approval.resolved",
      payload: { approvalId, decision },
    } as WorkspaceEvent);
  }

  emitQuestionRequested(questionId: string, prompt: string, options?: string[]): Promise<void> {
    return this.emit({
      type: "question.requested",
      payload: { questionId, prompt, options },
    } as WorkspaceEvent);
  }

  emitQuestionResolved(questionId: string, answer: string): Promise<void> {
    return this.emit({
      type: "question.resolved",
      payload: { questionId, answer },
    } as WorkspaceEvent);
  }

  emitPlanStarted(planId: string, turnId: string, title: string): void {
    this.emitBestEffort({
      type: "plan.started",
      payload: { planId, turnId, title },
    } as WorkspaceEvent);
  }

  emitPlanUpdated(
    planId: string,
    steps: Array<{
      id: string;
      description: string;
      status: "queued" | "active" | "completed" | "blocked" | "failed" | "skipped";
    }>,
  ): void {
    this.emitBestEffort({
      type: "plan.updated",
      payload: { planId, steps },
    } as WorkspaceEvent);
  }

  emitValidationStarted(validationId: string, type: string): void {
    this.emitBestEffort({
      type: "validation.started",
      payload: { validationId, type },
    } as WorkspaceEvent);
  }

  emitValidationCompleted(
    validationId: string,
    passed: number,
    failed: number,
    skipped: number,
  ): void {
    this.emitBestEffort({
      type: "validation.completed",
      payload: { validationId, passed, failed, skipped },
    } as WorkspaceEvent);
  }

  emitTestStarted(taskId: string): void {
    this.emitBestEffort({
      type: "test.started",
      payload: { taskId },
    } as WorkspaceEvent);
  }

  emitTestCompleted(taskId: string, passed: number, failed: number, skipped: number): void {
    this.emitBestEffort({
      type: "test.completed",
      payload: { taskId, passed, failed, skipped },
    } as WorkspaceEvent);
  }

  emitCheckpointCreated(
    checkpointId: string,
    label: string,
    fileCount: number,
    branch?: string,
    testStatus?: string,
  ): void {
    this.emitBestEffort({
      type: "checkpoint.created",
      payload: { checkpointId, label, fileCount, branch, testStatus },
    } as WorkspaceEvent);
  }

  emitCheckpointRestored(
    checkpointId: string,
    restoreType: "code_and_conversation" | "conversation_only" | "code_only",
  ): void {
    this.emitBestEffort({
      type: "checkpoint.restored",
      payload: { checkpointId, restoreType },
    } as WorkspaceEvent);
  }

  emitArtifactCreated(
    artifactId: string,
    type: string,
    title: string,
    turnId?: string,
  ): void {
    this.emitBestEffort({
      type: "artifact.created",
      payload: { artifactId, type, title, turnId },
    } as WorkspaceEvent);
  }

  emitEvidenceCreated(
    evidenceId: string,
    conclusion: string,
    references: Array<{ kind: "file" | "test" | "command" | "artifact"; ref: string }>,
  ): void {
    this.emitBestEffort({
      type: "evidence.created",
      payload: { evidenceId, conclusion, references },
    } as WorkspaceEvent);
  }

  emitTaskCreated(taskId: string, title: string, mode: string): void {
    this.emitBestEffort({
      type: "task.created",
      payload: { taskId, title, mode },
    } as WorkspaceEvent);
  }

  emitTaskStarted(taskId: string): void {
    this.emitBestEffort({
      type: "task.started",
      payload: { taskId },
    } as WorkspaceEvent);
  }

  emitTaskStateChanged(taskId: string, from: string, to: string): void {
    this.emitBestEffort({
      type: "task.state_changed",
      payload: { taskId, from, to },
    } as WorkspaceEvent);
  }

  emitTaskCompleted(taskId: string, result: string): void {
    this.emitBestEffort({
      type: "task.completed",
      payload: { taskId, result },
    } as WorkspaceEvent);
  }

  emitTaskCancelled(taskId: string, reason?: string): void {
    this.emitBestEffort({
      type: "task.cancelled",
      payload: { taskId, reason },
    } as WorkspaceEvent);
  }

  emitWorkflowVerificationStarted(taskId: string, attempt: number): void {
    this.emitBestEffort({
      type: "workflow.verification_started",
      payload: { taskId, attempt },
    } as WorkspaceEvent);
  }

  emitWorkflowVerificationCompleted(
    taskId: string,
    attempt: number,
    result: {
      notConfigured?: boolean;
      passed: number;
      failed: number;
      skipped: number;
      durationMs: number;
      verifiers?: Array<{
        id: string;
        kind: "test" | "typecheck" | "build" | "lint" | "custom";
        command: string;
        required: boolean;
        status: "passed" | "failed" | "not_configured" | "timed_out" | "cancelled" | "infra_error" | "interrupted";
        passed: number;
        failed: number;
        skipped: number;
        exitCode: number;
        durationMs: number;
        failureSummary?: string;
      }>;
    },
  ): void {
    this.emitBestEffort({
      type: "workflow.verification_completed",
      payload: {
        taskId,
        attempt,
        notConfigured: result.notConfigured === true,
        passed: result.passed,
        failed: result.failed,
        skipped: result.skipped,
        durationMs: result.durationMs,
        verifiers: result.verifiers ?? [],
      },
    } as WorkspaceEvent);
  }

  emitForgeVerifyPlanCreated(taskId: string, planId: string, policyVersion: string, requiredVerifierIds: string[]): Promise<void> {
    return this.emit({ type: "forgeverify.plan_created", payload: { taskId, planId, policyVersion, requiredVerifierIds } });
  }

  emitForgeVerifyAttemptStarted(taskId: string, planId: string, attemptId: string, verifierId: string): Promise<void> {
    return this.emit({ type: "forgeverify.attempt_started", payload: { taskId, planId, attemptId, verifierId } });
  }

  emitForgeVerifyEvidenceCreated(taskId: string, planId: string, attemptId: string, evidenceId: string, verifierId: string, status: "passed" | "failed" | "cancelled" | "timed_out" | "infra_error" | "interrupted", durationMs: number, outputTruncated: boolean): Promise<void> {
    return this.emit({ type: "forgeverify.evidence_created", payload: { taskId, planId, attemptId, evidenceId, verifierId, status, durationMs, outputTruncated } });
  }

  emitWorkflowRepairAttempted(taskId: string, attempt: number, summary: string): void {
    this.emitBestEffort({
      type: "workflow.repair_attempted",
      payload: { taskId, attempt, summary },
    } as WorkspaceEvent);
  }

  emitWorkflowReviewCompleted(
    taskId: string,
    approved: boolean,
    findings: Array<{ code: string; severity: "blocking" | "advisory"; path: string; message: string }>,
    diffCount: number,
  ): void {
    this.emitBestEffort({
      type: "workflow.review_completed",
      payload: { taskId, approved, findings, diffCount },
    } as WorkspaceEvent);
  }

  emitWorkflowCompletionDecided(
    taskId: string,
    outcome: "completed" | "blocked" | "failed",
    rationale: string,
    blockers: Array<{ code: string; severity: string; message: string }>,
  ): Promise<void> {
    return this.emit({
      type: "workflow.completion_decided",
      payload: { taskId, outcome, rationale, blockers },
    } as WorkspaceEvent);
  }

  emitReviewStarted(taskId: string): void {
    this.emitBestEffort({
      type: "review.started",
      payload: { taskId },
    } as WorkspaceEvent);
  }

  emitReviewCompleted(taskId: string, accepted: boolean, issues: string[]): void {
    this.emitBestEffort({
      type: "review.completed",
      payload: { taskId, accepted, issues },
    } as WorkspaceEvent);
  }

  emitPlanStatusChanged(planId: string, status: "draft" | "review" | "approved" | "rejected" | "superseded" | "completed"): Promise<void> {
    return this.emit({
      type: "plan.status_changed",
      payload: { planId, status },
    } as WorkspaceEvent);
  }

  emitStatusChanged(from: string, to: string): void {
    this.emitBestEffort({
      type: "status.changed",
      payload: { from, to },
    } as WorkspaceEvent);
  }

  emitRouterSelection(
    taskId: string,
    modelId: string,
    providerId: string,
    score: number,
    reasons: string[],
  ): void {
    this.emitBestEffort({
      type: "router.selection",
      payload: { taskId, modelId, providerId, score, reasons },
    } as WorkspaceEvent);
  }

  emitRouterFailover(taskId: string, fromModelId: string, toModelId: string, reason: string): void {
    this.emitBestEffort({
      type: "router.failover",
      payload: { taskId, fromModelId, toModelId, reason },
    } as WorkspaceEvent);
  }

  emitEightBitStatus(
    event:
      | "CATALOG_SCAN_STARTED"
      | "ROUTE_DEGRADED"
      | "ROUTE_COOLDOWN"
      | "PROVIDER_OFFLINE"
      | "PROVIDER_ONLINE"
      | "FREE_ELIGIBILITY_REMOVED"
      | "ROUTE_ROTATION_STARTED"
      | "ROUTE_ROTATED"
      | "ROUTE_READY"
      | "NO_ELIGIBLE_FREE_MODEL",
    role: string,
    reasonCodes: string[],
    accessibleText: string,
    previous?: { providerId: string; modelId: string },
    selected?: { providerId: string; modelId: string },
  ): void {
    this.emitBestEffort({
      type: "eightbit.status",
      payload: { event, role, previous, selected, reasonCodes, accessibleText },
    } as WorkspaceEvent);
  }

  emitToolStarted(toolCallId: string, tool: string, taskId: string): void {
    this.emitBestEffort({
      type: "tool.started",
      payload: { toolCallId, tool, taskId },
    } as WorkspaceEvent);
  }

  emitToolCompleted(toolCallId: string, tool: string, durationMs: number): void {
    this.emitBestEffort({
      type: "tool.completed",
      payload: { toolCallId, tool, durationMs },
    } as WorkspaceEvent);
  }

  emitToolFailed(toolCallId: string, tool: string, error: string): void {
    this.emitBestEffort({
      type: "tool.failed",
      payload: { toolCallId, tool, error },
    } as WorkspaceEvent);
  }

  emitTextDelta(turnId: string, delta: string, agentId?: string, messageId?: string): void {
    this.emitBestEffort({
      type: "text.delta",
      payload: { turnId, delta, agentId, messageId },
    } as WorkspaceEvent);
  }

  emitAssistantMessageStarted(turnId: string, messageId: string, agentId?: string): void {
    this.emitBestEffort({
      type: "assistant.message.started",
      payload: { turnId, messageId, agentId },
    } as WorkspaceEvent);
  }

  emitAssistantMessageCompleted(turnId: string, messageId: string, text: string, agentId?: string): void {
    this.emitBestEffort({
      type: "assistant.message.completed",
      payload: { turnId, messageId, text, agentId },
    } as WorkspaceEvent);
  }

  emitToolCallStarted(turnId: string, toolCallId: string, toolName: string, agentId?: string): void {
    this.emitBestEffort({
      type: "tool.call_started",
      payload: { turnId, toolCallId, toolName, agentId },
    } as WorkspaceEvent);
  }

  emitToolCallCompleted(turnId: string, toolCallId: string, toolName: string, argsJson: string, agentId?: string): void {
    this.emitBestEffort({
      type: "tool.call_completed",
      payload: { turnId, toolCallId, toolName, argsJson: safeEventText(argsJson) ?? "", agentId },
    } as WorkspaceEvent);
  }

  emitToolExecutionStarted(turnId: string, toolCallId: string, toolName: string, argsJson: string): void {
    this.emitBestEffort({
      type: "tool.execution_started",
      payload: { turnId, toolCallId, toolName, argsJson: safeEventText(argsJson) ?? "" },
    } as WorkspaceEvent);
  }

  emitToolExecutionCompleted(turnId: string, toolCallId: string, toolName: string, result: string): void {
    this.emitBestEffort({
      type: "tool.execution_completed",
      payload: { turnId, toolCallId, toolName, result: safeEventText(result) ?? "" },
    } as WorkspaceEvent);
  }

  emitToolExecutionFailed(turnId: string, toolCallId: string, toolName: string, error: string): void {
    this.emitBestEffort({
      type: "tool.execution_failed",
      payload: { turnId, toolCallId, toolName, error: safeEventText(error) ?? "" },
    } as WorkspaceEvent);
  }

  emitToolExecutionBlocked(turnId: string, toolCallId: string, toolName: string, reason: string): void {
    this.emitBestEffort({
      type: "tool.execution_blocked",
      payload: { turnId, toolCallId, toolName, reason: safeEventText(reason) ?? "" },
    } as WorkspaceEvent);
  }

  emitTokenUsage(turnId: string, inputTokens: number, outputTokens: number, totalTokens?: number): void {
    this.emitBestEffort({
      type: "token.usage",
      payload: { turnId, inputTokens, outputTokens, totalTokens },
    } as WorkspaceEvent);
  }

  emitFileWritten(fileCallId: string, path: string, bytesOrChars?: number): void {
    this.emitBestEffort({
      type: "file.written",
      payload: { fileCallId, path, bytesOrChars },
    } as WorkspaceEvent);
  }

  emitCommandExecuted(commandId: string, command: string, output: string, exitCode: number): void {
    this.emitBestEffort({
      type: "command.executed",
      payload: { commandId, command, output, exitCode },
    } as WorkspaceEvent);
  }

  /**
   * FG-8: ForgeGreen sustainability/resource-measurement lifecycle events. Aggregated once per
   * run — never one event per token/tool-call — so this stays a bounded stream. Observational
   * only: counts/ids/classifications, never prompt or source content.
   */
  emitForgeGreenRunStarted(runId: string): void {
    this.emitBestEffort({ type: "forgegreen.run_started", payload: { runId } } as WorkspaceEvent);
  }

  emitForgeGreenModelUsageRecorded(runId: string, coverage: string, requestCount?: number, totalTokens?: number): void {
    this.emitBestEffort({
      type: "forgegreen.model_usage_recorded",
      payload: { runId, coverage, requestCount, totalTokens },
    } as WorkspaceEvent);
  }

  emitForgeGreenToolUsageRecorded(runId: string, toolCallCount?: number, toolFailureCount?: number): void {
    this.emitBestEffort({
      type: "forgegreen.tool_usage_recorded",
      payload: { runId, toolCallCount, toolFailureCount },
    } as WorkspaceEvent);
  }

  emitForgeGreenVerificationUsageRecorded(runId: string, obligationsGenerated?: number): void {
    this.emitBestEffort({
      type: "forgegreen.verification_usage_recorded",
      payload: { runId, obligationsGenerated },
    } as WorkspaceEvent);
  }

  emitForgeGreenBaselineGenerated(runId: string, baselineKinds: string[], comparisonBasis: string[]): void {
    this.emitBestEffort({
      type: "forgegreen.baseline_generated",
      payload: { runId, baselineKinds, comparisonBasis },
    } as WorkspaceEvent);
  }

  emitForgeGreenEnergyEstimated(runId: string, estimatorId: string, estimatorVersion: string, confidence: string): void {
    this.emitBestEffort({
      type: "forgegreen.energy_estimated",
      payload: { runId, estimatorId, estimatorVersion, confidence },
    } as WorkspaceEvent);
  }

  emitForgeGreenRunFinalized(runId: string, receiptId: string, measurementStatus: string): void {
    this.emitBestEffort({
      type: "forgegreen.run_finalized",
      payload: { runId, receiptId, measurementStatus },
    } as WorkspaceEvent);
  }

  /** Non-fatal measurement failure (hardening #4): the underlying agent run is never affected,
   * but the failure itself must be observable, not silently erased. */
  emitForgeGreenMeasurementFailed(runId: string, reasonCodes: string[]): void {
    this.emitBestEffort({
      type: "forgegreen.measurement_failed",
      payload: { runId, reasonCodes },
    } as WorkspaceEvent);
  }

  /**
   * FG-9: ForgeGreen optimization & efficiency policy lifecycle events. Aggregated once per run
   * per optimization kind — never one event per candidate/suppression instance.
   */
  emitForgeGreenOptimizationCandidate(runId: string, kind: string, mode: string, candidateCount: number): void {
    this.emitBestEffort({
      type: "forgegreen.optimization_candidate",
      payload: { runId, kind, mode, candidateCount },
    } as WorkspaceEvent);
  }

  emitForgeGreenOptimizationApplied(runId: string, decisionId: string, kind: string, avoidedToolExecutions?: number, avoidedBytes?: number): void {
    this.emitBestEffort({
      type: "forgegreen.optimization_applied",
      payload: { runId, decisionId, kind, avoidedToolExecutions, avoidedBytes },
    } as WorkspaceEvent);
  }

  emitForgeGreenOptimizationRejected(runId: string, kind: string, reasonCodes: string[]): void {
    this.emitBestEffort({
      type: "forgegreen.optimization_rejected",
      payload: { runId, kind, reasonCodes },
    } as WorkspaceEvent);
  }

  emitForgeGreenOptimizationInvalidated(runId: string, decisionId: string, reasonCodes: string[]): void {
    this.emitBestEffort({
      type: "forgegreen.optimization_invalidated",
      payload: { runId, decisionId, reasonCodes },
    } as WorkspaceEvent);
  }

  emitForgeGreenOptimizationSummary(runId: string, candidatesConsidered: number, applied: number, proposed: number, skippedInsufficientEvidence: number): void {
    this.emitBestEffort({
      type: "forgegreen.optimization_summary",
      payload: { runId, candidatesConsidered, applied, proposed, skippedInsufficientEvidence },
    } as WorkspaceEvent);
  }

  getSeq(): number {
    return this.eventStore.getLastSeq();
  }
}

export function createWorkspaceEventAdapter(
  options: WorkspaceEventAdapterOptions,
): WorkspaceEventAdapter {
  return new WorkspaceEventAdapter(options);
}
