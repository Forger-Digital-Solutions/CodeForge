import type { ISessionPersistence, WorkItem } from "@codeforge/sessions";
import type { EngineeringPlan, ContractState, WorkstreamResult } from "./parallel-workstreams.js";

/** How a dispatched worktree was classified once the parent run reached a terminal state. */
export type ParallelDispatchCleanup = "retained_dirty" | "released" | "cleaned" | "missing" | "orphaned";

export type ParallelRunStatus = "created" | "planning" | "executing" | "synthesizing" | "reviewing" | "verifying" | "integrating" | "completed" | "blocked" | "cancelled" | "failed";

export interface ParallelSynthesisState {
  workspaceId: string;
  worktreeId: string;
  branch?: string;
  order: string[];
  included: Array<{ workstreamId: string; sourceRevision: string; resultingRevision: string }>;
  conflicts: Array<{ workstreams: string[]; paths: string[]; type: string }>;
}

/** Aggregate provider-reported usage for one parallel run; nothing here is estimated. */
export interface ParallelRunUsage {
  modelRequests: number;
  agentTurns: number;
  toolCalls: number;
  writeCalls: number;
  commandExecutions: number;
  verificationRuns: number;
  inputTokens: number;
  outputTokens: number;
}

export function emptyParallelRunUsage(): ParallelRunUsage {
  return { modelRequests: 0, agentTurns: 0, toolCalls: 0, writeCalls: 0, commandExecutions: 0, verificationRuns: 0, inputTokens: 0, outputTokens: 0 };
}

export interface DurableParallelRun {
  kind: "parallel_run";
  id: string;
  sessionId: string;
  workspaceId: string;
  goal: string;
  status: ParallelRunStatus;
  baseRevision: string;
  plan?: EngineeringPlan;
  workstreams: WorkstreamResult[];
  dispatches: Array<{ workstreamId: string; dispatchId: string; workspaceId: string; worktreeId: string; branch?: string; state: "dispatched" | "active" | "completed" | "cancelled" | "revalidation_required"; cleanup?: ParallelDispatchCleanup; retainedPath?: string; branchPreserved?: boolean }>;
  contracts: ContractState[];
  synthesis?: ParallelSynthesisState;
  promotion?: { status: string; code?: string };
  /** Verification gate the caller configured, so a resumed run applies the same gate. */
  verificationCommands?: string[];
  usage?: ParallelRunUsage;
  /** Set once the terminal retention pass has classified every dispatched worktree. */
  cleanupCompletedAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ParallelEvent {
  type: string;
  sessionId: string;
  runId: string;
  workstreamId?: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export class ParallelRunStore {
  constructor(private readonly persistence?: ISessionPersistence, private readonly onEvent?: (event: ParallelEvent) => void) {}

  async save(run: DurableParallelRun): Promise<void> {
    if (!this.persistence) return;
    await this.persistence.upsertWorkItem({
      kind: "parallel_run", id: run.id, sessionId: run.sessionId, workspaceId: run.workspaceId,
      goal: run.goal, status: run.status, baseRevision: run.baseRevision,
      ...(run.plan ? { planJson: JSON.stringify(run.plan) } : {}),
      workstreamsJson: JSON.stringify({ results: run.workstreams, dispatches: run.dispatches }), contractsJson: JSON.stringify(run.contracts),
      ...(run.synthesis ? { synthesisJson: JSON.stringify(run.synthesis) } : {}),
      ...(run.promotion ? { promotionJson: JSON.stringify(run.promotion) } : {}),
      ...(run.verificationCommands ? { verificationCommandsJson: JSON.stringify(run.verificationCommands) } : {}),
      ...(run.usage ? { usageJson: JSON.stringify(run.usage) } : {}),
      ...(run.cleanupCompletedAt ? { cleanupCompletedAt: run.cleanupCompletedAt } : {}),
      ...(run.error ? { error: run.error } : {}), createdAt: run.createdAt, updatedAt: run.updatedAt,
    } as WorkItem);
  }

  async get(runId: string): Promise<DurableParallelRun | undefined> {
    const item = await this.persistence?.getWorkItem(runId);
    if (!item || item.kind !== "parallel_run") return undefined;
    const workstreamState = item.workstreamsJson ? JSON.parse(item.workstreamsJson) as WorkstreamResult[] | { results?: WorkstreamResult[]; dispatches?: DurableParallelRun["dispatches"] } : [];
    const results = Array.isArray(workstreamState) ? workstreamState : workstreamState.results ?? [];
    const dispatches = Array.isArray(workstreamState) ? [] : workstreamState.dispatches ?? [];
    return {
      kind: "parallel_run", id: item.id, sessionId: item.sessionId, workspaceId: item.workspaceId,
      goal: item.goal, status: item.status, baseRevision: item.baseRevision,
      ...(item.planJson ? { plan: JSON.parse(item.planJson) as EngineeringPlan } : {}),
      workstreams: results, dispatches,
      contracts: item.contractsJson ? JSON.parse(item.contractsJson) as ContractState[] : [],
      ...(item.synthesisJson ? { synthesis: JSON.parse(item.synthesisJson) as ParallelSynthesisState } : {}),
      ...(item.promotionJson ? { promotion: JSON.parse(item.promotionJson) as { status: string; code?: string } } : {}),
      ...(item.verificationCommandsJson ? { verificationCommands: JSON.parse(item.verificationCommandsJson) as string[] } : {}),
      ...(item.usageJson ? { usage: JSON.parse(item.usageJson) as ParallelRunUsage } : {}),
      ...(item.cleanupCompletedAt ? { cleanupCompletedAt: item.cleanupCompletedAt } : {}),
      ...(item.error ? { error: item.error } : {}), createdAt: item.createdAt, updatedAt: item.updatedAt,
    };
  }

  async list(sessionId?: string): Promise<DurableParallelRun[]> {
    const items = sessionId ? (await this.persistence?.getWorkItems(sessionId)) ?? [] : (await this.persistence?.getWorkItemsByKind("parallel_run")) ?? [];
    const candidates = items.filter((item) => item.kind === "parallel_run");
    const resolved = await Promise.all(candidates.map((item) => this.get(item.id)));
    return resolved.filter((run): run is DurableParallelRun => Boolean(run));
  }

  async emit(run: DurableParallelRun, type: string, payload: Record<string, unknown> = {}, workstreamId?: string): Promise<void> {
    const event: ParallelEvent = { type, sessionId: run.sessionId, runId: run.id, ...(workstreamId ? { workstreamId } : {}), timestamp: new Date().toISOString(), payload };
    await this.persistence?.appendEvent(event);
    this.onEvent?.(event);
  }
}
