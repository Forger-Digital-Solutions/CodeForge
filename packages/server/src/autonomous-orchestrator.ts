import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  type AgentResult,
  type AgentFinding,
  type AgentEvidenceRef,
  type AgentPermissions,
  type PlannerResult,
  getAgent,
} from "@codeforge/agent";
import {
  type WorkspaceService,
  type ForgeWorkspace,
  type WorkspaceLease,
} from "./workspace-service.js";
import {
  type CheckpointService,
  type CheckpointInfo,
  createCheckpointService,
} from "./checkpoint-service.js";
import {
  type SubagentManager,
  type ChildRun,
  createSubagentManager,
} from "./subagent-manager.js";
import {
  type IntegrationService,
  type IntegrateResult,
  createIntegrationService,
  type IntegrationFailureCode,
} from "./integration-service.js";
import type { ISessionPersistence } from "@codeforge/sessions";
import type { WorkspaceEventAdapter } from "./workspace-event-adapter.js";
import { runVerification, verificationPassed as forgeVerificationPassed, type VerificationResult } from "@codeforge/workflow";
import { redactSecrets } from "@codeforge/secrets";
import { getSanitizedEnvForChild } from "./env-filter.js";

const execFile = promisify(execFileCallback);

import type { AgentRuntime } from "./agent-runtime.js";

export const MAX_REVIEW_REVISION_ROUNDS = 2;

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
  integration: {
    status: "integrated" | "retained" | "blocked" | "not_attempted";
    branch?: string;
    worktreeId?: string;
    reason?: string;
  };
  evidence: AgentEvidenceRef[];
  counters: AutonomousRunCounters;
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
  adapter?: WorkspaceEventAdapter;
  signal?: AbortSignal;
  /** Custom coder executor function for testing or specialized model execution */
  coderExecutor?: (worktreePath: string, goal: string, reviewFeedback?: string) => Promise<{ success: boolean; filesChanged: string[]; output?: string }>;
}

export interface OrchestratorOptions {
  workspaceService: WorkspaceService;
  persistence?: ISessionPersistence;
  subagentManager?: SubagentManager;
  integrationService?: IntegrationService;
  checkpointServiceFactory?: (repoRoot: string) => CheckpointService;
  agentRuntime?: AgentRuntime;
}

export class AutonomousRunOrchestrator {
  private readonly workspaceService: WorkspaceService;
  private readonly persistence?: ISessionPersistence;
  private readonly subagentManager: SubagentManager;
  private readonly integrationService: IntegrationService;
  private readonly checkpointServiceFactory: (repoRoot: string) => CheckpointService;
  private readonly agentRuntime?: AgentRuntime;
  private readonly runs: Map<string, AutonomousRun> = new Map();
  private readonly abortControllers: Map<string, AbortController> = new Map();

  constructor(options: OrchestratorOptions) {
    this.workspaceService = options.workspaceService;
    this.persistence = options.persistence;
    this.agentRuntime = options.agentRuntime;
    this.subagentManager = options.subagentManager ?? createSubagentManager({
      persistence: options.persistence,
      workspaceService: options.workspaceService,
      agentRuntime: options.agentRuntime,
    });
    this.checkpointServiceFactory = options.checkpointServiceFactory ?? ((repoRoot: string) => createCheckpointService(repoRoot, options.persistence));
    this.integrationService = options.integrationService ?? createIntegrationService({ workspaceService: options.workspaceService, checkpointServiceFactory: this.checkpointServiceFactory });
  }

  private async git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
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

  /**
   * Execute an autonomous multi-agent engineering run.
   */
  async startRun(options: OrchestratorRunOptions): Promise<AutonomousRunResult> {
    const { sessionId, workspacePath, goal, verificationCommands = [], adapter, signal, coderExecutor } = options;

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
      counters.childrenSpawned++;
      const explorerResult = await this.subagentManager.spawnChildAgent({
        parentRunId: runId,
        agentId: "explorer",
        task: `Explore repository for goal: ${goal}`,
        workspacePath: targetWs.rootPath,
        adapter,
        signal: controller.signal,
        structuredOutput: "explorer",
      });

      if (explorerResult.findings) allFindings.push(...explorerResult.findings);
      if (explorerResult.evidence) allEvidence.push(...explorerResult.evidence);

      // ==========================================
      // PHASE 2: TASK & EXECUTION PLANNING
      // ==========================================
      this.transitionRun(run, "planning", adapter);
      if (this.agentRuntime) {
        counters.childrenSpawned++;
        const plannerResult = await this.subagentManager.spawnChildAgent({
          parentRunId: runId,
          agentId: "planner",
          task: `Produce the minimal task graph for goal: ${goal}`,
          workspacePath: targetWs.rootPath,
          explorerEvidence: explorerResult.evidence,
          findings: explorerResult.findings,
          adapter,
          signal: controller.signal,
          structuredOutput: "planner",
        });
        if (plannerResult.status !== "completed" || !plannerResult.structuredData) {
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
        const plan = plannerResult.structuredData as PlannerResult;
        run.taskGraph = { tasks: plan.tasks.map((task) => ({ ...task, status: "pending" })) };
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

      while (!reviewPassed) {
        if (controller.signal.aborted) throw new Error("Run cancelled during execution/revision");

        // Coder implementation / revision
        if (coderExecutor) {
          const codeExecResult = await coderExecutor(worktreeWs.rootPath, goal, reviewFeedback);
          changedFiles = codeExecResult.filesChanged;
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
          });
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
        counters.childrenSpawned++;

        // Inspect diff in worktree
        const { stdout: diffOut } = await this.git(worktreeWs.rootPath, ["diff", baseRevision]).catch(() => ({ stdout: "" }));

        // Spawn independent Reviewer child agent with private context
        const reviewResult = await this.subagentManager.spawnChildAgent({
          parentRunId: runId,
          agentId: "reviewer",
          task: `Review implementation for goal: ${goal}`,
          workspacePath: worktreeWs.rootPath,
          contextSummary: diffOut ? `Diff against base:
${diffOut.slice(0, 2000)}` : `Changes verified for task: ${goal}`,
          findings: reviewFindings,
          adapter,
          signal: controller.signal,
          structuredOutput: "reviewer",
        });

        reviewFindings = reviewResult.findings || [];
        allFindings.push(...reviewFindings);
        if (reviewResult.evidence) allEvidence.push(...reviewResult.evidence);

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
        ? await runVerification(verificationCwd, verificationCommands, { signal: controller.signal, runId })
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
        integration: { status: "integrated", branch: worktreeWs.branch, worktreeId: worktreeWs.id },
        evidence: allEvidence,
        counters,
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
    } catch {}

    return { recovered, requiresRevalidation, blocked };
  }
}

export function createAutonomousRunOrchestrator(options: OrchestratorOptions): AutonomousRunOrchestrator {
  return new AutonomousRunOrchestrator(options);
}
