import { z } from "zod";

export const TaskStatusSchema = z.enum([
  "received",
  "reconnaissance",
  "planning",
  "decomposition",
  "routing",
  "implementing",
  "testing",
  "diagnosing",
  "repairing",
  "reviewing",
  "validating",
  "complete",
  "blocked",
  "waiting_for_free_model",
  "quota_exhausted",
  "user_input_required",
  "failed_safely",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskTypeSchema = z.enum([
  "repo_exploration",
  "architecture",
  "implementation",
  "debugging",
  "testing",
  "refactoring",
  "documentation",
  "research",
  "ui",
  "multi_file_feature",
  "bugfix",
  "test_repair",
]);
export type TaskType = z.infer<typeof TaskTypeSchema>;

export const AgentRoleSchema = z.enum([
  "forge_director",
  "scout",
  "architect",
  "builder",
  "debugger",
  "tester",
  "reviewer",
  "researcher",
  "ui_forge",
  "gems_forge",
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const UserModeSchema = z.enum(["auto", "guided", "manual"]);
export type UserMode = z.infer<typeof UserModeSchema>;

export const ExecutionModeSchema = z.enum(["chat", "agent"]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export const DEFAULT_EXECUTION_MODE: ExecutionMode = "agent";
export const MISSING_EXECUTION_MODE_FALLBACK: ExecutionMode = "chat";

/**
 * A text file the user attached to a message. Only text is accepted at the boundary: the free
 * routes ForgeAuto uses are not vision models, so an image attachment would be silently ignored
 * — the composer refuses images with a visible notice instead of pretending.
 */
export const MAX_ATTACHMENT_CHARS = 200_000;
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;
export const SendAttachmentSchema = z.object({
  name: z.string().min(1).max(260),
  content: z.string().max(MAX_ATTACHMENT_CHARS),
  size: z.number().int().nonnegative().optional(),
});
export type SendAttachment = z.infer<typeof SendAttachmentSchema>;

export const SendRequestSchema = z.object({
  sessionId: z.string().min(1).max(128).optional(),
  message: z.string(),
  attachments: z.array(SendAttachmentSchema).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  turnId: z.string().min(1).max(128).optional(),
  steerId: z.string().min(1).max(128).optional(),
  executionMode: ExecutionModeSchema.optional(),
  steer: z.boolean().optional(),
  userId: z.string().min(1).max(128).optional(),
  verificationCommands: z.array(z.string()).optional(),
  forceHeuristic: z.boolean().optional(),
  /** Continue a stopped task inside the same session authority — injects the
   * previous run's failure context instead of starting a cold new task. */
  repair: z.boolean().optional(),
});
export type SendRequest = z.infer<typeof SendRequestSchema>;

export const UserIntentHoldPolicySchema = z.enum(["expensive_actions_only", "always", "off"]);
export type UserIntentHoldPolicy = z.infer<typeof UserIntentHoldPolicySchema>;

export const USER_INTENT_HOLD_QUIET_GRACE_MS = 1_500;

export const UserIntentHoldRequestSchema = z.object({
  sessionId: z.string().min(1).max(128),
  runId: z.string().min(1).max(128).optional(),
  turnId: z.string().min(1).max(128).optional(),
  action: z.enum(["request", "release"]),
  generation: z.number().int().positive().optional(),
});
export type UserIntentHoldRequest = z.infer<typeof UserIntentHoldRequestSchema>;

export const PermissionDecisionSchema = z.enum(["allow", "ask", "deny"]);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export type { Capability } from "./workspace-state.js";
export type { ModelHealth } from "./workspace-state.js";
export type { FreeStatus } from "./workspace-state.js";
export { CapabilitySchema } from "./workspace-state.js";
export { ModelHealthSchema } from "./workspace-state.js";
export { FreeStatusSchema } from "./workspace-state.js";

const ATTACHMENT_OPEN = (name: string, size: number) => `--- Attached file: ${name} (${size} chars) ---`;
const ATTACHMENT_CLOSE = "--- End of attached file ---";

/**
 * Fold attachments into the message the runtime executes. The user's own words come first; each
 * file follows in a delimited block the conversation view can collapse back into a chip.
 */
export function composeMessageWithAttachments(message: string, attachments: SendAttachment[] | undefined): string {
  if (!attachments || attachments.length === 0) return message;
  const blocks = attachments.map((a) => `${ATTACHMENT_OPEN(a.name, a.content.length)}\n${a.content}\n${ATTACHMENT_CLOSE}`);
  return `${message.trimEnd()}\n\n${blocks.join("\n\n")}`;
}

/** Split a composed message back into the user's text and its attachment blocks (for display). */
export function splitMessageAttachments(composed: string): { text: string; attachments: Array<{ name: string; content: string }> } {
  const re = /--- Attached file: (.+?) \(\d+ chars\) ---\n([\s\S]*?)\n--- End of attached file ---/g;
  const attachments: Array<{ name: string; content: string }> = [];
  let text = composed;
  let match: RegExpExecArray | null;
  while ((match = re.exec(composed)) !== null) {
    attachments.push({ name: match[1]!, content: match[2]! });
    text = text.replace(match[0], "");
  }
  return { text: text.trim(), attachments };
}
