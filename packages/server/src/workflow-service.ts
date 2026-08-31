import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createWorkspaceEventAdapter, type WorkspaceEventAdapter } from "./workspace-event-adapter.js";
import { ApprovalService } from "./approval-service.js";
import type { EventStore, SessionPersistence } from "@codeforge/sessions";
import {
  createWorkflowEngine,
  type WorkflowEngine,
  type WorkflowTask,
  type WorkflowResult,
} from "@codeforge/workflow";
import type { WorkflowPlan, ContextBundle, RepoMap, FailureAnalysis, VerificationResult, TaskIntent } from "@codeforge/workflow";
import type { AgentRuntime } from "./agent-runtime.js";
import { redactSecrets } from "@codeforge/secrets";

export interface WorkflowServiceOptions {
  eventStore: EventStore;
  persistence: SessionPersistence;
  workspacePath?: string;
  /** Factory for AgentRuntime per session — connects workflow to real execution pipeline */
  getOrCreateRuntime?: (sessionId: string, userId?: string) => AgentRuntime;
  /** When true, Implement/Repair phases delegate to AgentRuntime (real LLM + tools); else heuristic */
  useRealRuntime?: boolean;
}

export interface WorkflowRunRequest {
  sessionId: string;
  message: string;
  workspacePath?: string;
  verificationCommands?: string[];
  userId?: string;
  /** Force heuristic even if real runtime available (for deterministic tests) */
  forceHeuristic?: boolean;
}

const MAX_CONCURRENT_PER_SESSION = 1;
const MAX_WORKFLOWS_GLOBAL = 20;
const WORKFLOW_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_WORKSPACE_PATH_LENGTH = 1024;

function validateWorkspacePath(workspacePath: string): { valid: boolean; resolved?: string; error?: string } {
  if (typeof workspacePath !== "string" || workspacePath.length === 0 || workspacePath.length > MAX_WORKSPACE_PATH_LENGTH) {
    return { valid: false, error: "Invalid workspace path" };
  }
  if (workspacePath.includes("\0")) return { valid: false, error: "Invalid workspace path" };
  let resolved: string;
  try {
    resolved = path.resolve(workspacePath);
  } catch {
    return { valid: false, error: "Invalid workspace path" };
  }
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    return { valid: false, error: "Workspace path does not exist" };
  }
  try {
    const stat = fs.statSync(real);
    if (!stat.isDirectory()) return { valid: false, error: "Workspace path is not a directory" };
  } catch {
    return { valid: false, error: "Workspace path not accessible" };
  }
  return { valid: true, resolved: real };
}

const ACTIVE_PHASES = new Set<string>([
  "received",
  "understanding",
  "inspecting",
  "building_context",
  "planning",
  "awaiting_approval",
  "implementing",
  "verifying",
  "diagnosing",
  "repairing",
  "reviewing",
  "summarizing",
]);

function isActivePhase(phase: string): boolean {
  return ACTIVE_PHASES.has(phase);
}

export class WorkflowService {
  private readonly eventStore: EventStore;
  private readonly persistence: SessionPersistence;
  private readonly approvalService: ApprovalService;
  private readonly workflows: Map<string, { engine: WorkflowEngine; controller: AbortController; promise: Promise<WorkflowResult>; task: WorkflowTask }> = new Map();
  private defaultWorkspacePath?: string;
  private readonly getOrCreateRuntime?: (sessionId: string, userId?: string) => AgentRuntime;
  private readonly useRealRuntime: boolean;

  constructor(options: WorkflowServiceOptions) {
    this.eventStore = options.eventStore;
    this.persistence = options.persistence;
    this.defaultWorkspacePath = options.workspacePath;
    this.approvalService = new ApprovalService({ defaultTimeoutMs: 5 * 60 * 1000 });
    this.getOrCreateRuntime = options.getOrCreateRuntime;
    this.useRealRuntime = options.useRealRuntime ?? false;
    this.recoverStalePersistedState();
  }

  private recoverStalePersistedState(): void {
    try {
      const sessions = this.persistence.listSessions();
      for (const sess of sessions) {
        const statusStr = sess.status as string;
        const isTerminal = statusStr === "completed" || statusStr === "failed" || statusStr === "cancelled" || statusStr === "failed_safely";
        if (!isTerminal) {
          const turns = this.persistence.getTurns(sess.id);
          for (const turn of turns) {
            const isTurnTerminal = turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled";
            if (!isTurnTerminal) {
              try {
                this.persistence.upsertTurn({
                  ...turn,
                  status: "failed",
                  completedAt: new Date().toISOString(),
                  error: "Recovery required: server restarted during active execution. No duplicate execution will occur; inspect workspace and retry if needed.",
                });
              } catch {}
            }
          }
          try {
            this.persistence.upsertSession({
              ...sess,
              status: "failed",
              updatedAt: new Date().toISOString(),
            });
            try {
              const recoveryEvent = {
                type: "task.state_changed",
                timestamp: new Date().toISOString(),
                seq: this.eventStore.getLastSeq() + 1,
                sessionId: sess.id,
                payload: { taskId: sess.id, from: sess.status, to: "failed_safely", reason: "recovery_required" },
              } as const;
              this.eventStore.append(recoveryEvent as any);
              this.persistence.appendEvent(recoveryEvent);
            } catch {}
          } catch {}
        }
      }
    } catch {}
  }

  getApprovalService(): ApprovalService {
    return this.approvalService;
  }

  private createAgentExecutor(
    sessionId: string,
    userId: string | undefined,
    signal: AbortSignal,
    adapter: WorkspaceEventAdapter,
  ): NonNullable<import("@codeforge/workflow").WorkflowEngineOptions["agentExecutor"]> {
    const getRuntime = this.getOrCreateRuntime!;
    const waitForTurn = async (runtime: AgentRuntime, turnId: string): Promise<{ status: string; turn?: ReturnType<AgentRuntime["getTurn"]> }> => {
      // This budget bounds how long the AGENT may work. Time the turn spends parked on a human
      // decision is not the agent working, so it is excluded: otherwise a user who takes longer than
      // the budget to read an approval has their workflow declared failed for having thought about
      // it, which is exactly the wrong incentive on the one gate that exists for safety.
      //
      // The wait is still bounded — ApprovalService owns that bound and expires the approval on its
      // own timeout, which resolves the promise and lets the turn finish. Nothing here is unbounded
      // and no timeout protection is removed.
      const timeoutMs = 120_000;
      let workingMs = 0;
      let lastTick = Date.now();
      while (workingMs < timeoutMs) {
        if (signal.aborted) {
          try { await runtime.cancelTurn(turnId, "Workflow cancelled"); } catch {}
          return { status: "cancelled" };
        }
        const turn = runtime.getTurn(turnId);
        const now = Date.now();
        const elapsed = now - lastTick;
        lastTick = now;

        if (!turn) {
          workingMs += elapsed;
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
        if (turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled") {
          return { status: turn.status, turn };
        }
        if (turn.status === "waiting_for_approval") {
          // Paused on the user, not stalled: do not charge this to the working budget. The runtime
          // stays paused until an explicit user decision reaches its ApprovalService through the
          // normal API/UI route. A workflow must not manufacture an approval on the user's behalf.
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
        workingMs += elapsed;
        await new Promise((r) => setTimeout(r, 200));
      }
      return { status: "failed" };
    };

    const buildImplementPrompt = (plan: WorkflowPlan, context: ContextBundle, repoMap: RepoMap, intent: TaskIntent): string => {
      const lines: string[] = [];
      lines.push(`You are CodeForge, an autonomous coding agent. Implement the following plan disciplinedly.`);
      lines.push(`Task: ${redactSecrets(intent.title)}`);
      lines.push(`Type: ${intent.taskType}, Goals: ${intent.goals.join(" | ")}`);
      lines.push(`\nPlan ${plan.id}: ${redactSecrets(plan.title)}`);
      lines.push(`Steps:`);
      for (const s of plan.steps.filter((st) => st.status === "queued" || st.status === "active")) {
        lines.push(`- [${s.kind}:${s.risk}] ${redactSecrets(s.description)}${s.targetPath ? ` → ${s.targetPath}` : ""}`);
      }
      lines.push(`\nRelevant files (context): ${context.primaryFiles.join(", ")}`);
      lines.push(`\nContext snippets:`);
      for (const snippet of context.snippets.slice(0, 4)) {
        lines.push(`\n--- ${snippet.path} (relevance ${snippet.relevance}) ---\n${redactSecrets(snippet.preview.slice(0, 1200))}\n`);
      }
      lines.push(`\nInstructions:`);
      lines.push(`- Use read_file to inspect files (hash will be provided).`);
      lines.push(`- Use edit_file with exact oldText/newText and expectedHash for safe edits.`);
      lines.push(`- Use run_command only if needed and approved.`);
      lines.push(`- After edits, the workflow will run verification automatically; do not run verification yourself unless needed.`);
      lines.push(`- Be precise, minimal, and preserve existing behavior.`);
      return lines.join("\n");
    };

    const buildRepairPrompt = (analysis: FailureAnalysis, verification: VerificationResult, context: ContextBundle, intent: TaskIntent): string => {
      const lines: string[] = [];
      lines.push(`Verification failed; diagnose and repair.`);
      lines.push(`Task: ${redactSecrets(intent.title)}`);
      lines.push(`\nVerification output:\n${redactSecrets(verification.output.slice(0, 4000))}`);
      lines.push(`\nFailures: ${redactSecrets(verification.failures.map((f) => `${f.test}: ${f.message}`).join("\n").slice(0, 2000))}`);
      lines.push(`\nDiagnostics:\n${redactSecrets(analysis.diagnostics.slice(0, 10).join("\n"))}`);
      lines.push(`\nSuggested repairs: ${redactSecrets(JSON.stringify(analysis.suggestedRepairs.slice(0, 3), null, 2))}`);
      lines.push(`\nRelevant files: ${context.primaryFiles.join(", ")}`);
      lines.push(`\nPlease fix the failures using edit_file with hash protection. Be minimal.`);
      return lines.join("\n");
    };

    return {
      executePlan: async (
        plan: WorkflowPlan,
        context: ContextBundle,
        repoMap: RepoMap,
        intent: TaskIntent,
        sig?: AbortSignal,
      ): Promise<{ success: boolean; output: string; turnId?: string }> => {
        const prompt = buildImplementPrompt(plan, context, repoMap, intent);
        adapter.emitAgentStarted(`agent-${plan.id.slice(0, 8)}`, "Builder", plan.id);
        const runtime = getRuntime(sessionId, userId);
        const turnId = await runtime.startTurn(prompt);
        const result = await waitForTurn(runtime, turnId);
        if (result.status === "completed") {
          adapter.emitAgentCompleted(`agent-${plan.id.slice(0, 8)}`, plan.id);
          return { success: true, output: `Turn ${turnId} completed`, turnId };
        }
        if (result.status === "cancelled" || sig?.aborted || signal.aborted) {
          return { success: false, output: `Turn ${turnId} cancelled` };
        }
        return { success: false, output: `Turn ${turnId} failed: ${result.turn?.error ?? "unknown"}` };
      },
      executeRepair: async (
        analysis: FailureAnalysis,
        verification: VerificationResult,
        context: ContextBundle,
        _repoMap: RepoMap,
        intent: TaskIntent,
        sig?: AbortSignal,
      ): Promise<{ success: boolean; output: string; turnId?: string }> => {
        const prompt = buildRepairPrompt(analysis, verification, context, intent);
        const runtime = getRuntime(sessionId, userId);
        const turnId = await runtime.startTurn(prompt);
        const result = await waitForTurn(runtime, turnId);
        if (result.status === "completed") return { success: true, output: `Repair turn ${turnId} completed`, turnId };
        return { success: false, output: `Repair turn ${turnId} ${result.status}` };
      },
    };
  }

  async startWorkflow(request: WorkflowRunRequest): Promise<{ taskId: string; turnId: string }> {
    const sessionId = request.sessionId;
    const rawWorkspacePath = request.workspacePath ?? this.defaultWorkspacePath;
    if (!rawWorkspacePath) {
      throw new Error("No workspace path configured for workflow");
    }
    const validated = validateWorkspacePath(rawWorkspacePath);
    if (!validated.valid || !validated.resolved) {
      throw new Error(validated.error ?? "Invalid workspace");
    }
    const workspacePath = validated.resolved;

    // Concurrency hardening: at most 1 running workflow per session, max 20 global
    const runningForSession = Array.from(this.workflows.values()).filter(
      (w) => w.task.sessionId === sessionId && isActivePhase(w.engine.getTask().phase),
    );
    if (runningForSession.length >= MAX_CONCURRENT_PER_SESSION) {
      throw new Error("A workflow is already running for this session. Cancel or wait for it to complete.");
    }
    const activeGlobal = Array.from(this.workflows.values()).filter((w) => isActivePhase(w.engine.getTask().phase));
    if (activeGlobal.length >= MAX_WORKFLOWS_GLOBAL) {
      throw new Error("Too many concurrent workflows. Please wait.");
    }

    if (typeof request.message !== "string" || request.message.trim().length === 0) {
      throw new Error("Message is required");
    }
    if (request.message.length > 10000) {
      throw new Error("Message too long");
    }

    const adapter = createWorkspaceEventAdapter({
      sessionId,
      eventStore: this.eventStore,
      persistence: this.persistence,
    });

    const taskId = crypto.randomUUID();
    const turnId = crypto.randomUUID();

    // Emit task lifecycle events immediately (redact secrets in title)
    const redactedTitle = redactSecrets(request.message.slice(0, 80));
    adapter.emitTaskCreated(taskId, redactedTitle, "autonomous");
    adapter.emitTaskStarted(taskId);
    adapter.emitTaskStateChanged(taskId, "received", "reconnaissance");
    adapter.emitStatusChanged("idle", "running");

    const controller = new AbortController();
    const workflowTimeout = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort();
        try {
          adapter.emitTaskStateChanged(taskId, "running", "failed_safely");
          adapter.emitStatusChanged("running", "failed");
          adapter.emitTurnFailed(turnId, "Workflow timed out after 10 minutes");
        } catch {}
      }
    }, WORKFLOW_TIMEOUT_MS);
    // Ensure timeout is cleared when workflow settles
    const clearWorkflowTimeout = () => clearTimeout(workflowTimeout);

    const shouldUseRealAgent = !request.forceHeuristic && this.useRealRuntime && !!this.getOrCreateRuntime;
    const agentExecutor = shouldUseRealAgent ? this.createAgentExecutor(sessionId, request.userId, controller.signal, adapter) : undefined;

    // Snapshot adapter for phase transitions
    const engine = createWorkflowEngine({
      workspacePath,
      sessionId,
      taskId,
      turnId,
      signal: controller.signal,
      verificationCommands: request.verificationCommands,
      agentExecutor,
      onPhaseChange: (phase: string, task: WorkflowTask) => {
        // Map workflow phases to TaskStatus for task.state_changed
        const statusMap: Record<string, string> = {
          understanding: "reconnaissance",
          inspecting: "reconnaissance",
          building_context: "reconnaissance",
          planning: "planning",
          awaiting_approval: "user_input_required",
          implementing: "implementing",
          verifying: "testing",
          diagnosing: "diagnosing",
          repairing: "repairing",
          reviewing: "reviewing",
          summarizing: "validating",
          completed: "complete",
          failed: "failed_safely",
          cancelled: "cancelled",
        };
        const to = statusMap[phase] ?? phase;
        adapter.emitTaskStateChanged(taskId, task.phase, to);
        adapter.emitStatusChanged(task.phase, phase);
        // Persist session status
        try {
          this.persistence.upsertSession({
            id: sessionId,
            title: task.title,
            createdAt: task.createdAt,
            updatedAt: new Date().toISOString(),
            status: (to as unknown as "running") ?? "running",
            taskTitle: task.title,
            workspacePath,
          });
        } catch {}
      },
      onEvent: (evt: { type: string; payload: unknown }) => {
        if (evt.type === "workflow.plan_created") {
          const payload = evt.payload as { planId: string; steps: number };
          const safePlanTitle = redactSecrets(`Plan for ${request.message.slice(0, 40)}`);
          adapter.emitPlanStarted(payload.planId, taskId, safePlanTitle);
          // Also persist plan as WorkItem
          try {
            this.persistence.upsertWorkItem({
              kind: "plan",
              id: payload.planId,
              sessionId,
              turnId,
              title: safePlanTitle,
              status: "draft",
              steps: [],
              comments: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            } as unknown as import("@codeforge/sessions").WorkItem);
          } catch {}
        } else if (evt.type === "workflow.approval_requested") {
          // Handled via askForApproval below
        }
      },
      askForApproval: async (plan: WorkflowPlan) => {
        // Use authoritative ApprovalService — ensure secrets never leak into approval records
        const safePlanTitle = redactSecrets(plan.title);
        const safeDescription = redactSecrets(`Execute plan ${plan.id}: ${safePlanTitle}`);
        const risk = plan.steps.some((s: WorkflowPlan["steps"][number]) => s.risk === "critical") ? "critical" : plan.steps.some((s: WorkflowPlan["steps"][number]) => s.risk === "high") ? "high" : "moderate";
        const { approvalId, promise } = this.approvalService.requestApproval({
          turnId,
          tool: "workflow",
          action: "execute_plan",
          description: safeDescription,
          risk,
          scope: workspacePath,
          signal: controller.signal,
        });
        adapter.emitApprovalRequested(approvalId, "workflow", "execute_plan", safeDescription, risk, workspacePath);
        // Persist approval as WorkItem
        try {
          this.persistence.upsertWorkItem({
            kind: "approval",
            id: approvalId,
            sessionId,
            turnId,
            tool: "workflow",
            action: "execute_plan",
            description: safeDescription,
            risk,
            scope: workspacePath,
            createdAt: new Date().toISOString(),
          } as unknown as import("@codeforge/sessions").WorkItem);
        } catch {}

        const result = await promise;
        // Cleanup legacy persistence? Update work item decision
        try {
          const decision = result.approved ? "allow_once" as const : "deny" as const;
          adapter.emitApprovalResolved(approvalId, decision);
          this.persistence.upsertWorkItem({
            kind: "approval",
            id: approvalId,
            sessionId,
            turnId,
            tool: "workflow",
            action: "execute_plan",
            description: safeDescription,
            risk,
            scope: workspacePath,
            decision,
            resolvedAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          } as unknown as import("@codeforge/sessions").WorkItem);
        } catch {}
        return result.approved ? "allow_once" : "deny";
      },
    });

    // Track
    const task: WorkflowTask = engine.getTask();
    const promise = engine.run(request.message).then(
      (result: WorkflowResult) => {
        clearWorkflowTimeout();
        // A workflow that has reached a terminal state must not leave a live approval behind it.
        // An approval outliving its workflow is an orphan: it still holds a resolver that could
        // admit a tool execution for work nobody is waiting on any more, and it renders as a card
        // that looks actionable but has nothing left to act on.
        try { this.approvalService.cancelForTurn(turnId, "Workflow finished before this approval was answered"); } catch {}
        // Redact secrets in summary/diff for safe persistence/display
        const safeSummary = redactSecrets(result.summary);
        const safeDiff = result.diffSummary ? redactSecrets(result.diffSummary) : undefined;
        const safeResult = { ...result, summary: safeSummary, diffSummary: safeDiff };
        if (safeResult.status === "completed") {
          adapter.emitTaskCompleted(taskId, safeResult.summary);
          adapter.emitStatusChanged("running", "completed");
          // Evidence and checkpoint as artifacts
          if (safeResult.evidenceId) {
            adapter.emitEvidenceCreated(safeResult.evidenceId, safeResult.summary.slice(0, 500), [
              { kind: "file", ref: safeDiff?.slice(0, 100) ?? "workflow" },
            ]);
            try {
              this.persistence.upsertWorkItem({
                kind: "evidence",
                id: safeResult.evidenceId,
                sessionId,
                turnId,
                conclusion: safeResult.summary.slice(0, 500),
                references: [],
                createdAt: new Date().toISOString(),
              } as unknown as import("@codeforge/sessions").WorkItem);
            } catch {}
          }
          if (safeResult.checkpointId) {
            adapter.emitCheckpointCreated(safeResult.checkpointId, `Workflow ${taskId.slice(0, 8)}`, safeResult.review?.diffs.length ?? 0);
          }
          // Final turn-like completion for compatibility
          adapter.emitTurnCompleted(turnId, safeResult.summary);
        } else if (safeResult.status === "failed") {
          adapter.emitTaskStateChanged(taskId, "implementing", "failed_safely");
          adapter.emitTurnFailed(turnId, safeResult.summary);
          adapter.emitStatusChanged("running", "failed");
        } else if (safeResult.status === "cancelled") {
          adapter.emitTaskCancelled(taskId, safeResult.summary);
          adapter.emitTurnCancelled(turnId, safeResult.summary);
          adapter.emitStatusChanged("running", "cancelled");
        }
        // Persist final session status (redacted)
        try {
          const safeMsg = redactSecrets(request.message.slice(0, 80));
          this.persistence.upsertSession({
            id: sessionId,
            title: safeMsg,
            createdAt: task.createdAt,
            updatedAt: new Date().toISOString(),
            status: safeResult.status === "completed" ? "completed" : safeResult.status === "cancelled" ? "cancelled" : "failed",
            taskTitle: safeMsg,
            workspacePath,
          });
          this.persistence.upsertTurn({
            id: turnId,
            sessionId,
            seq: this.eventStore.getLastSeq(),
            userMessage: redactSecrets(request.message),
            status: safeResult.status === "completed" ? "completed" : safeResult.status === "cancelled" ? "cancelled" : "failed",
            startedAt: task.createdAt,
            completedAt: new Date().toISOString(),
            error: safeResult.status !== "completed" ? safeResult.summary : undefined,
          });
        } catch {}
        return safeResult;
      },
      (error: unknown) => {
        clearWorkflowTimeout();
        // Same invariant on the failure path: no approval survives the workflow that requested it.
        try { this.approvalService.cancelForTurn(turnId, "Workflow failed before this approval was answered"); } catch {}
        const raw = error instanceof Error ? error.message : String(error);
        const msg = redactSecrets(raw);
        adapter.emitTurnFailed(turnId, msg);
        adapter.emitTaskStateChanged(taskId, "running", "failed_safely");
        adapter.emitStatusChanged("running", "failed");
        return {
          taskId,
          status: "failed" as const,
          phase: "failed" as const,
          summary: msg,
        };
      },
    );

    // Ensure timeout and promise cleanup on settle
    promise.finally(clearWorkflowTimeout).catch(() => clearWorkflowTimeout());

    this.workflows.set(taskId, { engine, controller, promise, task: engine.getTask() });

    // Also persist initial turn as running (redacted)
    try {
      this.persistence.upsertTurn({
        id: turnId,
        sessionId,
        seq: this.eventStore.getLastSeq(),
        userMessage: redactSecrets(request.message),
        status: "running",
        startedAt: task.createdAt,
      });
    } catch {}

    return { taskId, turnId };
  }

  getWorkflow(taskId: string): { task: WorkflowTask; promise: Promise<WorkflowResult> } | undefined {
    const entry = this.workflows.get(taskId);
    if (!entry) return undefined;
    return { task: entry.engine.getTask(), promise: entry.promise };
  }

  listWorkflows(): WorkflowTask[] {
    return Array.from(this.workflows.values()).map((w) => w.engine.getTask());
  }

  async cancelWorkflow(taskId: string, reason = "User cancelled"): Promise<void> {
    const entry = this.workflows.get(taskId);
    if (!entry) throw new Error(`Workflow ${taskId} not found`);
    const currentPhase = entry.engine.getTask().phase;
    // Idempotent: terminal workflows already finished — no duplicate side effects
    if (!isActivePhase(currentPhase)) {
      return;
    }
    // Abort exactly once — subsequent aborts are no-ops
    if (!entry.controller.signal.aborted) {
      entry.controller.abort();
    }
    this.approvalService.cancelForTurn(entry.task.turnId, reason);
    // Also cancel any AgentRuntime turn that may be running for this workflow
    try {
      if (this.getOrCreateRuntime) {
        const rt = this.getOrCreateRuntime(entry.task.sessionId);
        const active = rt.getActiveTurns();
        for (const t of active) {
          try { await rt.cancelTurn(t.turnId, reason); } catch {}
        }
      }
    } catch {}
  }

  cancelAll(reason = "Workspace changed"): void {
    for (const [id, entry] of Array.from(this.workflows.entries())) {
      if (entry.task.phase !== "completed" && entry.task.phase !== "failed" && entry.task.phase !== "cancelled") {
        entry.controller.abort();
        this.approvalService.cancelForTurn(entry.task.turnId, reason);
        try {
          if (this.getOrCreateRuntime) {
            const rt = this.getOrCreateRuntime(entry.task.sessionId);
            for (const t of rt.getActiveTurns()) {
              rt.cancelTurn(t.turnId, reason).catch(() => {});
            }
          }
        } catch {}
      }
    }
  }

  setWorkspacePath(p: string): void {
    // Cancel running workflows when workspace changes — prevents cross-workspace file writes
    if (this.defaultWorkspacePath && this.defaultWorkspacePath !== p) {
      this.cancelAll("Workspace changed");
    }
    this.defaultWorkspacePath = p;
  }

  getRunningCountForSession(sessionId: string): number {
    return Array.from(this.workflows.values()).filter(
      (w) => w.task.sessionId === sessionId && isActivePhase(w.engine.getTask().phase),
    ).length;
  }

  getActiveCount(): number {
    return Array.from(this.workflows.values()).filter((w) => isActivePhase(w.engine.getTask().phase)).length;
  }

  /**
   * Graceful shutdown — cancel active workflows and release resources exactly once.
   * Never silently duplicates execution; marks interrupted tasks as cancelled.
   */
  shutdown(reason = "Server shutting down"): void {
    for (const entry of Array.from(this.workflows.values())) {
      if (isActivePhase(entry.engine.getTask().phase) && !entry.controller.signal.aborted) {
        try { entry.controller.abort(); } catch {}
        try { this.approvalService.cancelForTurn(entry.task.turnId, reason); } catch {}
      }
    }
    this.approvalService.cancelAll(reason);
  }

  /**
   * Whether a task is in a terminal state (immutable).
   */
  isTerminal(taskId: string): boolean {
    const entry = this.workflows.get(taskId);
    if (!entry) return false;
    const phase = entry.engine.getTask().phase;
    return phase === "completed" || phase === "failed" || phase === "cancelled";
  }
}

export function createWorkflowService(options: WorkflowServiceOptions): WorkflowService {
  return new WorkflowService(options);
}
