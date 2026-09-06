import { z } from "zod";
import { ExecutionModeSchema } from "./api.js";
import {
  TaskCreatedSchema,
  TaskStartedSchema,
  TaskStateChangedSchema,
  TaskCompletedSchema,
  TaskCancelledSchema,
  AgentStartedSchema,
  AgentCompletedSchema,
  RouterSelectionSchema,
  RouterFailoverSchema,
  EightBitStatusSchema,
  ProviderRateLimitedSchema,
  ProviderQuotaExhaustedSchema,
  ToolStartedSchema,
  ToolCompletedSchema,
  ToolFailedSchema,
  FileChangedSchema,
  GitCheckpointCreatedSchema,
  TestStartedSchema,
  TestCompletedSchema,
  ReviewStartedSchema,
  ReviewCompletedSchema,
  PermissionRequestedSchema,
} from "./events.js";

const EventBase = <T extends string, S extends z.ZodType>(type: T, schema: S) =>
  z.object({
    type: z.literal(type),
    timestamp: z.string().datetime(),
    seq: z.number().int().nonnegative(),
    sessionId: z.string(),
    /**
     * A durable execution boundary. Chat events intentionally omit this; Agent evidence is
     * always attached to the workflow/run that produced it so historical sessions cannot mix.
     */
    runId: z.string().min(1).max(128).optional(),
    payload: schema,
  });

export const TurnStartedSchema = EventBase(
  "turn.started",
  z.object({
    turnId: z.string(),
    userMessage: z.string(),
    agentId: z.string().optional(),
  }),
);

export const TurnSteeredSchema = EventBase(
  "turn.steered",
  z.object({
    turnId: z.string(),
    steering: z.string(),
  }),
);

export const TurnPausedSchema = EventBase("turn.paused", z.object({ turnId: z.string() }));
export const TurnResumedSchema = EventBase("turn.resumed", z.object({ turnId: z.string() }));
export const TurnRecoverySchema = EventBase(
  "turn.recovery",
  z.object({
    turnId: z.string(),
    phase: z.enum(["hydrated", "stale_execution_invalidated", "replan_required", "replan_started", "resumed", "blocked"]),
    generation: z.number().int().positive(),
    detail: z.string().optional(),
  }),
);
export const TurnCancelledSchema = EventBase(
  "turn.cancelled",
  z.object({ turnId: z.string(), reason: z.string().optional() }),
);
export const TurnFailedSchema = EventBase(
  "turn.failed",
  z.object({ turnId: z.string(), error: z.string() }),
);
export const TurnCompletedSchema = EventBase(
  "turn.completed",
  z.object({ turnId: z.string(), result: z.string().optional() }),
);

export const UserIntentHoldEnteredSchema = EventBase(
  "user_intent_hold.entered",
  z.object({
    runId: z.string(),
    turnId: z.string().optional(),
    generation: z.number().int().positive(),
    reason: z.enum(["user_composer_active", "user_steer_queued", "awaiting_inflight_completion"]),
  }),
);

export const UserIntentHoldReleasedSchema = EventBase(
  "user_intent_hold.released",
  z.object({
    runId: z.string(),
    generation: z.number().int().positive(),
    reason: z.enum(["draft_cleared", "user_intent_hold_disabled", "reconciled", "stale_lease", "terminal"]),
  }),
);

export const UserIntentSteerQueuedSchema = EventBase(
  "user_intent_steer.queued",
  z.object({
    runId: z.string(),
    turnId: z.string(),
    steerId: z.string(),
    position: z.number().int().nonnegative(),
  }),
);

export const UserIntentReconciliationStartedSchema = EventBase(
  "user_intent_steer.reconciliation_started",
  z.object({ runId: z.string(), turnId: z.string(), steerIds: z.array(z.string()) }),
);

export const UserIntentReconciliationCompletedSchema = EventBase(
  "user_intent_steer.reconciliation_completed",
  z.object({ runId: z.string(), turnId: z.string(), steerIds: z.array(z.string()) }),
);

export const ExecutionRequestedSchema = EventBase(
  "execution.requested",
  z.object({
    requestId: z.string(),
    executionMode: ExecutionModeSchema,
    runtime: z.enum(["chat", "workflow"]),
  }),
);

export const ExecutionStartFailedSchema = EventBase(
  "execution.start_failed",
  z.object({
    requestId: z.string(),
    executionMode: ExecutionModeSchema,
    code: z.string(),
    message: z.string(),
  }),
);

const WorkflowVerifierResultSchema = z.object({
  id: z.string(),
  kind: z.enum(["test", "typecheck", "build", "lint", "custom"]),
  command: z.string(),
  required: z.boolean(),
  status: z.enum(["passed", "failed", "not_configured", "timed_out", "cancelled", "infra_error", "interrupted"]),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  exitCode: z.number().int(),
  durationMs: z.number().nonnegative(),
  failureSummary: z.string().optional(),
});

export const WorkflowVerificationStartedSchema = EventBase(
  "workflow.verification_started",
  z.object({ taskId: z.string(), attempt: z.number().int().positive() }),
);

export const WorkflowVerificationCompletedSchema = EventBase(
  "workflow.verification_completed",
  z.object({
    taskId: z.string(),
    attempt: z.number().int().positive(),
    notConfigured: z.boolean(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    verifiers: z.array(WorkflowVerifierResultSchema),
  }),
);

export const ForgeVerifyPlanCreatedSchema = EventBase(
  "forgeverify.plan_created",
  z.object({ taskId: z.string(), planId: z.string(), policyVersion: z.string(), requiredVerifierIds: z.array(z.string()) }),
);

export const ForgeVerifyAttemptStartedSchema = EventBase(
  "forgeverify.attempt_started",
  z.object({ taskId: z.string(), planId: z.string(), attemptId: z.string(), verifierId: z.string() }),
);

export const ForgeVerifyEvidenceCreatedSchema = EventBase(
  "forgeverify.evidence_created",
  z.object({ taskId: z.string(), planId: z.string(), attemptId: z.string(), evidenceId: z.string(), verifierId: z.string(), status: z.enum(["passed", "failed", "cancelled", "timed_out", "infra_error", "interrupted"]), durationMs: z.number().nonnegative(), outputTruncated: z.boolean() }),
);

export const WorkflowRepairAttemptedSchema = EventBase(
  "workflow.repair_attempted",
  z.object({ taskId: z.string(), attempt: z.number().int().positive(), summary: z.string() }),
);

export const WorkflowReviewCompletedSchema = EventBase(
  "workflow.review_completed",
  z.object({
    taskId: z.string(),
    approved: z.boolean(),
    findings: z.array(z.object({
      code: z.string(),
      severity: z.enum(["blocking", "advisory"]),
      path: z.string(),
      message: z.string(),
    })),
    diffCount: z.number().int().nonnegative(),
  }),
);

export const WorkflowCompletionDecidedSchema = EventBase(
  "workflow.completion_decided",
  z.object({
    taskId: z.string(),
    outcome: z.enum(["completed", "blocked", "failed"]),
    rationale: z.string(),
    blockers: z.array(z.object({ code: z.string(), severity: z.string(), message: z.string() })),
  }),
);

export const PlanStartedSchema = EventBase(
  "plan.started",
  z.object({
    planId: z.string(),
    turnId: z.string(),
    title: z.string(),
  }),
);

export const PlanUpdatedSchema = EventBase(
  "plan.updated",
  z.object({
    planId: z.string(),
    steps: z.array(
      z.object({
        id: z.string(),
        description: z.string(),
        status: z.enum(["queued", "active", "completed", "blocked", "failed", "skipped"]),
      }),
    ),
  }),
);

export const PlanStatusChangedSchema = EventBase(
  "plan.status_changed",
  z.object({
    planId: z.string(),
    status: z.enum(["draft", "review", "approved", "rejected", "superseded", "completed"]),
  }),
);

export const FileReadSchema = EventBase(
  "file.read",
  z.object({
    fileCallId: z.string(),
    path: z.string(),
    lines: z.number().optional(),
  }),
);

export const FileChangeProposedSchema = EventBase(
  "file.change_proposed",
  z.object({
    changeId: z.string(),
    path: z.string(),
    changeType: z.enum(["created", "modified", "deleted"]),
    additions: z.number(),
    deletions: z.number(),
    description: z.string().optional(),
    diff: z.string().optional(),
  }),
);

export const FileChangeAppliedSchema = EventBase(
  "file.change_applied",
  z.object({
    changeId: z.string(),
    path: z.string(),
  }),
);

export const FileChangeRevertedSchema = EventBase(
  "file.change_reverted",
  z.object({
    changeId: z.string(),
    path: z.string(),
  }),
);

export const CommandStartedSchema = EventBase(
  "command.started",
  z.object({
    commandId: z.string(),
    command: z.string(),
    workingDirectory: z.string().optional(),
  }),
);

export const CommandOutputSchema = EventBase(
  "command.output",
  z.object({
    commandId: z.string(),
    output: z.string(),
    stream: z.enum(["stdout", "stderr"]).optional(),
  }),
);

export const CommandCompletedSchema = EventBase(
  "command.completed",
  z.object({
    commandId: z.string(),
    exitCode: z.number(),
    durationMs: z.number(),
  }),
);

export const ApprovalRequestedSchema = EventBase(
  "approval.requested",
  z.object({
    approvalId: z.string(),
    tool: z.string(),
    action: z.string(),
    description: z.string(),
    risk: z.enum(["safe", "moderate", "high", "critical"]),
    scope: z.string().optional(),
  }),
);

export const ApprovalResolvedSchema = EventBase(
  "approval.resolved",
  z.object({
    approvalId: z.string(),
    decision: z.enum(["allow_once", "allow_session", "deny"]),
  }),
);

export const QuestionRequestedSchema = EventBase(
  "question.requested",
  z.object({
    questionId: z.string(),
    prompt: z.string(),
    options: z.array(z.string()).optional(),
  }),
);

export const QuestionResolvedSchema = EventBase(
  "question.resolved",
  z.object({
    questionId: z.string(),
    answer: z.string(),
  }),
);

export const ArtifactCreatedSchema = EventBase(
  "artifact.created",
  z.object({
    artifactId: z.string(),
    type: z.string(),
    title: z.string(),
    sessionId: z.string().optional(),
    turnId: z.string().optional(),
  }),
);

export const ArtifactUpdatedSchema = EventBase(
  "artifact.updated",
  z.object({
    artifactId: z.string(),
    title: z.string().optional(),
  }),
);

export const CheckpointCreatedSchema = EventBase(
  "checkpoint.created",
  z.object({
    checkpointId: z.string(),
    label: z.string(),
    branch: z.string().optional(),
    fileCount: z.number(),
    testStatus: z.string().optional(),
  }),
);

export const CheckpointRestoredSchema = EventBase(
  "checkpoint.restored",
  z.object({
    checkpointId: z.string(),
    restoreType: z.enum(["code_and_conversation", "conversation_only", "code_only"]),
  }),
);

export const SubagentStartedSchema = EventBase(
  "subagent.started",
  z.object({
    agentId: z.string(),
    role: z.string(),
    parentAgentId: z.string().optional(),
    task: z.string(),
  }),
);

export const SubagentProgressSchema = EventBase(
  "subagent.progress",
  z.object({
    agentId: z.string(),
    message: z.string(),
    percent: z.number().min(0).max(100).optional(),
  }),
);

export const SubagentCompletedSchema = EventBase(
  "subagent.completed",
  z.object({
    agentId: z.string(),
    result: z.string().optional(),
  }),
);

export const SubagentFailedSchema = EventBase(
  "subagent.failed",
  z.object({
    agentId: z.string(),
    error: z.string(),
  }),
);

export const ValidationStartedSchema = EventBase(
  "validation.started",
  z.object({
    validationId: z.string(),
    type: z.string(),
  }),
);

export const ValidationCompletedSchema = EventBase(
  "validation.completed",
  z.object({
    validationId: z.string(),
    passed: z.number(),
    failed: z.number(),
    skipped: z.number(),
  }),
);

export const ContextUpdatedSchema = EventBase(
  "context.updated",
  z.object({
    sessionId: z.string(),
    filesAdded: z.number(),
    tokensApprox: z.number().optional(),
  }),
);

export const ContextCompactedSchema = EventBase(
  "context.compacted",
  z.object({
    sessionId: z.string(),
    summary: z.string().optional(),
  }),
);

export const EvidenceCreatedSchema = EventBase(
  "evidence.created",
  z.object({
    evidenceId: z.string(),
    conclusion: z.string(),
    references: z.array(
      z.object({
        kind: z.enum(["file", "test", "command", "artifact"]),
        ref: z.string(),
      }),
    ),
  }),
);

export const StatusChangedSchema = EventBase(
  "status.changed",
  z.object({
    from: z.string(),
    to: z.string(),
  }),
);

export const TextDeltaSchema = EventBase(
  "text.delta",
  z.object({
    turnId: z.string(),
    delta: z.string(),
    agentId: z.string().optional(),
    /** Groups deltas into a single assistant message segment within a turn. */
    messageId: z.string().optional(),
  }),
);

/**
 * Assistant free-text message boundaries. A turn may contain several assistant messages
 * interleaved with tool activity (message → tools → message → tools → completion). These
 * boundaries let the renderer segment prose correctly and persist the final user-facing text.
 */
export const AssistantMessageStartedSchema = EventBase(
  "assistant.message.started",
  z.object({
    turnId: z.string(),
    messageId: z.string(),
    agentId: z.string().optional(),
  }),
);

export const AssistantMessageCompletedSchema = EventBase(
  "assistant.message.completed",
  z.object({
    turnId: z.string(),
    messageId: z.string(),
    /** Final user-facing assistant text for this segment (persisted for reload). */
    text: z.string(),
    agentId: z.string().optional(),
  }),
);

export const ToolCallStartedSchema = EventBase(
  "tool.call_started",
  z.object({
    turnId: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    agentId: z.string().optional(),
  }),
);

export const ToolCallCompletedSchema = EventBase(
  "tool.call_completed",
  z.object({
    turnId: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    argsJson: z.string(),
    agentId: z.string().optional(),
  }),
);

export const ToolExecutionStartedSchema = EventBase(
  "tool.execution_started",
  z.object({
    turnId: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    argsJson: z.string(),
  }),
);

export const ToolExecutionCompletedSchema = EventBase(
  "tool.execution_completed",
  z.object({
    turnId: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    result: z.string(),
  }),
);

export const ToolExecutionFailedSchema = EventBase(
  "tool.execution_failed",
  z.object({
    turnId: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    error: z.string(),
  }),
);

export const ToolExecutionBlockedSchema = EventBase(
  "tool.execution_blocked",
  z.object({
    turnId: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    reason: z.string(),
  }),
);

export const TokenUsageSchema = EventBase(
  "token.usage",
  z.object({
    turnId: z.string(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative().optional(),
  }),
);

export const FileWrittenSchema = EventBase(
  "file.written",
  z.object({
    fileCallId: z.string(),
    path: z.string(),
    bytesOrChars: z.number().optional(),
  }),
);

export const CommandExecutedSchema = EventBase(
  "command.executed",
  z.object({
    commandId: z.string(),
    command: z.string(),
    output: z.string(),
    exitCode: z.number(),
  }),
);

export const DisplayModeChangedSchema = EventBase(
  "display_mode.changed",
  z.object({
    mode: z.enum(["compact", "detailed", "debug"]),
  }),
);

export const WorkspaceEventSchema = z.discriminatedUnion("type", [
  TaskCreatedSchema,
  TaskStartedSchema,
  TaskStateChangedSchema,
  TaskCompletedSchema,
  TaskCancelledSchema,
  AgentStartedSchema,
  AgentCompletedSchema,
  RouterSelectionSchema,
  RouterFailoverSchema,
  EightBitStatusSchema,
  ProviderRateLimitedSchema,
  ProviderQuotaExhaustedSchema,
  ToolStartedSchema,
  ToolCompletedSchema,
  ToolFailedSchema,
  FileChangedSchema,
  GitCheckpointCreatedSchema,
  TestStartedSchema,
  TestCompletedSchema,
  ReviewStartedSchema,
  ReviewCompletedSchema,
  PermissionRequestedSchema,
  TurnStartedSchema,
  TurnSteeredSchema,
  TurnPausedSchema,
  TurnResumedSchema,
  TurnRecoverySchema,
  TurnCancelledSchema,
  TurnFailedSchema,
  TurnCompletedSchema,
  UserIntentHoldEnteredSchema,
  UserIntentHoldReleasedSchema,
  UserIntentSteerQueuedSchema,
  UserIntentReconciliationStartedSchema,
  UserIntentReconciliationCompletedSchema,
  ExecutionRequestedSchema,
  ExecutionStartFailedSchema,
  WorkflowVerificationStartedSchema,
  WorkflowVerificationCompletedSchema,
  ForgeVerifyPlanCreatedSchema,
  ForgeVerifyAttemptStartedSchema,
  ForgeVerifyEvidenceCreatedSchema,
  WorkflowRepairAttemptedSchema,
  WorkflowReviewCompletedSchema,
  WorkflowCompletionDecidedSchema,
  PlanStartedSchema,
  PlanUpdatedSchema,
  PlanStatusChangedSchema,
  FileReadSchema,
  FileChangeProposedSchema,
  FileChangeAppliedSchema,
  FileChangeRevertedSchema,
  FileWrittenSchema,
  CommandStartedSchema,
  CommandOutputSchema,
  CommandCompletedSchema,
  CommandExecutedSchema,
  ApprovalRequestedSchema,
  ApprovalResolvedSchema,
  QuestionRequestedSchema,
  QuestionResolvedSchema,
  ArtifactCreatedSchema,
  ArtifactUpdatedSchema,
  CheckpointCreatedSchema,
  CheckpointRestoredSchema,
  SubagentStartedSchema,
  SubagentProgressSchema,
  SubagentCompletedSchema,
  SubagentFailedSchema,
  ValidationStartedSchema,
  ValidationCompletedSchema,
  ContextUpdatedSchema,
  ContextCompactedSchema,
  EvidenceCreatedSchema,
  StatusChangedSchema,
  DisplayModeChangedSchema,
  TextDeltaSchema,
  AssistantMessageStartedSchema,
  AssistantMessageCompletedSchema,
  ToolCallStartedSchema,
  ToolCallCompletedSchema,
  ToolExecutionStartedSchema,
  ToolExecutionCompletedSchema,
  ToolExecutionFailedSchema,
  ToolExecutionBlockedSchema,
  TokenUsageSchema,
]);

export type WorkspaceEvent = z.infer<typeof WorkspaceEventSchema>;
export type WorkspaceEventType = WorkspaceEvent["type"];

export const isWorkspaceEvent = (value: unknown): value is WorkspaceEvent =>
  WorkspaceEventSchema.safeParse(value).success;
