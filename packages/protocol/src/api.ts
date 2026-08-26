import { z } from "zod";
import {
  CapabilitySchema,
  FreeStatusSchema,
  ModelHealthSchema,
  PermissionPolicySchema,
} from "./workspace-state.js";

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

export const PermissionDecisionSchema = z.enum(["allow", "ask", "deny"]);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export type { Capability } from "./workspace-state.js";
export type { ModelHealth } from "./workspace-state.js";
export type { FreeStatus } from "./workspace-state.js";
export { CapabilitySchema } from "./workspace-state.js";
export { ModelHealthSchema } from "./workspace-state.js";
export { FreeStatusSchema } from "./workspace-state.js";

