import { z } from "zod";

export const DesktopWorkerActionTypeSchema = z.enum([
  "READ_FILE",
  "LIST_FILES",
  "SEARCH_FILES",
  "WRITE_PATCH",
  "CREATE_FILE",
  "DELETE_FILE",
  "RUN_COMMAND",
  "CHECK_GIT_STATUS",
  "GET_DIFF",
  "RUN_TEST",
  "REQUEST_APPROVAL",
  "ASK_USER",
]);
export type DesktopWorkerActionType = z.infer<typeof DesktopWorkerActionTypeSchema>;

export const DesktopWorkerActionRequestSchema = z.object({
  actionId: z.string().uuid(),
  workflowId: z.string().min(1).max(128),
  turnId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  workerId: z.string().min(1).max(128),
  type: DesktopWorkerActionTypeSchema,
  arguments: z.record(z.unknown()),
  idempotencyKey: z.string().min(1).max(256),
  expectedWorkspaceRevision: z.string().max(256).optional(),
  cancellationId: z.string().uuid().optional(),
});
export type DesktopWorkerActionRequest = z.infer<typeof DesktopWorkerActionRequestSchema>;

export const DesktopWorkerActionResultSchema = z.object({
  actionId: z.string().uuid(),
  workerId: z.string().min(1).max(128),
  status: z.enum(["succeeded", "failed", "cancelled", "stale"]),
  output: z.string().max(32_768),
  exitCode: z.number().int().optional(),
  workspaceRevision: z.string().max(256).optional(),
  changedResources: z.array(z.string().max(512)).max(256).default([]),
});
export type DesktopWorkerActionResult = z.infer<typeof DesktopWorkerActionResultSchema>;
