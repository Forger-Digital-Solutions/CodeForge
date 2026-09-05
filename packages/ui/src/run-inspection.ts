import type { WorkspaceEvent } from "@codeforge/protocol";
import type { WorkItem } from "@codeforge/sessions";

type InspectionRecord = Extract<WorkItem, { kind: "run_inspection" }>;

export type InspectionStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "verifying"
  | "repairing"
  | "reviewing"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled";

export interface InspectionAgent {
  id: string;
  role: string;
  parentId?: string;
  task?: string;
  status: "running" | "completed" | "failed" | "cancelled" | "blocked";
  startedAt?: string;
  completedAt?: string;
  result?: string;
  failure?: string;
}

export interface InspectionTool {
  id: string;
  name: string;
  agentId?: string;
  status: "running" | "completed" | "failed" | "blocked";
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  failure?: string;
}

export interface InspectionChange {
  id: string;
  path: string;
  changeType: "created" | "modified" | "deleted";
  additions: number;
  deletions: number;
  diff?: string;
  binary?: boolean;
  beforeSize?: number;
  afterSize?: number;
  truncated?: boolean;
}

export interface InspectionApproval {
  id: string;
  tool: string;
  action: string;
  description: string;
  risk: string;
  status: "pending" | "approved" | "denied";
  requestedAt: string;
  resolvedAt?: string;
}

export interface InspectionVerification {
  attempt: number;
  notConfigured: boolean;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  verifiers: Array<{
    id: string;
    kind: string;
    command: string;
    required: boolean;
    status: string;
    passed: number;
    failed: number;
    skipped: number;
    exitCode: number;
    durationMs: number;
    failureSummary?: string;
  }>;
}

export interface InspectionForgeVerify {
  planId: string;
  policyVersion: string;
  requiredCount: number;
  satisfiedCount: number;
  missingCount: number;
  staleCount: number;
  verificationComplete: boolean;
  missingRequiredVerifiers: string[];
  evidence: Array<{ evidenceId: string; verifierId: string; status: string; durationMs: number; outputTruncated: boolean }>;
}

export interface InspectionRepair {
  attempt: number;
  summary: string;
}

export interface InspectionReview {
  approved: boolean;
  findings: Array<{ code: string; severity: "blocking" | "advisory"; path: string; message: string }>;
}

export interface InspectionCompletion {
  outcome: "completed" | "blocked" | "failed";
  rationale: string;
  blockers: Array<{ code: string; severity: string; message: string }>;
}

export interface RunInspectionState {
  runId: string;
  title?: string;
  status: InspectionStatus;
  phase?: string;
  startedAt?: string;
  completedAt?: string;
  executionMode: "agent";
  workspace?: { id: string; kind: "local" | "git-worktree"; branch?: string; checkpointId?: string };
  agents: InspectionAgent[];
  tools: InspectionTool[];
  changes: InspectionChange[];
  verification: InspectionVerification[];
  forgeVerify?: InspectionForgeVerify;
  repairs: InspectionRepair[];
  approvals: InspectionApproval[];
  review?: InspectionReview;
  completion?: InspectionCompletion;
  provider?: { providerId: string; modelId: string };
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  startFailure?: { code: string; message: string };
}

function compareEvents(left: WorkspaceEvent, right: WorkspaceEvent): number {
  return left.seq - right.seq;
}

/**
 * Deduplication is intentionally by durable server sequence, not timestamp or payload text.
 * Timestamps can collide across concurrent agents and two identical tool calls are still distinct.
 */
export function dedupeRunEvents(events: WorkspaceEvent[], runId: string): WorkspaceEvent[] {
  const seen = new Set<string>();
  return events
    .filter((event) => event.runId === runId)
    .slice()
    .sort(compareEvents)
    .filter((event) => {
      const key = `${event.sessionId}:${event.seq}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function latestInspectionRecord(workItems: WorkItem[], runId: string): InspectionRecord | undefined {
  return workItems.find((item): item is InspectionRecord => item.kind === "run_inspection" && item.runId === runId);
}

function displayStatus(phase: string): InspectionStatus {
  switch (phase) {
    case "user_input_required":
    case "awaiting_approval":
      return "waiting_for_approval";
    case "testing":
    case "verifying":
      return "verifying";
    case "repairing":
      return "repairing";
    case "reviewing":
      return "reviewing";
    case "complete":
    case "completed":
      return "completed";
    case "blocked":
      return "blocked";
    case "failed":
    case "failed_safely":
    case "failed_to_start":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "received":
      return "starting";
    default:
      return "running";
  }
}

function upsertAgent(agents: Map<string, InspectionAgent>, agent: InspectionAgent): void {
  agents.set(agent.id, { ...agents.get(agent.id), ...agent });
}

function upsertTool(tools: Map<string, InspectionTool>, tool: InspectionTool): void {
  tools.set(tool.id, { ...tools.get(tool.id), ...tool });
}

function fromSnapshot(snapshot: InspectionRecord): Pick<RunInspectionState, "changes" | "verification" | "forgeVerify" | "repairs" | "review" | "completion" | "workspace" | "title" | "status" | "phase" | "startedAt" | "completedAt" | "provider" | "usage"> {
  return {
    title: snapshot.taskTitle,
    status: displayStatus(snapshot.status),
    phase: snapshot.phase,
    startedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt,
    workspace: snapshot.workspace,
    changes: snapshot.diffs.map((diff, index) => ({
      id: `${snapshot.runId}:diff:${index}`,
      path: diff.path,
      changeType: diff.changeType,
      additions: diff.additions,
      deletions: diff.deletions,
      ...(diff.diff ? { diff: diff.diff } : {}),
      ...(diff.binary ? { binary: true } : {}),
      ...(diff.beforeSize !== undefined ? { beforeSize: diff.beforeSize } : {}),
      ...(diff.afterSize !== undefined ? { afterSize: diff.afterSize } : {}),
      ...(diff.truncated ? { truncated: true } : {}),
    })),
    verification: snapshot.verificationAttempts,
    ...(snapshot.verification ? { forgeVerify: snapshot.verification } : {}),
    repairs: snapshot.repairs,
    ...(snapshot.review ? { review: snapshot.review } : {}),
    ...(snapshot.completion ? { completion: snapshot.completion } : {}),
    ...(snapshot.provider ? { provider: snapshot.provider } : {}),
    ...(snapshot.usage ? { usage: snapshot.usage } : {}),
  };
}

/** Reduce one run's durable events into a display-only, deterministic inspection state. */
export function projectRunInspection(events: WorkspaceEvent[], workItems: WorkItem[], runId: string): RunInspectionState {
  const agents = new Map<string, InspectionAgent>();
  const tools = new Map<string, InspectionTool>();
  const changes = new Map<string, InspectionChange>();
  const approvals = new Map<string, InspectionApproval>();
  const verification = new Map<number, InspectionVerification>();
  const repairs = new Map<number, InspectionRepair>();
  const state: RunInspectionState = {
    runId,
    executionMode: "agent",
    status: "queued",
    agents: [],
    tools: [],
    changes: [],
    verification: [],
    repairs: [],
    approvals: [],
  };

  for (const event of dedupeRunEvents(events, runId)) {
    switch (event.type) {
      case "task.created":
        state.title = event.payload.title;
        state.status = "starting";
        state.phase = "received";
        state.startedAt = event.timestamp;
        break;
      case "task.started":
        state.status = "running";
        break;
      case "task.state_changed":
        state.phase = event.payload.to;
        state.status = displayStatus(event.payload.to);
        break;
      case "task.completed":
        state.status = "completed";
        state.phase = "completed";
        state.completedAt = event.timestamp;
        break;
      case "task.cancelled":
        state.status = "cancelled";
        state.phase = "cancelled";
        state.completedAt = event.timestamp;
        break;
      case "turn.failed":
        if (state.status !== "blocked" && state.status !== "cancelled") {
          state.status = "failed";
          state.completedAt = event.timestamp;
        }
        break;
      case "agent.started":
        upsertAgent(agents, { id: event.payload.agentId, role: event.payload.role, task: event.payload.taskId, status: "running", startedAt: event.timestamp });
        break;
      case "agent.completed":
        upsertAgent(agents, { id: event.payload.agentId, role: agents.get(event.payload.agentId)?.role ?? "Agent", status: "completed", completedAt: event.timestamp });
        break;
      case "subagent.started":
        upsertAgent(agents, {
          id: event.payload.agentId,
          role: event.payload.role,
          task: event.payload.task,
          ...(event.payload.parentAgentId ? { parentId: event.payload.parentAgentId } : {}),
          status: "running",
          startedAt: event.timestamp,
        });
        break;
      case "subagent.completed":
        upsertAgent(agents, { id: event.payload.agentId, role: agents.get(event.payload.agentId)?.role ?? "Subagent", status: "completed", completedAt: event.timestamp, result: event.payload.result });
        break;
      case "subagent.failed":
        upsertAgent(agents, { id: event.payload.agentId, role: agents.get(event.payload.agentId)?.role ?? "Subagent", status: "failed", completedAt: event.timestamp, failure: event.payload.error });
        break;
      case "tool.started":
        upsertTool(tools, { id: event.payload.toolCallId, name: event.payload.tool, status: "running", startedAt: event.timestamp });
        break;
      case "tool.completed":
        upsertTool(tools, { id: event.payload.toolCallId, name: event.payload.tool, status: "completed", completedAt: event.timestamp, durationMs: event.payload.durationMs });
        break;
      case "tool.failed":
        upsertTool(tools, { id: event.payload.toolCallId, name: event.payload.tool, status: "failed", completedAt: event.timestamp, failure: event.payload.error });
        break;
      case "tool.call_started":
        upsertTool(tools, { id: event.payload.toolCallId, name: event.payload.toolName, ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}), status: "running", startedAt: event.timestamp });
        break;
      case "tool.execution_completed":
        upsertTool(tools, { id: event.payload.toolCallId, name: event.payload.toolName, status: "completed", completedAt: event.timestamp });
        break;
      case "tool.execution_failed":
        upsertTool(tools, { id: event.payload.toolCallId, name: event.payload.toolName, status: "failed", completedAt: event.timestamp, failure: event.payload.error });
        break;
      case "tool.execution_blocked":
        upsertTool(tools, { id: event.payload.toolCallId, name: event.payload.toolName, status: "blocked", completedAt: event.timestamp, failure: event.payload.reason });
        break;
      case "file.change_proposed":
        changes.set(event.payload.changeId, {
          id: event.payload.changeId,
          path: event.payload.path,
          changeType: event.payload.changeType,
          additions: event.payload.additions,
          deletions: event.payload.deletions,
          ...(event.payload.diff ? { diff: event.payload.diff } : {}),
        });
        break;
      case "file.written":
        if (![...changes.values()].some((change) => change.path === event.payload.path)) {
          changes.set(event.payload.fileCallId, { id: event.payload.fileCallId, path: event.payload.path, changeType: "modified", additions: 0, deletions: 0 });
        }
        break;
      case "approval.requested":
        approvals.set(event.payload.approvalId, {
          id: event.payload.approvalId,
          tool: event.payload.tool,
          action: event.payload.action,
          description: event.payload.description,
          risk: event.payload.risk,
          status: "pending",
          requestedAt: event.timestamp,
        });
        break;
      case "approval.resolved": {
        const previous = approvals.get(event.payload.approvalId);
        if (previous) {
          approvals.set(event.payload.approvalId, {
            ...previous,
            status: event.payload.decision === "deny" ? "denied" : "approved",
            resolvedAt: event.timestamp,
          });
        }
        break;
      }
      case "workflow.verification_completed":
        verification.set(event.payload.attempt, {
          attempt: event.payload.attempt,
          notConfigured: event.payload.notConfigured,
          passed: event.payload.passed,
          failed: event.payload.failed,
          skipped: event.payload.skipped,
          durationMs: event.payload.durationMs,
          verifiers: event.payload.verifiers,
        });
        break;
      case "forgeverify.plan_created":
        state.forgeVerify = {
          planId: event.payload.planId,
          policyVersion: event.payload.policyVersion,
          requiredCount: event.payload.requiredVerifierIds.length,
          satisfiedCount: 0,
          missingCount: event.payload.requiredVerifierIds.length,
          staleCount: 0,
          verificationComplete: false,
          missingRequiredVerifiers: event.payload.requiredVerifierIds,
          evidence: [],
        };
        break;
      case "forgeverify.evidence_created": {
        const current = state.forgeVerify;
        if (!current || current.planId !== event.payload.planId) break;
        const evidence = [...current.evidence.filter((item) => item.evidenceId !== event.payload.evidenceId), {
          evidenceId: event.payload.evidenceId,
          verifierId: event.payload.verifierId,
          status: event.payload.status,
          durationMs: event.payload.durationMs,
          outputTruncated: event.payload.outputTruncated,
        }];
        const satisfied = new Set(evidence.filter((item) => item.status === "passed").map((item) => item.verifierId));
        const missing = current.missingRequiredVerifiers.filter((verifierId) => !satisfied.has(verifierId));
        state.forgeVerify = { ...current, evidence, satisfiedCount: current.requiredCount - missing.length, missingCount: missing.length, missingRequiredVerifiers: missing, verificationComplete: current.requiredCount > 0 && missing.length === 0 };
        break;
      }
      case "workflow.repair_attempted":
        repairs.set(event.payload.attempt, { attempt: event.payload.attempt, summary: event.payload.summary });
        break;
      case "workflow.review_completed":
        state.review = { approved: event.payload.approved, findings: event.payload.findings };
        break;
      case "workflow.completion_decided":
        state.completion = event.payload;
        break;
      case "router.selection":
        state.provider = { providerId: event.payload.providerId, modelId: event.payload.modelId };
        break;
      case "token.usage": {
        const previous = state.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        const inputTokens = previous.inputTokens + event.payload.inputTokens;
        const outputTokens = previous.outputTokens + event.payload.outputTokens;
        state.usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
        break;
      }
    }
  }

  const snapshot = latestInspectionRecord(workItems, runId);
  if (snapshot) Object.assign(state, fromSnapshot(snapshot));
  state.agents = [...agents.values()];
  state.tools = [...tools.values()];
  state.changes = snapshot ? state.changes : [...changes.values()];
  state.verification = snapshot ? state.verification : [...verification.values()].sort((left, right) => left.attempt - right.attempt);
  state.repairs = snapshot ? state.repairs : [...repairs.values()].sort((left, right) => left.attempt - right.attempt);
  state.approvals = [...approvals.values()];
  return state;
}

/** Select the newest run that has explicit run-scoped evidence; Chat has no fallback. */
export function selectInspectableRunId(events: WorkspaceEvent[], workItems: WorkItem[], preferredRunId?: string | null): string | undefined {
  if (preferredRunId && events.some((event) => event.runId === preferredRunId)) return preferredRunId;
  const records = workItems
    .filter((item): item is InspectionRecord => item.kind === "run_inspection")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (records[0]) return records[0].runId;
  const latest = events.filter((event) => event.runId && event.type === "task.created").sort(compareEvents).at(-1);
  return latest?.runId;
}
