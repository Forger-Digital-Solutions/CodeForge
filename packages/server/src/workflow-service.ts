import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createWorkspaceEventAdapter, type WorkspaceEventAdapter } from "./workspace-event-adapter.js";
import { ApprovalService } from "./approval-service.js";
import type { EventStore, ISessionPersistence } from "@codeforge/sessions";
import {
  createWorkflowEngine,
  type WorkflowEngine,
  type WorkflowTask,
  type WorkflowResult,
} from "@codeforge/workflow";
import type { WorkflowPlan, ContextBundle, RepoMap, FailureAnalysis, VerificationResult, TaskIntent } from "@codeforge/workflow";
import type { ForgeVerifyObserver, VerificationAttempt, VerificationEvidence, VerificationPlan } from "@codeforge/workflow";
import type { AgentRuntime } from "./agent-runtime.js";
import type { UserIntentHoldController } from "./user-intent-hold.js";
import { redactSecrets } from "@codeforge/secrets";
import { WorkspaceService, createWorkspaceService, type WorkspaceLease } from "./workspace-service.js";

export interface WorkflowServiceOptions {
  eventStore: EventStore;
  persistence: ISessionPersistence;
  workspacePath?: string;
  workspaceService?: WorkspaceService;
  /** Factory for AgentRuntime per session — connects workflow to real execution pipeline */
  getOrCreateRuntime?: (sessionId: string, userId?: string) => AgentRuntime;
  /** When true, Implement/Repair phases delegate to AgentRuntime (real LLM + tools); else heuristic */
  /**
   * Boolean or predicate. A predicate is re-evaluated per run so a provider connected AFTER boot
   * flips the workflow to the real agent, exactly as the turn path already does. A stale `false`
   * here silently routes real work to the heuristic implementer.
   */
  useRealRuntime?: boolean | (() => boolean);
  userIntentHold?: UserIntentHoldController;
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

/** A persisted running process has no trustworthy terminal result after a service restart. */
async function recoverInterruptedForgeVerifyAttempts(persistence: ISessionPersistence, sessionId: string): Promise<void> {
  const now = new Date().toISOString();
  for (const item of await persistence.getWorkItems(sessionId)) {
    if (item.kind !== "verification" || item.recordType !== "attempt" || item.status !== "running") continue;
    const payload = { ...item.payload, status: "interrupted", finishedAt: now, terminationReason: "restart" };
    await persistence.upsertWorkItem({ ...item, status: "interrupted", payload, updatedAt: now });
  }
}

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

function sanitizeInspectionText(value: string, limit = 2_000): string {
  const redacted = redactSecrets(value)
    .replace(/\b(?:[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|API(?:_|-)?KEY|PASSWORD)|AUTHORIZATION)\s*=\s*[^\s;&]+/gi, "[REDACTED]")
    .replace(/--(?:token|api(?:_|-)?key|secret|password|authorization)(?:=|\s+)\S+/gi, "[REDACTED]");
  return redacted.length > limit ? `${redacted.slice(0, limit)}\n[TRUNCATED]` : redacted;
}

function safeVerificationAttempt(result: VerificationResult, attempt: number) {
  const report = result as VerificationResult & { verifiers?: Array<{
    id: string;
    kind: "test" | "typecheck" | "build" | "lint" | "custom";
    command: string;
    required: boolean;
    status: "passed" | "failed" | "not_configured" | "timed_out" | "cancelled";
    passed: number;
    failed: number;
    skipped: number;
    exitCode: number;
    durationMs: number;
    failures: Array<{ message: string }>;
  }> };
  return {
    attempt,
    notConfigured: result.notConfigured === true,
    passed: result.passed,
    failed: result.failed,
    skipped: result.skipped,
    durationMs: result.durationMs,
    verifiers: (report.verifiers ?? []).map((verifier) => ({
      id: verifier.id,
      kind: verifier.kind,
      command: sanitizeInspectionText(verifier.command, 500),
      required: verifier.required,
      status: verifier.status,
      passed: verifier.passed,
      failed: verifier.failed,
      skipped: verifier.skipped,
      exitCode: verifier.exitCode,
      durationMs: verifier.durationMs,
      ...(verifier.failures[0]?.message ? { failureSummary: sanitizeInspectionText(verifier.failures[0].message, 500) } : {}),
    })),
  };
}

export class WorkflowService {
  private readonly eventStore: EventStore;
  private readonly persistence: ISessionPersistence;
  private readonly approvalService: ApprovalService;
  private readonly workspaceService: WorkspaceService;
  private readonly workflows: Map<string, { engine: WorkflowEngine; controller: AbortController; promise: Promise<WorkflowResult>; task: WorkflowTask }> = new Map();
  private defaultWorkspacePath?: string;
  private readonly getOrCreateRuntime?: (sessionId: string, userId?: string) => AgentRuntime;
  private readonly isRealRuntimeEnabled: () => boolean;
  private readonly userIntentHold?: UserIntentHoldController;

  constructor(options: WorkflowServiceOptions) {
    this.eventStore = options.eventStore;
    this.persistence = options.persistence;
    this.defaultWorkspacePath = options.workspacePath;
    this.workspaceService = options.workspaceService ?? createWorkspaceService({ persistence: options.persistence });
    this.approvalService = new ApprovalService({ defaultTimeoutMs: 5 * 60 * 1000 });
    this.getOrCreateRuntime = options.getOrCreateRuntime;
    const realRuntime = options.useRealRuntime ?? false;
    this.isRealRuntimeEnabled = typeof realRuntime === "function" ? realRuntime : () => realRuntime;
    this.userIntentHold = options.userIntentHold;
  }

  /** Must be awaited once after construction — reclassifies persisted state before serving. */
  async init(): Promise<void> {
    await this.recoverStalePersistedState();
  }

  private async recoverStalePersistedState(): Promise<void> {
    try {
      const sessions = await this.persistence.listSessions();
      for (const sess of sessions) {
        const statusStr = sess.status as string;
        const isTerminal = statusStr === "completed" || statusStr === "failed" || statusStr === "cancelled" || statusStr === "failed_safely";
        if (!isTerminal) {
          // A turn record contains durable user intent and may be owned by AgentRuntime rather
          // than a workflow. Failing it here destroys the information needed for the runtime's
          // explicit hydrate/classify/replan path. Preserve the turn facts and put only the
          // session in a visible recovery hold; no continuation is resumed from this method.
          try {
            await this.persistence.upsertSession({
              ...sess,
              status: "recovering",
              updatedAt: new Date().toISOString(),
            });
          } catch {}
          await recoverInterruptedForgeVerifyAttempts(this.persistence, sess.id);
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
        const turnId = await runtime.startTurn(prompt, adapter);
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
        const turnId = await runtime.startTurn(prompt, adapter);
        const result = await waitForTurn(runtime, turnId);
        if (result.status === "completed") return { success: true, output: `Repair turn ${turnId} completed`, turnId };
        return { success: false, output: `Repair turn ${turnId} ${result.status}` };
      },
    };
  }

  async startWorkflow(request: WorkflowRunRequest): Promise<{ taskId: string; turnId: string }> {
    const sessionId = request.sessionId;
    recoverInterruptedForgeVerifyAttempts(this.persistence, sessionId);
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

    const taskId = crypto.randomUUID();
    const turnId = crypto.randomUUID();
    const adapter = createWorkspaceEventAdapter({
      sessionId,
      runId: taskId,
      eventStore: this.eventStore,
      persistence: this.persistence,
    });

    // Acquire exclusive write lease for this workspace (throws WORKSPACE_LEASE_CONFLICT on conflict)
    const lease = this.workspaceService.acquireLease(workspacePath, taskId, "write");

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

    const shouldUseRealAgent = !request.forceHeuristic && this.isRealRuntimeEnabled() && !!this.getOrCreateRuntime;
    const agentExecutor = shouldUseRealAgent ? this.createAgentExecutor(sessionId, request.userId, controller.signal, adapter) : undefined;

    const repairAttempts: Array<{ attempt: number; summary: string }> = [];
    const persistForgeVerify = async (recordType: "plan" | "attempt" | "evidence", id: string, planId: string, value: VerificationPlan | VerificationAttempt | VerificationEvidence): Promise<void> => {
      const createdAt = "createdAt" in value ? value.createdAt : value.startedAt;
      const updatedAt = "finishedAt" in value && value.finishedAt ? value.finishedAt : createdAt;
      const item = {
        kind: "verification",
        id,
        sessionId,
        runId: taskId,
        recordType,
        planId,
        ...("verifierId" in value ? { verifierId: value.verifierId } : {}),
        ...("status" in value ? { status: value.status } : {}),
        payload: JSON.parse(JSON.stringify(value)) as Record<string, unknown>,
        createdAt,
        updatedAt,
      } as import("@codeforge/sessions").WorkItem;
      if (recordType === "plan" || recordType === "evidence") await this.persistence.insertImmutableWorkItem(item);
      else await this.persistence.upsertWorkItem(item);
    };
    const verificationObserver: ForgeVerifyObserver = {
      planCreated: async (plan) => {
        await persistForgeVerify("plan", plan.planId, plan.planId, plan);
        await adapter.emitForgeVerifyPlanCreated(taskId, plan.planId, plan.policyVersion, plan.verifiers.filter((verifier) => verifier.requirement === "required").map((verifier) => verifier.verifierId));
      },
      attemptStarted: async (attempt) => {
        await persistForgeVerify("attempt", attempt.attemptId, attempt.planId, attempt);
        await adapter.emitForgeVerifyAttemptStarted(taskId, attempt.planId, attempt.attemptId, attempt.verifierId);
      },
      attemptTerminal: (attempt) => persistForgeVerify("attempt", attempt.attemptId, attempt.planId, attempt),
      evidenceCreated: async (evidence) => {
        await persistForgeVerify("evidence", evidence.evidenceId, evidence.planId, evidence);
        await adapter.emitForgeVerifyEvidenceCreated(taskId, evidence.planId, evidence.attemptId, evidence.evidenceId, evidence.verifierId, evidence.status, evidence.elapsedMs, evidence.outputTruncated);
      },
    };
    // Snapshot adapter for phase transitions
    const engine = createWorkflowEngine({
      workspacePath,
      sessionId,
      taskId,
      turnId,
      signal: controller.signal,
      verificationCommands: request.verificationCommands,
      verificationObserver,
      agentExecutor,
      beforeVerificationDispatch: this.userIntentHold
        ? () => this.userIntentHold!.waitForDispatch(sessionId, "verifier")
        : undefined,
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
          blocked: "blocked",
          failed: "failed_safely",
          cancelled: "cancelled",
        };
        const to = statusMap[phase] ?? phase;
        adapter.emitTaskStateChanged(taskId, task.phase, to);
        adapter.emitStatusChanged(task.phase, phase);
        // Persist session status — phase telemetry, so best-effort by design
        this.persistence.upsertSession({
          id: sessionId,
          title: task.title,
          createdAt: task.createdAt,
          updatedAt: new Date().toISOString(),
          status: (to as unknown as "running") ?? "running",
          taskTitle: task.title,
          workspacePath,
        }).catch(() => {});
      },
      onEvent: (evt: { type: string; payload: unknown }) => {
        if (evt.type === "workflow.plan_created") {
          const payload = evt.payload as { planId: string; steps: number };
          const safePlanTitle = redactSecrets(`Plan for ${request.message.slice(0, 40)}`);
          adapter.emitPlanStarted(payload.planId, taskId, safePlanTitle);
          // Also persist plan as WorkItem — best-effort progress record
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
          } as unknown as import("@codeforge/sessions").WorkItem).catch(() => {});
        } else if (evt.type === "workflow.approval_requested") {
          // Handled via askForApproval below
        } else if (evt.type === "workflow.verification_started") {
          const payload = evt.payload as { attempt: number };
          adapter.emitWorkflowVerificationStarted(taskId, payload.attempt);
        } else if (evt.type === "workflow.plan_revised") {
          // CF-17: a consumed steer superseded the plan revision; announce it durably so the UI
          // and the event journal reflect that previous verification authority is now stale.
          const payload = evt.payload as { planId: string; fromRevision: number; toRevision: number };
          void adapter.emitPlanStatusChanged(payload.planId, "superseded").catch(() => {});
        } else if (evt.type === "workflow.verification_completed") {
          const payload = evt.payload as { attempt: number; verification: VerificationResult };
          const safeAttempt = safeVerificationAttempt(payload.verification, payload.attempt);
          adapter.emitWorkflowVerificationCompleted(taskId, payload.attempt, safeAttempt);
        } else if (evt.type === "workflow.repair_attempted") {
          const payload = evt.payload as { attempt: number; analysis: FailureAnalysis };
          const summary = sanitizeInspectionText(payload.analysis.summary, 500);
          repairAttempts.push({ attempt: payload.attempt, summary });
          adapter.emitWorkflowRepairAttempted(taskId, payload.attempt, summary);
        } else if (evt.type === "workflow.review_finished") {
          const payload = evt.payload as {
            approved: boolean;
            diffCount: number;
            findings: Array<{ code: string; severity: "blocking" | "advisory"; path: string; message: string }>;
          };
          adapter.emitWorkflowReviewCompleted(taskId, payload.approved, payload.findings.map((finding) => ({
            ...finding,
            path: sanitizeInspectionText(finding.path, 500),
            message: sanitizeInspectionText(finding.message, 500),
          })), payload.diffCount);
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
          await this.persistence.upsertWorkItem({
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
          await adapter.emitApprovalResolved(approvalId, decision);
          await this.persistence.upsertWorkItem({
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
      async (result: WorkflowResult) => {
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
        if (safeResult.completion) {
          await adapter.emitWorkflowCompletionDecided(
            taskId,
            safeResult.completion.outcome,
            sanitizeInspectionText(safeResult.completion.rationale, 1_000),
            safeResult.completion.blockers.map((blocker) => ({
              code: blocker.code,
              severity: blocker.severity,
              message: sanitizeInspectionText(blocker.message, 500),
            })),
          );
        }

        // Capture the terminal evidence once, at the run boundary. Reopening this record never
        // reads the mutable workspace, so unrelated user edits after completion cannot rewrite a
        // historical diff or verification receipt.
        try {
          const verificationAttempts = (safeResult.verificationAttempts ?? (safeResult.verification ? [safeResult.verification] : []))
            .map((verification, index) => safeVerificationAttempt(verification, index + 1));
          const forgeVerify = (safeResult.verification as import("@codeforge/workflow").VerificationReport | undefined)?.forgeVerify;
          const inspection = {
            kind: "run_inspection" as const,
            id: taskId,
            sessionId,
            runId: taskId,
            turnId,
            executionMode: "agent" as const,
            taskTitle: sanitizeInspectionText(task.title, 500),
            status: safeResult.status === "requires_approval" ? "failed" : safeResult.status,
            phase: safeResult.phase,
            workspace: { id: taskId, kind: "local" as const, checkpointId: safeResult.checkpointId },
            diffs: (safeResult.review?.diffs ?? []).map((diff) => ({
              path: sanitizeInspectionText(diff.path, 1_000),
              changeType: diff.changeType,
              additions: Math.max(0, diff.additions),
              deletions: Math.max(0, diff.deletions),
              diff: diff.binary ? "" : sanitizeInspectionText(diff.diff, 32 * 1024),
              ...(diff.binary ? { binary: true } : {}),
              ...(diff.beforeSize !== undefined ? { beforeSize: diff.beforeSize } : {}),
              ...(diff.afterSize !== undefined ? { afterSize: diff.afterSize } : {}),
              ...(diff.truncated ? { truncated: true } : {}),
            })),
            verificationAttempts,
            ...(forgeVerify ? {
              verification: {
                planId: forgeVerify.plan.planId,
                policyVersion: forgeVerify.plan.policyVersion,
                requiredCount: forgeVerify.summary.requiredCount,
                satisfiedCount: forgeVerify.summary.satisfiedCount,
                missingCount: forgeVerify.summary.missingCount,
                staleCount: forgeVerify.summary.staleCount,
                verificationComplete: forgeVerify.summary.verificationComplete,
                missingRequiredVerifiers: [...forgeVerify.summary.missingRequiredVerifiers],
                evidence: forgeVerify.evidence.map((evidence) => ({
                  evidenceId: evidence.evidenceId,
                  verifierId: evidence.verifierId,
                  status: evidence.status,
                  durationMs: evidence.elapsedMs,
                  outputTruncated: evidence.outputTruncated,
                })),
              },
            } : {}),
            repairs: repairAttempts,
            ...(safeResult.review ? {
              review: {
                approved: safeResult.review.approved,
                findings: safeResult.review.findings.map((finding) => ({
                  code: finding.code,
                  severity: finding.severity,
                  path: sanitizeInspectionText(finding.path, 1_000),
                  message: sanitizeInspectionText(finding.message, 1_000),
                })),
              },
            } : {}),
            ...(safeResult.completion ? {
              completion: {
                outcome: safeResult.completion.outcome,
                rationale: sanitizeInspectionText(safeResult.completion.rationale, 1_000),
                blockers: safeResult.completion.blockers.map((blocker) => ({
                  code: blocker.code,
                  severity: blocker.severity,
                  message: sanitizeInspectionText(blocker.message, 500),
                })),
              },
            } : {}),
            startedAt: task.createdAt,
            completedAt: new Date().toISOString(),
            createdAt: task.createdAt,
            updatedAt: new Date().toISOString(),
          };
          await this.persistence.upsertWorkItem(inspection as unknown as import("@codeforge/sessions").WorkItem);
        } catch {}
        // Evidence belongs to any run that reached a considered verdict — a run held back by the
        // completion gate is exactly when the user most needs to see what was done and why.
        if (safeResult.status === "completed" || safeResult.status === "blocked") {
          if (safeResult.evidenceId) {
            adapter.emitEvidenceCreated(safeResult.evidenceId, safeResult.summary.slice(0, 500), [
              { kind: "file", ref: safeDiff?.slice(0, 100) ?? "workflow" },
            ]);
            try {
              await this.persistence.upsertWorkItem({
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
        }

        if (safeResult.status === "completed") {
          adapter.emitTaskCompleted(taskId, safeResult.summary);
          adapter.emitStatusChanged("running", "completed");
          // Final turn-like completion for compatibility
          await adapter.emitTurnCompleted(turnId, safeResult.summary);
        } else if (safeResult.status === "blocked") {
          adapter.emitTaskStateChanged(taskId, "implementing", "blocked");
          await adapter.emitTurnFailed(turnId, safeResult.summary);
          adapter.emitStatusChanged("running", "failed");
        } else if (safeResult.status === "failed") {
          adapter.emitTaskStateChanged(taskId, "implementing", "failed_safely");
          await adapter.emitTurnFailed(turnId, safeResult.summary);
          adapter.emitStatusChanged("running", "failed");
        } else if (safeResult.status === "cancelled") {
          adapter.emitTaskCancelled(taskId, safeResult.summary);
          await adapter.emitTurnCancelled(turnId, safeResult.summary);
          adapter.emitStatusChanged("running", "cancelled");
        }
        // Persist final session status (redacted)
        try {
          const safeMsg = redactSecrets(request.message.slice(0, 80));
          await this.persistence.upsertSession({
            id: sessionId,
            title: safeMsg,
            createdAt: task.createdAt,
            updatedAt: new Date().toISOString(),
            status: safeResult.status === "completed" ? "completed" : safeResult.status === "cancelled" ? "cancelled" : "failed",
            taskTitle: safeMsg,
            workspacePath,
          });
          await this.persistence.upsertTurn({
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
      async (error: unknown) => {
        clearWorkflowTimeout();
        // Same invariant on the failure path: no approval survives the workflow that requested it.
        try { this.approvalService.cancelForTurn(turnId, "Workflow failed before this approval was answered"); } catch {}
        const raw = error instanceof Error ? error.message : String(error);
        const msg = redactSecrets(raw);
        await adapter.emitTurnFailed(turnId, msg);
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

    // Ensure timeout and lease cleanup on settle
    const cleanup = () => {
      clearWorkflowTimeout();
      try {
        this.workspaceService.releaseLease(lease.leaseId, taskId);
      } catch {}
    };
    promise.finally(cleanup).catch(() => cleanup());

    this.workflows.set(taskId, { engine, controller, promise, task: engine.getTask() });

    // Also persist initial turn as running (redacted)
    try {
      await this.persistence.upsertTurn({
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

  /**
   * CF-17: accepts a user steer for a running workflow. Exactly-once acceptance is durable —
   * a `steer_receipt` work item with a unique id is inserted through `insertIfAbsent`, so a
   * retried delivery can never reach the engine twice, across restarts or concurrent requests.
   * The steer text carries no authority: at the engine's post-verification safe boundary it only
   * increments the plan revision and forces fresh ForgeVerify verification for that revision.
   */
  async steerWorkflow(taskId: string, sessionId: string, message: string, steerId?: string): Promise<{ ok: boolean; duplicate?: boolean; error?: string }> {
    const entry = this.workflows.get(taskId);
    if (!entry) return { ok: false, error: "WORKFLOW_NOT_FOUND" };
    const resolvedSteerId = steerId ?? `steer-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const receipt = {
      kind: "steer_receipt",
      id: `steer-receipt-${sessionId}-${resolvedSteerId}`,
      sessionId,
      steerId: resolvedSteerId,
      turnId: entry.task.turnId,
      message: redactSecrets(message),
      createdAt: now,
      updatedAt: now,
    } as unknown as import("@codeforge/sessions").WorkItem;
    const accepted = await this.persistence.insertIfAbsent(receipt);
    if (!accepted) return { ok: true, duplicate: true };
    try {
      entry.engine.steer(redactSecrets(message), resolvedSteerId);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true };
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
