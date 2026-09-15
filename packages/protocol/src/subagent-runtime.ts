import { z } from "zod";

export const AgentWorkerLifecycleStateSchema = z.enum([
  "created",
  "queued",
  "starting",
  "running",
  "waiting",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "recovering",
]);
export type AgentWorkerLifecycleState = z.infer<typeof AgentWorkerLifecycleStateSchema>;

export const TaskCapsuleSchema = z.object({
  schemaVersion: z.literal(1),
  assignment: z.string().min(1).max(256),
  goal: z.string().min(1).max(16_000),
  relevantFiles: z.array(z.string().min(1).max(2_048)).max(500),
  knownEvidence: z.array(z.string().min(1).max(4_096)).max(500),
  constraints: z.array(z.string().min(1).max(2_048)).max(100),
  requiredOutput: z.array(z.string().min(1).max(2_048)).max(100),
  context: z.string().max(64 * 1024).optional(),
});
export type TaskCapsule = z.infer<typeof TaskCapsuleSchema>;

export const AgentPermissionSetSchema = z.object({
  read: z.boolean(),
  search: z.boolean(),
  write: z.boolean(),
  executeCommand: z.boolean(),
  network: z.boolean(),
});
export type AgentPermissionSet = z.infer<typeof AgentPermissionSetSchema>;

export const AgentExecutionBudgetRecordSchema = z.object({
  maxModelTurns: z.number().int().positive(),
  maxToolCalls: z.number().int().positive(),
  maxWriteToolCalls: z.number().int().nonnegative().optional(),
  maxCommandExecutions: z.number().int().nonnegative().optional(),
  maxContextTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().optional(),
  wallTimeMs: z.number().int().positive(),
});
export type AgentExecutionBudgetRecord = z.infer<typeof AgentExecutionBudgetRecordSchema>;

export const AgentWorkerTelemetrySchema = z.object({
  wallTimeMs: z.number().int().nonnegative(),
  modelRequests: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative(),
  duplicateWorkCount: z.number().int().nonnegative(),
  providerFailures: z.number().int().nonnegative(),
  allowanceUnits: z.number().nonnegative().optional(),
});
export type AgentWorkerTelemetry = z.infer<typeof AgentWorkerTelemetrySchema>;

export const AgentArtifactReferenceSchema = z.object({
  kind: z.string().min(1).max(128),
  ref: z.string().min(1).max(4_096),
  digest: z.string().min(1).max(256),
  producerAgentId: z.string().min(1).max(256),
  sizeBytes: z.number().int().nonnegative().optional(),
  createdAt: z.string().datetime(),
});
export type AgentArtifactReference = z.infer<typeof AgentArtifactReferenceSchema>;

export const SubagentRunWorkItemSchema = z.object({
  kind: z.literal("subagent_run"),
  id: z.string().min(1),
  sessionId: z.string().min(1),
  parentRunId: z.string().min(1),
  agentId: z.string().min(1),
  role: z.string().min(1),
  task: z.string().min(1),
  depth: z.number().int().nonnegative(),
  status: AgentWorkerLifecycleStateSchema,
  capsule: TaskCapsuleSchema,
  permissions: AgentPermissionSetSchema,
  allowedTools: z.array(z.string().min(1)).max(500),
  workspace: z.object({
    id: z.string().min(1),
    kind: z.enum(["local", "git-worktree"]),
    branch: z.string().optional(),
  }),
  /** R2 durable recovery: absolute workspace path so a restart can locate the exact
   * worktree a crashed worker was writing to. Optional for records written before R2. */
  workspacePath: z.string().max(2_048).optional(),
  model: z.object({ providerId: z.string().min(1), modelId: z.string().min(1) }).optional(),
  budget: AgentExecutionBudgetRecordSchema,
  telemetry: AgentWorkerTelemetrySchema,
  artifacts: z.array(AgentArtifactReferenceSchema).max(100),
  resultSummary: z.string().max(16_000).optional(),
  error: z.string().max(16_000).optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SubagentRunWorkItem = z.infer<typeof SubagentRunWorkItemSchema>;

/**
 * R2 durable execution journal for a single agent run (one worker's model/tool loop). Persisted
 * incrementally so a process crash leaves enough durable state to decide — honestly — whether the
 * run can be RESUMEd from the exact recorded conversation, must be REPLANned, or cannot be
 * reconstructed at all. The transcript is the authority: it holds the assistant/tool messages
 * after the regenerable bootstrap context, so a resumed run continues the same conversation
 * instead of inventing one.
 */
export const AgentRunJournalSchema = z.object({
  kind: z.literal("agent_run_journal"),
  id: z.string().min(1),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  agentId: z.string().min(1),
  role: z.string().min(1),
  state: z.enum(["active", "resumed", "converged_failed", "completed"]),
  recoveryOutcome: z.enum(["none", "resume", "replan", "fail"]).default("none"),
  /** Conversation transcript from the first regenerable bootstrap message onward (redacted). */
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string().max(512 * 1024),
    toolCallId: z.string().max(512).optional(),
    toolCalls: z.array(z.object({
      id: z.string().max(512),
      name: z.string().max(256),
      arguments: z.string().max(512 * 1024),
    })).max(64).optional(),
  })).max(1_000),
  turnCount: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  writeCallCount: z.number().int().nonnegative(),
  commandCallCount: z.number().int().nonnegative(),
  route: z.object({ providerId: z.string().min(1), modelId: z.string().min(1) }).optional(),
  recoveryDetail: z.string().max(4_096).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AgentRunJournal = z.infer<typeof AgentRunJournalSchema>;
export type AgentRunJournalMessage = AgentRunJournal["messages"][number];

/**
 * R2 recovery lease: ensures at most one recovery worker or process attempts to resume or
 * reconcile an interrupted worker run simultaneously. Bounded by an expiration timestamp.
 */
export const AgentRecoveryLeaseSchema = z.object({
  kind: z.literal("agent_recovery_lease"),
  id: z.string().min(1),
  sessionId: z.string().min(1),
  workerId: z.string().min(1),
  ownerId: z.string().min(1),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AgentRecoveryLease = z.infer<typeof AgentRecoveryLeaseSchema>;

export const ForgeEvalTopologySchema = z.enum(["single_agent", "fixed_team"]);
export type ForgeEvalTopology = z.infer<typeof ForgeEvalTopologySchema>;

export const ForgeEvalOutcomeSchema = z.object({
  status: z.enum(["pass", "fail", "blocked", "unknown"]),
  verified: z.boolean(),
  score: z.number().min(0).max(1),
  oracleId: z.string().min(1),
  tier: z.enum(["deterministic", "structured", "blind_model", "human"]),
  reason: z.string().min(1).max(16_000),
});
export type ForgeEvalOutcome = z.infer<typeof ForgeEvalOutcomeSchema>;

export const ForgeEvalExperimentWorkItemSchema = z.object({
  kind: z.literal("forgeeval_experiment"),
  id: z.string().min(1),
  sessionId: z.string().optional(),
  taskId: z.string().min(1),
  taskType: z.string().min(1),
  capsuleDigest: z.string().min(1),
  startingStateDigest: z.string().min(1),
  controlTopology: ForgeEvalTopologySchema,
  treatmentTopology: ForgeEvalTopologySchema,
  control: ForgeEvalOutcomeSchema.optional(),
  treatment: ForgeEvalOutcomeSchema.optional(),
  environmentalDifferences: z.array(z.string().max(2_048)).max(100),
  status: z.enum(["planned", "running", "graded", "failed"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ForgeEvalExperimentWorkItem = z.infer<typeof ForgeEvalExperimentWorkItemSchema>;

export const AdaptiveTopologySchema = z.enum([
  "fixed_r1",
  "tiny",
  "normal",
  "complex",
  "vision",
]);
export type AdaptiveTopology = z.infer<typeof AdaptiveTopologySchema>;

export const AdaptiveTopologyPlanSchema = z.object({
  topology: AdaptiveTopologySchema,
  explorers: z.number().int().nonnegative(),
  hasPlanner: z.boolean(),
  hasReviewer: z.boolean(),
  hasVision: z.boolean(),
  requiresForgeVerify: z.literal(true),
  reason: z.string().min(1),
  stages: z.array(z.string().min(1)),
});
export type AdaptiveTopologyPlan = z.infer<typeof AdaptiveTopologyPlanSchema>;
