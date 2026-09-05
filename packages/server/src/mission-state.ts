import crypto from "node:crypto";
import type { SessionPersistence, WorkItem } from "@codeforge/sessions";
import type { AgentEvidenceRef, AgentFinding } from "@codeforge/agent";

/** Structured failure taxonomy for the long-horizon mission layer. */
export const MISSION_ERRORS = {
  MISSION_PLAN_INVALID: "MISSION_PLAN_INVALID",
  MISSION_REPLAN_LIMIT: "MISSION_REPLAN_LIMIT",
  MISSION_REPLAN_LOOP_DETECTED: "MISSION_REPLAN_LOOP_DETECTED",
  MISSION_BUDGET_EXHAUSTED: "MISSION_BUDGET_EXHAUSTED",
  MISSION_ACCEPTANCE_UNPROVEN: "MISSION_ACCEPTANCE_UNPROVEN",
  MISSION_MILESTONE_BLOCKED: "MISSION_MILESTONE_BLOCKED",
  MISSION_MILESTONE_INVALIDATED: "MISSION_MILESTONE_INVALIDATED",
  MISSION_ASSUMPTION_INVALIDATED: "MISSION_ASSUMPTION_INVALIDATED",
  MISSION_PAUSED: "MISSION_PAUSED",
  MISSION_CANCELLED: "MISSION_CANCELLED",
  MISSION_RECOVERY_REVALIDATION_REQUIRED: "MISSION_RECOVERY_REVALIDATION_REQUIRED",
  MISSION_REPOSITORY_DRIFT: "MISSION_REPOSITORY_DRIFT",
  MISSION_DUPLICATE_WAVE_DISPATCH: "MISSION_DUPLICATE_WAVE_DISPATCH",
  MISSION_DUPLICATE_REPLAN: "MISSION_DUPLICATE_REPLAN",
  MISSION_FINAL_REVIEW_BLOCKED: "MISSION_FINAL_REVIEW_BLOCKED",
  MISSION_FINAL_VERIFICATION_FAILED: "MISSION_FINAL_VERIFICATION_FAILED",
  MISSION_ACCEPTANCE_COMPILATION_FAILED: "MISSION_ACCEPTANCE_COMPILATION_FAILED",
  MISSION_PLANNER_FAILED: "MISSION_PLANNER_FAILED",
  MISSION_REPLANNER_FAILED: "MISSION_REPLANNER_FAILED",
} as const;
export type MissionErrorCode = (typeof MISSION_ERRORS)[keyof typeof MISSION_ERRORS];

export type EvidenceRef = AgentEvidenceRef;

export type AcceptanceStatus = "unproven" | "partially_proven" | "proven" | "invalidated" | "waived";

export interface AcceptanceCriterion {
  id: string;
  description: string;
  mandatory: boolean;
  status: AcceptanceStatus;
  evidence: EvidenceRef[];
  provenBy?: { workstreamIds?: string[]; verificationIds?: string[]; reviewFindingIds?: string[] };
  /** Intent version that introduced this criterion; later additions start unproven. */
  introducedInIntentVersion: number;
}

export interface MissionConstraint { kind: "exclusion" | "security" | "provider" | "budget"; statement: string }

/**
 * The user-authorized record of what the mission is.  Only trusted user steering may produce a
 * new version; no model role, repository file, or tool output can rewrite it.
 */
export interface MissionIntent {
  version: number;
  goal: string;
  acceptanceCriteriaIds: string[];
  explicitExclusions: string[];
  securityConstraints: string[];
  providerConstraints?: { providerId?: string; modelId?: string };
  initialUserInstructions: string;
  /** Digest of the authorized fields; any silent rewrite changes this. */
  digest: string;
  authorizedBy: "user";
  createdAt: string;
}

export type MilestoneStatus = "pending" | "ready" | "executing" | "verifying" | "completed" | "invalidated" | "blocked" | "cancelled";

export interface MissionMilestone {
  id: string;
  title: string;
  objective: string;
  dependencies: string[];
  acceptanceCriteria: string[];
  verificationCommands?: string[];
  status: MilestoneStatus;
  planVersion: number;
  checkpointId?: string;
  resultRevision?: string;
  waveIds: number[];
  evidence: EvidenceRef[];
  invalidation?: { reason: string; by: "runtime" | "user"; at: string; evidence: EvidenceRef[] };
}

export type ReplanTrigger =
  | { type: "verification_failure"; verificationId: string; command?: string; exitCode?: number }
  | { type: "review_block"; findingIds: string[] }
  | { type: "contract_drift"; contractId: string }
  | { type: "dependency_failure"; workstreamId: string }
  | { type: "repository_divergence"; expected: string; actual: string }
  | { type: "new_evidence"; evidence: EvidenceRef[] }
  | { type: "assumption_invalidated"; assumptionId: string }
  | { type: "human_steering"; steeringId: string };

export interface MissionPlanDiff {
  fromVersion: number;
  toVersion: number;
  preservedMilestones: string[];
  invalidatedMilestones: string[];
  addedMilestones: string[];
  removedMilestones: string[];
  preservedWorkstreams: string[];
  invalidatedWorkstreams: string[];
  reason: ReplanTrigger;
}

export interface MissionPlanVersion {
  version: number;
  parentVersion?: number;
  milestones: MissionMilestone[];
  createdAt: string;
  reason?: ReplanTrigger;
  diff?: MissionPlanDiff;
  /** Deterministic identity of (trigger, resulting shape) used for mission-level loop detection. */
  fingerprint: string;
}

export type AssumptionStatus = "unverified" | "verified" | "invalidated";

export interface MissionAssumption {
  id: string;
  statement: string;
  status: AssumptionStatus;
  evidence: EvidenceRef[];
  declaredInPlanVersion: number;
  /** Only the trusted runtime writes this; a model asserting its own proof is ignored. */
  updatedBy?: "runtime";
}

export interface MissionWaveResult {
  wave: number;
  planVersion: number;
  milestoneId: string;
  dispatchId: string;
  parallelRunId?: string;
  status: "completed" | "blocked" | "cancelled" | "failed";
  resultingRevision?: string;
  provenCriteria: string[];
  invalidatedCriteria: string[];
  replanTrigger?: ReplanTrigger;
  evidence: EvidenceRef[];
  error?: string;
}

export interface MissionBudget {
  maxWaves: number;
  maxReplans: number;
  maxMilestones: number;
  maxTotalWorkstreams: number;
  maxTotalAgentTurns: number;
  maxTotalToolCalls: number;
  maxTotalVerificationRuns: number;
  maxWallClockMs?: number;
}

export interface MissionUsage {
  waves: number;
  replans: number;
  milestonesCompleted: number;
  workstreams: number;
  modelRequests: number;
  agentTurns: number;
  toolCalls: number;
  writeCalls: number;
  commandExecutions: number;
  verificationRuns: number;
  inputTokens: number;
  outputTokens: number;
  wallClockMs: number;
}

export type MissionSteeringType =
  | "clarification" | "priority_change" | "acceptance_change" | "scope_reduction"
  | "replan_request" | "pause" | "resume" | "cancel";

export interface MissionSteering {
  id: string;
  missionId: string;
  type: MissionSteeringType;
  message?: string;
  /** Trusted user-authored additions; never sourced from repository or model text. */
  addedAcceptanceCriteria?: Array<{ id: string; description: string; mandatory?: boolean }>;
  removedMilestoneIds?: string[];
  createdAt: string;
  appliedAt?: string;
  resultingPlanVersion?: number;
}

export type MissionStatus =
  | "created" | "analyzing" | "planning" | "executing" | "evaluating" | "replanning"
  | "paused" | "blocked" | "cancelled" | "failed" | "completed";

export interface AutonomousMission {
  kind: "mission";
  id: string;
  sessionId: string;
  workspaceId: string;
  /** CodeForge-owned integration worktree; the user checkout is only touched at final promotion. */
  missionWorkspaceId?: string;
  missionBranch?: string;
  originalGoal: string;
  baseRevision: string;
  intent: MissionIntent;
  intentHistory: MissionIntent[];
  acceptanceCriteria: AcceptanceCriterion[];
  constraints: MissionConstraint[];
  status: MissionStatus;
  currentPlanVersion: number;
  currentWave: number;
  planVersions: MissionPlanVersion[];
  milestones: MissionMilestone[];
  assumptions: MissionAssumption[];
  waves: MissionWaveResult[];
  steering: MissionSteering[];
  budget: MissionBudget;
  usage: MissionUsage;
  evidence: EvidenceRef[];
  memory: MissionMemory;
  finalRevision?: string;
  pauseRequested?: boolean;
  /** Target revisions a repository-drift replan already accounted for. */
  driftHandledRevisions: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Bounded, structured mission memory.  Deliberately holds public decisions and evidence
 * references only: no runtime transcripts, no private agent context, no chain-of-thought.
 */
export interface MissionMemory {
  missionSummary: string;
  milestoneSummaries: Array<{ milestoneId: string; summary: string; revision?: string; checkpointId?: string; contextRevision: string; stale?: boolean }>;
  openRisks: string[];
  recentFailures: string[];
  keyContracts: Array<{ id: string; revision: string; summary: string }>;
  steeringSummaries: string[];
  evidenceRefs: EvidenceRef[];
  compactions: number;
}

export interface MissionEvent {
  type: string;
  sessionId: string;
  missionId: string;
  milestoneId?: string;
  wave?: number;
  timestamp: string;
  payload: Record<string, unknown>;
}

export const DEFAULT_MISSION_BUDGET: MissionBudget = {
  maxWaves: 12,
  maxReplans: 4,
  maxMilestones: 10,
  maxTotalWorkstreams: 40,
  maxTotalAgentTurns: 400,
  maxTotalToolCalls: 800,
  maxTotalVerificationRuns: 80,
  maxWallClockMs: 6 * 60 * 60 * 1000,
};

/** Bounded ceilings for the structured mission memory that feeds future prompts. */
export const MISSION_MEMORY_LIMITS = {
  maxMilestoneSummaries: 12,
  maxSummaryChars: 400,
  maxOpenRisks: 8,
  maxRecentFailures: 5,
  maxKeyContracts: 12,
  maxSteeringSummaries: 6,
  maxEvidenceRefs: 40,
  maxSerializedBytes: 16_000,
} as const;

export const BUDGET_WARNING_RATIO = 0.8;

export function missionIntentDigest(intent: Omit<MissionIntent, "digest">): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    version: intent.version, goal: intent.goal, acceptanceCriteriaIds: [...intent.acceptanceCriteriaIds].sort(),
    explicitExclusions: intent.explicitExclusions, securityConstraints: intent.securityConstraints,
    providerConstraints: intent.providerConstraints ?? null, initialUserInstructions: intent.initialUserInstructions,
  })).digest("hex");
}

/** Fails closed if anything rewrote the authorized intent behind the runtime's back. */
export function verifyMissionIntent(intent: MissionIntent): boolean {
  const { digest, ...rest } = intent;
  return missionIntentDigest(rest) === digest;
}

export interface MilestoneValidation { valid: boolean; error?: string; order?: string[] }

/** Trusted runtime validation of a model-proposed milestone roadmap. */
export function validateMilestoneRoadmap(milestones: MissionMilestone[], budget: MissionBudget, knownCriteriaIds: string[]): MilestoneValidation {
  if (!Array.isArray(milestones) || milestones.length === 0) return { valid: false, error: "Mission plan requires at least one milestone" };
  if (milestones.length > budget.maxMilestones) return { valid: false, error: MISSION_ERRORS.MISSION_BUDGET_EXHAUSTED };
  const ids = new Set<string>();
  const criteria = new Set(knownCriteriaIds);
  for (const milestone of milestones) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(milestone.id)) return { valid: false, error: `Invalid milestone id ${milestone.id}` };
    if (ids.has(milestone.id)) return { valid: false, error: `Duplicate milestone id ${milestone.id}` };
    ids.add(milestone.id);
    if (!milestone.title || !milestone.objective) return { valid: false, error: `Milestone ${milestone.id} is missing title or objective` };
    if (milestone.dependencies.includes(milestone.id)) return { valid: false, error: `Self dependency ${milestone.id}` };
    // A milestone may only claim criteria the trusted acceptance set already contains.
    for (const criterion of milestone.acceptanceCriteria) if (!criteria.has(criterion)) return { valid: false, error: `Milestone ${milestone.id} references unknown acceptance criterion ${criterion}` };
  }
  for (const milestone of milestones) for (const dependency of milestone.dependencies) if (!ids.has(dependency)) return { valid: false, error: `Missing milestone dependency ${dependency}` };
  const pending = new Map(milestones.map((milestone) => [milestone.id, new Set(milestone.dependencies)]));
  const order: string[] = [];
  while (pending.size) {
    const ready = [...pending.entries()].filter(([, dependencies]) => dependencies.size === 0).map(([id]) => id).sort();
    if (!ready.length) return { valid: false, error: "Milestone dependency cycle" };
    for (const id of ready) { pending.delete(id); order.push(id); for (const dependencies of pending.values()) dependencies.delete(id); }
  }
  return { valid: true, order };
}

/**
 * Structured, auditable difference between two plan versions.  A milestone is preserved when it
 * is already completed and its identity plus objective survive unchanged in the new roadmap.
 */
export function diffMissionPlans(previous: MissionMilestone[], next: MissionMilestone[], reason: ReplanTrigger, invalidatedIds: string[] = []): MissionPlanDiff {
  const previousById = new Map(previous.map((milestone) => [milestone.id, milestone]));
  const nextById = new Map(next.map((milestone) => [milestone.id, milestone]));
  const invalidated = new Set(invalidatedIds);
  const preservedMilestones: string[] = [];
  const invalidatedMilestones: string[] = [];
  const removedMilestones: string[] = [];
  for (const milestone of previous) {
    const replacement = nextById.get(milestone.id);
    if (!replacement) { removedMilestones.push(milestone.id); continue; }
    const unchanged = replacement.objective === milestone.objective
      && JSON.stringify(replacement.dependencies) === JSON.stringify(milestone.dependencies)
      && JSON.stringify(replacement.acceptanceCriteria) === JSON.stringify(milestone.acceptanceCriteria)
      && JSON.stringify(replacement.verificationCommands ?? []) === JSON.stringify(milestone.verificationCommands ?? []);
    if (unchanged && !invalidated.has(milestone.id)) preservedMilestones.push(milestone.id);
    else invalidatedMilestones.push(milestone.id);
  }
  const addedMilestones = next.filter((milestone) => !previousById.has(milestone.id)).map((milestone) => milestone.id);
  return {
    fromVersion: 0, toVersion: 0, preservedMilestones, invalidatedMilestones, addedMilestones, removedMilestones,
    preservedWorkstreams: [], invalidatedWorkstreams: [], reason,
  };
}

/** Deterministic identity of a replan cycle, used to detect mission-level loops without a model. */
export function replanFingerprint(trigger: ReplanTrigger, milestones: MissionMilestone[]): string {
  const triggerKey = trigger.type === "verification_failure" ? `verification_failure:${trigger.command ?? trigger.verificationId}`
    : trigger.type === "review_block" ? `review_block:${[...trigger.findingIds].sort().join(",")}`
    : trigger.type === "contract_drift" ? `contract_drift:${trigger.contractId}`
    : trigger.type === "dependency_failure" ? `dependency_failure:${trigger.workstreamId}`
    : trigger.type === "repository_divergence" ? "repository_divergence"
    : trigger.type === "assumption_invalidated" ? `assumption_invalidated:${trigger.assumptionId}`
    : trigger.type === "human_steering" ? `human_steering:${trigger.steeringId}`
    : `new_evidence:${trigger.evidence.map((evidence) => evidence.ref).sort().join(",")}`;
  const shape = milestones.map((milestone) => `${milestone.id}|${milestone.objective}|${milestone.dependencies.join(",")}|${(milestone.verificationCommands ?? []).join(",")}`).sort().join("\n");
  return crypto.createHash("sha256").update(`${triggerKey}\n${shape}`).digest("hex").slice(0, 32);
}

/** Compacts mission memory to a hard ceiling so a long mission cannot grow its prompt forever. */
export function compactMissionMemory(memory: MissionMemory): MissionMemory {
  const clamp = (value: string) => value.length > MISSION_MEMORY_LIMITS.maxSummaryChars ? `${value.slice(0, MISSION_MEMORY_LIMITS.maxSummaryChars - 1)}…` : value;
  let compacted: MissionMemory = {
    missionSummary: clamp(memory.missionSummary),
    milestoneSummaries: memory.milestoneSummaries.slice(-MISSION_MEMORY_LIMITS.maxMilestoneSummaries).map((entry) => ({ ...entry, summary: clamp(entry.summary) })),
    openRisks: memory.openRisks.slice(-MISSION_MEMORY_LIMITS.maxOpenRisks).map(clamp),
    recentFailures: memory.recentFailures.slice(-MISSION_MEMORY_LIMITS.maxRecentFailures).map(clamp),
    keyContracts: memory.keyContracts.slice(-MISSION_MEMORY_LIMITS.maxKeyContracts).map((entry) => ({ ...entry, summary: clamp(entry.summary) })),
    steeringSummaries: memory.steeringSummaries.slice(-MISSION_MEMORY_LIMITS.maxSteeringSummaries).map(clamp),
    evidenceRefs: memory.evidenceRefs.slice(-MISSION_MEMORY_LIMITS.maxEvidenceRefs),
    compactions: memory.compactions + 1,
  };
  // Hard byte ceiling: shed the oldest structured detail until the serialized form fits.
  while (Buffer.byteLength(JSON.stringify(compacted), "utf8") > MISSION_MEMORY_LIMITS.maxSerializedBytes) {
    if (compacted.evidenceRefs.length) { compacted = { ...compacted, evidenceRefs: compacted.evidenceRefs.slice(1) }; continue; }
    if (compacted.milestoneSummaries.length > 1) { compacted = { ...compacted, milestoneSummaries: compacted.milestoneSummaries.slice(1) }; continue; }
    if (compacted.keyContracts.length) { compacted = { ...compacted, keyContracts: compacted.keyContracts.slice(1) }; continue; }
    if (compacted.openRisks.length) { compacted = { ...compacted, openRisks: compacted.openRisks.slice(1) }; continue; }
    if (compacted.recentFailures.length) { compacted = { ...compacted, recentFailures: compacted.recentFailures.slice(1) }; continue; }
    if (compacted.steeringSummaries.length) { compacted = { ...compacted, steeringSummaries: compacted.steeringSummaries.slice(1) }; continue; }
    compacted = { ...compacted, missionSummary: compacted.missionSummary.slice(0, 200) };
    break;
  }
  return compacted;
}

/** Marks memory entries whose captured repository revision no longer matches reality. */
export function markMemoryStaleness(memory: MissionMemory, currentRevision: string): MissionMemory {
  return { ...memory, milestoneSummaries: memory.milestoneSummaries.map((entry) => ({ ...entry, stale: entry.contextRevision !== currentRevision })) };
}

export interface BudgetCheck { ok: boolean; code?: MissionErrorCode; detail?: string; warnings: string[] }

/** Hard aggregate ceilings; the runtime, not a model, decides whether more work may start. */
export function checkMissionBudget(mission: AutonomousMission, request: "wave" | "replan" | "milestone"): BudgetCheck {
  const { budget, usage } = mission;
  const warnings: string[] = [];
  const warn = (label: string, used: number, max: number) => { if (max > 0 && used / max >= BUDGET_WARNING_RATIO && used < max) warnings.push(`${label}:${used}/${max}`); };
  warn("waves", usage.waves, budget.maxWaves);
  warn("replans", usage.replans, budget.maxReplans);
  warn("workstreams", usage.workstreams, budget.maxTotalWorkstreams);
  warn("agentTurns", usage.agentTurns, budget.maxTotalAgentTurns);
  warn("toolCalls", usage.toolCalls, budget.maxTotalToolCalls);
  warn("verificationRuns", usage.verificationRuns, budget.maxTotalVerificationRuns);
  const exhausted = (label: string, used: number, max: number) => used >= max ? `${label} ${used}/${max}` : undefined;
  const aggregate = exhausted("agentTurns", usage.agentTurns, budget.maxTotalAgentTurns)
    ?? exhausted("toolCalls", usage.toolCalls, budget.maxTotalToolCalls)
    ?? exhausted("workstreams", usage.workstreams, budget.maxTotalWorkstreams)
    ?? exhausted("verificationRuns", usage.verificationRuns, budget.maxTotalVerificationRuns)
    ?? (budget.maxWallClockMs !== undefined ? exhausted("wallClockMs", usage.wallClockMs, budget.maxWallClockMs) : undefined);
  if (aggregate) return { ok: false, code: MISSION_ERRORS.MISSION_BUDGET_EXHAUSTED, detail: aggregate, warnings };
  if (request === "wave") { const detail = exhausted("waves", usage.waves, budget.maxWaves); if (detail) return { ok: false, code: MISSION_ERRORS.MISSION_BUDGET_EXHAUSTED, detail, warnings }; }
  if (request === "replan") { const detail = exhausted("replans", usage.replans, budget.maxReplans); if (detail) return { ok: false, code: MISSION_ERRORS.MISSION_REPLAN_LIMIT, detail, warnings }; }
  if (request === "milestone") { const detail = exhausted("milestones", mission.milestones.length, budget.maxMilestones); if (detail) return { ok: false, code: MISSION_ERRORS.MISSION_BUDGET_EXHAUSTED, detail, warnings }; }
  return { ok: true, warnings };
}

/** Acceptance is evidence-gated: a criterion is never proven by a model asserting it. */
export function unprovenMandatoryCriteria(mission: AutonomousMission): AcceptanceCriterion[] {
  return mission.acceptanceCriteria.filter((criterion) => criterion.mandatory && criterion.status !== "proven" && criterion.status !== "waived");
}

export interface AutonomousMissionResult {
  missionId: string;
  status: "completed" | "blocked" | "cancelled" | "failed";
  summary: string;
  planVersions: number;
  wavesExecuted: number;
  replans: number;
  milestones: MissionMilestone[];
  acceptance: AcceptanceCriterion[];
  finalRevision?: string;
  usage: MissionUsage;
  evidence: EvidenceRef[];
  error?: string;
  retainedWork?: RetainedAutonomousWork[];
  findings?: AgentFinding[];
}

export interface RetainedAutonomousWork {
  kind: "milestone_checkpoint" | "milestone_revision" | "mission_branch" | "parallel_run";
  ref: string;
  description: string;
}

/** Durable mission persistence, mirroring the certified parallel-run store conventions. */
export class MissionStore {
  constructor(private readonly persistence?: SessionPersistence, private readonly onEvent?: (event: MissionEvent) => void) {}

  save(mission: AutonomousMission): void {
    if (!this.persistence) return;
    this.persistence.upsertWorkItem({
      kind: "mission", id: mission.id, sessionId: mission.sessionId, workspaceId: mission.workspaceId,
      goal: mission.originalGoal, status: mission.status, baseRevision: mission.baseRevision,
      currentPlanVersion: mission.currentPlanVersion, currentWave: mission.currentWave,
      missionJson: JSON.stringify({
        missionWorkspaceId: mission.missionWorkspaceId, missionBranch: mission.missionBranch,
        intent: mission.intent, intentHistory: mission.intentHistory, acceptanceCriteria: mission.acceptanceCriteria,
        constraints: mission.constraints, planVersions: mission.planVersions, milestones: mission.milestones,
        assumptions: mission.assumptions, waves: mission.waves, steering: mission.steering,
        budget: mission.budget, usage: mission.usage, evidence: mission.evidence, memory: mission.memory,
        finalRevision: mission.finalRevision, pauseRequested: mission.pauseRequested, driftHandledRevisions: mission.driftHandledRevisions,
      }),
      ...(mission.error ? { error: mission.error } : {}),
      createdAt: mission.createdAt, updatedAt: mission.updatedAt,
    } as unknown as WorkItem);
  }

  get(missionId: string): AutonomousMission | undefined {
    const item = this.persistence?.getWorkItem(missionId) as unknown as (WorkItem & { missionJson?: string; currentPlanVersion?: number; currentWave?: number; baseRevision?: string; goal?: string; workspaceId?: string }) | undefined;
    if (!item || item.kind !== "mission") return undefined;
    const detail = item.missionJson ? JSON.parse(item.missionJson) as Partial<AutonomousMission> : {};
    return {
      kind: "mission", id: item.id, sessionId: item.sessionId!, workspaceId: item.workspaceId ?? "",
      originalGoal: item.goal ?? "", status: item.status as MissionStatus, baseRevision: item.baseRevision ?? "",
      currentPlanVersion: item.currentPlanVersion ?? 1, currentWave: item.currentWave ?? 0,
      missionWorkspaceId: detail.missionWorkspaceId, missionBranch: detail.missionBranch,
      intent: detail.intent as MissionIntent, intentHistory: detail.intentHistory ?? [],
      acceptanceCriteria: detail.acceptanceCriteria ?? [], constraints: detail.constraints ?? [],
      planVersions: detail.planVersions ?? [], milestones: detail.milestones ?? [], assumptions: detail.assumptions ?? [],
      waves: detail.waves ?? [], steering: detail.steering ?? [],
      budget: detail.budget ?? DEFAULT_MISSION_BUDGET, usage: detail.usage ?? emptyMissionUsage(),
      evidence: detail.evidence ?? [], memory: detail.memory ?? emptyMissionMemory(),
      finalRevision: detail.finalRevision, pauseRequested: detail.pauseRequested, driftHandledRevisions: detail.driftHandledRevisions ?? [],
      ...(item.error ? { error: item.error } : {}),
      createdAt: item.createdAt, updatedAt: item.updatedAt,
    };
  }

  list(sessionId?: string): AutonomousMission[] {
    const items = sessionId ? this.persistence?.getWorkItems(sessionId) ?? [] : this.persistence?.getWorkItemsByKind("mission") ?? [];
    return items.filter((item) => item.kind === "mission").map((item) => this.get(item.id)!).filter(Boolean);
  }

  emit(mission: AutonomousMission, type: string, payload: Record<string, unknown> = {}, extra: { milestoneId?: string; wave?: number } = {}): void {
    const event: MissionEvent = {
      type, sessionId: mission.sessionId, missionId: mission.id,
      ...(extra.milestoneId ? { milestoneId: extra.milestoneId } : {}), ...(extra.wave !== undefined ? { wave: extra.wave } : {}),
      timestamp: new Date().toISOString(), payload,
    };
    this.persistence?.appendEvent(event);
    this.onEvent?.(event);
  }
}

export function emptyMissionUsage(): MissionUsage {
  return { waves: 0, replans: 0, milestonesCompleted: 0, workstreams: 0, modelRequests: 0, agentTurns: 0, toolCalls: 0, writeCalls: 0, commandExecutions: 0, verificationRuns: 0, inputTokens: 0, outputTokens: 0, wallClockMs: 0 };
}

export function emptyMissionMemory(): MissionMemory {
  return { missionSummary: "", milestoneSummaries: [], openRisks: [], recentFailures: [], keyContracts: [], steeringSummaries: [], evidenceRefs: [], compactions: 0 };
}
