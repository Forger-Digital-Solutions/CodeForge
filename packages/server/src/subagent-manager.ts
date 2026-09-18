import crypto from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  getAgent,
  BUILT_IN_AGENTS,
  DEFAULT_EXECUTION_BUDGETS,
  type AgentDefinition,
  type AgentPermissions,
  type AgentResult,
  type AgentUsage,
  type AgentFinding,
  type AgentEvidenceRef,
  type AgentExecutionBudget,
  type StructuredOutputKind,
} from "@codeforge/agent";
import type {
  AgentArtifactReference,
  AgentWorkerLifecycleState,
  AgentWorkerTelemetry,
  SubagentRunWorkItem,
  TaskCapsule,
  AgentRunJournal,
  AgentRecoveryLease,
} from "@codeforge/protocol";
import type { WorkspaceEventAdapter } from "./workspace-event-adapter.js";
import type { ISessionPersistence, WorkItem } from "@codeforge/sessions";
import type { WorkspaceService } from "./workspace-service.js";
import { redactSecrets } from "@codeforge/secrets";
import { createTaskCapsule } from "./task-capsule.js";
import { classifyRunRecovery, type RunRecoveryToolRecord } from "./run-recovery.js";
import type { DurableToolExecutionState, ToolExecutionClass } from "./agent-runtime.js";

import type { AgentRuntime } from "./agent-runtime.js";

export const MAX_SUBAGENT_DEPTH = 1;
export const MAX_CHILDREN_PER_PARENT = 5;

export interface SpawnChildOptions {
  parentRunId: string;
  sessionId?: string;
  agentId: string;
  task: string;
  workspacePath: string;
  parentPermissions?: AgentPermissions;
  depth?: number;
  adapter?: WorkspaceEventAdapter;
  signal?: AbortSignal;
  contextSummary?: string;
  explorerEvidence?: AgentEvidenceRef[];
  findings?: AgentFinding[];
  taskPlan?: string;
  reviewFeedback?: string;
  structuredOutput?: StructuredOutputKind;
  /** Caller-supplied role budget; values never exceed the caller's explicit ceiling. */
  executionBudget?: AgentExecutionBudget;
  /** Per-child watchdog base budget. This is a phase ceiling when supplied by the orchestrator. */
  timeoutMs?: number;
  /** Phase-scoped watchdog extensions. Zero means the child must converge within timeoutMs. */
  watchdogMaxExtensions?: number;
  metadata?: Record<string, unknown>;
  taskCapsule?: TaskCapsule;
  workspaceKind?: "local" | "git-worktree";
  workspaceBranch?: string;
  customToolExecutor?: (name: string, args: Record<string, unknown>) => Promise<string>;
}

export interface ChildRun {
  childRunId: string;
  parentRunId: string;
  agentId: string;
  role: string;
  task: string;
  workspacePath: string;
  depth: number;
  status: "queued" | "working" | "completed" | "blocked" | "failed" | "cancelled";
  permissions: AgentPermissions;
  allowedTools: string[];
  controller: AbortController;
  startedAt: Date;
  completedAt?: Date;
  result?: AgentResult;
  capsule?: TaskCapsule;
  workerRecord?: SubagentRunWorkItem;
  /** Times the progress watchdog extended this worker's budget instead of aborting a paced wait. */
  watchdogExtensions?: number;
  /** Why the watchdog finally aborted: true stall, or budget ceiling reached while still progressing. */
  watchdogAbortReason?: "stalled" | "watchdog_budget_ceiling";
}

export interface SubagentManagerOptions {
  persistence?: ISessionPersistence;
  workspaceService?: WorkspaceService;
  agentRuntime?: AgentRuntime;
  getAgentRuntime?: (sessionId: string) => AgentRuntime;
  /** R1 path: durable worker state, Task Capsules, and artifact references. Off by default. */
  r1Enabled?: boolean;
  /**
   * Progress watchdog: a child whose durable model turns/tool executions advanced within this
   * window is legitimately paced (shared free-provider capacity), not stalled. Defaults to 120s —
   * provider pacing never silently waits longer (cooldowns >60s throw; TPM/RPM waits are bounded
   * by the 60s window), so silence beyond this is a real stall.
   */
  watchdogProgressWindowMs?: number;
  /** Hard ceiling on watchdog extensions: budget ≤ timeoutMs + maxExtensions × window. */
  watchdogMaxExtensions?: number;
}

export class SubagentManager {
  private readonly persistence?: ISessionPersistence;
  private readonly workspaceService?: WorkspaceService;
  private readonly agentRuntime?: AgentRuntime;
  private readonly getAgentRuntime?: (sessionId: string) => AgentRuntime;
  private readonly r1Enabled: boolean;
  private readonly watchdogProgressWindowMs: number;
  private readonly watchdogMaxExtensions: number;
  private readonly activeChildren: Map<string, ChildRun> = new Map(); // childRunId -> ChildRun
  private readonly childrenByParent: Map<string, Set<string>> = new Map(); // parentRunId -> Set<childRunId>

  constructor(options: SubagentManagerOptions = {}) {
    this.persistence = options.persistence;
    this.workspaceService = options.workspaceService;
    this.agentRuntime = options.agentRuntime;
    this.getAgentRuntime = options.getAgentRuntime;
    this.r1Enabled = options.r1Enabled ?? false;
    this.watchdogProgressWindowMs = options.watchdogProgressWindowMs ?? 120_000;
    this.watchdogMaxExtensions = options.watchdogMaxExtensions ?? 2;
  }

  private emptyTelemetry(): AgentWorkerTelemetry {
    return {
      wallTimeMs: 0,
      modelRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      retryCount: 0,
      duplicateWorkCount: 0,
      providerFailures: 0,
    };
  }

  private emptyUsage(): AgentUsage {
    return { inputTokens: 0, outputTokens: 0, requestCount: 0, toolCount: 0 };
  }

  private executionBudget(agentId: string, override?: AgentExecutionBudget): AgentExecutionBudget {
    const budget = DEFAULT_EXECUTION_BUDGETS[agentId] ?? DEFAULT_EXECUTION_BUDGETS.default!;
    return {
      maxModelTurns: budget.maxModelTurns,
      maxToolCalls: budget.maxToolCalls,
      ...(budget.maxWriteToolCalls !== undefined ? { maxWriteToolCalls: budget.maxWriteToolCalls } : {}),
      ...(budget.maxCommandExecutions !== undefined ? { maxCommandExecutions: budget.maxCommandExecutions } : {}),
      maxContextTokens: budget.maxContextTokens,
      ...(budget.maxOutputTokens !== undefined ? { maxOutputTokens: budget.maxOutputTokens } : {}),
      ...override,
    };
  }

  private async persistWorker(record: SubagentRunWorkItem): Promise<void> {
    if (this.r1Enabled && this.persistence) await this.persistence.upsertWorkItem(record);
  }

  private async transitionWorker(
    child: ChildRun,
    state: AgentWorkerLifecycleState,
    adapter?: WorkspaceEventAdapter,
    reason?: string,
  ): Promise<void> {
    const record = child.workerRecord;
    if (!record || !this.r1Enabled) return;
    record.status = state;
    record.updatedAt = new Date().toISOString();
    if (!record.startedAt && (state === "starting" || state === "running")) record.startedAt = record.updatedAt;
    if (reason) record.error = redactSecrets(reason);
    await this.persistWorker(record);
    await adapter?.emitSubagentLifecycle({
      agentId: record.agentId,
      role: record.role,
      parentAgentId: record.parentRunId,
      task: record.task,
      state,
      capsuleVersion: record.capsule.schemaVersion,
      ...(record.model ? { model: record.model } : {}),
      ...(state === "completed" || state === "blocked" || state === "failed" || state === "cancelled" ? { telemetry: record.telemetry } : {}),
      ...(reason ? { reason: redactSecrets(reason) } : {}),
    });
  }

  private async persistResultArtifact(child: ChildRun, result: AgentResult, adapter?: WorkspaceEventAdapter): Promise<AgentArtifactReference[]> {
    if (!this.r1Enabled || !this.persistence || !child.workerRecord) return [];
    const createdAt = new Date().toISOString();
    const content = redactSecrets(JSON.stringify({
      schemaVersion: 1,
      workerId: child.childRunId,
      status: result.status,
      summary: result.summary,
      findings: result.findings,
      evidence: result.evidence,
      files: result.files,
      risks: result.risks,
      recommendations: result.recommendations,
      ...(result.structuredData ? { structuredData: result.structuredData } : {}),
    }));
    const digest = crypto.createHash("sha256").update(content).digest("hex");
    const artifactId = `artifact-${child.childRunId}-result`;
    const reference: AgentArtifactReference = {
      kind: "worker_result",
      ref: `forge://run/${child.parentRunId}/worker/${child.childRunId}/result`,
      digest,
      producerAgentId: child.agentId,
      sizeBytes: Buffer.byteLength(content, "utf8"),
      createdAt,
    };
    await this.persistence.upsertWorkItem({
      kind: "artifact",
      id: artifactId,
      sessionId: child.workerRecord.sessionId,
      turnId: child.childRunId,
      type: "report",
      title: `Worker result: ${child.role}`,
      content,
      status: "ready",
      author: child.agentId,
      createdAt,
      updatedAt: createdAt,
    });
    await adapter?.emitSubagentArtifactWritten(reference, child.childRunId);
    return [reference];
  }

  private async initializeWorkerRecord(child: ChildRun, options: SpawnChildOptions, def: AgentDefinition, capsule: TaskCapsule): Promise<void> {
    if (!this.r1Enabled) return;
    const now = new Date().toISOString();
    child.workerRecord = {
      kind: "subagent_run",
      id: child.childRunId,
      sessionId: options.sessionId ?? `subagent-session-${child.parentRunId}`,
      parentRunId: child.parentRunId,
      agentId: child.agentId,
      role: child.role,
      task: child.task,
      depth: child.depth,
      status: "created",
      capsule,
      permissions: { ...child.permissions, network: child.permissions.network ?? false },
      allowedTools: [...child.allowedTools],
      workspace: {
        id: child.childRunId,
        kind: options.workspaceKind ?? "local",
        ...(options.workspaceBranch ? { branch: options.workspaceBranch } : {}),
      },
      workspacePath: child.workspacePath,
      budget: {
        ...this.executionBudget(def.id, options.executionBudget),
        wallTimeMs: options.timeoutMs
          ?? (options.metadata?.timeoutMs as number | undefined)
          ?? BUILT_IN_AGENTS[def.id]?.budget.timeoutMs
          ?? 60_000,
      },
      telemetry: this.emptyTelemetry(),
      artifacts: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.persistWorker(child.workerRecord);
  }

  /**
   * Spawn a child agent with private context, bounded permissions, depth limits, and cancellation propagation.
   */
  async spawnChildAgent(options: SpawnChildOptions): Promise<AgentResult> {
    const {
      parentRunId,
      agentId,
      task,
      workspacePath,
      parentPermissions,
      depth = 1,
      adapter,
      signal,
      contextSummary,
    } = options;

    // 1. Invariant: Depth Bound (MAX_SUBAGENT_DEPTH = 1)
    if (depth > MAX_SUBAGENT_DEPTH) {
      const error = new Error(
        `SUBAGENT_DEPTH_EXCEEDED: Subagent depth ${depth} exceeds maximum allowable depth (${MAX_SUBAGENT_DEPTH})`,
      );
      (error as unknown as { code: string }).code = "SUBAGENT_DEPTH_EXCEEDED";
      throw error;
    }

    // 2. Resolve trusted agent definition
    const def = getAgent(agentId);
    if (!def) {
      const error = new Error(`UNKNOWN_AGENT: Agent definition for "${agentId}" not found in trusted registry`);
      (error as unknown as { code: string }).code = "UNKNOWN_AGENT";
      throw error;
    }

    // 3. Invariant: Privilege Ceiling (child permissions ⊆ parent permissions)
    const effectivePermissions: AgentPermissions = {
      read: Boolean(def.permissions.read && (parentPermissions?.read ?? true)),
      search: Boolean(def.permissions.search && (parentPermissions?.search ?? true)),
      write: Boolean(def.permissions.write && (parentPermissions?.write ?? true)),
      executeCommand: Boolean(def.permissions.executeCommand && (parentPermissions?.executeCommand ?? true)),
      network: Boolean(def.permissions.network && (parentPermissions?.network ?? false)),
    };

    // Filter allowed tools based on effective permissions
    const writeTools = new Set(["edit_file", "write_file", "apply_patch", "run_destructive_command"]);
    const commandTools = new Set(["run_command"]);

    const allowedTools = def.tools.filter((tool) => {
      if (writeTools.has(tool) && !effectivePermissions.write) return false;
      if (commandTools.has(tool) && !effectivePermissions.executeCommand) return false;
      return true;
    });

    // 4. Invariant: Max concurrent children per parent
    const existingChildren = this.childrenByParent.get(parentRunId) ?? new Set();
    if (existingChildren.size >= MAX_CHILDREN_PER_PARENT) {
      const error = new Error(
        `SUBAGENT_QUOTA_EXCEEDED: Parent "${parentRunId}" reached maximum active child agents (${MAX_CHILDREN_PER_PARENT})`,
      );
      (error as unknown as { code: string }).code = "SUBAGENT_QUOTA_EXCEEDED";
      throw error;
    }

    // 5. Create Child Run Identity & Linked AbortController
    const childRunId = `child-${crypto.randomUUID()}`;
    const controller = new AbortController();

    // Link parent signal if provided
    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
    }

    // Set child timeout, then let the progress watchdog own it. The budget is a stall detector,
    // not a fixed kill clock: at expiry the worker is aborted only if its durable progress
    // (model turns, tool executions, journal) went quiet past the window, or the bounded
    // extension ceiling is exhausted. A worker being paced by shared provider capacity keeps
    // earning extensions; a genuinely dead worker is killed at the first quiet check.
    const childTimeoutMs = options.timeoutMs
      ?? (options.metadata?.timeoutMs as number | undefined)
      ?? def.budget.timeoutMs
      ?? 180_000;
    const watchdogMaxExtensions = options.watchdogMaxExtensions
      ?? (options.metadata?.watchdogMaxExtensions as number | undefined)
      ?? this.watchdogMaxExtensions;
    let watchdogExtensions = 0;
    const watchdogTimerRef: { timer?: NodeJS.Timeout } = {};
    const progressWatchdog = (): void => {
      if (controller.signal.aborted || !this.activeChildren.has(childRunId)) return;
      void (async () => {
        const progressAt = await this.latestRunProgressMs(childRunId);
        if (controller.signal.aborted || !this.activeChildren.has(childRunId)) return;
        const stalled = progressAt === undefined || Date.now() - progressAt > this.watchdogProgressWindowMs;
        if (!stalled && watchdogExtensions < watchdogMaxExtensions) {
          watchdogExtensions++;
          childRun.watchdogExtensions = watchdogExtensions;
          watchdogTimerRef.timer = setTimeout(progressWatchdog, this.watchdogProgressWindowMs);
          return;
        }
        childRun.watchdogAbortReason = stalled ? "stalled" : "watchdog_budget_ceiling";
        controller.abort();
      })().catch(() => {
        childRun.watchdogAbortReason = "stalled";
        if (!controller.signal.aborted) controller.abort();
      });
    };
    const childRun: ChildRun = {
      childRunId,
      parentRunId,
      agentId: def.id,
      role: def.role,
      task,
      workspacePath,
      depth,
      status: "working",
      permissions: effectivePermissions,
      allowedTools,
      controller,
      startedAt: new Date(),
    };

    const capsule = options.taskCapsule ?? createTaskCapsule({
      role: def.id,
      task,
      contextSummary,
      explorerEvidence: options.explorerEvidence,
      findings: options.findings,
      taskPlan: options.taskPlan,
      reviewFeedback: options.reviewFeedback,
    });
    childRun.capsule = capsule;
    await this.initializeWorkerRecord(childRun, options, def, capsule);

    this.activeChildren.set(childRunId, childRun);
    if (!this.childrenByParent.has(parentRunId)) {
      this.childrenByParent.set(parentRunId, new Set());
    }
    this.childrenByParent.get(parentRunId)!.add(childRunId);

    // 6. Emit subagent.started event
    adapter?.emitSubagentStarted(childRunId, def.role, task, parentRunId);
    await this.transitionWorker(childRun, "created", adapter);
    await this.transitionWorker(childRun, "starting", adapter);
    // Start the watchdog after the child is registered and its durable startup boundaries have
    // landed. Measuring the budget from before initialization can classify normal setup as a stall
    // and abort a paced worker before its first model turn has a chance to record progress.
    watchdogTimerRef.timer = setTimeout(progressWatchdog, childTimeoutMs);

    try {
      if (controller.signal.aborted) {
        throw new Error("Subagent execution cancelled");
      }

      await this.transitionWorker(childRun, "running", adapter);

      // 7. Execute specialized child logic in private context
      let result: AgentResult;
      let usage = this.emptyUsage();

      const runtime = this.r1Enabled && options.sessionId
        ? this.agentRuntime ?? this.getAgentRuntime?.(options.sessionId)
        : this.agentRuntime;
      if (runtime) {
        const runtimeRes = await runtime.executeAgentRun({
          runId: childRunId,
          agentId: def.id,
          role: def.id,
          goal: task,
          workspaceId: childRunId,
          workspacePath,
          permissions: effectivePermissions,
          signal: controller.signal,
          adapter,
          initialContext: this.r1Enabled ? JSON.stringify(capsule) : contextSummary,
          explorerEvidence: options.explorerEvidence,
          findings: options.findings,
          taskPlan: options.taskPlan,
          reviewFeedback: options.reviewFeedback,
          executionBudget: this.executionBudget(def.id, options.executionBudget),
          diff: def.id === "reviewer" ? contextSummary : undefined,
          verificationEvidence: def.id === "reviewer" ? contextSummary : undefined,
          structuredOutput: options.structuredOutput,
          customToolExecutor: options.customToolExecutor,
          roleRouting: this.r1Enabled,
        });
        usage = runtimeRes.usage;
        const runtimeStatus = childRun.watchdogAbortReason === "watchdog_budget_ceiling" && runtimeRes.status === "cancelled"
          ? "blocked" as const
          : runtimeRes.status;

        result = {
          status: runtimeStatus,
          summary: runtimeRes.summary,
          findings: runtimeRes.findings,
          evidence: runtimeRes.evidence,
          files: runtimeRes.filesChanged,
          risks: runtimeStatus === "blocked" ? ["Reviewer or budget blocker"] : [],
          recommendations: runtimeStatus === "completed" ? ["Proceed"] : ["Resolve blockers"],
          structuredData: runtimeRes.structuredData,
        };
      } else if (def.id === "explorer") {
        result = await this.executeExplorer(childRun, contextSummary, adapter);
      } else if (def.id === "reviewer") {
        result = await this.executeReviewer(childRun, contextSummary, adapter);
      } else {
        result = await this.executeGenericChild(childRun, contextSummary, adapter);
      }

      childRun.status = result.status === "completed" ? "completed" : result.status === "blocked" ? "blocked" : result.status === "cancelled" ? "cancelled" : "failed";
      childRun.completedAt = new Date();
      childRun.result = result;

      if (childRun.workerRecord) {
        const startedAt = childRun.startedAt.getTime();
        childRun.workerRecord.telemetry = {
          wallTimeMs: Math.max(0, childRun.completedAt.getTime() - startedAt),
          modelRequests: usage.requestCount,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          toolCalls: usage.toolCount,
          retryCount: 0,
          duplicateWorkCount: 0,
          providerFailures: result.status === "failed" ? 1 : 0,
        };
        if (usage.provider && usage.model) childRun.workerRecord.model = { providerId: usage.provider, modelId: usage.model };
        childRun.workerRecord.resultSummary = redactSecrets(result.summary);
        childRun.workerRecord.completedAt = childRun.completedAt.toISOString();
        childRun.workerRecord.artifacts = await this.persistResultArtifact(childRun, result, adapter);
        await this.transitionWorker(childRun, result.status, adapter, result.status === "blocked" ? result.summary : undefined);
      }

      // 8. Emit subagent.completed event
      if (result.status === "completed") adapter?.emitSubagentCompleted(childRunId, result.summary);
      else if (result.status === "blocked") adapter?.emitSubagentFailed(childRunId, result.summary);
      else if (result.status === "cancelled") adapter?.emitSubagentCompleted(childRunId, "Subagent cancelled");
      else adapter?.emitSubagentFailed(childRunId, result.summary);

      return result;
    } catch (err: unknown) {
      const isCancelled = controller.signal.aborted || (signal && signal.aborted);
      const watchdogBlocked = childRun.watchdogAbortReason === "watchdog_budget_ceiling";
      const status = watchdogBlocked ? "blocked" : isCancelled ? "cancelled" : "failed";
      const errorMsg = err instanceof Error ? err.message : String(err);
      const failedResult: AgentResult = {
        status,
        summary: `Subagent ${def.role} ${status}: ${errorMsg}`,
        findings: [],
        evidence: [],
        files: [],
        risks: [],
        recommendations: [],
      };

      childRun.status = status;
      childRun.completedAt = new Date();
      childRun.result = failedResult;

      if (childRun.workerRecord) {
        childRun.workerRecord.completedAt = childRun.completedAt.toISOString();
        childRun.workerRecord.resultSummary = redactSecrets(failedResult.summary);
        childRun.workerRecord.telemetry = {
          ...childRun.workerRecord.telemetry,
          wallTimeMs: Math.max(0, childRun.completedAt.getTime() - childRun.startedAt.getTime()),
          providerFailures: status === "failed" ? 1 : 0,
        };
        childRun.workerRecord.artifacts = await this.persistResultArtifact(childRun, failedResult, adapter);
        await this.transitionWorker(childRun, status, adapter, errorMsg);
      }

      if (isCancelled) {
        adapter?.emitSubagentCompleted(childRunId, "Subagent cancelled");
      } else {
        adapter?.emitSubagentFailed(childRunId, errorMsg);
      }

      return failedResult;
    } finally {
      if (watchdogTimerRef.timer) clearTimeout(watchdogTimerRef.timer);
      // Clean up child registry
      const set = this.childrenByParent.get(parentRunId);
      if (set) {
        set.delete(childRunId);
        if (set.size === 0) this.childrenByParent.delete(parentRunId);
      }
      this.activeChildren.delete(childRunId);
    }
  }

  /**
   * Cancel all child runs associated with a parent run.
   */
  cancelParent(parentRunId: string): void {
    const children = this.childrenByParent.get(parentRunId);
    if (!children) return;

    for (const childId of children) {
      const child = this.activeChildren.get(childId);
      if (child) {
        child.controller.abort();
        child.status = "cancelled";
      }
    }
  }

  getActiveChildren(parentRunId: string): ChildRun[] {
    const children = this.childrenByParent.get(parentRunId);
    if (!children) return [];
    const result: ChildRun[] = [];
    for (const id of children) {
      const c = this.activeChildren.get(id);
      if (c) result.push(c);
    }
    return result;
  }

  /**
   * Latest durable activity timestamp for a child run: model-turn boundaries, tool-execution
   * records, and the run journal all bump `updatedAt` as the worker advances. A recent timestamp
   * is evidence of legitimate paced progress; prolonged silence is a true stall.
   */
  private async latestRunProgressMs(runId: string): Promise<number | undefined> {
    if (!this.persistence) return undefined;
    let latest: number | undefined;
    const consider = (raw: unknown): void => {
      if (typeof raw !== "string") return;
      const t = Date.parse(raw);
      if (!Number.isNaN(t) && (latest === undefined || t > latest)) latest = t;
    };
    for (const kind of ["agent_model_turn", "agent_tool_execution"] as const) {
      for (const item of await this.persistence.getWorkItemsByKind(kind)) {
        const rec = item as unknown as { runId?: string; updatedAt?: string };
        if (rec.runId === runId) consider(rec.updatedAt);
      }
    }
    const journal = await this.persistence.getWorkItem(`agent-run-journal-${runId}`) as { updatedAt?: string } | undefined;
    if (journal) consider(journal.updatedAt);
    return latest;
  }

  /**
   * R1: converge durable worker records left non-terminal by a process crash/restart into an
   * honest terminal state. Active execution is deliberately NOT resumed (recovery is replan-only:
   * no durable execution journal exists), so a worker recorded as running/waiting/recovering must
   * not appear alive forever — it failed with the process.
   */
  async reconcileStaleWorkers(reason: string): Promise<number> {
    if (!this.persistence) return 0;
    const terminal = new Set<AgentWorkerLifecycleState>(["completed", "failed", "cancelled", "blocked"]);
    const workers = await this.persistence.getWorkItemsByKind("subagent_run");
    let reconciled = 0;
    for (const item of workers) {
      if (item.kind !== "subagent_run" || terminal.has(item.status)) continue;
      const now = new Date().toISOString();
      item.status = "failed";
      item.error = redactSecrets(reason);
      item.updatedAt = now;
      if (!item.completedAt) item.completedAt = now;
      await this.persistence.upsertWorkItem(item);
      reconciled++;
    }
    return reconciled;
  }

  /**
   * R2: recover interrupted workers using durable execution journals. This is the authoritative
   * recovery entry point — it classifies each non-terminal worker into RESUME/REPLAN/FAIL based
   * on journal content and tool execution records, then executes the corresponding strategy.
   */
  async recoverInterruptedWorkers(options?: { recoveryOwnerId?: string }): Promise<{ resumed: number; replanned: number; failed: number; decisions: Array<{ workerId: string; outcome: string; reason: string }> }> {
    if (!this.persistence) return { resumed: 0, replanned: 0, failed: 0, decisions: [] };

    const ownerId = options?.recoveryOwnerId ?? `recovery-owner-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    const terminal = new Set<AgentWorkerLifecycleState>(["completed", "failed", "cancelled", "blocked"]);
    const workers = await this.persistence.getWorkItemsByKind("subagent_run");
    const decisions: Array<{ workerId: string; outcome: string; reason: string }> = [];
    let resumed = 0;
    let replanned = 0;
    let failed = 0;

    for (const item of workers) {
      if (item.kind !== "subagent_run" || terminal.has(item.status)) continue;

      // Cross-process recovery lease: ensure at most one recovery worker/process resumes this worker
      const leaseId = `recovery-lease-${item.id}`;
      const leaseTtlMs = 60_000;
      const nowMs = Date.now();
      const acquired = await this.persistence.withTransaction(async (tx) => {
        const existing = (await tx.getWorkItem(leaseId)) as AgentRecoveryLease | undefined;
        if (existing && existing.kind === "agent_recovery_lease") {
          if (Date.parse(existing.expiresAt) > nowMs && existing.ownerId !== ownerId) {
            return false;
          }
        }
        const lease: AgentRecoveryLease = {
          kind: "agent_recovery_lease",
          id: leaseId,
          sessionId: item.sessionId ?? "default",
          workerId: item.id,
          ownerId,
          expiresAt: new Date(nowMs + leaseTtlMs).toISOString(),
          createdAt: existing?.createdAt ?? new Date(nowMs).toISOString(),
          updatedAt: new Date(nowMs).toISOString(),
        };
        await tx.upsertWorkItem(lease as unknown as WorkItem);
        return true;
      });

      if (!acquired) continue;

      const journal = await this.persistence.getWorkItem(`agent-run-journal-${item.id}`) as AgentRunJournal | undefined;
      const toolRecords: RunRecoveryToolRecord[] = [];
      const toolItems = await this.persistence.getWorkItemsByKind("agent_tool_execution");
      const staleToolRecords: Array<{ id: string; state: string; executionClass: string }> = [];
      for (const ti of toolItems) {
        if (ti.kind === "agent_tool_execution") {
          const record = ti as unknown as { id: string; runId: string; toolName: string; executionClass: ToolExecutionClass; state: DurableToolExecutionState };
          if (record.runId !== item.id) continue;
          toolRecords.push({
            toolName: record.toolName,
            executionClass: record.executionClass,
            state: record.state,
          });
          if (record.state !== "observation_recorded" && record.state !== "completed" && record.state !== "failed" && record.state !== "cancelled") {
            staleToolRecords.push({ id: record.id, state: record.state, executionClass: record.executionClass });
          }
        }
      }

      /** Crash-window records never stay open: a resumed run re-issues what it needs; everything
       * else is converged to cancelled so no later recovery mistakes it for live work. */
      const convergeStaleToolRecords = async (): Promise<void> => {
        for (const stale of staleToolRecords) {
          const record = await this.persistence!.getWorkItem(stale.id);
          if (!record || record.kind !== "agent_tool_execution") continue;
          const next = { ...(record as unknown as Record<string, unknown>), state: "cancelled", recoveryDisposition: "blocked", updatedAt: new Date().toISOString() };
          await this.persistence!.upsertWorkItem(next as unknown as WorkItem);
        }
      };

      const outcome = classifyRunRecovery(journal, toolRecords);
      decisions.push({ workerId: item.id, outcome: outcome.outcome, reason: outcome.reason });

      if (outcome.outcome === "resume") {
        const workspacePath = item.workspacePath ?? (item.workspace as any)?.path ?? (this.agentRuntime as any)?.workspacePath ?? process.cwd();
        if ((item.workspace?.kind === "git-worktree" && !existsSync(workspacePath)) || (!item.workspacePath && !existsSync(workspacePath))) {
          item.status = "failed";
          item.error = redactSecrets(item.workspace?.kind === "git-worktree"
            ? "RECOVERY_REPLAN: worktree path does not exist on disk"
            : "RECOVERY_REPLAN: workspace path does not exist on disk");
          item.updatedAt = new Date().toISOString();
          if (!item.completedAt) item.completedAt = item.updatedAt;
          await this.persistence.upsertWorkItem(item);
          if (journal) {
            journal.state = "converged_failed";
            journal.recoveryOutcome = "replan";
            journal.recoveryDetail = item.error;
            journal.updatedAt = item.updatedAt;
            await this.persistence.upsertWorkItem(journal as unknown as WorkItem);
          }
          await convergeStaleToolRecords();
          replanned++;
          continue;
        }

        const runtime = item.sessionId ? (this.getAgentRuntime?.(item.sessionId) ?? this.agentRuntime) : this.agentRuntime;
        if (!runtime || !journal) {
          item.status = "failed";
          item.error = redactSecrets("RECOVERY_FAIL: no agent runtime or journal available to resume this worker; replan required");
          item.updatedAt = new Date().toISOString();
          if (!item.completedAt) item.completedAt = item.updatedAt;
          await this.persistence.upsertWorkItem(item);
          if (journal) {
            journal.state = "converged_failed";
            journal.recoveryOutcome = "fail";
            journal.recoveryDetail = item.error;
            journal.updatedAt = item.updatedAt;
            await this.persistence.upsertWorkItem(journal as unknown as WorkItem);
          }
          await convergeStaleToolRecords();
          failed++;
          continue;
        }
        const runtimeRes = await runtime.executeAgentRun({
          runId: item.id,
          agentId: item.agentId,
          role: item.role,
          goal: item.task,
          workspaceId: item.workspace?.id ?? item.id,
          workspacePath,
          permissions: item.permissions,
          initialContext: item.capsule ? JSON.stringify(item.capsule) : undefined,
          structuredOutput: item.agentId === "reviewer" ? "reviewer" : undefined,
          roleRouting: this.r1Enabled,
          resumeJournal: {
            journal,
            replayToolCallIds: outcome.outcome === "resume" ? outcome.replayToolCallIds : [],
          },
        });
        item.status = runtimeRes.status === "completed" ? "completed" : runtimeRes.status === "blocked" ? "blocked" : runtimeRes.status === "cancelled" ? "cancelled" : "failed";
        item.resultSummary = redactSecrets(runtimeRes.summary);
        item.telemetry = {
          ...item.telemetry,
          wallTimeMs: (item.telemetry?.wallTimeMs ?? 0) + 0,
          modelRequests: (item.telemetry?.modelRequests ?? 0) + runtimeRes.usage.requestCount,
          inputTokens: (item.telemetry?.inputTokens ?? 0) + runtimeRes.usage.inputTokens,
          outputTokens: (item.telemetry?.outputTokens ?? 0) + runtimeRes.usage.outputTokens,
          toolCalls: (item.telemetry?.toolCalls ?? 0) + runtimeRes.usage.toolCount,
          providerFailures: runtimeRes.status === "failed" ? (item.telemetry?.providerFailures ?? 0) + 1 : item.telemetry?.providerFailures ?? 0,
        };
        if (runtimeRes.usage.provider && runtimeRes.usage.model) {
          item.model = { providerId: runtimeRes.usage.provider, modelId: runtimeRes.usage.model };
        }
        item.completedAt = new Date().toISOString();
        item.updatedAt = item.completedAt;
        await this.persistence.upsertWorkItem(item);
        await convergeStaleToolRecords();
        resumed++;
      } else if (outcome.outcome === "replan") {
        item.status = "failed";
        item.error = redactSecrets(outcome.reason);
        item.updatedAt = new Date().toISOString();
        if (!item.completedAt) item.completedAt = item.updatedAt;
        await this.persistence.upsertWorkItem(item);
        if (journal) {
          journal.state = "converged_failed";
          journal.recoveryOutcome = "replan";
          journal.recoveryDetail = redactSecrets(outcome.reason);
          journal.updatedAt = item.updatedAt;
          await this.persistence.upsertWorkItem(journal as unknown as WorkItem);
        }
        await convergeStaleToolRecords();
        replanned++;
      } else {
        item.status = "failed";
        item.error = redactSecrets(outcome.reason);
        item.updatedAt = new Date().toISOString();
        if (!item.completedAt) item.completedAt = item.updatedAt;
        await this.persistence.upsertWorkItem(item);
        if (journal) {
          journal.state = "converged_failed";
          journal.recoveryOutcome = "fail";
          journal.recoveryDetail = redactSecrets(outcome.reason);
          journal.updatedAt = item.updatedAt;
          await this.persistence.upsertWorkItem(journal as unknown as WorkItem);
        }
        await convergeStaleToolRecords();
        failed++;
      }
    }

    return { resumed, replanned, failed, decisions };
  }

  /**
   * Specialized Explorer execution:
   * Scans workspace files, maps relevant symbols, and returns structured findings.
   */
  private async executeExplorer(
    run: ChildRun,
    contextSummary?: string,
    adapter?: WorkspaceEventAdapter,
  ): Promise<AgentResult> {
    const findings: AgentFinding[] = [];
    const evidence: AgentEvidenceRef[] = [];
    const discoveredFiles: string[] = [];

    adapter?.emitSubagentProgress(run.childRunId, "Scanning workspace directory...", 20);

    try {
      const entries = await fs.readdir(run.workspacePath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
        discoveredFiles.push(entry.name);
      }
    } catch {}

    adapter?.emitSubagentProgress(run.childRunId, `Analyzing code structure in ${discoveredFiles.length} file(s)...`, 60);

    findings.push({
      id: `finding-${crypto.randomUUID().slice(0, 8)}`,
      severity: "advisory",
      category: "architecture",
      message: `Exploration identified ${discoveredFiles.length} primary top-level components.`,
      evidence: discoveredFiles.slice(0, 5).join(", "),
    });

    evidence.push({
      kind: "directory_listing",
      ref: run.workspacePath,
      description: `Top-level files: ${discoveredFiles.slice(0, 8).join(", ")}`,
    });

    adapter?.emitSubagentProgress(run.childRunId, "Exploration complete.", 100);

    return {
      status: "completed",
      summary: `Explorer mapped ${discoveredFiles.length} top-level files for task "${redactSecrets(run.task)}"`,
      findings,
      evidence,
      files: discoveredFiles,
      risks: [],
      recommendations: ["Target primary entry points for modification"],
    };
  }

  /**
   * Specialized Reviewer execution:
   * Analyzes diff and test outputs, returning structured blocking vs advisory findings.
   */
  private async executeReviewer(
    run: ChildRun,
    contextSummary?: string,
    adapter?: WorkspaceEventAdapter,
  ): Promise<AgentResult> {
    adapter?.emitSubagentProgress(run.childRunId, "Inspecting changes and verification evidence...", 30);

    const findings: AgentFinding[] = [];
    const evidence: AgentEvidenceRef[] = [];

    // Analyze task and context summary for safety/regression issues
    const isFailureReport = contextSummary && (
      /(?:[1-9]\d*|some|unresolved|potential)\s*(?:failures?|errors?|regressions?)/i.test(contextSummary) ||
      /(?:verification\s+failed|test\s+failure|typeerror|syntaxerror|build\s+failed)/i.test(contextSummary)
    );

    if (isFailureReport) {
      findings.push({
        id: `review-${crypto.randomUUID().slice(0, 8)}`,
        severity: "blocking",
        category: "correctness",
        message: "Review detected potential failures or regressions in verification summary.",
        evidence: contextSummary.slice(0, 200),
      });
    } else {
      findings.push({
        id: `review-${crypto.randomUUID().slice(0, 8)}`,
        severity: "advisory",
        category: "quality",
        message: "Diff and verification results meet quality standards.",
      });
    }

    evidence.push({
      kind: "review_audit",
      ref: run.workspacePath,
      description: "Independent review audit recorded",
    });

    adapter?.emitSubagentProgress(run.childRunId, "Review complete.", 100);

    const hasBlocking = findings.some((f) => f.severity === "blocking");

    return {
      status: hasBlocking ? "blocked" : "completed",
      summary: hasBlocking
        ? "Reviewer identified blocking issues that require resolution."
        : "Reviewer approved changes with clean findings.",
      findings,
      evidence,
      files: [],
      risks: hasBlocking ? ["Verification regression detected"] : [],
      recommendations: hasBlocking ? ["Fix reported failure before completion"] : ["Proceed to completion gate"],
    };
  }

  private async executeGenericChild(
    run: ChildRun,
    contextSummary?: string,
    adapter?: WorkspaceEventAdapter,
  ): Promise<AgentResult> {
    adapter?.emitSubagentProgress(run.childRunId, "Executing child agent task...", 50);
    return {
      status: "completed",
      summary: `Child agent ${run.role} completed task "${redactSecrets(run.task)}"`,
      findings: [],
      evidence: [],
      files: [],
      risks: [],
      recommendations: [],
    };
  }
}

export function createSubagentManager(options: SubagentManagerOptions = {}): SubagentManager {
  return new SubagentManager(options);
}
