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
  | "blocked"
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
  /**
   * CF-17: the authoritative execution revision. Revision 1 is the original approved plan; a
   * material user steer consumed at a safe boundary increments it, and completion must bind to
   * verification evidence produced for exactly this revision.
   */
  revision?: number;
  createdAt: string;
  updatedAt: string;
}

export type VerifierKind = "test" | "typecheck" | "build" | "lint" | "custom";

export interface Verifier {
  id: string;
  kind: VerifierKind;
  command: string;
  cwd?: string;
  required: boolean;
  timeoutMs?: number;
  source: "discovered" | "configured" | "default";
}

export interface VerifierRunResult {
  id: string;
  kind: VerifierKind;
  command: string;
  required: boolean;
  status: "passed" | "failed" | "not_configured" | "timed_out" | "cancelled" | "infra_error" | "interrupted";
  passed: number;
  failed: number;
  skipped: number;
  exitCode: number;
  durationMs: number;
  output: string;
  failures: Array<{ test: string; message: string; stack?: string }>;
  timedOut?: boolean;
  cancelled?: boolean;
  notConfigured?: boolean;
}

export interface VerificationResult {
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  output: string;
  exitCode: number;
  command: string;
  cwd?: string;
  failures: Array<{ test: string; message: string; stack?: string }>;
  timedOut?: boolean;
  cancelled?: boolean;
  /**
   * No verification command could run in this workspace (e.g. no `test` script). Distinct from a
   * failure: nothing was executed, so there is no result to pass or fail. Consumers must not read
   * this as a pass.
   */
  notConfigured?: boolean;
}

export interface VerificationReport extends VerificationResult {
  verifiers: VerifierRunResult[];
  requiredPassed: boolean;
  hasFailures: boolean;
  advisories: VerifierRunResult[];
  overallStatus: "passed" | "failed" | "blocked";
  summary: string;
  /** The canonical structured evidence used by the completion gate when present. */
  forgeVerify?: import("./forge-verify.js").ForgeVerifyExecution;
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
  /** Binary contents are never placed in the product evidence stream. */
  binary?: boolean;
  beforeSize?: number;
  afterSize?: number;
  /** The stored patch is deliberately bounded for UI safety. */
  truncated?: boolean;
}

export type ReviewFindingSeverity = "blocking" | "advisory";

export interface ReviewFinding {
  code: "sensitive_file" | "oversized_diff";
  severity: ReviewFindingSeverity;
  path: string;
  message: string;
}

export interface ReviewDecision {
  approved: boolean;
  issues: string[];
  /** Structured form of `issues`; the completion gate reads severity from here, not from prose. */
  findings: ReviewFinding[];
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
  status: "completed" | "blocked" | "failed" | "cancelled" | "requires_approval";
  phase: WorkflowPhase;
  summary: string;
  plan?: WorkflowPlan;
  verification?: VerificationResult;
  /** Every actual verification attempt, retained so repair never rewrites a failed history. */
  verificationAttempts?: VerificationResult[];
  review?: ReviewDecision;
  /** Why the runtime allowed or refused completion. Present on every non-cancelled terminal result. */
  completion?: import("./completion-gate.js").CompletionGateDecision;
  evidenceId?: string;
  checkpointId?: string;
  diffSummary?: string;
  verificationRecommendation?: import("@codeforge/forge-green").VerificationRecommendation;
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
  | "workflow.verification_completed"
  | "workflow.review_finished"
  | "workflow.completion_blocked"
  | "workflow.repair_attempted";

export interface WorkflowEvent {
  type: WorkflowEventType;
  taskId: string;
  sessionId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}
