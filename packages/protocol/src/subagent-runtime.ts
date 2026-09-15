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
