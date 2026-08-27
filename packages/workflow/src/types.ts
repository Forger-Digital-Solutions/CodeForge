import type { TaskStatus, TaskType } from "@codeforge/protocol";

export type WorkflowPhase =
  | "received"
  | "understanding"
  | "inspecting"
  | "building_context"
  | "planning"
  | "awaiting_approval"
  | "implementing"
  | "verifying"
  | "diagnosing"
  | "repairing"
  | "reviewing"
  | "summarizing"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskIntent {
  rawMessage: string;
  title: string;
  taskType: TaskType;
  goals: string[];
  constraints: string[];
  keywords: string[];
  risk: "low" | "medium" | "high";
  requiresApproval: boolean;
}

export interface RepoFileInfo {
  path: string;
  relativePath: string;
  size: number;
  lines: number;
}

export interface RepoMap {
  workspacePath: string;
  files: RepoFileInfo[];
  searchedMatches: Array<{ file: string; line: number; column: number; preview: string }>;
  readFiles: Array<{ path: string; content: string; hash: string; lines: number; truncated: boolean }>;
}

export interface ContextBundle {
  primaryFiles: string[];
  relevanceScores: Map<string, number>;
  snippets: Array<{ path: string; preview: string; relevance: number }>;
  tokensApprox: number;
  summary: string;
}

export interface PlanStep {
  id: string;
  description: string;
  status: "queued" | "active" | "completed" | "blocked" | "failed" | "skipped";
  kind: "inspect" | "read" | "edit" | "write" | "command" | "verify" | "review";
  targetPath?: string;
  command?: string;
  oldText?: string;
  newText?: string;
  risk: "safe" | "moderate" | "high" | "critical";
  requiresApproval: boolean;
}

export interface WorkflowPlan {
  id: string;
  title: string;
  taskId: string;
  status: "draft" | "review" | "approved" | "rejected" | "superseded" | "completed";
  steps: PlanStep[];
  createdAt: string;
  updatedAt: string;
}

export interface VerificationResult {
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  output: string;
  exitCode: number;
  command: string;
  failures: Array<{ test: string; message: string; stack?: string }>;
}

export interface FailureAnalysis {
  hasFailures: boolean;
  summary: string;
  diagnostics: string[];
  suggestedRepairs: Array<{ file: string; oldText: string; newText: string; reason: string }>;
  isRepairable: boolean;
}

export interface DiffEntry {
  path: string;
  changeType: "created" | "modified" | "deleted";
  additions: number;
  deletions: number;
  diff: string;
  beforeHash: string;
  afterHash: string;
}

export interface ReviewDecision {
  approved: boolean;
  issues: string[];
  diffs: DiffEntry[];
  summary: string;
}

export interface WorkflowTask {
  id: string;
  sessionId: string;
  turnId: string;
  title: string;
  userMessage: string;
  workspacePath: string;
  status: TaskStatus;
  phase: WorkflowPhase;
  progress: number;
  createdAt: string;
  updatedAt: string;
  planId?: string;
  error?: string;
  summary?: string;
}

export interface WorkflowResult {
  taskId: string;
  status: "completed" | "failed" | "cancelled" | "requires_approval";
  phase: WorkflowPhase;
  summary: string;
  plan?: WorkflowPlan;
  verification?: VerificationResult;
  review?: ReviewDecision;
  evidenceId?: string;
  checkpointId?: string;
  diffSummary?: string;
}

export interface ApprovalRequest {
  approvalId: string;
  taskId: string;
  planId: string;
  description: string;
  risk: "safe" | "moderate" | "high" | "critical";
  createdAt: number;
}

export type WorkflowEventType =
  | "workflow.phase_changed"
  | "workflow.task_created"
  | "workflow.context_built"
  | "workflow.plan_created"
  | "workflow.approval_requested"
  | "workflow.implementation_started"
  | "workflow.verification_started"
  | "workflow.repair_attempted";

export interface WorkflowEvent {
  type: WorkflowEventType;
  taskId: string;
  sessionId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}
