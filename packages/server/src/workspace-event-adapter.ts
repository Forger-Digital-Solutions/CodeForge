import type { WorkspaceEvent } from "@codeforge/protocol";
import type { EventStore, SessionPersistence } from "@codeforge/sessions";
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
  persistence: SessionPersistence;
}

export class WorkspaceEventAdapter {
  private readonly sessionId: string;
  private readonly runId?: string;
  private readonly eventStore: EventStore;
  private readonly persistence: SessionPersistence;

  constructor(options: WorkspaceEventAdapterOptions) {
    this.sessionId = options.sessionId;
    this.runId = options.runId;
    this.eventStore = options.eventStore;
    this.persistence = options.persistence;
  }

  emit(event: Omit<WorkspaceEvent, "seq" | "sessionId" | "timestamp">): void {
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
    this.persistence.appendEvent(fullEvent);
  }

  emitTurnStarted(turnId: string, userMessage: string, agentId?: string): void {
    this.emit({
      type: "turn.started",
      payload: { turnId, userMessage, agentId },
    } as WorkspaceEvent);
  }

  emitTurnSteered(turnId: string, steering: string): void {
    this.emit({
      type: "turn.steered",
      payload: { turnId, steering },
    } as WorkspaceEvent);
  }

  emitTurnPaused(turnId: string): void {
    this.emit({
      type: "turn.paused",
      payload: { turnId },
    } as WorkspaceEvent);
  }

  emitTurnResumed(turnId: string): void {
    this.emit({
      type: "turn.resumed",
      payload: { turnId },
    } as WorkspaceEvent);
  }

  emitTurnCancelled(turnId: string, reason?: string): void {
    this.emit({
      type: "turn.cancelled",
      payload: { turnId, reason },
    } as WorkspaceEvent);
  }

  emitTurnFailed(turnId: string, error: string): void {
    this.emit({
      type: "turn.failed",
      payload: { turnId, error },
    } as WorkspaceEvent);
  }

  emitTurnCompleted(turnId: string, result?: string): void {
    this.emit({
      type: "turn.completed",
      payload: { turnId, result },
    } as WorkspaceEvent);
  }

  emitAgentStarted(agentId: string, role: string, taskId: string): void {
    this.emit({
      type: "agent.started",
      payload: { agentId, role, taskId },
    } as WorkspaceEvent);
  }

  emitAgentCompleted(agentId: string, taskId: string): void {
    this.emit({
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
    this.emit({
      type: "subagent.started",
      payload: { agentId, role, task, parentAgentId },
    } as WorkspaceEvent);
  }

  emitSubagentProgress(agentId: string, message: string, percent?: number): void {
    this.emit({
      type: "subagent.progress",
      payload: { agentId, message, percent },
    } as WorkspaceEvent);
  }

  emitSubagentCompleted(agentId: string, result?: string): void {
    this.emit({
      type: "subagent.completed",
      payload: { agentId, result },
    } as WorkspaceEvent);
  }

  emitSubagentFailed(agentId: string, error: string): void {
    this.emit({
      type: "subagent.failed",
      payload: { agentId, error },
    } as WorkspaceEvent);
  }

  emitFileRead(fileCallId: string, path: string, lines?: number): void {
    this.emit({
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
    this.emit({
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
    this.emit({
      type: "file.change_applied",
      payload: { changeId, path },
    } as WorkspaceEvent);
  }

  emitFileChangeReverted(changeId: string, path: string): void {
    this.emit({
      type: "file.change_reverted",
      payload: { changeId, path },
    } as WorkspaceEvent);
  }

  emitCommandStarted(commandId: string, command: string, workingDirectory?: string): void {
    this.emit({
      type: "command.started",
      payload: { commandId, command, workingDirectory },
    } as WorkspaceEvent);
  }

  emitCommandOutput(commandId: string, output: string, stream?: "stdout" | "stderr"): void {
    this.emit({
      type: "command.output",
      payload: { commandId, output, stream },
    } as WorkspaceEvent);
  }

  emitCommandCompleted(commandId: string, exitCode: number, durationMs: number): void {
    this.emit({
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
  ): void {
    this.emit({
      type: "approval.requested",
      payload: { approvalId, tool, action, description, risk, scope },
    } as WorkspaceEvent);
  }

  emitApprovalResolved(
    approvalId: string,
    decision: "allow_once" | "allow_session" | "deny",
  ): void {
    this.emit({
      type: "approval.resolved",
      payload: { approvalId, decision },
    } as WorkspaceEvent);
  }

  emitQuestionRequested(questionId: string, prompt: string, options?: string[]): void {
    this.emit({
      type: "question.requested",
      payload: { questionId, prompt, options },
    } as WorkspaceEvent);
  }

  emitQuestionResolved(questionId: string, answer: string): void {
    this.emit({
      type: "question.resolved",
      payload: { questionId, answer },
    } as WorkspaceEvent);
  }

  emitPlanStarted(planId: string, turnId: string, title: string): void {
    this.emit({
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
    this.emit({
      type: "plan.updated",
      payload: { planId, steps },
    } as WorkspaceEvent);
  }

  emitValidationStarted(validationId: string, type: string): void {
    this.emit({
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
    this.emit({
      type: "validation.completed",
      payload: { validationId, passed, failed, skipped },
    } as WorkspaceEvent);
  }

  emitTestStarted(taskId: string): void {
    this.emit({
      type: "test.started",
      payload: { taskId },
    } as WorkspaceEvent);
  }

  emitTestCompleted(taskId: string, passed: number, failed: number, skipped: number): void {
    this.emit({
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
    this.emit({
      type: "checkpoint.created",
      payload: { checkpointId, label, fileCount, branch, testStatus },
    } as WorkspaceEvent);
  }

  emitCheckpointRestored(
    checkpointId: string,
    restoreType: "code_and_conversation" | "conversation_only" | "code_only",
  ): void {
    this.emit({
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
    this.emit({
      type: "artifact.created",
      payload: { artifactId, type, title, turnId },
    } as WorkspaceEvent);
  }

  emitEvidenceCreated(
    evidenceId: string,
    conclusion: string,
    references: Array<{ kind: "file" | "test" | "command" | "artifact"; ref: string }>,
  ): void {
    this.emit({
      type: "evidence.created",
      payload: { evidenceId, conclusion, references },
    } as WorkspaceEvent);
  }

  emitTaskCreated(taskId: string, title: string, mode: string): void {
    this.emit({
      type: "task.created",
      payload: { taskId, title, mode },
    } as WorkspaceEvent);
  }

  emitTaskStarted(taskId: string): void {
    this.emit({
      type: "task.started",
      payload: { taskId },
    } as WorkspaceEvent);
  }

  emitTaskStateChanged(taskId: string, from: string, to: string): void {
    this.emit({
      type: "task.state_changed",
      payload: { taskId, from, to },
    } as WorkspaceEvent);
  }

  emitTaskCompleted(taskId: string, result: string): void {
    this.emit({
      type: "task.completed",
      payload: { taskId, result },
    } as WorkspaceEvent);
  }

  emitTaskCancelled(taskId: string, reason?: string): void {
    this.emit({
      type: "task.cancelled",
      payload: { taskId, reason },
    } as WorkspaceEvent);
  }

  emitWorkflowVerificationStarted(taskId: string, attempt: number): void {
    this.emit({
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
    this.emit({
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

  emitForgeVerifyPlanCreated(taskId: string, planId: string, policyVersion: string, requiredVerifierIds: string[]): void {
    this.emit({ type: "forgeverify.plan_created", payload: { taskId, planId, policyVersion, requiredVerifierIds } });
  }

  emitForgeVerifyAttemptStarted(taskId: string, planId: string, attemptId: string, verifierId: string): void {
    this.emit({ type: "forgeverify.attempt_started", payload: { taskId, planId, attemptId, verifierId } });
  }

  emitForgeVerifyEvidenceCreated(taskId: string, planId: string, attemptId: string, evidenceId: string, verifierId: string, status: "passed" | "failed" | "cancelled" | "timed_out" | "infra_error" | "interrupted", durationMs: number, outputTruncated: boolean): void {
    this.emit({ type: "forgeverify.evidence_created", payload: { taskId, planId, attemptId, evidenceId, verifierId, status, durationMs, outputTruncated } });
  }

  emitWorkflowRepairAttempted(taskId: string, attempt: number, summary: string): void {
    this.emit({
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
    this.emit({
      type: "workflow.review_completed",
      payload: { taskId, approved, findings, diffCount },
    } as WorkspaceEvent);
  }

  emitWorkflowCompletionDecided(
    taskId: string,
    outcome: "completed" | "blocked" | "failed",
    rationale: string,
    blockers: Array<{ code: string; severity: string; message: string }>,
  ): void {
    this.emit({
      type: "workflow.completion_decided",
      payload: { taskId, outcome, rationale, blockers },
    } as WorkspaceEvent);
  }

  emitReviewStarted(taskId: string): void {
    this.emit({
      type: "review.started",
      payload: { taskId },
    } as WorkspaceEvent);
  }

  emitReviewCompleted(taskId: string, accepted: boolean, issues: string[]): void {
    this.emit({
      type: "review.completed",
      payload: { taskId, accepted, issues },
    } as WorkspaceEvent);
  }

  emitPlanStatusChanged(planId: string, status: "draft" | "review" | "approved" | "rejected" | "superseded" | "completed"): void {
    this.emit({
      type: "plan.status_changed",
      payload: { planId, status },
    } as WorkspaceEvent);
  }

  emitStatusChanged(from: string, to: string): void {
    this.emit({
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
    this.emit({
      type: "router.selection",
      payload: { taskId, modelId, providerId, score, reasons },
    } as WorkspaceEvent);
  }

  emitToolStarted(toolCallId: string, tool: string, taskId: string): void {
    this.emit({
      type: "tool.started",
      payload: { toolCallId, tool, taskId },
    } as WorkspaceEvent);
  }

  emitToolCompleted(toolCallId: string, tool: string, durationMs: number): void {
    this.emit({
      type: "tool.completed",
      payload: { toolCallId, tool, durationMs },
    } as WorkspaceEvent);
  }

  emitToolFailed(toolCallId: string, tool: string, error: string): void {
    this.emit({
      type: "tool.failed",
      payload: { toolCallId, tool, error },
    } as WorkspaceEvent);
  }

  emitTextDelta(turnId: string, delta: string, agentId?: string, messageId?: string): void {
    this.emit({
      type: "text.delta",
      payload: { turnId, delta, agentId, messageId },
    } as WorkspaceEvent);
  }

  emitAssistantMessageStarted(turnId: string, messageId: string, agentId?: string): void {
    this.emit({
      type: "assistant.message.started",
      payload: { turnId, messageId, agentId },
    } as WorkspaceEvent);
  }

  emitAssistantMessageCompleted(turnId: string, messageId: string, text: string, agentId?: string): void {
    this.emit({
      type: "assistant.message.completed",
      payload: { turnId, messageId, text, agentId },
    } as WorkspaceEvent);
  }

  emitToolCallStarted(turnId: string, toolCallId: string, toolName: string, agentId?: string): void {
    this.emit({
      type: "tool.call_started",
      payload: { turnId, toolCallId, toolName, agentId },
    } as WorkspaceEvent);
  }

  emitToolCallCompleted(turnId: string, toolCallId: string, toolName: string, argsJson: string, agentId?: string): void {
    this.emit({
      type: "tool.call_completed",
      payload: { turnId, toolCallId, toolName, argsJson: safeEventText(argsJson) ?? "", agentId },
    } as WorkspaceEvent);
  }

  emitToolExecutionStarted(turnId: string, toolCallId: string, toolName: string, argsJson: string): void {
    this.emit({
      type: "tool.execution_started",
      payload: { turnId, toolCallId, toolName, argsJson: safeEventText(argsJson) ?? "" },
    } as WorkspaceEvent);
  }

  emitToolExecutionCompleted(turnId: string, toolCallId: string, toolName: string, result: string): void {
    this.emit({
      type: "tool.execution_completed",
      payload: { turnId, toolCallId, toolName, result: safeEventText(result) ?? "" },
    } as WorkspaceEvent);
  }

  emitToolExecutionFailed(turnId: string, toolCallId: string, toolName: string, error: string): void {
    this.emit({
      type: "tool.execution_failed",
      payload: { turnId, toolCallId, toolName, error: safeEventText(error) ?? "" },
    } as WorkspaceEvent);
  }

  emitToolExecutionBlocked(turnId: string, toolCallId: string, toolName: string, reason: string): void {
    this.emit({
      type: "tool.execution_blocked",
      payload: { turnId, toolCallId, toolName, reason: safeEventText(reason) ?? "" },
    } as WorkspaceEvent);
  }

  emitTokenUsage(turnId: string, inputTokens: number, outputTokens: number, totalTokens?: number): void {
    this.emit({
      type: "token.usage",
      payload: { turnId, inputTokens, outputTokens, totalTokens },
    } as WorkspaceEvent);
  }

  emitFileWritten(fileCallId: string, path: string, bytesOrChars?: number): void {
    this.emit({
      type: "file.written",
      payload: { fileCallId, path, bytesOrChars },
    } as WorkspaceEvent);
  }

  emitCommandExecuted(commandId: string, command: string, output: string, exitCode: number): void {
    this.emit({
      type: "command.executed",
      payload: { commandId, command, output, exitCode },
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
