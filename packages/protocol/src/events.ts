import { z } from "zod";

const EventBase = <T extends string, S extends z.ZodType>(type: T, schema: S) =>
  z.object({
    type: z.literal(type),
    timestamp: z.string().datetime(),
    seq: z.number().int().nonnegative(),
    sessionId: z.string(),
    payload: schema,
  });

export const TaskCreatedSchema = EventBase(
  "task.created",
  z.object({ taskId: z.string(), title: z.string(), mode: z.string() }),
);
export const TaskStartedSchema = EventBase("task.started", z.object({ taskId: z.string() }));
export const TaskStateChangedSchema = EventBase(
  "task.state_changed",
  z.object({
    taskId: z.string(),
    from: z.string(),
    to: z.string(),
  }),
);
export const TaskCompletedSchema = EventBase(
  "task.completed",
  z.object({ taskId: z.string(), result: z.string() }),
);
export const TaskCancelledSchema = EventBase(
  "task.cancelled",
  z.object({ taskId: z.string(), reason: z.string().optional() }),
);

export const AgentStartedSchema = EventBase(
  "agent.started",
  z.object({ agentId: z.string(), role: z.string(), taskId: z.string() }),
);
export const AgentCompletedSchema = EventBase(
  "agent.completed",
  z.object({ agentId: z.string(), taskId: z.string() }),
);

export const RouterSelectionSchema = EventBase(
  "router.selection",
  z.object({
    taskId: z.string(),
    modelId: z.string(),
    providerId: z.string(),
    score: z.number(),
    reasons: z.array(z.string()),
  }),
);
export const RouterFailoverSchema = EventBase(
  "router.failover",
  z.object({
    taskId: z.string(),
    fromModelId: z.string(),
    toModelId: z.string(),
    reason: z.string(),
  }),
);

export const ProviderRateLimitedSchema = EventBase(
  "provider.rate_limited",
  z.object({ providerId: z.string(), retryAfterMs: z.number().optional() }),
);
export const ProviderQuotaExhaustedSchema = EventBase(
  "provider.quota_exhausted",
  z.object({ providerId: z.string() }),
);

export const ToolStartedSchema = EventBase(
  "tool.started",
  z.object({ toolCallId: z.string(), tool: z.string(), taskId: z.string() }),
);
export const ToolCompletedSchema = EventBase(
  "tool.completed",
  z.object({ toolCallId: z.string(), tool: z.string(), durationMs: z.number() }),
);
export const ToolFailedSchema = EventBase(
  "tool.failed",
  z.object({ toolCallId: z.string(), tool: z.string(), error: z.string() }),
);

export const FileChangedSchema = EventBase(
  "file.changed",
  z.object({ path: z.string(), changeType: z.enum(["created", "modified", "deleted"]) }),
);
export const GitCheckpointCreatedSchema = EventBase(
  "git.checkpoint_created",
  z.object({ checkpointId: z.string(), ref: z.string() }),
);

export const TestStartedSchema = EventBase("test.started", z.object({ taskId: z.string() }));
export const TestCompletedSchema = EventBase(
  "test.completed",
  z.object({
    taskId: z.string(),
    passed: z.number(),
    failed: z.number(),
    skipped: z.number(),
  }),
);

export const ReviewStartedSchema = EventBase("review.started", z.object({ taskId: z.string() }));
export const ReviewCompletedSchema = EventBase(
  "review.completed",
  z.object({ taskId: z.string(), accepted: z.boolean(), issues: z.array(z.string()) }),
);

export const PermissionRequestedSchema = EventBase(
  "permission.requested",
  z.object({
    taskId: z.string(),
    tool: z.string(),
    description: z.string(),
  }),
);

export const ForgeEventSchema = z.discriminatedUnion("type", [
  TaskCreatedSchema,
  TaskStartedSchema,
  TaskStateChangedSchema,
  TaskCompletedSchema,
  TaskCancelledSchema,
  AgentStartedSchema,
  AgentCompletedSchema,
  RouterSelectionSchema,
  RouterFailoverSchema,
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
]);
export type ForgeEvent = z.infer<typeof ForgeEventSchema>;

export type ForgeEventType = ForgeEvent["type"];

export const isForgeEvent = (value: unknown): value is ForgeEvent =>
  ForgeEventSchema.safeParse(value).success;
