import crypto from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { SessionPersistence } from "@codeforge/sessions";
import type { AcceptanceCriteriaResult, AgentEvidenceRef, AgentFinding, ExplorerResult, MissionPlanResult, ReviewResult } from "@codeforge/agent";
import { runVerification, type VerificationResult } from "@codeforge/workflow";
import type { AgentRuntime, AgentRuntimeResult } from "./agent-runtime.js";
import type { WorkspaceService, ForgeWorkspace } from "./workspace-service.js";
import type { IntegrationService } from "./integration-service.js";
import { createIntegrationService } from "./integration-service.js";
import { CheckpointService } from "./checkpoint-service.js";
import { getSanitizedEnvForChild } from "./env-filter.js";
import { ParallelAutonomousRunOrchestrator, createParallelAutonomousRunOrchestrator, type ParallelRunResult, type PrivateAgentContext } from "./parallel-orchestrator.js";
import type { ParallelEvent } from "./parallel-state.js";
import { createForgeVerifyPersistenceObserver } from "./forge-verify-persistence.js";
import {
  BUDGET_WARNING_RATIO, DEFAULT_MISSION_BUDGET, MISSION_ERRORS, MissionStore,
  checkMissionBudget, compactMissionMemory, diffMissionPlans, emptyMissionMemory, emptyMissionUsage,
  markMemoryStaleness, missionIntentDigest, replanFingerprint, unprovenMandatoryCriteria, validateMilestoneRoadmap, verifyMissionIntent,
  type AcceptanceCriterion, type AutonomousMission, type AutonomousMissionResult, type EvidenceRef,
  type MissionAssumption, type MissionBudget, type MissionEvent, type MissionIntent, type MissionMilestone,
  type MissionPlanVersion, type MissionSteering, type MissionWaveResult, type ReplanTrigger, type RetainedAutonomousWork,
} from "./mission-state.js";

const execFile = promisify(execFileCallback);

export type WorkstreamRecoveryClass = "completed" | "safe_to_resume" | "requires_revalidation" | "unknown_side_effect" | "blocked";
export type TargetDriftClass = "NO_DRIFT" | "SAFE_ADDITIVE_DRIFT" | "REPLAN_REQUIRED" | "PROMOTION_CONFLICT";

export interface MissionSupervisorOptions {
  workspaceService: WorkspaceService;
  agentRuntime: AgentRuntime;
  persistence?: SessionPersistence;
  integrationService?: IntegrationService;
  parallelOrchestrator?: ParallelAutonomousRunOrchestrator;
  checkpointServiceFactory?: (workspaceRoot: string) => CheckpointService;
  onEvent?: (event: MissionEvent) => void;
  onParallelEvent?: (event: ParallelEvent) => void;
}

export interface StartMissionInput {
  sessionId: string;
  workspacePath: string;
  goal: string;
  userInstructions?: string;
  explicitExclusions?: string[];
  securityConstraints?: string[];
  providerConstraints?: { providerId?: string; modelId?: string };
  budget?: Partial<MissionBudget>;
  signal?: AbortSignal;
  /** Per-agent private briefings forwarded to a single wave agent; never stored in mission state. */
  privateAgentContext?: PrivateAgentContext;
  missionId?: string;
}

export interface ResumeMissionInput { signal?: AbortSignal; privateAgentContext?: PrivateAgentContext }

const TERMINAL_MISSION_STATUSES = ["completed", "blocked", "cancelled", "failed"];

function evidence(kind: string, ref: string, description?: string): EvidenceRef {
  return { kind, ref, ...(description ? { description } : {}) };
}

/**
 * Long-horizon mission supervisor.  It owns mission lifecycle, milestone readiness, plan
 * versions, replan authority, aggregate budget, steering and the final acceptance decision, and
 * delegates every execution wave to the certified parallel orchestrator beneath it.  It never
 * performs worktree or tool work itself.
 */
export class MissionSupervisor {
  private readonly store: MissionStore;
  private readonly integrationService: IntegrationService;
  private readonly parallel: ParallelAutonomousRunOrchestrator;
  private readonly checkpointFactory: (workspaceRoot: string) => CheckpointService;
  private readonly activeControllers = new Map<string, AbortController>();
  /** Missions this supervisor is currently driving, so steering lands on the live record. */
  private readonly activeMissions = new Map<string, AutonomousMission>();

  constructor(private readonly options: MissionSupervisorOptions) {
    this.store = new MissionStore(options.persistence, options.onEvent);
    this.integrationService = options.integrationService ?? createIntegrationService({ workspaceService: options.workspaceService });
    this.parallel = options.parallelOrchestrator ?? createParallelAutonomousRunOrchestrator({
      workspaceService: options.workspaceService, agentRuntime: options.agentRuntime,
      ...(options.persistence ? { persistence: options.persistence } : {}),
      ...(options.integrationService ? { integrationService: options.integrationService } : {}),
      ...(options.onParallelEvent ? { onEvent: options.onParallelEvent } : {}),
    });
    this.checkpointFactory = options.checkpointServiceFactory ?? ((root) => new CheckpointService(root, options.persistence));
  }

  getMission(missionId: string): AutonomousMission | undefined { return this.store.get(missionId); }
  private liveMission(missionId: string): AutonomousMission | undefined { return this.activeMissions.get(missionId) ?? this.store.get(missionId); }
  listMissions(sessionId?: string): AutonomousMission[] { return this.store.list(sessionId); }

  private save(mission: AutonomousMission): void { mission.updatedAt = new Date().toISOString(); this.store.save(mission); }
  private emit(mission: AutonomousMission, type: string, payload: Record<string, unknown> = {}, extra: { milestoneId?: string; wave?: number } = {}): void { this.store.emit(mission, type, payload, extra); }
  private async git(cwd: string, args: string[]) { return execFile("git", args, { cwd, env: { ...getSanitizedEnvForChild(), GIT_TERMINAL_PROMPT: "0" } }); }

  private missionWorkspace(mission: AutonomousMission): ForgeWorkspace | undefined {
    return mission.missionWorkspaceId ? this.options.workspaceService.getWorkspace(mission.missionWorkspaceId) : undefined;
  }

  /** Accumulates only what the runtime actually measured; provider metrics are never invented. */
  private recordAgentUsage(mission: AutonomousMission, results: AgentRuntimeResult[]): void {
    for (const result of results) {
      mission.usage.modelRequests += result.usage.requestCount;
      mission.usage.agentTurns += result.usage.requestCount;
      mission.usage.toolCalls += result.usage.toolCount;
      mission.usage.inputTokens += result.usage.inputTokens;
      mission.usage.outputTokens += result.usage.outputTokens;
    }
  }

  private recordWaveUsage(mission: AutonomousMission, run: ParallelRunResult): void {
    mission.usage.modelRequests += run.usage.modelRequests;
    mission.usage.agentTurns += run.usage.agentTurns;
    mission.usage.toolCalls += run.usage.toolCalls;
    mission.usage.writeCalls += run.usage.writeCalls;
    mission.usage.commandExecutions += run.usage.commandExecutions;
    mission.usage.verificationRuns += run.usage.verificationRuns;
    mission.usage.inputTokens += run.usage.inputTokens;
    mission.usage.outputTokens += run.usage.outputTokens;
    mission.usage.workstreams += run.workstreams.length;
  }

  // ---------------------------------------------------------------- lifecycle

  async startMission(input: StartMissionInput): Promise<AutonomousMissionResult> {
    const missionId = input.missionId ?? `mission-${crypto.randomUUID()}`;
    const controller = new AbortController();
    const onAbort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    this.activeControllers.set(missionId, controller);
    let mission: AutonomousMission | undefined;
    const startedAt = Date.now();
    try {
      const target = await this.options.workspaceService.registerLocalWorkspace(input.workspacePath);
      const baseRevision = (await this.git(target.rootPath, ["rev-parse", "HEAD"])).stdout.trim();
      const now = new Date().toISOString();
      if (this.options.persistence && !this.options.persistence.getSession(input.sessionId)) {
        this.options.persistence.upsertSession({ id: input.sessionId, title: input.goal.slice(0, 80), createdAt: now, updatedAt: now, status: "running" });
      }
      const budget: MissionBudget = { ...DEFAULT_MISSION_BUDGET, ...input.budget };
      const intentSeed: Omit<MissionIntent, "digest"> = {
        version: 1, goal: input.goal, acceptanceCriteriaIds: [],
        explicitExclusions: input.explicitExclusions ?? [], securityConstraints: input.securityConstraints ?? [],
        ...(input.providerConstraints ? { providerConstraints: input.providerConstraints } : {}),
        initialUserInstructions: input.userInstructions ?? input.goal,
        authorizedBy: "user", createdAt: now,
      };
      mission = {
        kind: "mission", id: missionId, sessionId: input.sessionId, workspaceId: target.id,
        originalGoal: input.goal, baseRevision,
        intent: { ...intentSeed, digest: missionIntentDigest(intentSeed) }, intentHistory: [],
        acceptanceCriteria: [], constraints: [
          ...(input.explicitExclusions ?? []).map((statement) => ({ kind: "exclusion" as const, statement })),
          ...(input.securityConstraints ?? []).map((statement) => ({ kind: "security" as const, statement })),
        ],
        status: "created", currentPlanVersion: 0, currentWave: 0, driftHandledRevisions: [],
        planVersions: [], milestones: [], assumptions: [], waves: [], steering: [],
        budget, usage: emptyMissionUsage(), evidence: [], memory: emptyMissionMemory(),
        createdAt: now, updatedAt: now,
      };
      this.save(mission);
      this.activeMissions.set(missionId, mission);
      this.emit(mission, "mission.created", { goal: input.goal });

      // CodeForge-owned integration worktree; the user checkout stays untouched until promotion.
      const missionWorkspace = await this.options.workspaceService.createWorktree({
        parentWorkspaceId: target.id, base: "head", runId: missionId, label: "mission",
        metadata: { missionId, baseRevision },
      });
      mission.missionWorkspaceId = missionWorkspace.id;
      mission.missionBranch = missionWorkspace.branch;
      mission.memory.missionSummary = `Mission: ${input.goal}`;
      this.save(mission);

      const compiled = await this.compileAcceptanceCriteria(mission, missionWorkspace, controller.signal);
      if (!compiled) return this.terminate(mission, "blocked", MISSION_ERRORS.MISSION_ACCEPTANCE_COMPILATION_FAILED, startedAt);

      const planned = await this.createInitialPlan(mission, missionWorkspace, controller.signal);
      if (!planned) return this.terminate(mission, "blocked", mission.error ?? MISSION_ERRORS.MISSION_PLANNER_FAILED, startedAt);

      return await this.drive(mission, controller.signal, startedAt, input.privateAgentContext);
    } catch (error) {
      if (!mission) throw error;
      return this.terminate(mission, controller.signal.aborted ? "cancelled" : "failed", controller.signal.aborted ? MISSION_ERRORS.MISSION_CANCELLED : error instanceof Error ? error.message : String(error), startedAt);
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
      this.activeControllers.delete(missionId);
      this.activeMissions.delete(missionId);
    }
  }

  /**
   * Resume a mission whose supervisor process died, or which the user paused.  Everything is
   * rebuilt from durable state and revalidated against real Git; nothing is reconstructed from
   * conversation text.
   */
  async resumeMission(missionId: string, input: ResumeMissionInput = {}): Promise<AutonomousMissionResult> {
    const mission = this.store.get(missionId);
    if (!mission) throw new Error("MISSION_NOT_FOUND");
    if (TERMINAL_MISSION_STATUSES.includes(mission.status)) return this.result(mission);
    if (!verifyMissionIntent(mission.intent)) return this.terminate(mission, "blocked", MISSION_ERRORS.MISSION_RECOVERY_REVALIDATION_REQUIRED, Date.now());
    const missionWorkspace = this.missionWorkspace(mission);
    if (!missionWorkspace || !existsSync(missionWorkspace.rootPath)) {
      return this.terminate(mission, "blocked", MISSION_ERRORS.MISSION_RECOVERY_REVALIDATION_REQUIRED, Date.now());
    }
    const head = (await this.git(missionWorkspace.rootPath, ["rev-parse", "HEAD"]).catch(() => ({ stdout: "" }))).stdout.trim();
    const expected = [...mission.milestones].reverse().find((milestone) => milestone.status === "completed" && milestone.resultRevision)?.resultRevision ?? mission.baseRevision;
    if (!head || head !== expected) return this.terminate(mission, "blocked", MISSION_ERRORS.MISSION_RECOVERY_REVALIDATION_REQUIRED, Date.now());
    for (const milestone of mission.milestones) {
      if (milestone.status === "completed" && milestone.checkpointId) {
        const checkpoints = this.checkpointFactory(missionWorkspace.rootPath);
        const valid = await checkpoints.validateCheckpointRef(milestone.checkpointId).catch(() => undefined);
        if (!valid) return this.terminate(mission, "blocked", MISSION_ERRORS.MISSION_RECOVERY_REVALIDATION_REQUIRED, Date.now());
      }
    }
    mission.memory = markMemoryStaleness(mission.memory, head);
    // Clear the pause durably: the drive loop re-reads the record and would otherwise re-pause.
    mission.pauseRequested = false;
    this.save(mission);
    this.emit(mission, "mission.resumed", {
      recoveredPlanVersion: mission.currentPlanVersion, head,
      completedMilestones: mission.milestones.filter((milestone) => milestone.status === "completed").map((milestone) => milestone.id),
      usage: { waves: mission.usage.waves, replans: mission.usage.replans, workstreams: mission.usage.workstreams },
    });
    const controller = new AbortController();
    const onAbort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    this.activeControllers.set(missionId, controller);
    this.activeMissions.set(missionId, mission);
    try {
      return await this.drive(mission, controller.signal, Date.now(), input.privateAgentContext);
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
      this.activeControllers.delete(missionId);
      this.activeMissions.delete(missionId);
    }
  }

  /** Pause stops new dispatch at the next safe boundary; in-flight work finishes deterministically. */
  pauseMission(missionId: string, message?: string): boolean {
    const mission = this.liveMission(missionId);
    if (!mission || TERMINAL_MISSION_STATUSES.includes(mission.status)) return false;
    mission.pauseRequested = true;
    mission.steering.push({ id: `steer-${crypto.randomUUID().slice(0, 8)}`, missionId, type: "pause", ...(message ? { message } : {}), createdAt: new Date().toISOString() });
    if (mission.status === "created" || mission.status === "planning" || mission.status === "analyzing") mission.status = "paused";
    this.save(mission);
    this.emit(mission, "mission.paused", { requestedDuring: mission.status });
    return true;
  }

  cancelMission(missionId: string): boolean {
    const mission = this.liveMission(missionId);
    if (!mission || TERMINAL_MISSION_STATUSES.includes(mission.status)) return false;
    const controller = this.activeControllers.get(missionId);
    for (const wave of mission.waves) if (wave.parallelRunId) this.parallel.cancelRun(wave.parallelRunId);
    if (controller && !controller.signal.aborted) controller.abort(new Error(MISSION_ERRORS.MISSION_CANCELLED));
    else { mission.status = "cancelled"; mission.error = MISSION_ERRORS.MISSION_CANCELLED; this.save(mission); this.emit(mission, "mission.cancelled", {}); }
    return true;
  }

  /**
   * Trusted user steering.  Only this entry point may extend mission intent or acceptance
   * criteria; repository files, tool output and model text never reach it.
   */
  steerMission(missionId: string, steering: Omit<MissionSteering, "id" | "missionId" | "createdAt"> & { id?: string }): MissionSteering | undefined {
    const mission = this.liveMission(missionId);
    if (!mission || TERMINAL_MISSION_STATUSES.includes(mission.status)) return undefined;
    const record: MissionSteering = {
      id: steering.id ?? `steer-${crypto.randomUUID().slice(0, 8)}`, missionId,
      type: steering.type, ...(steering.message ? { message: steering.message } : {}),
      ...(steering.addedAcceptanceCriteria ? { addedAcceptanceCriteria: steering.addedAcceptanceCriteria } : {}),
      ...(steering.removedMilestoneIds ? { removedMilestoneIds: steering.removedMilestoneIds } : {}),
      createdAt: new Date().toISOString(),
    };
    mission.steering.push(record);
    if (record.type === "pause") mission.pauseRequested = true;
    if (record.type === "resume") mission.pauseRequested = false;
    if (record.type === "acceptance_change" && record.addedAcceptanceCriteria?.length) {
      // A new criterion always begins unproven: earlier evidence never retroactively proves it.
      const introduced = mission.intent.version + 1;
      for (const criterion of record.addedAcceptanceCriteria) {
        if (mission.acceptanceCriteria.some((existing) => existing.id === criterion.id)) continue;
        mission.acceptanceCriteria.push({ id: criterion.id, description: criterion.description, mandatory: criterion.mandatory !== false, status: "unproven", evidence: [], introducedInIntentVersion: introduced });
      }
      this.reviseIntent(mission, { acceptanceCriteriaIds: mission.acceptanceCriteria.map((criterion) => criterion.id) });
      this.emit(mission, "mission.acceptance.updated", { added: record.addedAcceptanceCriteria.map((criterion) => criterion.id), intentVersion: mission.intent.version });
    }
    if (record.type === "scope_reduction" && record.removedMilestoneIds?.length) {
      this.reviseIntent(mission, {});
    }
    mission.memory.steeringSummaries.push(`${record.type}: ${(record.message ?? "").slice(0, 160)}`);
    mission.memory = compactMissionMemory(mission.memory);
    this.save(mission);
    this.emit(mission, record.type === "cancel" ? "mission.cancelled" : "mission.steered", { steeringId: record.id, type: record.type });
    if (record.type === "cancel") this.cancelMission(missionId);
    return record;
  }

  /** Produces the next authorized intent version; the digest makes any silent rewrite detectable. */
  private reviseIntent(mission: AutonomousMission, changes: Partial<Pick<MissionIntent, "acceptanceCriteriaIds" | "explicitExclusions" | "securityConstraints">>): void {
    mission.intentHistory.push(mission.intent);
    const next: Omit<MissionIntent, "digest"> = {
      version: mission.intent.version + 1,
      goal: mission.intent.goal,
      acceptanceCriteriaIds: changes.acceptanceCriteriaIds ?? mission.intent.acceptanceCriteriaIds,
      explicitExclusions: changes.explicitExclusions ?? mission.intent.explicitExclusions,
      securityConstraints: changes.securityConstraints ?? mission.intent.securityConstraints,
      ...(mission.intent.providerConstraints ? { providerConstraints: mission.intent.providerConstraints } : {}),
      initialUserInstructions: mission.intent.initialUserInstructions,
      authorizedBy: "user", createdAt: new Date().toISOString(),
    };
    mission.intent = { ...next, digest: missionIntentDigest(next) };
    this.emit(mission, "mission.intent.recorded", { version: mission.intent.version, digest: mission.intent.digest });
  }

  // ---------------------------------------------------------------- planning

  private async compileAcceptanceCriteria(mission: AutonomousMission, workspace: ForgeWorkspace, signal: AbortSignal): Promise<boolean> {
    mission.status = "analyzing"; this.save(mission);
    const run = await this.options.agentRuntime.executeAgentRun({
      runId: `${mission.id}:acceptance`, agentId: "mission-planner", role: "mission-planner",
      goal: `Compile acceptance criteria for mission: ${mission.originalGoal}`,
      taskPlan: JSON.stringify({ missionIntent: this.publicIntent(mission) }),
      workspaceId: workspace.id, workspacePath: workspace.rootPath,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      structuredOutput: "acceptance_criteria", signal,
    });
    this.recordAgentUsage(mission, [run]);
    const compiled = run.structuredData as AcceptanceCriteriaResult | undefined;
    if (run.status !== "completed" || !compiled) { mission.error = MISSION_ERRORS.MISSION_ACCEPTANCE_COMPILATION_FAILED; this.save(mission); return false; }
    mission.acceptanceCriteria = compiled.criteria.map((criterion) => ({
      id: criterion.id, description: criterion.description, mandatory: criterion.mandatory,
      status: "unproven", evidence: [], introducedInIntentVersion: 1,
    }));
    this.reviseIntent(mission, { acceptanceCriteriaIds: mission.acceptanceCriteria.map((criterion) => criterion.id) });
    this.save(mission);
    this.emit(mission, "mission.acceptance.updated", { criteria: mission.acceptanceCriteria.map((criterion) => criterion.id) });
    return true;
  }

  /** Public, trusted mission facts a planning role may see. Never carries private agent context. */
  private publicIntent(mission: AutonomousMission): Record<string, unknown> {
    return {
      goal: mission.intent.goal, intentVersion: mission.intent.version,
      acceptanceCriteria: mission.acceptanceCriteria.map((criterion) => ({ id: criterion.id, description: criterion.description, mandatory: criterion.mandatory, status: criterion.status })),
      explicitExclusions: mission.intent.explicitExclusions, securityConstraints: mission.intent.securityConstraints,
      userInstructions: mission.intent.initialUserInstructions,
    };
  }

  private async createInitialPlan(mission: AutonomousMission, workspace: ForgeWorkspace, signal: AbortSignal): Promise<boolean> {
    mission.status = "planning"; this.save(mission);
    const run = await this.options.agentRuntime.executeAgentRun({
      runId: `${mission.id}:plan:1`, agentId: "mission-planner", role: "mission-planner",
      goal: `Mission roadmap for: ${mission.originalGoal}`,
      taskPlan: JSON.stringify({ missionIntent: this.publicIntent(mission), missionMemory: mission.memory }),
      workspaceId: workspace.id, workspacePath: workspace.rootPath,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      structuredOutput: "mission_plan", signal,
    });
    this.recordAgentUsage(mission, [run]);
    const proposed = run.structuredData as MissionPlanResult | undefined;
    if (run.status !== "completed" || !proposed) { mission.error = MISSION_ERRORS.MISSION_PLANNER_FAILED; this.save(mission); return false; }
    return this.applyPlanVersion(mission, proposed, undefined);
  }

  /** Validates and installs a model-proposed roadmap. The runtime owns every status transition. */
  private applyPlanVersion(mission: AutonomousMission, proposed: MissionPlanResult, reason: ReplanTrigger | undefined): boolean {
    const version = mission.currentPlanVersion + 1;
    const milestones: MissionMilestone[] = proposed.milestones.map((milestone) => ({
      id: milestone.id, title: milestone.title, objective: milestone.objective,
      dependencies: [...milestone.dependencies], acceptanceCriteria: [...milestone.acceptanceCriteria],
      ...(milestone.verificationCommands ? { verificationCommands: [...milestone.verificationCommands] } : {}),
      status: "pending", planVersion: version, waveIds: [], evidence: [],
    }));
    const validation = validateMilestoneRoadmap(milestones, mission.budget, mission.acceptanceCriteria.map((criterion) => criterion.id));
    if (!validation.valid) {
      mission.error = `${MISSION_ERRORS.MISSION_PLAN_INVALID}: ${validation.error}`;
      this.save(mission);
      this.emit(mission, reason ? "mission.replan.blocked" : "mission.plan.validated", { valid: false, error: validation.error });
      return false;
    }
    const previous = mission.milestones;
    const invalidatedIds = reason ? this.milestonesInvalidatedBy(mission, reason) : [];
    const diff = reason ? { ...diffMissionPlans(previous, milestones, reason, invalidatedIds), fromVersion: mission.currentPlanVersion, toVersion: version } : undefined;

    // Preserve certified work: a preserved milestone keeps its completed status and evidence.
    const previousById = new Map(previous.map((milestone) => [milestone.id, milestone]));
    const preserved = new Set(diff?.preservedMilestones ?? []);
    mission.milestones = milestones.map((milestone) => {
      const before = previousById.get(milestone.id);
      if (before && preserved.has(milestone.id) && before.status === "completed") {
        return { ...before, planVersion: version, dependencies: milestone.dependencies, acceptanceCriteria: milestone.acceptanceCriteria };
      }
      if (before && before.status === "completed" && !preserved.has(milestone.id)) {
        this.emit(mission, "mission.milestone.invalidated", { reason: reason?.type ?? "replan" }, { milestoneId: milestone.id });
        return { ...milestone, invalidation: { reason: reason?.type ?? "replan", by: "runtime", at: new Date().toISOString(), evidence: [] } };
      }
      return milestone;
    });
    if (diff) {
      diff.preservedWorkstreams = mission.waves.filter((wave) => preserved.has(wave.milestoneId) && wave.status === "completed").map((wave) => wave.dispatchId);
      diff.invalidatedWorkstreams = mission.waves.filter((wave) => diff.invalidatedMilestones.includes(wave.milestoneId)).map((wave) => wave.dispatchId);
    }
    const planVersion: MissionPlanVersion = {
      version, ...(mission.currentPlanVersion ? { parentVersion: mission.currentPlanVersion } : {}),
      milestones: mission.milestones.map((milestone) => ({ ...milestone })), createdAt: new Date().toISOString(),
      ...(reason ? { reason } : {}), ...(diff ? { diff } : {}),
      fingerprint: replanFingerprint(reason ?? { type: "new_evidence", evidence: [] }, milestones),
    };
    mission.planVersions.push(planVersion);
    mission.currentPlanVersion = version;

    for (const assumption of proposed.assumptions ?? []) {
      if (mission.assumptions.some((existing) => existing.id === assumption.id)) continue;
      // Declared assumptions always start unverified: a planning role cannot certify itself.
      mission.assumptions.push({ id: assumption.id, statement: assumption.statement, status: "unverified", evidence: [], declaredInPlanVersion: version });
      this.emit(mission, "mission.assumption.created", { assumptionId: assumption.id });
    }
    this.save(mission);
    this.emit(mission, reason ? "mission.plan.replaced" : "mission.plan.created", { version, order: validation.order, ...(diff ? { diff } : {}) });
    this.emit(mission, "mission.plan.validated", { version, valid: true, order: validation.order });
    return true;
  }

  private milestonesInvalidatedBy(mission: AutonomousMission, reason: ReplanTrigger): string[] {
    const failing = [...mission.waves].reverse().find((wave) => wave.status !== "completed")?.milestoneId;
    const seeds = new Set<string>();
    if (reason.type === "human_steering") {
      const steering = mission.steering.find((entry) => entry.id === reason.steeringId);
      for (const id of steering?.removedMilestoneIds ?? []) seeds.add(id);
      for (const milestone of mission.milestones) if (milestone.status !== "completed") seeds.add(milestone.id);
    } else if (failing) seeds.add(failing);
    // Anything downstream of an invalidated milestone is invalidated too.
    let grew = true;
    while (grew) {
      grew = false;
      for (const milestone of mission.milestones) {
        if (seeds.has(milestone.id)) continue;
        if (milestone.dependencies.some((dependency) => seeds.has(dependency))) { seeds.add(milestone.id); grew = true; }
      }
    }
    return [...seeds];
  }

  // ---------------------------------------------------------------- replanning

  /** The runtime, not a model, decides whether a replan may happen at all. */
  private async requestReplan(mission: AutonomousMission, trigger: ReplanTrigger, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    if (mission.pauseRequested) return false;
    const budget = checkMissionBudget(mission, "replan");
    for (const warning of budget.warnings) this.emit(mission, "mission.budget.warning", { warning, ratio: BUDGET_WARNING_RATIO });
    if (!budget.ok) { mission.error = budget.code!; this.save(mission); this.emit(mission, "mission.replan.blocked", { code: budget.code, detail: budget.detail }); return false; }

    const triggerKey = replanFingerprint(trigger, []);
    // Idempotent transition: an event replay after restart must not create a second plan version.
    const existing = mission.planVersions.find((version) => version.parentVersion === mission.currentPlanVersion && version.reason && replanFingerprint(version.reason, []) === triggerKey);
    if (existing) { this.emit(mission, "mission.replan.blocked", { code: MISSION_ERRORS.MISSION_DUPLICATE_REPLAN, version: existing.version }); return false; }

    mission.status = "replanning"; this.save(mission);
    this.emit(mission, "mission.replan.requested", { trigger: trigger.type });
    this.emit(mission, "mission.replan.started", { trigger: trigger.type, fromVersion: mission.currentPlanVersion });

    const workspace = this.missionWorkspace(mission)!;
    const run = await this.options.agentRuntime.executeAgentRun({
      runId: `${mission.id}:replan:${mission.currentPlanVersion + 1}`, agentId: "replanner", role: "replanner",
      goal: `Mission replan v${mission.currentPlanVersion + 1} for: ${mission.originalGoal}`,
      taskPlan: JSON.stringify({
        missionIntent: this.publicIntent(mission),
        currentPlan: mission.milestones.map((milestone) => ({ id: milestone.id, title: milestone.title, objective: milestone.objective, dependencies: milestone.dependencies, acceptanceCriteria: milestone.acceptanceCriteria, verificationCommands: milestone.verificationCommands, status: milestone.status })),
        completedEvidence: mission.milestones.filter((milestone) => milestone.status === "completed").map((milestone) => ({ id: milestone.id, revision: milestone.resultRevision, checkpointId: milestone.checkpointId })),
        assumptions: mission.assumptions.map((assumption) => ({ id: assumption.id, statement: assumption.statement, status: assumption.status })),
        missionMemory: mission.memory,
        trigger,
      }),
      workspaceId: workspace.id, workspacePath: workspace.rootPath,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      structuredOutput: "mission_plan", signal,
    });
    this.recordAgentUsage(mission, [run]);
    const proposed = run.structuredData as MissionPlanResult | undefined;
    if (run.status !== "completed" || !proposed) { mission.error = MISSION_ERRORS.MISSION_REPLANNER_FAILED; this.save(mission); this.emit(mission, "mission.replan.blocked", { code: MISSION_ERRORS.MISSION_REPLANNER_FAILED }); return false; }

    // Mission-level loop detection: an equivalent (trigger, roadmap shape) cycle is not progress.
    const candidateMilestones = proposed.milestones.map((milestone) => ({ ...milestone, status: "pending" as const, planVersion: 0, waveIds: [], evidence: [] }));
    const fingerprint = replanFingerprint(trigger, candidateMilestones);
    if (mission.planVersions.some((version) => version.fingerprint === fingerprint)) {
      mission.error = MISSION_ERRORS.MISSION_REPLAN_LOOP_DETECTED;
      this.save(mission);
      this.emit(mission, "mission.replan.blocked", { code: MISSION_ERRORS.MISSION_REPLAN_LOOP_DETECTED, fingerprint });
      return false;
    }
    const intentBefore = mission.intent.digest;
    if (!this.applyPlanVersion(mission, proposed, trigger)) return false;
    // The Replanner is read-only over intent: any drift here is a fail-closed condition.
    if (mission.intent.digest !== intentBefore) { mission.error = MISSION_ERRORS.MISSION_RECOVERY_REVALIDATION_REQUIRED; this.save(mission); return false; }
    mission.usage.replans++;
    this.save(mission);
    this.emit(mission, "mission.replan.completed", { version: mission.currentPlanVersion, trigger: trigger.type });
    return true;
  }

  // ---------------------------------------------------------------- drive loop

  private async drive(mission: AutonomousMission, signal: AbortSignal, startedAt: number, privateAgentContext?: PrivateAgentContext): Promise<AutonomousMissionResult> {
    for (;;) {
      if (signal.aborted) return this.terminate(mission, "cancelled", MISSION_ERRORS.MISSION_CANCELLED, startedAt);
      const live = this.store.get(mission.id);
      if (live?.pauseRequested) mission.pauseRequested = true;
      if (live?.steering.length && live.steering.length !== mission.steering.length) mission.steering = live.steering;
      if (live?.acceptanceCriteria.length && live.intent.version > mission.intent.version) {
        mission.intent = live.intent; mission.intentHistory = live.intentHistory; mission.acceptanceCriteria = live.acceptanceCriteria;
      }
      if (mission.pauseRequested) { mission.status = "paused"; this.save(mission); this.emit(mission, "mission.paused", { atWave: mission.currentWave }); return this.result(mission, MISSION_ERRORS.MISSION_PAUSED); }

      const pendingSteering = mission.steering.find((entry) => !entry.appliedAt && ["clarification", "priority_change", "acceptance_change", "scope_reduction", "replan_request"].includes(entry.type));
      if (pendingSteering) {
        pendingSteering.appliedAt = new Date().toISOString();
        this.save(mission);
        const replanned = await this.requestReplan(mission, { type: "human_steering", steeringId: pendingSteering.id }, signal);
        pendingSteering.resultingPlanVersion = mission.currentPlanVersion;
        this.save(mission);
        if (!replanned) return this.terminate(mission, "blocked", mission.error ?? MISSION_ERRORS.MISSION_REPLAN_LIMIT, startedAt);
        continue;
      }

      const next = this.nextReadyMilestone(mission);
      if (!next) {
        const outstanding = mission.milestones.filter((milestone) => milestone.status !== "completed" && milestone.status !== "cancelled");
        if (outstanding.length) return this.terminate(mission, "blocked", mission.error ?? MISSION_ERRORS.MISSION_MILESTONE_BLOCKED, startedAt, outstanding.map((milestone) => milestone.id).join(","));
        // An exhausted wave budget must not prevent evaluating work that already finished.
        return await this.finalAcceptance(mission, signal, startedAt);
      }

      const budget = checkMissionBudget(mission, "wave");
      for (const warning of budget.warnings) this.emit(mission, "mission.budget.warning", { warning });
      if (!budget.ok) return this.terminate(mission, "blocked", budget.code!, startedAt, budget.detail);

      const drift = await this.classifyTargetDrift(mission);
      if (drift.classification === "PROMOTION_CONFLICT") return this.terminate(mission, "blocked", MISSION_ERRORS.MISSION_REPOSITORY_DRIFT, startedAt, drift.actual);
      if (drift.classification === "REPLAN_REQUIRED" && !mission.driftHandledRevisions.includes(drift.actual)) {
        // Replan once per distinct target revision; a second identical drift is decided by the
        // final promotion gate rather than by an unbounded replan cycle.
        this.emit(mission, "mission.repository.drift", { classification: drift.classification, expected: drift.expected, actual: drift.actual, overlappingPaths: drift.overlappingPaths });
        mission.driftHandledRevisions.push(drift.actual); this.save(mission);
        const replanned = await this.requestReplan(mission, { type: "repository_divergence", expected: drift.expected, actual: drift.actual }, signal);
        if (!replanned) return this.terminate(mission, "blocked", mission.error ?? MISSION_ERRORS.MISSION_REPOSITORY_DRIFT, startedAt);
        continue;
      }
      if (drift.classification === "SAFE_ADDITIVE_DRIFT") this.emit(mission, "mission.repository.drift", { classification: drift.classification, expected: drift.expected, actual: drift.actual });

      const assumptionTrigger = await this.evaluateAssumptions(mission, next, signal);
      if (assumptionTrigger) {
        const replanned = await this.requestReplan(mission, assumptionTrigger, signal);
        if (!replanned) return this.terminate(mission, "blocked", mission.error ?? MISSION_ERRORS.MISSION_ASSUMPTION_INVALIDATED, startedAt);
        continue;
      }

      const wave = await this.executeMilestoneWave(mission, next, signal, privateAgentContext);
      if (signal.aborted) return this.terminate(mission, "cancelled", MISSION_ERRORS.MISSION_CANCELLED, startedAt);
      if (wave.status === "completed") continue;
      if (wave.status === "cancelled") return this.terminate(mission, "cancelled", MISSION_ERRORS.MISSION_CANCELLED, startedAt);
      if (!wave.replanTrigger) return this.terminate(mission, "blocked", wave.error ?? MISSION_ERRORS.MISSION_MILESTONE_BLOCKED, startedAt);
      const replanned = await this.requestReplan(mission, wave.replanTrigger, signal);
      if (!replanned) return this.terminate(mission, "blocked", mission.error ?? MISSION_ERRORS.MISSION_MILESTONE_BLOCKED, startedAt);
    }
  }

  private nextReadyMilestone(mission: AutonomousMission): MissionMilestone | undefined {
    const completed = new Set(mission.milestones.filter((milestone) => milestone.status === "completed").map((milestone) => milestone.id));
    // "executing"/"verifying" only survive a crash; re-entering them goes through the wave
    // recovery path, which consumes the existing dispatch instead of starting a second one.
    return mission.milestones.find((milestone) =>
      ["pending", "ready", "executing", "verifying"].includes(milestone.status)
      && milestone.dependencies.every((dependency) => completed.has(dependency)));
  }

  // ---------------------------------------------------------------- drift

  async classifyTargetDrift(mission: AutonomousMission): Promise<{ classification: TargetDriftClass; expected: string; actual: string; overlappingPaths: string[] }> {
    const target = this.options.workspaceService.getWorkspace(mission.workspaceId);
    const expected = mission.baseRevision;
    if (!target || !existsSync(target.rootPath)) return { classification: "PROMOTION_CONFLICT", expected, actual: "", overlappingPaths: [] };
    const actual = (await this.git(target.rootPath, ["rev-parse", "HEAD"]).catch(() => ({ stdout: "" }))).stdout.trim();
    if (!actual) return { classification: "PROMOTION_CONFLICT", expected, actual, overlappingPaths: [] };
    if (actual === expected) return { classification: "NO_DRIFT", expected, actual, overlappingPaths: [] };
    const descendant = await this.git(target.rootPath, ["merge-base", "--is-ancestor", expected, actual]).then(() => true).catch(() => false);
    if (!descendant) return { classification: "PROMOTION_CONFLICT", expected, actual, overlappingPaths: [] };
    const targetPaths = (await this.git(target.rootPath, ["diff", "--name-only", expected, actual]).catch(() => ({ stdout: "" }))).stdout.split(/\r?\n/).filter(Boolean);
    const workspace = this.missionWorkspace(mission);
    const missionPaths = workspace ? (await this.git(workspace.rootPath, ["diff", "--name-only", expected, "HEAD"]).catch(() => ({ stdout: "" }))).stdout.split(/\r?\n/).filter(Boolean) : [];
    const overlappingPaths = targetPaths.filter((file) => missionPaths.includes(file));
    // Overlap means the mission's assumptions about those files are no longer evidence-backed.
    return { classification: overlappingPaths.length ? "REPLAN_REQUIRED" : "SAFE_ADDITIVE_DRIFT", expected, actual, overlappingPaths };
  }

  // ---------------------------------------------------------------- assumptions

  /**
   * Assumptions are decided by the runtime from cited evidence, never by the role that declared
   * them: an Explorer reports observations, and a citation is only accepted when the referenced
   * path actually exists in the mission worktree.
   */
  private async evaluateAssumptions(mission: AutonomousMission, milestone: MissionMilestone, signal: AbortSignal): Promise<ReplanTrigger | undefined> {
    const unverified = mission.assumptions.filter((assumption) => assumption.status === "unverified");
    if (!unverified.length) return undefined;
    const workspace = this.missionWorkspace(mission)!;
    const run = await this.options.agentRuntime.executeAgentRun({
      runId: `${mission.id}:assumptions:${milestone.id}:${mission.currentPlanVersion}`, agentId: "explorer", role: "explorer",
      goal: `Gather evidence for mission assumptions before milestone ${milestone.id}`,
      taskPlan: JSON.stringify({ assumptions: unverified.map((assumption) => ({ id: assumption.id, statement: assumption.statement })) }),
      workspaceId: workspace.id, workspacePath: workspace.rootPath,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      structuredOutput: "explorer", signal,
    });
    this.recordAgentUsage(mission, [run]);
    const explored = run.structuredData as ExplorerResult | undefined;
    if (run.status !== "completed" || !explored) return undefined;
    let invalidated: MissionAssumption | undefined;
    for (const finding of explored.findings) {
      const match = /^assumption:([A-Za-z0-9_-]{1,60}):(verified|invalidated)$/.exec(finding.id);
      if (!match) continue;
      const assumption = mission.assumptions.find((candidate) => candidate.id === match[1] && candidate.status === "unverified");
      if (!assumption) continue;
      const citation = finding.path ?? finding.evidence;
      if (!citation || !existsSync(path.join(workspace.rootPath, citation))) continue; // uncited claims change nothing
      assumption.evidence.push(evidence("file", citation, finding.message.slice(0, 200)));
      assumption.status = match[2] === "verified" ? "verified" : "invalidated";
      assumption.updatedBy = "runtime";
      this.emit(mission, assumption.status === "verified" ? "mission.assumption.verified" : "mission.assumption.invalidated", { assumptionId: assumption.id, evidence: citation });
      if (assumption.status === "invalidated") invalidated = assumption;
    }
    this.save(mission);
    return invalidated ? { type: "assumption_invalidated", assumptionId: invalidated.id } : undefined;
  }

  // ---------------------------------------------------------------- waves

  /** Classifies a recovered parallel dispatch without ever blindly respawning active work. */
  classifyWorkstreamRecovery(runId: string): Record<string, WorkstreamRecoveryClass> {
    const run = this.parallel.getRun(runId);
    const classes: Record<string, WorkstreamRecoveryClass> = {};
    for (const dispatch of run?.dispatches ?? []) {
      const result = run?.workstreams.find((workstream) => workstream.workstreamId === dispatch.workstreamId);
      classes[dispatch.workstreamId] = dispatch.state === "completed" && result?.status === "completed" ? "completed"
        : dispatch.state === "dispatched" ? "safe_to_resume"
        : dispatch.state === "active" ? "requires_revalidation"
        : dispatch.state === "revalidation_required" ? "unknown_side_effect"
        : "blocked";
    }
    return classes;
  }

  private async executeMilestoneWave(mission: AutonomousMission, milestone: MissionMilestone, signal: AbortSignal, privateAgentContext?: PrivateAgentContext): Promise<MissionWaveResult> {
    const workspace = this.missionWorkspace(mission)!;
    const dispatchId = `${mission.id}:v${mission.currentPlanVersion}:${milestone.id}`;
    const runId = `parallel-${dispatchId.replace(/[^A-Za-z0-9_:-]/g, "")}`;

    // Stable dispatch identity: a restart consumes the existing run instead of dispatching twice.
    const existingWave = mission.waves.find((wave) => wave.dispatchId === dispatchId);
    const existingRun = this.parallel.getRun(runId);
    if (existingWave && existingWave.status === "completed") {
      this.emit(mission, "mission.wave.completed", { duplicateSuppressed: true, dispatchId }, { milestoneId: milestone.id, wave: existingWave.wave });
      return existingWave;
    }
    if (existingRun && !["completed", "blocked", "cancelled", "failed"].includes(existingRun.status)) {
      this.emit(mission, "mission.wave.recovered", { dispatchId, recovery: this.classifyWorkstreamRecovery(runId) }, { milestoneId: milestone.id });
    }

    mission.currentWave++;
    const wave = mission.currentWave;
    milestone.status = "executing"; milestone.waveIds.push(wave);
    mission.status = "executing"; mission.usage.waves++;
    const pending: MissionWaveResult = { wave, planVersion: mission.currentPlanVersion, milestoneId: milestone.id, dispatchId, parallelRunId: runId, status: "failed", provenCriteria: [], invalidatedCriteria: [], evidence: [] };
    mission.waves = [...mission.waves.filter((entry) => entry.dispatchId !== dispatchId), pending];
    this.save(mission);
    this.emit(mission, "mission.milestone.started", { objective: milestone.objective }, { milestoneId: milestone.id, wave });
    this.emit(mission, "mission.wave.started", { dispatchId, runId, planVersion: mission.currentPlanVersion }, { milestoneId: milestone.id, wave });

    const run = existingRun && ["completed", "blocked", "failed"].includes(existingRun.status)
      ? { runId, status: existingRun.status as ParallelRunResult["status"], workstreams: existingRun.workstreams, synthesis: existingRun.synthesis, verification: [], usage: existingRun.usage ?? { modelRequests: 0, agentTurns: 0, toolCalls: 0, writeCalls: 0, commandExecutions: 0, verificationRuns: 0, inputTokens: 0, outputTokens: 0 }, error: existingRun.error }
      : existingRun
        ? await this.parallel.resumeRun(runId, { signal, ...(milestone.verificationCommands ? { verificationCommands: milestone.verificationCommands } : {}), ...(privateAgentContext ? { privateAgentContext } : {}) })
        : await this.parallel.startRun({
            runId, sessionId: mission.sessionId, workspacePath: workspace.rootPath,
            goal: `${milestone.objective} (mission milestone ${milestone.id})`,
            ...(milestone.verificationCommands ? { verificationCommands: milestone.verificationCommands } : {}),
            ...(privateAgentContext ? { privateAgentContext } : {}),
            signal,
          });

    this.recordWaveUsage(mission, run);
    const result: MissionWaveResult = { ...pending, status: run.status, evidence: [] };
    if (run.status === "completed") {
      const revision = (await this.git(workspace.rootPath, ["rev-parse", "HEAD"])).stdout.trim();
      milestone.status = "completed"; milestone.resultRevision = revision;
      milestone.evidence = [evidence("revision", revision, `Milestone ${milestone.id} result`), ...run.workstreams.map((workstream) => evidence("branch", workstream.branch ?? workstream.workstreamId, `workstream ${workstream.workstreamId}`))];
      result.resultingRevision = revision;
      result.evidence = milestone.evidence;

      const checkpoint = await this.checkpointFactory(workspace.rootPath)
        .createCheckpoint({ checkpointId: `cp-${mission.id.slice(-8)}-${milestone.id}-v${mission.currentPlanVersion}`, sessionId: mission.sessionId, label: `Mission ${mission.id} milestone ${milestone.id}` })
        .catch(() => undefined);
      if (checkpoint) { milestone.checkpointId = checkpoint.checkpointId; result.evidence.push(evidence("checkpoint", checkpoint.checkpointId, checkpoint.durableRef)); }

      result.provenCriteria = this.proveAcceptance(mission, milestone, run, revision);
      mission.usage.milestonesCompleted++;
      this.appendMilestoneMemory(mission, milestone, revision, run);
    } else {
      milestone.status = run.status === "cancelled" ? "cancelled" : "blocked";
      result.error = run.error;
      result.replanTrigger = this.deriveReplanTrigger(run);
      mission.memory.recentFailures.push(`${milestone.id}: ${run.error ?? run.status}`);
      mission.memory = compactMissionMemory(mission.memory);
    }
    // Persist the outcome before announcing it, so a crash between the two cannot lose a
    // certified milestone or resurrect one that never finished.
    mission.waves = [...mission.waves.filter((entry) => entry.dispatchId !== dispatchId), result];
    this.save(mission);
    if (result.status === "completed") {
      this.emit(mission, "mission.milestone.completed", { revision: result.resultingRevision, checkpointId: milestone.checkpointId, provenCriteria: result.provenCriteria }, { milestoneId: milestone.id, wave });
      this.emit(mission, "mission.wave.completed", { dispatchId, revision: result.resultingRevision }, { milestoneId: milestone.id, wave });
    } else {
      this.emit(mission, "mission.wave.blocked", { dispatchId, error: run.error, trigger: result.replanTrigger?.type }, { milestoneId: milestone.id, wave });
    }
    return result;
  }

  private deriveReplanTrigger(run: ParallelRunResult): ReplanTrigger | undefined {
    if (run.error === "GLOBAL_VERIFICATION_FAILED") {
      const failure = run.verification.find((verification) => verification.failed > 0) ?? run.workstreams.flatMap((workstream) => workstream.verification).find((verification) => verification.failed > 0);
      return { type: "verification_failure", verificationId: failure?.command ?? "global", ...(failure ? { command: failure.command, exitCode: failure.exitCode } : {}) };
    }
    if (run.error === "GLOBAL_REVIEW_BLOCKED" || run.error === "PARALLEL_WORKSTREAM_BLOCKED") {
      const findings = run.workstreams.flatMap((workstream) => workstream.findings).filter((finding) => finding.severity === "blocking");
      const failedVerification = run.workstreams.flatMap((workstream) => workstream.verification).find((verification) => verification.failed > 0);
      if (findings.length) return { type: "review_block", findingIds: findings.map((finding) => finding.id) };
      if (failedVerification) return { type: "verification_failure", verificationId: failedVerification.command, command: failedVerification.command, exitCode: failedVerification.exitCode };
      const failed = run.workstreams.find((workstream) => workstream.status !== "completed");
      return failed ? { type: "dependency_failure", workstreamId: failed.workstreamId } : undefined;
    }
    if (run.error === "SYNTHESIS_CONFLICT_UNRESOLVED") {
      const conflict = run.synthesis?.conflicts[0];
      return conflict ? { type: "dependency_failure", workstreamId: conflict.workstreams[0] ?? "synthesis" } : undefined;
    }
    if (run.error === "PROMOTION_TARGET_DIVERGED") return { type: "repository_divergence", expected: "mission base", actual: "target advanced" };
    return undefined;
  }

  /**
   * Acceptance is proven by deterministic evidence only: a milestone that carried real
   * verification commands and passed both verification and independent review.
   */
  private proveAcceptance(mission: AutonomousMission, milestone: MissionMilestone, run: ParallelRunResult, revision: string): string[] {
    const verifications = [...run.verification, ...run.workstreams.flatMap((workstream) => workstream.verification)];
    const passed = verifications.filter((verification) => verification.failed === 0 && verification.passed > 0);
    const proven: string[] = [];
    for (const criterionId of milestone.acceptanceCriteria) {
      const criterion = mission.acceptanceCriteria.find((candidate) => candidate.id === criterionId);
      if (!criterion || criterion.status === "waived") continue;
      const refs: EvidenceRef[] = [evidence("revision", revision, `milestone ${milestone.id}`), ...passed.map((verification) => evidence("verification", verification.command, `exit ${verification.exitCode}`))];
      criterion.evidence.push(...refs);
      criterion.provenBy = {
        workstreamIds: run.workstreams.map((workstream) => workstream.workstreamId),
        verificationIds: passed.map((verification) => verification.command),
        reviewFindingIds: run.workstreams.flatMap((workstream) => workstream.findings.map((finding) => finding.id)),
      };
      criterion.status = passed.length ? "proven" : "partially_proven";
      if (criterion.status === "proven") { proven.push(criterion.id); this.emit(mission, "mission.acceptance.proven", { criterionId: criterion.id, revision }, { milestoneId: milestone.id }); }
    }
    return proven;
  }

  /** Public, evidence-linked, size-bounded memory. Runtime transcripts never enter here. */
  private appendMilestoneMemory(mission: AutonomousMission, milestone: MissionMilestone, revision: string, run: ParallelRunResult): void {
    mission.memory.milestoneSummaries.push({
      milestoneId: milestone.id,
      summary: `${milestone.title}: ${run.workstreams.length} workstream(s) certified; criteria ${milestone.acceptanceCriteria.join(", ") || "none"}`,
      revision, ...(milestone.checkpointId ? { checkpointId: milestone.checkpointId } : {}), contextRevision: revision,
    });
    for (const workstream of run.workstreams) {
      for (const contract of workstream.contractsProduced) mission.memory.keyContracts.push({ id: contract.id, revision: contract.revision, summary: contract.summary });
    }
    mission.memory.evidenceRefs.push(evidence("revision", revision, milestone.id));
    mission.memory = compactMissionMemory(mission.memory);
    mission.evidence.push(evidence("revision", revision, `milestone ${milestone.id}`));
    this.emit(mission, "mission.memory.compacted", { compactions: mission.memory.compactions, bytes: Buffer.byteLength(JSON.stringify(mission.memory), "utf8") });
  }

  // ---------------------------------------------------------------- final gate

  private async finalAcceptance(mission: AutonomousMission, signal: AbortSignal, startedAt: number): Promise<AutonomousMissionResult> {
    mission.status = "evaluating"; this.save(mission);
    const workspace = this.missionWorkspace(mission)!;

    const unproven = unprovenMandatoryCriteria(mission);
    if (unproven.length) return this.terminate(mission, "blocked", MISSION_ERRORS.MISSION_ACCEPTANCE_UNPROVEN, startedAt, unproven.map((criterion) => criterion.id).join(","));

    const commands = [...new Set(mission.milestones.flatMap((milestone) => milestone.verificationCommands ?? []))];
    const verification = await this.runVerification(workspace.rootPath, commands, signal, mission.id, mission.sessionId);
    mission.usage.verificationRuns += commands.length;
    this.emit(mission, "mission.final_verification.completed", { passed: !verification.some((result) => result.failed > 0), commands });
    if (verification.some((result) => result.failed > 0)) return this.terminate(mission, "blocked", MISSION_ERRORS.MISSION_FINAL_VERIFICATION_FAILED, startedAt);

    const finalReview = await this.options.agentRuntime.executeAgentRun({
      runId: `${mission.id}:final-review`, agentId: "reviewer", role: "reviewer",
      goal: `Final acceptance review for mission: ${mission.originalGoal}`,
      taskPlan: JSON.stringify({
        missionIntent: this.publicIntent(mission),
        acceptanceMatrix: mission.acceptanceCriteria.map((criterion) => ({ id: criterion.id, description: criterion.description, status: criterion.status, mandatory: criterion.mandatory })),
        milestones: mission.milestones.map((milestone) => ({ id: milestone.id, status: milestone.status, revision: milestone.resultRevision, checkpointId: milestone.checkpointId })),
        verification: verification.map((result) => ({ command: result.command, passed: result.passed, failed: result.failed })),
        contracts: mission.memory.keyContracts,
      }),
      workspaceId: workspace.id, workspacePath: workspace.rootPath,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      structuredOutput: "reviewer", signal,
    });
    this.recordAgentUsage(mission, [finalReview]);
    const review = finalReview.structuredData as ReviewResult | undefined;
    this.emit(mission, "mission.final_review.completed", { passed: finalReview.status === "completed" && review?.verdict === "pass", findingIds: (review?.findings ?? []).map((finding) => finding.id) });
    if (finalReview.status !== "completed" || review?.verdict !== "pass") {
      const result = this.terminate(mission, "blocked", MISSION_ERRORS.MISSION_FINAL_REVIEW_BLOCKED, startedAt);
      return { ...result, findings: review?.findings ?? finalReview.findings };
    }

    const drift = await this.classifyTargetDrift(mission);
    if (drift.classification !== "NO_DRIFT") return this.terminate(mission, "blocked", MISSION_ERRORS.MISSION_REPOSITORY_DRIFT, startedAt, drift.classification);

    mission.status = "executing"; this.save(mission);
    const promotion = await this.integrationService.integrate({
      targetWorkspaceId: mission.workspaceId, isolatedWorktreeId: workspace.id,
      expectedBaseSha: mission.baseRevision, runId: mission.id,
      reviewFindings: review.findings, verificationResults: verification,
      commitMessage: `Autonomous mission: ${mission.originalGoal}`,
    });
    if (promotion.status !== "integrated") return this.terminate(mission, "blocked", promotion.code ?? "MISSION_PROMOTION_BLOCKED", startedAt);
    mission.finalRevision = promotion.finalRevision;
    this.emit(mission, "mission.promotion.completed", { finalRevision: promotion.finalRevision });
    return this.terminate(mission, "completed", undefined, startedAt);
  }

  private async runVerification(cwd: string, commands: string[], signal: AbortSignal, runId?: string, sessionId?: string): Promise<VerificationResult[]> {
    if (!commands.length) return [];
    const report = await runVerification(cwd, commands, { signal, ...(runId ? { runId } : {}), ...(sessionId && this.options.persistence ? { observer: createForgeVerifyPersistenceObserver(this.options.persistence, sessionId) } : {}) });
    if (signal.aborted) throw new Error(MISSION_ERRORS.MISSION_CANCELLED);
    return report.verifiers.map((verifier) => ({
      command: verifier.command,
      cwd,
      passed: verifier.passed,
      failed: verifier.failed,
      skipped: verifier.skipped,
      exitCode: verifier.exitCode,
      durationMs: verifier.durationMs,
      output: verifier.output,
      failures: verifier.failures,
      ...(verifier.timedOut ? { timedOut: true } : {}),
      ...(verifier.cancelled ? { cancelled: true } : {}),
    }));
  }

  // ---------------------------------------------------------------- results

  private terminate(mission: AutonomousMission, status: AutonomousMission["status"], error: string | undefined, startedAt: number, detail?: string): AutonomousMissionResult {
    mission.status = status;
    mission.error = error ? (detail ? `${error}: ${detail}` : error) : undefined;
    mission.usage.wallClockMs += Date.now() - startedAt;
    this.save(mission);
    this.emit(mission, status === "completed" ? "mission.completed" : status === "cancelled" ? "mission.cancelled" : status === "paused" ? "mission.paused" : "mission.blocked", { error: mission.error });
    return this.result(mission, mission.error);
  }

  private result(mission: AutonomousMission, error?: string): AutonomousMissionResult {
    const retainedWork: RetainedAutonomousWork[] = [
      ...(mission.missionBranch ? [{ kind: "mission_branch" as const, ref: mission.missionBranch, description: "CodeForge-owned mission integration branch" }] : []),
      ...mission.milestones.filter((milestone) => milestone.checkpointId).map((milestone) => ({ kind: "milestone_checkpoint" as const, ref: milestone.checkpointId!, description: `Certified milestone ${milestone.id}` })),
      ...mission.milestones.filter((milestone) => milestone.resultRevision).map((milestone) => ({ kind: "milestone_revision" as const, ref: milestone.resultRevision!, description: `Milestone ${milestone.id} result revision` })),
      ...mission.waves.filter((wave) => wave.parallelRunId).map((wave) => ({ kind: "parallel_run" as const, ref: wave.parallelRunId!, description: `Wave ${wave.wave} for ${wave.milestoneId}` })),
    ];
    const summary = `${mission.originalGoal} — ${mission.milestones.filter((milestone) => milestone.status === "completed").length}/${mission.milestones.length} milestones, plan v${mission.currentPlanVersion}, ${mission.usage.replans} replan(s), ${mission.usage.waves} wave(s)`;
    return {
      missionId: mission.id,
      status: mission.status === "completed" ? "completed" : mission.status === "cancelled" ? "cancelled" : mission.status === "failed" ? "failed" : "blocked",
      summary, planVersions: mission.planVersions.length, wavesExecuted: mission.usage.waves, replans: mission.usage.replans,
      milestones: mission.milestones, acceptance: mission.acceptanceCriteria,
      ...(mission.finalRevision ? { finalRevision: mission.finalRevision } : {}),
      usage: mission.usage, evidence: mission.evidence, retainedWork,
      ...(error ?? mission.error ? { error: error ?? mission.error } : {}),
    };
  }
}

export function createMissionSupervisor(options: MissionSupervisorOptions): MissionSupervisor {
  return new MissionSupervisor(options);
}

export type { AgentEvidenceRef, AgentFinding };
