import { z } from "zod";
import {
  SessionStatusSchema,
  PlanStepStatusSchema,
  PlanStatusSchema,
  ApprovalDecisionSchema,
  DisplayModeSchema,
  ChangeTypeSchema,
  AgentStatusSchema,
  ArtifactTypeSchema,
  RestoreTypeSchema,
  CommandStreamSchema,
  RiskLevelSchema,
  PermissionPolicySchema,
  EvidenceReferenceKindSchema,
  ContextReferenceTypeSchema,
} from "@codeforge/protocol";

export const SessionRecordSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  status: SessionStatusSchema,
  currentAgentId: z.string().optional(),
  currentModelId: z.string().optional(),
  currentProviderId: z.string().optional(),
  permissionMode: PermissionPolicySchema.optional(),
  displayMode: DisplayModeSchema.optional(),
  branch: z.string().optional(),
  workspacePath: z.string().optional(),
  taskTitle: z.string().optional(),
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export const TurnRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  userMessage: z.string(),
  status: SessionStatusSchema,
  agentId: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  error: z.string().optional(),
});
export type TurnRecord = z.infer<typeof TurnRecordSchema>;

export const WorkItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("activity"),
    id: z.string(),
    sessionId: z.string(),
    turnId: z.string().optional(),
    title: z.string(),
    status: z.enum(["started", "completed", "failed"]),
    detail: z.string().optional(),
    expandedDetail: z.string().optional(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    durationMs: z.number().optional(),
  }),
  z.object({
    kind: z.literal("plan"),
    id: z.string(),
    sessionId: z.string(),
    turnId: z.string().optional(),
    title: z.string(),
    status: PlanStatusSchema,
    steps: z.array(
      z.object({
        id: z.string(),
        description: z.string(),
        status: PlanStepStatusSchema,
      }),
    ),
    comments: z
      .array(
        z.object({
          id: z.string(),
          stepId: z.string().optional(),
          text: z.string(),
          author: z.string(),
          createdAt: z.string().datetime(),
        }),
      )
      .optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
  z.object({
    kind: z.literal("command"),
    id: z.string(),
    sessionId: z.string(),
    turnId: z.string().optional(),
    command: z.string(),
    workingDirectory: z.string().optional(),
    status: z.enum(["running", "completed", "failed"]),
    exitCode: z.number().optional(),
    durationMs: z.number().optional(),
    output: z.string().optional(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
  }),
  z.object({
    kind: z.literal("file_change"),
    id: z.string(),
    sessionId: z.string(),
    turnId: z.string().optional(),
    path: z.string(),
    changeType: ChangeTypeSchema,
    additions: z.number(),
    deletions: z.number(),
    description: z.string().optional(),
    diff: z.string().optional(),
    comments: z
      .array(
        z.object({
          id: z.string(),
          line: z.number().optional(),
          text: z.string(),
          author: z.string(),
          createdAt: z.string().datetime(),
        }),
      )
      .optional(),
    appliedAt: z.string().datetime().optional(),
  }),
  z.object({
    kind: z.literal("approval"),
    id: z.string(),
    sessionId: z.string(),
    turnId: z.string().optional(),
    tool: z.string(),
    action: z.string(),
    description: z.string(),
    risk: RiskLevelSchema,
    scope: z.string().optional(),
    decision: ApprovalDecisionSchema.optional(),
    resolvedAt: z.string().datetime().optional(),
    createdAt: z.string().datetime(),
  }),
  z.object({
    kind: z.literal("question"),
    id: z.string(),
    sessionId: z.string(),
    turnId: z.string().optional(),
    prompt: z.string(),
    options: z.array(z.string()).optional(),
    answer: z.string().optional(),
    resolvedAt: z.string().datetime().optional(),
    createdAt: z.string().datetime(),
  }),
  z.object({
    kind: z.literal("artifact"),
    id: z.string(),
    sessionId: z.string(),
    turnId: z.string().optional(),
    type: ArtifactTypeSchema,
    title: z.string(),
    content: z.string().optional(),
    status: z.enum(["draft", "ready", "approved", "rejected"]),
    author: z.string().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
  z.object({
    kind: z.literal("test_run"),
    id: z.string(),
    sessionId: z.string(),
    turnId: z.string().optional(),
    name: z.string(),
    passed: z.number(),
    failed: z.number(),
    skipped: z.number(),
    failures: z
      .array(
        z.object({
          test: z.string(),
          message: z.string(),
          stack: z.string().optional(),
        }),
      )
      .optional(),
    durationMs: z.number().optional(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
  }),
  z.object({
    kind: z.literal("agent"),
    id: z.string(),
    sessionId: z.string(),
    role: z.string(),
    status: AgentStatusSchema,
    task: z.string(),
    parentAgentId: z.string().optional(),
    progress: z.number().min(0).max(100).optional(),
    modelId: z.string().optional(),
    providerId: z.string().optional(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
  }),
  z.object({
    kind: z.literal("checkpoint"),
    id: z.string(),
    sessionId: z.string(),
    label: z.string(),
    branch: z.string().optional(),
    fileCount: z.number(),
    testStatus: z.string().optional(),
    createdAt: z.string().datetime(),
  }),
  z.object({
    kind: z.literal("evidence"),
    id: z.string(),
    sessionId: z.string(),
    turnId: z.string().optional(),
    conclusion: z.string(),
    references: z.array(
      z.object({
        kind: EvidenceReferenceKindSchema,
        ref: z.string(),
      }),
    ),
    createdAt: z.string().datetime(),
  }),
  z.object({
    kind: z.literal("context_ref"),
    id: z.string(),
    sessionId: z.string(),
    refType: ContextReferenceTypeSchema,
    ref: z.string(),
    label: z.string().optional(),
    addedAt: z.string().datetime(),
  }),
]);
export type WorkItem = z.infer<typeof WorkItemSchema>;
export type WorkItemKind = WorkItem["kind"];

export const isWorkItem = (value: unknown): value is WorkItem =>
  WorkItemSchema.safeParse(value).success;

export const isWorkItemKind = <K extends WorkItem["kind"]>(item: WorkItem, kind: K): item is Extract<WorkItem, { kind: K }> =>
  item.kind === kind;
