import type { AgentEvidenceRef, AgentFinding, ReviewResult } from "@codeforge/agent";
import type { VerificationResult } from "@codeforge/workflow";

export const DEFAULT_PARALLEL_EXECUTION_BUDGET = {
  maxParallelWorkstreams: 3,
  maxActiveCoders: 3,
  maxActiveReviewers: 2,
  maxTotalWorkstreams: 12,
  maxSynthesisRounds: 1,
  maxConflictRepairRounds: 2,
  maxRevisionRounds: 2,
} as const;

export interface ParallelExecutionBudget {
  maxParallelWorkstreams: number;
  maxActiveCoders: number;
  maxActiveReviewers: number;
  maxTotalWorkstreams: number;
  maxSynthesisRounds: number;
  maxConflictRepairRounds: number;
  /** Bounded Coder revision rounds driven by public structured Reviewer findings. */
  maxRevisionRounds?: number;
}

export type WorkstreamStatus = "pending" | "ready" | "running" | "reviewing" | "completed" | "blocked" | "failed" | "cancelled";

export interface WorkstreamContract {
  id: string;
  producerWorkstreamId: string;
  consumerWorkstreamIds: string[];
  kind: "type" | "api" | "event" | "schema" | "module" | "database" | "other";
  revision: string;
  summary: string;
  evidence: AgentEvidenceRef[];
}

export interface EngineeringWorkstream {
  id: string;
  title: string;
  objective: string;
  dependencies: string[];
  expectedFiles?: string[];
  expectedModules?: string[];
  contractsProduced?: string[];
  contractsConsumed?: string[];
  verificationCommands?: string[];
  status?: WorkstreamStatus;
}

export interface EngineeringPlan {
  id: string;
  goal: string;
  workstreams: EngineeringWorkstream[];
  globalVerificationCommands?: string[];
}

export interface WorkstreamResult {
  workstreamId: string;
  status: "completed" | "blocked" | "failed" | "cancelled";
  workspaceId: string;
  worktreeId: string;
  branch?: string;
  baseRevision: string;
  resultRevision?: string;
  changedFiles: string[];
  contractsProduced: WorkstreamContract[];
  review: ReviewResult;
  verification: VerificationResult[];
  evidence: AgentEvidenceRef[];
  findings: AgentFinding[];
}

export interface ContractState {
  contract: WorkstreamContract;
  publishedAt: string;
  /** A newer producer revision makes every already-started consumer stale by default. */
  staleConsumerWorkstreamIds: string[];
}

/**
 * Keeps the only cross-workstream payload deliberately small and public.  Coder and reviewer
 * transcripts are never accepted here, so they cannot become an accidental dependency channel.
 */
export class WorkstreamContractRegistry {
  private readonly contracts = new Map<string, ContractState>();

  publish(contract: WorkstreamContract): ContractState {
    const existing = this.contracts.get(contract.id);
    const staleConsumerWorkstreamIds = existing && existing.contract.revision !== contract.revision
      ? [...new Set([...existing.contract.consumerWorkstreamIds, ...contract.consumerWorkstreamIds])]
      : [];
    const state = { contract: { ...contract, evidence: [...contract.evidence] }, publishedAt: new Date().toISOString(), staleConsumerWorkstreamIds };
    this.contracts.set(contract.id, state);
    return state;
  }

  get(id: string): ContractState | undefined {
    const state = this.contracts.get(id);
    return state && { ...state, contract: { ...state.contract, evidence: [...state.contract.evidence] }, staleConsumerWorkstreamIds: [...state.staleConsumerWorkstreamIds] };
  }

  getForConsumer(workstreamId: string, ids: string[]): WorkstreamContract[] | undefined {
    const states = ids.map((id) => this.contracts.get(id));
    if (states.some((state) => !state || state.staleConsumerWorkstreamIds.includes(workstreamId) || !state.contract.consumerWorkstreamIds.includes(workstreamId))) return undefined;
    return states.map((state) => ({ ...state!.contract, evidence: [...state!.contract.evidence] }));
  }

  all(): ContractState[] { return [...this.contracts.values()].map((state) => ({ ...state, contract: { ...state.contract, evidence: [...state.contract.evidence] }, staleConsumerWorkstreamIds: [...state.staleConsumerWorkstreamIds] })); }
}

export interface PlanValidationResult {
  valid: boolean;
  error?: string;
  orderedWorkstreamIds?: string[];
}

function safeArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim() !== "");
}

/** Validates model-proposed workstreams before scheduling any writer. */
export function validateEngineeringPlan(value: unknown, budget: ParallelExecutionBudget = DEFAULT_PARALLEL_EXECUTION_BUDGET): PlanValidationResult {
  if (!value || typeof value !== "object") return { valid: false, error: "Engineering plan must be an object" };
  const plan = value as Partial<EngineeringPlan>;
  if (typeof plan.id !== "string" || !plan.id || typeof plan.goal !== "string" || !plan.goal || !Array.isArray(plan.workstreams) || plan.workstreams.length === 0) {
    return { valid: false, error: "Engineering plan is missing id, goal, or workstreams" };
  }
  if (plan.workstreams.length > budget.maxTotalWorkstreams) return { valid: false, error: "PARALLEL_WORKSTREAM_LIMIT" };
  const ids = new Set<string>();
  const ownership = new Map<string, string>();
  for (const stream of plan.workstreams) {
    if (!stream || typeof stream.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(stream.id)) return { valid: false, error: "Invalid workstream ID" };
    if (ids.has(stream.id)) return { valid: false, error: `Duplicate workstream ID ${stream.id}` };
    ids.add(stream.id);
    if (typeof stream.title !== "string" || !stream.title || typeof stream.objective !== "string" || !stream.objective || !safeArray(stream.dependencies ?? [])) return { valid: false, error: `Invalid workstream ${stream.id}` };
    if ((stream.dependencies ?? []).includes(stream.id)) return { valid: false, error: `Self dependency ${stream.id}` };
    if (stream.expectedFiles && !safeArray(stream.expectedFiles)) return { valid: false, error: `Invalid expectedFiles for ${stream.id}` };
    for (const file of stream.expectedFiles ?? []) {
      const owner = ownership.get(file);
      if (owner && owner !== stream.id) return { valid: false, error: `Duplicate ownership claim for ${file}` };
      ownership.set(file, stream.id);
    }
  }
  for (const stream of plan.workstreams) {
    for (const dependency of stream.dependencies) if (!ids.has(dependency)) return { valid: false, error: `Missing dependency ${dependency}` };
  }
  const pending = new Map(plan.workstreams.map((stream) => [stream.id, new Set(stream.dependencies)]));
  const ordered: string[] = [];
  while (pending.size) {
    const ready = [...pending.entries()].filter(([, dependencies]) => dependencies.size === 0).map(([id]) => id).sort();
    if (!ready.length) return { valid: false, error: "Workstream dependency cycle" };
    for (const id of ready) {
      pending.delete(id);
      ordered.push(id);
      for (const dependencies of pending.values()) dependencies.delete(id);
    }
  }
  return { valid: true, orderedWorkstreamIds: ordered };
}

export interface ParallelSchedulerOptions<T> {
  plan: EngineeringPlan;
  budget?: ParallelExecutionBudget;
  signal?: AbortSignal;
  execute: (workstream: EngineeringWorkstream) => Promise<T>;
  isSuccessful: (result: T) => boolean;
  /** Returns false until the declared public contracts have been published and are current. */
  hasRequiredContracts?: (workstream: EngineeringWorkstream) => boolean;
  onState?: (workstreamId: string, status: WorkstreamStatus) => void;
}

/** Bounded, dependency-authoritative scheduler. It has no model-timing decisions. */
export async function scheduleWorkstreams<T>(options: ParallelSchedulerOptions<T>): Promise<Map<string, T>> {
  const budget = options.budget ?? DEFAULT_PARALLEL_EXECUTION_BUDGET;
  const validation = validateEngineeringPlan(options.plan, budget);
  if (!validation.valid) throw new Error(`PARALLEL_PLAN_INVALID: ${validation.error}`);
  const byId = new Map(options.plan.workstreams.map((stream) => [stream.id, stream]));
  const remaining = new Set(byId.keys());
  const results = new Map<string, T>();
  const blocked = new Set<string>();
  while (remaining.size) {
    if (options.signal?.aborted) throw new Error("PARALLEL_RUN_CANCELLED");
    for (const id of [...remaining]) {
      const stream = byId.get(id)!;
      if (stream.dependencies.some((dependency) => blocked.has(dependency))) {
        remaining.delete(id); blocked.add(id); options.onState?.(id, "blocked");
      }
    }
    const ready = [...remaining].map((id) => byId.get(id)!).filter((stream) =>
      stream.dependencies.every((dependency) => results.has(dependency) && options.isSuccessful(results.get(dependency)!)) &&
      (options.hasRequiredContracts?.(stream) ?? true),
    ).sort((a, b) => a.id.localeCompare(b.id));
    if (!ready.length) {
      if (remaining.size) throw new Error("PARALLEL_DEPENDENCY_BLOCKED");
      break;
    }
    const batch = ready.slice(0, Math.min(budget.maxParallelWorkstreams, budget.maxActiveCoders));
    for (const stream of batch) options.onState?.(stream.id, "ready");
    await Promise.all(batch.map(async (stream) => {
      remaining.delete(stream.id);
      options.onState?.(stream.id, "running");
      const result = await options.execute(stream);
      results.set(stream.id, result);
      const success = options.isSuccessful(result);
      if (!success) blocked.add(stream.id);
      options.onState?.(stream.id, success ? "completed" : "blocked");
    }));
  }
  return results;
}
