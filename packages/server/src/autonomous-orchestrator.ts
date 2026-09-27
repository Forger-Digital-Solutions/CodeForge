import crypto from "node:crypto";
import { getSanitizedEnvForChild } from "./env-filter.js";
import fs from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  type AgentResult,
  type AgentFinding,
  type AgentEvidenceRef,
  type PlannerResult,
  validateStructuredAgentResult,
  validatePlanningCompleteness,
} from "@codeforge/agent";
import {
  type WorkspaceService,
  type ForgeWorkspace,
  type WorkspaceLease,
} from "./workspace-service.js";
import {
  type CheckpointService,
  createCheckpointService,
} from "./checkpoint-service.js";
import {
  type SubagentManager,
  createSubagentManager,
} from "./subagent-manager.js";
import {
  type IntegrationService,
  type IntegrateResult,
  createIntegrationService,
} from "./integration-service.js";
import type { ISessionPersistence } from "@codeforge/sessions";
import type { WorkspaceEventAdapter } from "./workspace-event-adapter.js";
import {
  createVerificationInputStateHash,
  evaluateCompletion,
  runVerification,
  verificationPassed as forgeVerificationPassed,
  type CompletionGateDecision,
  type FailureAnalysis,
  type ReviewDecision,
  type VerificationResult,
  type WorkflowPlan,
} from "@codeforge/workflow";
import { createForgeVerifyPersistenceObserver } from "./forge-verify-persistence.js";
import { redactSecrets } from "@codeforge/secrets";
import { reviewDiff, type ReviewFinding } from "@codeforge/workflow";
import type { AdaptiveTopology, AdaptiveTopologyPlan } from "@codeforge/protocol";
import type { ProviderTopologyCapacity } from "@codeforge/forge-green";
import { resolveAdaptiveTopology } from "./adaptive-topology.js";
import { evaluateMissionAdmission, type CapacityConfidenceReport, type MissionAdmissionVerdict } from "./capacity-confidence.js";
import { classifyTaskComplexity, type TaskComplexityDecision, type TaskComplexityTier } from "./task-complexity.js";

const execFile = promisify(execFileCallback);

import type { AgentRuntime } from "./agent-runtime.js";

export const MAX_REVIEW_REVISION_ROUNDS = 2;

/** Bound on the diff body handed to the independent reviewer. 24KB covers realistic
 * coordinated multi-file changes; the truncation marker points the reviewer at the worktree
 * for the remainder instead of silently dropping the tail (the R43 defect: a bare ~2KB
 * slice that reviewed most multi-file diffs blind). */
export const REVIEWER_DIFF_BODY_BYTES = 24_000;

/**
 * Build the reviewer's diff context: the full `--stat` inventory of every changed file plus
 * a bounded diff body with an explicit truncation marker. Never labels diff text as
 * verification evidence — verification has not run when the reviewer sees this.
 */
export function buildReviewerDiffContext(diffStat: string, diffOut: string, baseRevision: string): string {
  return `Diff stat against base:\n${diffStat.trim()}\n\nDiff against base:\n${diffOut.slice(0, REVIEWER_DIFF_BODY_BYTES)}${diffOut.length > REVIEWER_DIFF_BODY_BYTES ? `\n[diff truncated: ${diffOut.length - REVIEWER_DIFF_BODY_BYTES} bytes omitted; run git diff ${baseRevision} in the worktree for the remainder]` : ""}`;
}

/**
 * R1 phase ceilings reserve time for planning and execution. Explorers are read-only evidence
 * producers; a paced provider must not be allowed to consume the parent run's entire deadline
 * before the Planner gets a chance to produce an authorized graph. These are watchdog ceilings,
 * so the normal worker watchdog remains extension-aware outside this phase contract.
 */
export const R1_EXPLORER_TIMEOUT_MS = 90_000;
export const R1_PLANNER_TIMEOUT_MS = 90_000;

export type AutonomousRunStatus =
  | "created"
  | "exploring"
  | "planning"
  | "executing"
  | "reviewing"
  | "revising"
  | "verifying"
  | "integration_ready"
  | "integrating"
  | "completed"
  | "blocked"
  | "cancelled"
  | "failed";

export const TERMINAL_STATUSES = new Set<AutonomousRunStatus>([
  "completed",
  "blocked",
  "cancelled",
  "failed",
]);

export interface AgentTask {
  id: string;
  title: string;
  objective: string;
  dependencies: string[];
  assignedRole: "explorer" | "planner" | "coder" | "reviewer";
  status: "pending" | "running" | "completed" | "blocked" | "failed" | "cancelled";
  evidence?: AgentEvidenceRef[];
  result?: AgentResult;
}

export interface TaskGraph {
  tasks: AgentTask[];
}

export interface AutonomousRunCounters {
  childrenSpawned: number;
  reviewRounds: number;
  taskAttempts: number;
  verificationAttempts: number;
}

export interface AutonomousRunResult {
  runId: string;
  status: "completed" | "blocked" | "cancelled" | "failed";
  summary: string;
  workspaceId: string;
  baseRevision: string;
  finalRevision?: string;
  changedFiles: string[];
  review: {
    passed: boolean;
    findings: AgentFinding[];
  };
  verification: VerificationResult[];
  completion?: CompletionGateDecision;
  integration: {
    status: "integrated" | "retained" | "blocked" | "not_attempted";
    branch?: string;
    worktreeId?: string;
    reason?: string;
  };
  evidence: AgentEvidenceRef[];
  counters: AutonomousRunCounters;
  /** R21: the topology this run actually executed and why (receipt). */
  topology?: TopologyDecisionRecord;
}

/**
 * R21 topology receipt. Recorded on the durable run so the choice of team is inspectable and
 * reproducible: the deterministic complexity classification, the resolved plan, and which policy
 * made the call (an explicit request, the fixed R1 baseline via CODEFORGE_TOPOLOGY_POLICY, or the
 * adaptive smallest-useful default).
 */
export interface TopologyDecisionRecord {
  policy: "adaptive" | "explicit" | "fixed_r1_env";
  complexity: TaskComplexityDecision;
  plan: AdaptiveTopologyPlan;
  /** R24: the live capacity snapshot ForgeGreen advised against, when one was observed. */
  providerCapacity?: ProviderTopologyCapacity;
  /** R45: deterministic orientation coverage probed before spawn (normal-tier adaptive only). */
  orientationCoverage?: { covered: boolean; candidateFiles: number };
  /** R46: the mission-admission verdict recorded with the plan that produced it. */
  missionAdmission?: MissionAdmissionVerdict;
  repositoryFileCount: number;
  decidedAt: string;
}

export interface AutonomousRun {
  id: string;
  sessionId: string;
  workspaceId: string;
  workspacePath: string;
  goal: string;
  status: AutonomousRunStatus;
  baseRevision: string;
  finalRevision?: string;
  checkpointId?: string;
  isolatedWorktreeId?: string;
  isolatedBranch?: string;
  reviewRounds: number;
  taskGraph: TaskGraph;
  counters: AutonomousRunCounters;
  topology?: TopologyDecisionRecord;
  startedAt?: string;
  completedAt?: string;
  result?: AutonomousRunResult;
  error?: string;
}

export interface OrchestratorRunOptions {
  sessionId: string;
  workspacePath: string;
  goal: string;
  verificationCommands?: string[];
  /** Per-verification-command ceiling; defaults to runVerification's 300s. Long real suites
   *  (a monorepo's full `npm test`) need more and must be able to opt in without weakening the
   *  default for every other caller. */
  verificationTimeoutMs?: number;
  adapter?: WorkspaceEventAdapter;
  signal?: AbortSignal;
  /** Test/operator seam for proving the R1 phase contract without waiting 90 seconds. */
  r1PhaseTimeoutMs?: { explorer?: number; planner?: number };
  /** Custom coder executor function for testing or specialized model execution */
  coderExecutor?: (worktreePath: string, goal: string, reviewFeedback?: string) => Promise<{ success: boolean; filesChanged: string[]; output?: string }>;
  /** R21: explicit topology request; wins over the adaptive classifier. */
  topology?: AdaptiveTopology;
  /** R21: explicit complexity hint for the classifier (e.g. from the UI). */
  complexityHint?: TaskComplexityTier;
  /** R21: visual assets present — routes through the vision topology. */
  hasImages?: boolean;
}

export interface OrchestratorOptions {
  workspaceService: WorkspaceService;
  persistence?: ISessionPersistence;
  subagentManager?: SubagentManager;
  integrationService?: IntegrationService;
  checkpointServiceFactory?: (repoRoot: string) => CheckpointService;
  agentRuntime?: AgentRuntime;
  getAgentRuntime?: (sessionId: string) => AgentRuntime;
  /** Enables the additive R1 capsule, durable worker, and artifact instrumentation path. */
  subagentsR1Enabled?: boolean;
  /**
   * R24: live provider-capacity view for ForgeGreen topology advice. The host builds it over
   * the Free Cloud projections + route-health authority + the fabric's reservation snapshot;
   * absent, adaptive topology plans fall back to PROVIDER_CAPACITY_UNOBSERVED (no reduction).
   */
  providerTopologyCapacity?: () => ProviderTopologyCapacity | undefined;
  /**
   * R45: deterministic read-plan coverage probe, run before spawn for normal-tier tasks on the
   * adaptive path. Pure local indexing — no model call. The answer gates whether a narrow
   * capacity window may substitute packet orientation for a dedicated explorer. Absent →
   * coverage unobserved → no coverage-based reduction.
   */
  orientationProbe?: (goal: string, workspacePath: string) => Promise<{ covered: boolean; candidateFiles: number } | undefined>;
  /** R46 §13: live capacity-confidence projection for mission admission. Absent = UNOBSERVED,
   *  which admits honestly — the gate only refuses on provable insufficiency. */
  capacityConfidence?: () => CapacityConfidenceReport | undefined;
}

export class AutonomousRunOrchestrator {
  private readonly workspaceService: WorkspaceService;
  private readonly persistence?: ISessionPersistence;
  private readonly subagentManager: SubagentManager;
  private readonly integrationService: IntegrationService;
  private readonly checkpointServiceFactory: (repoRoot: string) => CheckpointService;
  private readonly agentRuntime?: AgentRuntime;
  private readonly getAgentRuntime?: (sessionId: string) => AgentRuntime;
  private readonly providerTopologyCapacity?: () => ProviderTopologyCapacity | undefined;
  private readonly orientationProbe?: (goal: string, workspacePath: string) => Promise<{ covered: boolean; candidateFiles: number } | undefined>;
  private readonly capacityConfidence?: () => CapacityConfidenceReport | undefined;
  private readonly subagentsR1Enabled: boolean;
  private readonly runs: Map<string, AutonomousRun> = new Map();
  private readonly abortControllers: Map<string, AbortController> = new Map();

  constructor(options: OrchestratorOptions) {
    this.workspaceService = options.workspaceService;
    this.persistence = options.persistence;
    this.agentRuntime = options.agentRuntime;
    this.getAgentRuntime = options.getAgentRuntime;
    this.providerTopologyCapacity = options.providerTopologyCapacity;
    this.orientationProbe = options.orientationProbe;
    this.capacityConfidence = options.capacityConfidence;
    this.subagentsR1Enabled = options.subagentsR1Enabled ?? false;
    this.subagentManager = options.subagentManager ?? createSubagentManager({
      persistence: options.persistence,
      workspaceService: options.workspaceService,
      agentRuntime: options.agentRuntime,
      getAgentRuntime: options.getAgentRuntime,
      r1Enabled: options.subagentsR1Enabled,
    });
    this.checkpointServiceFactory = options.checkpointServiceFactory ?? ((repoRoot: string) => createCheckpointService(repoRoot, options.persistence));
    this.integrationService = options.integrationService ?? createIntegrationService({ workspaceService: options.workspaceService, checkpointServiceFactory: this.checkpointServiceFactory });
  }

  private runtimeForSession(sessionId: string): AgentRuntime | undefined {
    return this.agentRuntime ?? this.getAgentRuntime?.(sessionId);
  }

  private async git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024, windowsHide: true, env: { ...getSanitizedEnvForChild(), GIT_TERMINAL_PROMPT: "0" } });
  }

  /**
   * Validate state transition according to explicit state machine rules.
   */
  private validateTransition(current: AutonomousRunStatus, next: AutonomousRunStatus): void {
    if (TERMINAL_STATUSES.has(current)) {
      const error = new Error(`RUN_INVALID_TRANSITION: Cannot transition from terminal state "${current}" to "${next}"`);
      (error as unknown as { code: string }).code = "RUN_INVALID_TRANSITION";
      throw error;
    }

    const allowedTransitions: Record<AutonomousRunStatus, AutonomousRunStatus[]> = {
      created: ["exploring", "cancelled", "failed"],
      exploring: ["planning", "cancelled", "failed", "blocked"],
      planning: ["executing", "cancelled", "failed", "blocked"],
      executing: ["reviewing", "cancelled", "failed", "blocked"],
      reviewing: ["verifying", "revising", "cancelled", "failed", "blocked"],
      revising: ["reviewing", "cancelled", "failed", "blocked"],
      verifying: ["integration_ready", "revising", "blocked", "cancelled", "failed"],
      integration_ready: ["integrating", "cancelled", "blocked", "failed"],
      integrating: ["completed", "blocked", "failed", "cancelled"],
      completed: [],
      blocked: [],
      cancelled: [],
      failed: [],
    };

    const valid = allowedTransitions[current]?.includes(next);
    if (!valid) {
      const error = new Error(`RUN_INVALID_TRANSITION: Illegal transition from "${current}" to "${next}"`);
      (error as unknown as { code: string }).code = "RUN_INVALID_TRANSITION";
      throw error;
    }
  }

  private transitionRun(run: AutonomousRun, next: AutonomousRunStatus, adapter?: WorkspaceEventAdapter): void {
    this.validateTransition(run.status, next);
    const prev = run.status;
    run.status = next;
    if (TERMINAL_STATUSES.has(next)) {
      run.completedAt = new Date().toISOString();
    }
    this.persistRun(run);
    adapter?.emitTaskStateChanged(run.id, prev, next);
    adapter?.emitStatusChanged(prev, next);
  }

  private persistRun(run: AutonomousRun): void {
    if (!this.persistence) return;
    try {
      this.persistence.upsertWorkItem({
        kind: "autonomous_run",
        id: run.id,
        sessionId: run.sessionId,
        workspaceId: run.workspaceId,
        goal: redactSecrets(run.goal),
        status: run.status,
        baseRevision: run.baseRevision,
        finalRevision: run.finalRevision,
        checkpointId: run.checkpointId,
        isolatedWorktreeId: run.isolatedWorktreeId,
        isolatedBranch: run.isolatedBranch,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        reviewRounds: run.reviewRounds,
        taskGraphJson: JSON.stringify(run.taskGraph),
        resultJson: run.result ? JSON.stringify(run.result) : undefined,
        error: run.error,
        createdAt: run.startedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as import("@codeforge/sessions").WorkItem).catch(() => {});
    } catch {}
  }

  /**
   * Topological DAG sort and cycle validation for task execution.
   */
  private validateTaskGraph(graph: TaskGraph): AgentTask[] {
    const taskMap = new Map<string, AgentTask>();
    for (const t of graph.tasks) {
      if (taskMap.has(t.id)) {
        const error = new Error(`TASK_DEPENDENCY_FAILED: Duplicate task ID "${t.id}"`);
        (error as unknown as { code: string }).code = "TASK_DEPENDENCY_FAILED";
        throw error;
      }
      taskMap.set(t.id, t);
    }

    // Verify dependencies exist
    for (const t of graph.tasks) {
      for (const depId of t.dependencies) {
        if (!taskMap.has(depId)) {
          const error = new Error(`TASK_DEPENDENCY_FAILED: Task "${t.id}" references missing dependency "${depId}"`);
          (error as unknown as { code: string }).code = "TASK_DEPENDENCY_FAILED";
          throw error;
        }
      }
    }

    // Cycle detection via Kahn's algorithm
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();
    for (const t of graph.tasks) {
      inDegree.set(t.id, 0);
      adj.set(t.id, []);
    }

    for (const t of graph.tasks) {
      for (const depId of t.dependencies) {
        adj.get(depId)!.push(t.id);
        inDegree.set(t.id, inDegree.get(t.id)! + 1);
      }
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(id);
    }

    const ordered: AgentTask[] = [];
    while (queue.length > 0) {
      const u = queue.shift()!;
      ordered.push(taskMap.get(u)!);
      for (const v of adj.get(u)!) {
        const newDeg = inDegree.get(v)! - 1;
        inDegree.set(v, newDeg);
        if (newDeg === 0) queue.push(v);
      }
    }

    if (ordered.length !== graph.tasks.length) {
      const error = new Error("TASK_DEPENDENCY_CYCLE: Dependency cycle detected in task execution graph");
      (error as unknown as { code: string }).code = "TASK_DEPENDENCY_CYCLE";
      throw error;
    }

    return ordered;
  }

  private authorizedPlannerResult(result: AgentResult, goal: string): PlannerResult | undefined {
    if (result.status !== "completed") return undefined;
    if (result.structuredData) {
      const validated = validateStructuredAgentResult("planner", result.structuredData);
      if (!validated.success) return undefined;
      const plan = validated.data as PlannerResult;
      return validatePlanningCompleteness(goal, plan).valid ? plan : undefined;
    }
    // Some provider adapters preserve a validated JSON payload only in the final summary. Recover
    // it through the same strict validator; prose or malformed output remains blocked.
    const recovered = validateStructuredAgentResult("planner", result.summary);
    if (!recovered.success) return undefined;
    const plan = recovered.data as PlannerResult;
    return validatePlanningCompleteness(goal, plan).valid ? plan : undefined;
  }

  private validateAuthorizedPlannerGraph(graph: TaskGraph): void {
    const roles = new Set(graph.tasks.map((task) => task.assignedRole));
    if (graph.tasks.length === 0 || !roles.has("coder") || !roles.has("reviewer")) {
      const error = new Error("TASK_AUTHORIZATION_FAILED: Planner graph must contain at least one coder and one reviewer");
      (error as unknown as { code: string }).code = "TASK_AUTHORIZATION_FAILED";
      throw error;
    }
  }

  /**
   * Execute an autonomous multi-agent engineering run.
   */
  async startRun(options: OrchestratorRunOptions): Promise<AutonomousRunResult> {
    const { sessionId, workspacePath, goal, verificationCommands = [], verificationTimeoutMs, adapter, signal, coderExecutor } = options;
    const r1ExplorerTimeoutMs = options.r1PhaseTimeoutMs?.explorer ?? R1_EXPLORER_TIMEOUT_MS;
    const r1PlannerTimeoutMs = options.r1PhaseTimeoutMs?.planner ?? R1_PLANNER_TIMEOUT_MS;

    const runId = `run-${crypto.randomUUID()}`;
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    this.abortControllers.set(runId, controller);

    // Register local workspace
    const targetWs = await this.workspaceService.registerLocalWorkspace(workspacePath);

    // Resolve base Git commit
    const { stdout: headShaOut } = await this.git(targetWs.rootPath, ["rev-parse", "HEAD"]).catch(() => ({ stdout: "0000000000000000000000000000000000000000" }));
    const baseRevision = headShaOut.trim();

    // R21 topology decision: the smallest useful team, decided deterministically before any agent
    // is spawned and recorded on the run. ForgeVerify is required by every plan.
    const repositoryFileCount = (await this.git(targetWs.rootPath, ["ls-files"]).catch(() => ({ stdout: "" }))).stdout.split(/\r?\n/).filter(Boolean).length;
    const complexity = classifyTaskComplexity({ goal, ...(options.complexityHint ? { hint: options.complexityHint } : {}), repositoryFileCount });
    const fixedR1ByEnv = !options.topology && process.env.CODEFORGE_TOPOLOGY_POLICY === "fixed_r1";
    // R24: ForgeGreen capacity advice only shapes the adaptive path — an explicit topology
    // request and the operator-pinned fixed_r1 baseline keep their authority over capacity.
    const adaptivePath = !options.topology && !fixedR1ByEnv;
    const providerCapacity = adaptivePath ? this.providerTopologyCapacity?.() : undefined;
    // R45 §17: coverage probing only runs on the adaptive path for normal-tier tasks — tiny
    // has no explorer to shed, complex keeps its full team regardless of packet coverage, and
    // explicit/pinned topologies keep their authority over this signal.
    const orientationCoverage = adaptivePath && complexity.tier === "normal" && this.orientationProbe
      ? await this.orientationProbe(goal, targetWs.rootPath).catch(() => undefined)
      : undefined;
    const topologyPlan = resolveAdaptiveTopology({
      goal,
      ...(options.hasImages ? { hasImages: true } : {}),
      ...(options.topology ? { requestedTopology: options.topology } : fixedR1ByEnv ? { requestedTopology: "fixed_r1" as const } : { complexityHint: complexity.tier }),
      ...(providerCapacity ? { providerCapacity } : {}),
      ...(orientationCoverage ? { orientationCoverage } : {}),
    });
    // R46 §13/§16: mission admission — refuse to launch a multi-stage plan into provably
    // insufficient free supply (zero admissible routes, every usable pool cooling/exhausted,
    // or every provider-stated window below the plan's measured call need incl. the verify
    // tail). Unmeasured capacity admits honestly: the fabric fails closed per turn.
    const missionAdmission = this.capacityConfidence
      ? (() => {
          const confidence = this.capacityConfidence!();
          return confidence ? evaluateMissionAdmission({ topology: topologyPlan.topology, confidence }) : undefined;
        })()
      : undefined;
    const topology: TopologyDecisionRecord = {
      policy: options.topology ? "explicit" : fixedR1ByEnv ? "fixed_r1_env" : "adaptive",
      complexity,
      plan: topologyPlan,
      ...(providerCapacity ? { providerCapacity } : {}),
      ...(orientationCoverage ? { orientationCoverage } : {}),
      ...(missionAdmission ? { missionAdmission } : {}),
      repositoryFileCount,
      decidedAt: new Date().toISOString(),
    };

    const counters: AutonomousRunCounters = {
      childrenSpawned: 0,
      reviewRounds: 0,
      taskAttempts: 0,
      verificationAttempts: 0,
    };

    const initialTaskGraph: TaskGraph = {
      tasks: [
        { id: "task-explore", title: "Explore repository", objective: "Identify architectural components and file boundaries", dependencies: [], assignedRole: "explorer", status: "pending" },
        { id: "task-code", title: "Implement changes", objective: goal, dependencies: ["task-explore"], assignedRole: "coder", status: "pending" },
        { id: "task-review", title: "Review implementation", objective: "Adversarial code review", dependencies: ["task-code"], assignedRole: "reviewer", status: "pending" },
      ],
    };

    const run: AutonomousRun = {
      id: runId,
      sessionId,
      workspaceId: targetWs.id,
      workspacePath: targetWs.rootPath,
      goal,
      status: "created",
      baseRevision,
      reviewRounds: 0,
      taskGraph: initialTaskGraph,
      topology,
      counters,
      startedAt: new Date().toISOString(),
    };

    // Ensure session exists in persistence for foreign key integrity
    if (this.persistence && sessionId) {
      try {
        if (!(await this.persistence.getSession(sessionId))) {
          await this.persistence.upsertSession({
            id: sessionId,
            title: redactSecrets(goal.slice(0, 80)),
            status: "running",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
      } catch {}
    }

    this.runs.set(runId, run);
    this.persistRun(run);
    adapter?.emitTaskCreated(runId, redactSecrets(goal.slice(0, 80)), "autonomous");

    if (missionAdmission && missionAdmission.verdict !== "ADMIT") {
      run.status = "blocked";
      run.error = missionAdmission.reason;
      this.persistRun(run);
      const result: AutonomousRunResult = {
        runId,
        status: "blocked",
        summary: `Mission admission ${missionAdmission.verdict}: ${missionAdmission.reason}`,
        workspaceId: targetWs.id,
        baseRevision,
        changedFiles: [],
        review: { passed: false, findings: [] },
        verification: [],
        integration: { status: "not_attempted", reason: missionAdmission.verdict },
        evidence: [],
        counters,
      };
      run.result = result;
      this.persistRun(run);
      return result;
    }

    let worktreeWs: ForgeWorkspace | undefined;
    let worktreeLease: WorkspaceLease | undefined;
    const allEvidence: AgentEvidenceRef[] = [];
    const allFindings: AgentFinding[] = [];
    const verificationResults: VerificationResult[] = [];
    let changedFiles: string[] = [];

    try {
      if (controller.signal.aborted) {
        throw new Error("Run cancelled before execution");
      }

      // ==========================================
      // PHASE 1: REPOSITORY EXPLORATION (Read-Only)
      // ==========================================
      this.transitionRun(run, "exploring", adapter);
      // The topology plan decides how many explorers run (0 for tiny, 1 for normal/vision, 2 for
      // complex/fixed_r1); the R1 flag only shapes their prompts and time budgets.
      const explorerTasks = topologyPlan.explorers === 0
        ? []
        : topologyPlan.explorers >= 2
          ? [
            `Explore repository structure and relevant files for goal: ${goal}`,
            `Inspect tests, runtime boundaries, and safety constraints relevant to goal: ${goal}`,
          ]
          : [`Explore repository for goal: ${goal}`];
      counters.childrenSpawned += explorerTasks.length;
      const explorerResults = await Promise.all(explorerTasks.map((task) => this.subagentManager.spawnChildAgent({
        parentRunId: runId,
        sessionId,
        agentId: "explorer",
        task,
        workspacePath: targetWs.rootPath,
        adapter,
        signal: controller.signal,
        structuredOutput: "explorer",
        ...(this.subagentsR1Enabled ? { timeoutMs: r1ExplorerTimeoutMs, watchdogMaxExtensions: 0 } : {}),
      })));

      for (const result of explorerResults) {
        if (result.findings) allFindings.push(...result.findings);
        if (result.evidence) allEvidence.push(...result.evidence);
      }
      // R45: explorer evidence is a run-scoped handoff — the coder consumes it directly so a
      // downstream role never re-navigates what upstream already located. Previously scoped
      // to the planner branch only, which left normal topologies (no planner) without it.
      const explorerEvidence = explorerResults.flatMap((result) => result.evidence ?? []);
      const explorerFindings = explorerResults.flatMap((result) => result.findings ?? []);

      // ==========================================
      // PHASE 2: TASK & EXECUTION PLANNING
      // ==========================================
      this.transitionRun(run, "planning", adapter);
      const runAgentRuntime = this.subagentsR1Enabled ? this.runtimeForSession(sessionId) : this.agentRuntime;
      // Without a planner in the topology the coder works from the goal-derived task graph.
      if (runAgentRuntime && topologyPlan.hasPlanner) {
        counters.childrenSpawned++;
        const incompleteExplorerRoles = explorerResults
          .map((result, index) => result.status === "completed" ? undefined : `Explorer ${index + 1} ${result.status}`)
          .filter((status): status is string => status !== undefined);
        const explorationContext = incompleteExplorerRoles.length > 0
          ? `R1 exploration was bounded and incomplete: ${incompleteExplorerRoles.join(", ")}. Treat missing evidence as unknown and continue with only the evidence supplied below.`
          : "R1 exploration completed; use only the evidence supplied below.";
        const plannerResult = await this.subagentManager.spawnChildAgent({
          parentRunId: runId,
          sessionId,
          agentId: "planner",
          task: `Produce the minimal task graph for goal: ${goal}`,
          workspacePath: targetWs.rootPath,
          explorerEvidence,
          findings: explorerFindings,
          contextSummary: explorationContext,
          adapter,
          signal: controller.signal,
          structuredOutput: "planner",
          ...(this.subagentsR1Enabled ? { timeoutMs: r1PlannerTimeoutMs, watchdogMaxExtensions: 0 } : {}),
        });
        const plan = this.authorizedPlannerResult(plannerResult, goal);
        if (!plan) {
          const error = "AGENT_INVALID_STRUCTURED_OUTPUT";
          this.transitionRun(run, "blocked", adapter);
          run.error = error;
          const result: AutonomousRunResult = {
            runId,
            status: "blocked",
            summary: `Planner did not produce an authorized task graph: ${plannerResult.summary}`,
            workspaceId: targetWs.id,
            baseRevision,
            changedFiles,
            review: { passed: false, findings: plannerResult.findings },
            verification: verificationResults,
            integration: { status: "not_attempted", reason: error },
            evidence: allEvidence,
            counters,
          };
          run.result = result;
          this.persistRun(run);
          return result;
        }
        run.taskGraph = { tasks: plan.tasks.map((task) => ({ ...task, status: "pending" })) };
        this.validateAuthorizedPlannerGraph(run.taskGraph);
        this.persistRun(run);
      }
      this.validateTaskGraph(run.taskGraph);

      // ==========================================
      // PHASE 3: ISOLATED WORKTREE & CODER EXECUTION
      // ==========================================
      this.transitionRun(run, "executing", adapter);

      // Create base checkpoint
      const chkSvc = this.checkpointServiceFactory(targetWs.rootPath);
      const checkpointId = `chk-${runId.slice(0, 8)}`;
      const chk = await chkSvc.createCheckpoint({
        checkpointId,
        label: `Base snapshot for ${runId}`,
        sessionId,
      });
      run.checkpointId = checkpointId;
      adapter?.emitCheckpointCreated(checkpointId, `Base snapshot ${checkpointId}`, chk.fileCount);

      // Create isolated worktree outside parent repo
      worktreeWs = await this.workspaceService.createWorktree({
        parentWorkspaceId: targetWs.id,
        base: "checkpoint",
        checkpointId,
        runId,
      });
      run.isolatedWorktreeId = worktreeWs.id;
      run.isolatedBranch = worktreeWs.branch;

      // Acquire exclusive write lease on worktree
      worktreeLease = this.workspaceService.acquireLease(worktreeWs.rootPath, runId, "write");

      // Execute Coder in isolated worktree
      counters.taskAttempts++;
      let reviewFeedback: string | undefined;
      const taskPlan = JSON.stringify(run.taskGraph.tasks.map(({ id, title, objective, dependencies, assignedRole }) => ({ id, title, objective, dependencies, assignedRole })));

      // ==========================================
      // PHASE 4: REVIEW & BOUNDED REVISION LOOP
      // ==========================================
      let reviewPassed = false;
      let reviewFindings: AgentFinding[] = [];
      let lastDeterministicReview: Awaited<ReturnType<typeof reviewDiff>> | undefined;
      // R48: the implementing run's quota-pool identity — the reviewer spawn prefers a
      // different physical pool so the review is capacity-independent, not the same
      // account judging its own output. Undefined when the implementer's pool was never
      // measured (pinned route, non-fabric selection); the hint is simply absent then.
      let implementerPoolId: string | undefined;

      while (!reviewPassed) {
        if (controller.signal.aborted) throw new Error("Run cancelled during execution/revision");

        // Coder implementation / revision
        if (coderExecutor) {
          const codeExecResult = await coderExecutor(worktreeWs.rootPath, goal, reviewFeedback);
          changedFiles = codeExecResult.filesChanged;
        } else if (this.subagentsR1Enabled) {
          const codeResult = await this.subagentManager.spawnChildAgent({
            parentRunId: runId,
            sessionId,
            agentId: "coder",
            task: goal,
            workspacePath: worktreeWs.rootPath,
            parentPermissions: { read: true, search: true, write: true, executeCommand: true, network: false },
            adapter,
            signal: controller.signal,
            taskPlan,
            // R45: hand the writer the explorer's file/symbol evidence so it does not
            // rediscover the repository the upstream role already mapped.
            explorerEvidence,
            findings: explorerFindings,
            reviewFeedback,
            workspaceKind: "git-worktree",
            workspaceBranch: worktreeWs.branch,
          });
          if (codeResult.status !== "completed") {
            if (codeResult.status === "cancelled") throw new Error(codeResult.summary);
            const reason = "SUBAGENT_WRITER_BLOCKED";
            this.transitionRun(run, "blocked", adapter);
            run.error = reason;
            const blockedResult: AutonomousRunResult = {
              runId,
              status: "blocked",
              summary: `Writer did not complete: ${codeResult.summary}`,
              workspaceId: targetWs.id,
              baseRevision,
              changedFiles,
              review: { passed: false, findings: codeResult.findings },
              verification: verificationResults,
              integration: { status: "blocked", branch: worktreeWs.branch, worktreeId: worktreeWs.id, reason },
              evidence: allEvidence,
              counters,
            };
            run.result = blockedResult;
            this.persistRun(run);
            return blockedResult;
          }
          changedFiles = codeResult.files;
          implementerPoolId = codeResult.routePoolId ?? implementerPoolId;
        } else if (this.agentRuntime) {
          const coderRunResult = await this.agentRuntime.executeAgentRun({
            runId,
            agentId: "coder",
            role: "coder",
            goal,
            workspaceId: worktreeWs.id,
            workspacePath: worktreeWs.rootPath,
            permissions: { read: true, search: true, write: true, executeCommand: true, network: false },
            signal: controller.signal,
            adapter,
            reviewFeedback,
            taskPlan,
            // R45: same handoff the R1 spawn path carries — without it the plain-runtime coder
            // rediscovered everything upstream already mapped (the R44 normal-topology gap).
            explorerEvidence,
            findings: explorerFindings,
          });
          implementerPoolId = coderRunResult.routePoolId ?? implementerPoolId;
          changedFiles = coderRunResult.filesChanged.length > 0
            ? coderRunResult.filesChanged
            : (await fs.readdir(worktreeWs.rootPath)).filter((f) => !f.startsWith("."));
        } else {
          // Standard implementation logic in worktree
          const files = await fs.readdir(worktreeWs.rootPath);
          changedFiles = files.filter((f) => !f.startsWith("."));
        }

        // Transition to Reviewing
        this.transitionRun(run, "reviewing", adapter);

        // R21: the deterministic diff review (sensitive files, verification-config edits) runs on
        // every topology, model-free, before any independent reviewer. Its blocking findings enter
        // the same bounded revision loop as reviewer findings.
        lastDeterministicReview = await reviewDiff(worktreeWs.rootPath, { base: baseRevision, signal: controller.signal }).catch(() => undefined);
        const deterministicFindings: AgentFinding[] = (lastDeterministicReview?.findings ?? []).map((finding, index) => ({
          id: `det-${finding.code}-${index}`,
          severity: finding.severity,
          category: finding.code,
          message: finding.message,
          evidence: finding.path,
        }));

        if (!topologyPlan.hasReviewer) {
          reviewFindings = deterministicFindings;
          allFindings.push(...reviewFindings);
        } else {
        counters.childrenSpawned++;

        // Inspect diff in worktree. The reviewer gets the full file inventory (--stat)
        // plus a generously bounded body — a bare 2KB slice silently dropped most of any
        // multi-file diff, so the reviewer could pass files it never saw (R43 multi-file
        // root cause). The context assembler's own token budget bounds the final size;
        // 24KB covers realistic coordinated changes, and the marker tells the reviewer
        // it can re-run the diff in the worktree for the remainder.
        const { stdout: diffStat } = await this.git(worktreeWs.rootPath, ["diff", "--stat", baseRevision]).catch(() => ({ stdout: "" }));
        const { stdout: diffOut } = await this.git(worktreeWs.rootPath, ["diff", baseRevision]).catch(() => ({ stdout: "" }));

        // Spawn independent Reviewer child agent with private context
        const reviewResult = await this.subagentManager.spawnChildAgent({
          parentRunId: runId,
          sessionId,
          agentId: "reviewer",
          task: `Review implementation for goal: ${goal}`,
          workspacePath: worktreeWs.rootPath,
          contextSummary: diffOut
            ? buildReviewerDiffContext(diffStat, diffOut, baseRevision)
            : `Changes verified for task: ${goal}`,
          findings: reviewFindings,
          adapter,
          signal: controller.signal,
          structuredOutput: "reviewer",
          workspaceKind: "git-worktree",
          workspaceBranch: worktreeWs.branch,
          // R48: the review must not silently reuse the implementer's quota pool — prefer
          // an independent route; a same-pool admission records SAME_POOL_FALLBACK.
          ...(implementerPoolId ? { preferIndependentFromPoolId: implementerPoolId } : {}),
        });

        reviewFindings = [...deterministicFindings, ...(reviewResult.findings || [])];
        allFindings.push(...reviewFindings);
        if (reviewResult.evidence) allEvidence.push(...reviewResult.evidence);

        // A reviewer that never delivered a verdict (failed or cancelled — e.g. its wall-clock
        // budget expired) never passes the review: the absence of findings from a reviewer that
        // died is not approval. Fail closed into a blocked run, same as persistent blocking
        // findings below.
        // R21: a reviewer that ran out of turns (blocked without a structured verdict) delivered no
        // review either; the absence of findings from an exhausted reviewer is not approval.
        // A verdict is either a structured reviewer result or at least one finding; an exhausted
        // reviewer produces neither (the runtime attaches reviewer findings only from a validated
        // structured result).
        const reviewerDeliveredVerdict = Boolean((reviewResult.structuredData as { verdict?: string } | undefined)?.verdict) || (reviewResult.findings?.length ?? 0) > 0;
        if (reviewResult.status === "cancelled" || reviewResult.status === "failed" || (reviewResult.status === "blocked" && !reviewerDeliveredVerdict)) {
          const reason = reviewResult.status === "cancelled" ? "REVIEWER_CANCELLED" : reviewResult.status === "blocked" ? "REVIEWER_BUDGET_EXHAUSTED" : "REVIEWER_FAILED";
          const summary = `Independent review did not complete (${reason}): ${reviewResult.summary}`;
          this.transitionRun(run, "blocked", adapter);
          run.error = reason;
          const blockedResult: AutonomousRunResult = {
            runId,
            status: "blocked",
            summary,
            workspaceId: targetWs.id,
            baseRevision,
            changedFiles,
            review: { passed: false, findings: reviewFindings },
            verification: verificationResults,
            integration: { status: "blocked", branch: worktreeWs.branch, worktreeId: worktreeWs.id, reason },
            evidence: allEvidence,
            counters,
          };
          run.result = blockedResult;
          this.persistRun(run);
          return blockedResult;
        }
        }

        const hasBlocking = reviewFindings.some((f) => f.severity === "blocking");

        if (!hasBlocking) {
          reviewPassed = true;
          break;
        }

        // Blocking findings require bounded revision
        run.reviewRounds++;
        counters.reviewRounds++;

        if (run.reviewRounds > MAX_REVIEW_REVISION_ROUNDS) {
          // Exhausted revision budget -> fail closed into blocked state
          const summary = `Reviewer identified persistent blocking issues after ${MAX_REVIEW_REVISION_ROUNDS} revision rounds: ${reviewFindings.map((f) => f.message).join("; ")}`;
          this.transitionRun(run, "blocked", adapter);
          run.error = "REVIEW_REVISION_LIMIT";

          const blockedResult: AutonomousRunResult = {
            runId,
            status: "blocked",
            summary,
            workspaceId: targetWs.id,
            baseRevision,
            changedFiles,
            review: { passed: false, findings: reviewFindings },
            verification: verificationResults,
            integration: { status: "blocked", branch: worktreeWs.branch, worktreeId: worktreeWs.id, reason: "REVIEW_REVISION_LIMIT" },
            evidence: allEvidence,
            counters,
          };
          run.result = blockedResult;
          this.persistRun(run);
          return blockedResult;
        }

        // Transition to Revising and loop
        this.transitionRun(run, "revising", adapter);
        reviewFeedback = JSON.stringify({
          verdict: "revision_required",
          findings: reviewFindings.map(({ id, severity, category, message, evidence, path, line }) => ({ id, severity, category, message, evidence, path, line })),
        });
      }

      // ==========================================
      // PHASE 5: DETERMINISTIC VERIFICATION GATE
      // ==========================================
      this.transitionRun(run, "verifying", adapter);
      counters.verificationAttempts++;

      const verificationCwd = worktreeWs.rootPath;
      const verificationReport = verificationCommands.length
        ? await runVerification(verificationCwd, verificationCommands, { signal: controller.signal, runId, ...(verificationTimeoutMs ? { timeoutMs: verificationTimeoutMs } : {}), ...(this.persistence ? { observer: createForgeVerifyPersistenceObserver(this.persistence, run.sessionId) } : {}) })
        : undefined;
      const verificationPassed = verificationReport ? forgeVerificationPassed(verificationReport) : true;
      if (verificationReport) verificationResults.push(...verificationReport.verifiers.map((verifier) => ({
        passed: verifier.passed,
        failed: verifier.failed,
        skipped: verifier.skipped,
        command: verifier.command,
        cwd: verificationCwd,
        exitCode: verifier.exitCode,
        output: verifier.output,
        failures: verifier.failures,
        durationMs: verifier.durationMs,
        ...(verifier.timedOut ? { timedOut: true } : {}),
        ...(verifier.cancelled ? { cancelled: true } : {}),
      })));
      if (!verificationPassed) {
        const summary = `Deterministic verification failed in worktree: ${verificationResults.filter((v) => v.failed > 0).map((v) => v.output).join("; ")}`;
        this.transitionRun(run, "blocked", adapter);
        run.error = "VERIFICATION_FAILED";

        const blockedResult: AutonomousRunResult = {
          runId,
          status: "blocked",
          summary,
          workspaceId: targetWs.id,
          baseRevision,
          changedFiles,
          review: { passed: true, findings: reviewFindings },
          verification: verificationResults,
          integration: { status: "blocked", branch: worktreeWs.branch, worktreeId: worktreeWs.id, reason: "VERIFICATION_FAILED" },
          evidence: allEvidence,
          counters,
        };
        run.result = blockedResult;
        this.persistRun(run);
        return blockedResult;
      }

      // Completion is an enforced lifecycle transition, not an inference from a clean reviewer or
      // a zero exit code. Build the gate input from authoritative worktree state and ForgeVerify's
      // report; model-reported file lists are never accepted as proof of an effective change.
      const [{ stdout: completionDiff }, { stdout: changedPathsOut }] = await Promise.all([
        this.git(worktreeWs.rootPath, ["diff", baseRevision]).catch(() => ({ stdout: "" })),
        this.git(worktreeWs.rootPath, ["diff", "--name-only", baseRevision]).catch(() => ({ stdout: "" })),
      ]);
      const completionChangedFiles = changedPathsOut.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
      const now = new Date().toISOString();
      const completionPlan: WorkflowPlan = {
        id: `completion-${runId}`,
        title: goal,
        taskId: runId,
        status: "completed",
        createdAt: run.startedAt ?? now,
        updatedAt: now,
        steps: [
          { id: `${runId}-explore`, description: "Repository exploration", status: "completed", kind: "inspect", risk: "safe", requiresApproval: false },
          { id: `${runId}-implement`, description: "Isolated implementation", status: "completed", kind: "edit", risk: "moderate", requiresApproval: false, targetPath: completionChangedFiles[0] ?? changedFiles[0] ?? "workspace" },
          { id: `${runId}-review`, description: "Independent review", status: "completed", kind: "review", risk: "safe", requiresApproval: false },
          { id: `${runId}-verify`, description: "ForgeVerify", status: verificationReport ? "completed" : "blocked", kind: "verify", risk: "safe", requiresApproval: false },
        ],
      };
      const completionVerification: VerificationResult = verificationReport ?? {
        passed: 0,
        failed: 0,
        skipped: 0,
        durationMs: 0,
        output: "No verification command was configured.",
        exitCode: 0,
        command: "",
        failures: [],
        notConfigured: true,
      };
      const completionAnalysis: FailureAnalysis = {
        hasFailures: completionVerification.failed > 0,
        summary: completionVerification.output,
        diagnostics: completionVerification.failures.map((failure) => failure.message),
        suggestedRepairs: [],
        isRepairable: false,
      };
      const completionReview: ReviewDecision = {
        approved: reviewPassed,
        issues: reviewFindings.map((finding) => finding.message),
        findings: (lastDeterministicReview?.findings ?? []) as ReviewFinding[],
        diffs: completionChangedFiles.map((filePath) => ({
          path: filePath,
          changeType: "modified" as const,
          additions: 0,
          deletions: 0,
          diff: completionDiff,
          beforeHash: baseRevision,
          afterHash: "worktree",
        })),
        summary: completionChangedFiles.length > 0 ? `${completionChangedFiles.length} file(s) changed` : "No effective change",
      };
      const completion = evaluateCompletion({
        plan: completionPlan,
        verification: completionVerification,
        analysis: completionAnalysis,
        review: completionReview,
        // R21: rebind ForgeVerify evidence to the worktree state observed at decision time.
        currentVerificationInputStateHash: createVerificationInputStateHash(verificationCwd),
      });
      await adapter?.emitWorkflowCompletionDecided(runId, completion.outcome, completion.rationale, completion.blockers);
      if (completion.outcome !== "completed") {
        this.transitionRun(run, "blocked", adapter);
        run.error = `COMPLETION_GATE_${completion.outcome.toUpperCase()}`;
        const blockedResult: AutonomousRunResult = {
          runId,
          status: "blocked",
          summary: `Completion gate refused success: ${completion.rationale}`,
          workspaceId: targetWs.id,
          baseRevision,
          changedFiles: completionChangedFiles,
          review: { passed: reviewPassed, findings: reviewFindings },
          verification: verificationResults,
          completion,
          integration: { status: "retained", branch: worktreeWs.branch, worktreeId: worktreeWs.id, reason: run.error },
          evidence: allEvidence,
          counters,
        };
        run.result = blockedResult;
        this.persistRun(run);
        return blockedResult;
      }
      changedFiles = completionChangedFiles;

      // ==========================================
      // PHASE 6: SAFE INTEGRATION
      // ==========================================
      this.transitionRun(run, "integration_ready", adapter);
      this.transitionRun(run, "integrating", adapter);

      const intResult: IntegrateResult = await this.integrationService.integrate({
        targetWorkspaceId: targetWs.id,
        isolatedWorktreeId: worktreeWs.id,
        expectedBaseSha: baseRevision,
        runId,
        commitMessage: `Autonomous implementation: ${goal}`,
        reviewFindings,
        verificationResults,
      });

      if (intResult.status === "blocked" || intResult.status === "failed") {
        this.transitionRun(run, "blocked", adapter);
        run.error = intResult.code || "INTEGRATION_FAILED";

        const blockedResult: AutonomousRunResult = {
          runId,
          status: "blocked",
          summary: `Integration blocked: ${intResult.reason || "Safe integration invariants not met"}`,
          workspaceId: targetWs.id,
          baseRevision,
          changedFiles,
          review: { passed: true, findings: reviewFindings },
          verification: verificationResults,
          integration: { status: "blocked", branch: worktreeWs.branch, worktreeId: worktreeWs.id, reason: intResult.code },
          evidence: allEvidence,
          counters,
        };
        run.result = blockedResult;
        this.persistRun(run);
        return blockedResult;
      }

      // Success!
      run.finalRevision = intResult.finalRevision;
      this.transitionRun(run, "completed", adapter);

      const completedResult: AutonomousRunResult = {
        runId,
        status: "completed",
        summary: `Successfully implemented, reviewed, verified, and integrated "${redactSecrets(goal)}"`,
        workspaceId: targetWs.id,
        baseRevision,
        finalRevision: intResult.finalRevision,
        changedFiles: intResult.changedFiles.length > 0 ? intResult.changedFiles : changedFiles,
        review: { passed: true, findings: reviewFindings },
        verification: verificationResults,
        completion,
        integration: { status: "integrated", branch: worktreeWs.branch, worktreeId: worktreeWs.id },
        evidence: allEvidence,
        counters,
        topology,
      };
      run.result = completedResult;
      this.persistRun(run);
      adapter?.emitTaskCompleted(runId, completedResult.summary);
      return completedResult;
    } catch (err: unknown) {
      const isCancelled = controller.signal.aborted || (signal && signal.aborted);
      const status: AutonomousRunStatus = isCancelled ? "cancelled" : "failed";
      const errorMsg = err instanceof Error ? err.message : String(err);

      run.status = status;
      run.completedAt = new Date().toISOString();
      run.error = errorMsg;

      const terminalResult: AutonomousRunResult = {
        runId,
        status,
        summary: `Autonomous run ${status}: ${errorMsg}`,
        workspaceId: targetWs.id,
        baseRevision,
        changedFiles,
        review: { passed: false, findings: allFindings },
        verification: verificationResults,
        integration: { status: "not_attempted", branch: worktreeWs?.branch, worktreeId: worktreeWs?.id, reason: errorMsg },
        evidence: allEvidence,
        counters,
      };
      run.result = terminalResult;
      this.persistRun(run);

      if (isCancelled) {
        adapter?.emitTaskCancelled(runId, "Autonomous run cancelled");
      } else {
        adapter?.emitTurnFailed(runId, errorMsg);
      }

      return terminalResult;
    } finally {
      // Release worktree lease
      if (worktreeLease) {
        try {
          this.workspaceService.releaseLease(worktreeLease.leaseId, runId);
        } catch {}
      }
      this.abortControllers.delete(runId);
    }
  }

  /**
   * Cancel an active autonomous run.
   */
  cancelRun(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || TERMINAL_STATUSES.has(run.status)) return false;

    const controller = this.abortControllers.get(runId);
    if (controller) controller.abort();

    this.subagentManager.cancelParent(runId);
    run.status = "cancelled";
    run.completedAt = new Date().toISOString();
    this.persistRun(run);
    return true;
  }

  getRun(runId: string): AutonomousRun | undefined {
    return this.runs.get(runId);
  }

  getAllRuns(): AutonomousRun[] {
    return Array.from(this.runs.values());
  }

  /**
   * Restart Recovery: Rehydrate runs from persistence and validate Git & workspace refs.
   */
  async recoverRuns(): Promise<{ recovered: number; requiresRevalidation: number; blocked: number }> {
    if (!this.persistence) return { recovered: 0, requiresRevalidation: 0, blocked: 0 };

    let recovered = 0;
    let requiresRevalidation = 0;
    let blocked = 0;

    try {
      const items = await this.persistence.getWorkItemsByKind("autonomous_run");
      for (const item of items) {
        if (item.kind === "autonomous_run" && item.id) {
          const raw = item as unknown as {
            id: string;
            sessionId?: string;
            workspaceId: string;
            goal: string;
            status: AutonomousRunStatus;
            baseRevision: string;
            finalRevision?: string;
            checkpointId?: string;
            isolatedWorktreeId?: string;
            isolatedBranch?: string;
            startedAt?: string;
            completedAt?: string;
            reviewRounds?: number;
            taskGraphJson?: string;
            resultJson?: string;
            error?: string;
          };

          let taskGraph: TaskGraph = { tasks: [] };
          if (raw.taskGraphJson) {
            try { taskGraph = JSON.parse(raw.taskGraphJson); } catch {}
          }

          let result: AutonomousRunResult | undefined;
          if (raw.resultJson) {
            try { result = JSON.parse(raw.resultJson); } catch {}
          }

          let effectiveStatus = raw.status;

          // If the run was left in an active state across a crash/restart:
          // Mark it as requires_revalidation / blocked (do NOT blindly resume partial commands)
          if (!TERMINAL_STATUSES.has(raw.status)) {
            effectiveStatus = "blocked";
            requiresRevalidation++;
          }

          const run: AutonomousRun = {
            id: raw.id,
            sessionId: raw.sessionId || "global",
            workspaceId: raw.workspaceId,
            workspacePath: "",
            goal: raw.goal,
            status: effectiveStatus,
            baseRevision: raw.baseRevision,
            finalRevision: raw.finalRevision,
            checkpointId: raw.checkpointId,
            isolatedWorktreeId: raw.isolatedWorktreeId,
            isolatedBranch: raw.isolatedBranch,
            reviewRounds: raw.reviewRounds || 0,
            taskGraph,
            counters: { childrenSpawned: 0, reviewRounds: raw.reviewRounds || 0, taskAttempts: 1, verificationAttempts: 0 },
            startedAt: raw.startedAt,
            completedAt: raw.completedAt || new Date().toISOString(),
            result,
            error: raw.error || (effectiveStatus === "blocked" ? "Server restarted during active execution" : undefined),
          };

          this.runs.set(run.id, run);
          recovered++;
          if (effectiveStatus === "blocked") blocked++;
        }
      }
      // R2: recover crash-interrupted workers through the durable execution journal. Workers
      // with a resume-safe journal are genuinely resumed (RESUME); the rest converge honestly to
      // failed with RECOVERY_REPLAN / RECOVERY_FAIL reasons (REPLAN / FAIL). Workers without any
      // journal (pre-R2 records) converge exactly as the R1 replan-only pass did.
      await this.subagentManager
        .recoverInterruptedWorkers()
        .catch(() => undefined);
    } catch {}

    return { recovered, requiresRevalidation, blocked };
  }
}

export function createAutonomousRunOrchestrator(options: OrchestratorOptions): AutonomousRunOrchestrator {
  return new AutonomousRunOrchestrator(options);
}
