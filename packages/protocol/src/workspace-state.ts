import { z } from "zod";

export const SessionStatusSchema = z.enum([
  "idle",
  "running",
  "paused",
  "waiting_for_approval",
  "waiting_for_question",
  "completed",
  "failed",
  "cancelled",
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const PlanStepStatusSchema = z.enum([
  "queued",
  "active",
  "completed",
  "blocked",
  "failed",
  "skipped",
]);
export type PlanStepStatus = z.infer<typeof PlanStepStatusSchema>;

export const PlanStatusSchema = z.enum([
  "draft",
  "review",
  "approved",
  "rejected",
  "superseded",
  "completed",
]);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const ApprovalDecisionSchema = z.enum(["allow_once", "allow_session", "deny"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const DisplayModeSchema = z.enum(["compact", "detailed", "debug"]);
export type DisplayMode = z.infer<typeof DisplayModeSchema>;

export const ChangeTypeSchema = z.enum(["created", "modified", "deleted"]);
export type ChangeType = z.infer<typeof ChangeTypeSchema>;

export const AgentStatusSchema = z.enum([
  "idle",
  "queued",
  "working",
  "waiting",
  "completed",
  "failed",
  "cancelled",
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const ArtifactTypeSchema = z.enum([
  "plan",
  "report",
  "diagram",
  "screenshot",
  "verification",
  "documentation",
  "benchmark",
  "security",
  "migration",
]);
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export const RestoreTypeSchema = z.enum([
  "code_and_conversation",
  "conversation_only",
  "code_only",
]);
export type RestoreType = z.infer<typeof RestoreTypeSchema>;

export const CommandStreamSchema = z.enum(["stdout", "stderr"]);
export type CommandStream = z.infer<typeof CommandStreamSchema>;

export const RiskLevelSchema = z.enum(["safe", "moderate", "high", "critical"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const PermissionPolicySchema = z.enum(["allow", "ask", "deny"]);
export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;

export const VerificationStepSchema = z.enum([
  "verify_cost",
  "verify_free_status",
  "verify_paid_fallback_disabled",
  "verify_provider_account",
  "allow",
]);
export type VerificationStep = z.infer<typeof VerificationStepSchema>;

export const ModelHealthSchema = z.enum([
  "configured",
  "authenticated",
  "verified",
  "available",
  "rate_limited",
  "quota_exhausted",
  "offline",
  "unknown",
]);
export type ModelHealth = z.infer<typeof ModelHealthSchema>;

export const FreeStatusSchema = z.enum([
  "verified_free",
  "unknown",
  "expired",
  "paid",
  "temporarily_unavailable",
]);
export type FreeStatus = z.infer<typeof FreeStatusSchema>;

export const CapabilitySchema = z.enum([
  "text",
  "coding",
  "toolCalling",
  "vision",
  "structuredOutput",
  "longContext",
]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const EvidenceReferenceKindSchema = z.enum(["file", "test", "command", "artifact"]);
export type EvidenceReferenceKind = z.infer<typeof EvidenceReferenceKindSchema>;

export const ContextReferenceTypeSchema = z.enum([
  "file",
  "folder",
  "symbol",
  "project",
  "branch",
  "session",
  "artifact",
  "test",
]);
export type ContextReferenceType = z.infer<typeof ContextReferenceTypeSchema>;
