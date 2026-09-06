import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { ISessionPersistence } from "@codeforge/sessions";
import type { AgentRuntime } from "./agent-runtime.js";
import type { WorkspaceService, ForgeWorkspace, WorkspaceLease } from "./workspace-service.js";
import type { IntegrationService } from "./integration-service.js";
import { createIntegrationService } from "./integration-service.js";
import type { AgentFinding, AgentUsage, EngineeringPlanResult, ReviewResult } from "@codeforge/agent";
import type { ToolExecutionRecord } from "@codeforge/tools";
import { runVerification, type VerificationResult } from "@codeforge/workflow";
import { getSanitizedEnvForChild } from "./env-filter.js";
import { DEFAULT_PARALLEL_EXECUTION_BUDGET, WorkstreamContractRegistry, type ParallelExecutionBudget, type EngineeringPlan, type EngineeringWorkstream, type WorkstreamContract, type WorkstreamResult, scheduleWorkstreams, validateEngineeringPlan } from "./parallel-workstreams.js";
import { ParallelRunStore, emptyParallelRunUsage, type DurableParallelRun, type ParallelEvent, type ParallelRunUsage, type ParallelSynthesisState } from "./parallel-state.js";
import { createForgeVerifyPersistenceObserver } from "./forge-verify-persistence.js";

const execFile = promisify(execFileCallback);

/**
 * Per-agent briefing that must never cross an agent boundary.  Keys are `coder:<workstreamId>`,
 * `reviewer:<workstreamId>` and `global-reviewer`; the value reaches only that one agent's own
 * provider request and is never written to contracts, events, or durable parallel state.
 */
export type PrivateAgentContext = Record<string, string>;

export interface ParallelRunOptions {
  sessionId: string; workspacePath: string; goal: string; verificationCommands?: string[];
  budget?: ParallelExecutionBudget; signal?: AbortSignal; privateAgentContext?: PrivateAgentContext;
  /** Caller-supplied stable run identity. A mission uses it so a restart cannot dispatch twice. */
  runId?: string;
}
export interface ParallelResumeOptions { signal?: AbortSignal; verificationCommands?: string[]; privateAgentContext?: PrivateAgentContext; }
export interface ParallelRunResult { runId: string; status: "completed" | "blocked" | "failed" | "cancelled"; plan?: EngineeringPlan; workstreams: WorkstreamResult[]; synthesis?: ParallelSynthesisState; verification: VerificationResult[]; usage: ParallelRunUsage; error?: string; }
export interface ParallelOrchestratorOptions { workspaceService: WorkspaceService; agentRuntime: AgentRuntime; integrationService?: IntegrationService; persistence?: ISessionPersistence; onEvent?: (event: ParallelEvent) => void; }

const TERMINAL_STATUSES = ["completed", "blocked", "cancelled", "failed"];

const WRITE_TOOLS = new Set(["write_file", "edit_file"]);
const COMMAND_TOOLS = new Set(["run_command"]);

function publishedContract(id: string, producerWorkstreamId: string, consumerWorkstreamIds: string[], revision: string, evidence: WorkstreamResult["evidence"]): WorkstreamContract {
  return { id, producerWorkstreamId, consumerWorkstreamIds, kind: "other", revision, summary: `Published contract ${id} at revision ${revision.slice(0, 12)}`, evidence: evidence.map(({ kind, ref, description }) => ({ kind, ref, ...(description ? { description } : {}) })) };
}

/** Only the structured, public fields of a Reviewer finding may reach another agent. */
function publicFindings(findings: AgentFinding[]): Array<Partial<AgentFinding>> {
  return findings.map(({ id, severity, category, message, evidence, path, line }) => ({ id, severity, category, message, ...(evidence ? { evidence } : {}), ...(path ? { path } : {}), ...(line !== undefined ? { line } : {}) }));
}

/** Bounded production coordinator; all writers receive an independent leased worktree. */
export class ParallelAutonomousRunOrchestrator {
  private readonly integrationService: IntegrationService;
  private readonly store: ParallelRunStore;
  private readonly activeControllers = new Map<string, AbortController>();

  constructor(private readonly options: ParallelOrchestratorOptions) { this.integrationService = options.integrationService ?? createIntegrationService({ workspaceService: options.workspaceService }); this.store = new ParallelRunStore(options.persistence, options.onEvent); }
  async getRun(runId: string): Promise<DurableParallelRun | undefined> { return await this.store.get(runId); }
  async listRuns(sessionId?: string): Promise<DurableParallelRun[]> { return await this.store.list(sessionId); }
  cancelRun(runId: string): boolean { const controller = this.activeControllers.get(runId); if (!controller || controller.signal.aborted) return false; controller.abort(new Error("PARALLEL_RUN_CANCELLED")); return true; }

  /**
   * CF-17 targeted parallel steering: durably, exactly-once accepts a steer scoped to one
   * workstream. The scope binding (`targetWorkstreamId` + the workstream's dispatch identity) is
   * persisted with the receipt, so it survives restarts and can never be consumed by a different
   * workstream. Invalid targets are rejected — never silently converted into a run-wide steer.
   */
  async steerWorkstream(runId: string, workstreamId: string, message: string, steerId?: string): Promise<{ ok: boolean; duplicate?: boolean; error?: string }> {
    if (!this.options.persistence) return { ok: false, error: "PARALLEL_STEER_UNAVAILABLE" };
    if (!workstreamId || !message) return { ok: false, error: "PARALLEL_STEER_MALFORMED" };
    const run = await this.store.get(runId);
    if (!run) return { ok: false, error: "PARALLEL_RUN_NOT_FOUND" };
    const resolvedSteerId = steerId ?? `steer-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const receipt = {
      kind: "steer_receipt",
      id: `steer-receipt-${run.sessionId}-${resolvedSteerId}`,
      sessionId: run.sessionId,
      steerId: resolvedSteerId,
      turnId: `${runId}:${workstreamId}`,
      targetWorkstreamId: workstreamId,
      message,
      createdAt: now,
      updatedAt: now,
    } as unknown as import("@codeforge/sessions").WorkItem;
    // A retried delivery of an already-accepted steer is a durable duplicate even if the run went
    // terminal in between; only a NEW steer is subject to the terminal/scope validation below.
    const existing = await this.options.persistence.getWorkItem(`steer-receipt-${run.sessionId}-${resolvedSteerId}`);
    if (existing) return { ok: true, duplicate: true };
    if (TERMINAL_STATUSES.includes(run.status)) return { ok: false, error: "PARALLEL_RUN_TERMINAL" };
    const planned = run.plan?.workstreams.find((stream) => stream.id === workstreamId);
    if (!planned) return { ok: false, error: "PARALLEL_WORKSTREAM_NOT_FOUND" };
    const dispatch = run.dispatches.find((entry) => entry.workstreamId === workstreamId);
    if (dispatch && (dispatch.state === "completed" || dispatch.state === "cancelled")) return { ok: false, error: "PARALLEL_WORKSTREAM_TERMINAL" };
    const accepted = await this.options.persistence.insertIfAbsent(receipt);
    if (!accepted) return { ok: true, duplicate: true };
    await this.emit(run, "parallel.workstream.steered", { workstreamId, steerId: resolvedSteerId }, workstreamId);
    return { ok: true };
  }

  /** Consumes one queued steer scoped to exactly this run+workstream; other scopes never match. */
  private async takeScopedSteer(runId: string, workstreamId: string): Promise<{ steerId: string; message: string } | undefined> {
    if (!this.options.persistence) return undefined;
    const receipts = await this.options.persistence.getWorkItemsByKind("steer_receipt");
    const pending = receipts.filter((item) => {
      const receipt = item as unknown as { turnId?: string; targetWorkstreamId?: string; consumedAt?: string; steerId?: string; message?: string };
      return receipt.turnId === `${runId}:${workstreamId}` && receipt.targetWorkstreamId === workstreamId && !receipt.consumedAt;
    });
    const receipt = pending[0];
    if (!receipt) return undefined;
    await this.options.persistence.upsertWorkItem({ ...receipt, consumedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as unknown as import("@codeforge/sessions").WorkItem);
    return { steerId: (receipt as unknown as { steerId: string }).steerId, message: (receipt as unknown as { message: string }).message };
  }

  async recoverRun(runId: string): Promise<DurableParallelRun | undefined> {
    const run = await this.store.get(runId);
    if (!run || TERMINAL_STATUSES.includes(run.status)) return run;
    const unsafe = run.dispatches.filter((dispatch) => dispatch.state === "dispatched" || dispatch.state === "active");
    if (unsafe.length) {
      run.dispatches = run.dispatches.map((dispatch) => unsafe.some((candidate) => candidate.dispatchId === dispatch.dispatchId) ? { ...dispatch, state: "revalidation_required" } : dispatch);
      run.status = "blocked"; run.error = "PARALLEL_RECOVERY_REVALIDATION_REQUIRED"; await this.save(run); await this.emit(run, "parallel.recovery.revalidation_required", { workstreamIds: unsafe.map((dispatch) => dispatch.workstreamId) });
    }
    return run;
  }
  private async git(cwd: string, args: string[]) { return execFile("git", args, { cwd, env: { ...getSanitizedEnvForChild(), GIT_TERMINAL_PROMPT: "0" } }); }
  private async save(run: DurableParallelRun): Promise<void> { run.updatedAt = new Date().toISOString(); await this.store.save(run); }
  private async emit(run: DurableParallelRun, type: string, payload: Record<string, unknown> = {}, workstreamId?: string): Promise<void> { await this.store.emit(run, type, payload, workstreamId); }
  private result(run: DurableParallelRun, verification: VerificationResult[]): ParallelRunResult { return { runId: run.id, status: run.status === "completed" ? "completed" : run.status === "cancelled" ? "cancelled" : run.status === "failed" ? "failed" : "blocked", ...(run.plan ? { plan: run.plan } : {}), workstreams: run.workstreams, ...(run.synthesis ? { synthesis: run.synthesis } : {}), verification, usage: run.usage ?? emptyParallelRunUsage(), ...(run.error ? { error: run.error } : {}) }; }

  /** Accumulates only metrics the provider boundary actually reports; nothing is estimated. */
  private record(run: DurableParallelRun, results: Array<{ usage: AgentUsage; toolExecutions: ToolExecutionRecord[] }>): void {
    const usage = run.usage ?? emptyParallelRunUsage();
    for (const result of results) {
      usage.inputTokens += result.usage.inputTokens; usage.outputTokens += result.usage.outputTokens;
      usage.modelRequests += result.usage.requestCount; usage.agentTurns += result.usage.requestCount; usage.toolCalls += result.usage.toolCount;
      usage.writeCalls += result.toolExecutions.filter((record) => WRITE_TOOLS.has(record.toolName)).length;
      usage.commandExecutions += result.toolExecutions.filter((record) => COMMAND_TOOLS.has(record.toolName)).length;
    }
    run.usage = usage;
  }


  private async verify(cwd: string, commands: string[], signal?: AbortSignal, run?: DurableParallelRun): Promise<VerificationResult[]> {
    if (!commands.length) return [];
    if (run) { run.usage = run.usage ?? emptyParallelRunUsage(); run.usage.verificationRuns += commands.length; }
    const report = await runVerification(cwd, commands, { signal, runId: run?.id, ...(run && this.options.persistence ? { observer: createForgeVerifyPersistenceObserver(this.options.persistence, run.sessionId) } : {}) });
    if (signal?.aborted) throw new Error("PARALLEL_RUN_CANCELLED");
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

  /**
   * Terminal retention pass for a cancelled parent run.  Cancellation must stop further work
   * without destroying autonomous results, so every dispatched worktree is classified rather
   * than force-removed: dirty worktrees are retained, committed branches survive worktree
   * removal.  Idempotent, so a repeated cancellation cannot double-clean.
   */
  private async finalizeCancellation(run: DurableParallelRun): Promise<void> {
    if (run.cleanupCompletedAt) return;
    for (const dispatch of run.dispatches) {
      if (!dispatch.worktreeId || dispatch.cleanup) continue;
      try {
        const outcome = await this.options.workspaceService.releaseWorktree(dispatch.worktreeId, false);
        dispatch.cleanup = outcome.status === "locked" || outcome.status === "ready" ? "orphaned" : outcome.status;
        if (outcome.branchPreserved) dispatch.branchPreserved = true;
        const workspace = this.options.workspaceService.getWorkspace(dispatch.worktreeId);
        if (outcome.status === "retained_dirty" && workspace) dispatch.retainedPath = workspace.rootPath;
      } catch { dispatch.cleanup = "orphaned"; }
    }
    run.cleanupCompletedAt = new Date().toISOString();
    await this.save(run);
    await this.emit(run, "parallel.cancellation.finalized", { retainedDirty: run.dispatches.filter((dispatch) => dispatch.cleanup === "retained_dirty").map((dispatch) => dispatch.workstreamId), branchesPreserved: run.dispatches.filter((dispatch) => dispatch.branchPreserved).map((dispatch) => dispatch.workstreamId) });
  }

  /**
   * Revalidate a persisted synthesis worktree against durable inclusion records before a fresh
   * runtime resumes it.  Fails closed rather than guessing: no reset, no replay, no repair.
   */
  private async revalidateSynthesis(run: DurableParallelRun): Promise<{ ok: true; head: string } | { ok: false; reason: string }> {
    const synthesis = run.synthesis;
    if (!synthesis) return { ok: false, reason: "SYNTHESIS_STATE_MISSING" };
    const workspace = this.options.workspaceService.getWorkspace(synthesis.worktreeId);
    if (!workspace) return { ok: false, reason: "SYNTHESIS_WORKSPACE_UNKNOWN" };
    if (!existsSync(workspace.rootPath)) return { ok: false, reason: "SYNTHESIS_WORKTREE_MISSING" };
    let head: string; let branch: string;
    try {
      head = (await this.git(workspace.rootPath, ["rev-parse", "HEAD"])).stdout.trim();
      branch = (await this.git(workspace.rootPath, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    } catch { return { ok: false, reason: "SYNTHESIS_WORKTREE_UNREADABLE" }; }
    if (synthesis.branch && branch !== synthesis.branch) return { ok: false, reason: "SYNTHESIS_BRANCH_DIVERGED" };
    const expected = synthesis.included.length ? synthesis.included[synthesis.included.length - 1]!.resultingRevision : run.baseRevision;
    if (head !== expected) return { ok: false, reason: "SYNTHESIS_HEAD_DIVERGED" };
    for (const included of synthesis.included) {
      try { await this.git(workspace.rootPath, ["cat-file", "-e", `${included.sourceRevision}^{commit}`]); } catch { return { ok: false, reason: "SYNTHESIS_SOURCE_REVISION_MISSING" }; }
      if (included.sourceRevision === run.baseRevision) continue;
      const applications = await this.countApplications(workspace.rootPath, run.baseRevision, included.sourceRevision);
      if (applications !== 1) return { ok: false, reason: applications === 0 ? "SYNTHESIS_INCLUSION_MISSING" : "SYNTHESIS_DUPLICATE_INCLUSION" };
    }
    return { ok: true, head };
  }

  /** Counts how often a source revision has actually been applied, using cherry-pick provenance. */
  private async countApplications(cwd: string, baseRevision: string, sourceRevision: string): Promise<number> {
    const log = await this.git(cwd, ["log", "--format=%B", `${baseRevision}..HEAD`]).catch(() => ({ stdout: "" }));
    return log.stdout.split(`(cherry picked from commit ${sourceRevision})`).length - 1;
  }

  /**
   * Deterministic Git synthesis followed by the global gates.  Driven entirely by durable
   * inclusion records so a resumed run never reapplies an already incorporated workstream.
   */
  private async synthesizeAndPromote(params: { run: DurableParallelRun; target: ForgeWorkspace; signal: AbortSignal; verificationCommands: string[]; privateAgentContext?: PrivateAgentContext }): Promise<ParallelRunResult> {
    const { run, target, signal } = params;
    const synthesis = run.synthesis!;
    const synthesisWorkspace = this.options.workspaceService.getWorkspace(synthesis.worktreeId);
    if (!synthesisWorkspace) { run.status = "blocked"; run.error = "PARALLEL_RECOVERY_REVALIDATION_REQUIRED"; await this.save(run); await this.emit(run, "parallel.recovery.revalidation_required", { reason: "SYNTHESIS_WORKSPACE_UNKNOWN" }); return this.result(run, []); }
    const synthesisPath = synthesisWorkspace.rootPath;
    const byId = new Map(run.workstreams.map((result) => [result.workstreamId, result]));
    const applied = new Set(synthesis.included.map((included) => included.workstreamId));

    for (const id of synthesis.order) {
      if (applied.has(id)) continue;
      if (signal.aborted) throw new Error("PARALLEL_RUN_CANCELLED");
      const stream = byId.get(id);
      if (!stream?.resultRevision) { run.status = "blocked"; run.error = "PARALLEL_SYNTHESIS_SOURCE_MISSING"; await this.save(run); await this.emit(run, "synthesis.blocked", { reason: "PARALLEL_SYNTHESIS_SOURCE_MISSING" }, id); return this.result(run, []); }
      if (stream.resultRevision !== run.baseRevision) {
        let conflicted = false;
        try { await this.git(synthesisPath, ["cherry-pick", "-x", stream.resultRevision]); } catch { conflicted = true; }
        if (conflicted) {
          const paths = (await this.git(synthesisPath, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ({ stdout: "" }))).stdout.split(/\r?\n/).filter(Boolean);
          synthesis.conflicts.push({ workstreams: [id], paths: paths.length ? paths : stream.changedFiles, type: "TEXTUAL_CONFLICT" });
          run.status = "blocked"; run.error = "SYNTHESIS_CONFLICT_UNRESOLVED"; await this.save(run); await this.emit(run, "synthesis.conflict", { paths }, id); return this.result(run, []);
        }
      }
      const resultingRevision = (await this.git(synthesisPath, ["rev-parse", "HEAD"])).stdout.trim();
      synthesis.included.push({ workstreamId: id, sourceRevision: stream.resultRevision, resultingRevision });
      await this.save(run); await this.emit(run, "synthesis.workstream_added", { sourceRevision: stream.resultRevision, resultingRevision }, id);
    }

    run.status = "verifying"; await this.save(run); await this.emit(run, "global_verification.started");
    const globalVerification = await this.verify(synthesisPath, params.verificationCommands, signal, run);
    await this.emit(run, "global_verification.completed", { passed: !globalVerification.some((result) => result.failed > 0) });
    if (globalVerification.some((result) => result.failed > 0)) { run.status = "blocked"; run.error = "GLOBAL_VERIFICATION_FAILED"; await this.save(run); return this.result(run, globalVerification); }

    run.status = "reviewing"; await this.save(run); await this.emit(run, "global_review.started");
    const globalReviewPrivateContext = params.privateAgentContext?.["global-reviewer"];
    const globalReview = await this.options.agentRuntime.executeAgentRun({ runId: `${run.id}:global-review`, agentId: "reviewer", role: "reviewer", goal: `Review synthesized implementation for ${run.goal}`, workspaceId: synthesisWorkspace.id, workspacePath: synthesisPath, permissions: { read: true, search: true, write: false, executeCommand: false, network: false }, structuredOutput: "reviewer", ...(globalReviewPrivateContext ? { initialContext: globalReviewPrivateContext } : {}), signal });
    const review = globalReview.structuredData as ReviewResult | undefined;
    this.record(run, [globalReview]);
    await this.emit(run, "global_review.completed", { passed: globalReview.status === "completed" && review?.verdict === "pass" });
    if (globalReview.status !== "completed" || review?.verdict !== "pass") { run.status = signal.aborted ? "cancelled" : "blocked"; run.error = signal.aborted ? "PARALLEL_RUN_CANCELLED" : "GLOBAL_REVIEW_BLOCKED"; await this.save(run); return this.result(run, globalVerification); }

    run.status = "integrating"; await this.save(run); await this.emit(run, "promotion.started");
    const promotion = await this.integrationService.integrate({ targetWorkspaceId: target.id, isolatedWorktreeId: synthesisWorkspace.id, expectedBaseSha: run.baseRevision, runId: run.id, reviewFindings: review.findings, verificationResults: globalVerification, commitMessage: `Parallel autonomous implementation: ${run.goal}` });
    run.promotion = { status: promotion.status, ...(promotion.code ? { code: promotion.code } : {}) };
    run.status = promotion.status === "integrated" ? "completed" : "blocked";
    run.error = promotion.status === "integrated" ? undefined : promotion.code === "INTEGRATION_TARGET_DIVERGED" ? "PROMOTION_TARGET_DIVERGED" : promotion.code ?? "PROMOTION_BLOCKED";
    await this.save(run); await this.emit(run, promotion.status === "integrated" ? "promotion.completed" : "promotion.blocked", { code: run.error });
    return this.result(run, globalVerification);
  }

  /**
   * Resume a run whose process died mid-flight.  A fresh orchestrator over the same durable
   * state revalidates against real Git before continuing, and never reapplies included work.
   */
  async resumeRun(runId: string, options: ParallelResumeOptions = {}): Promise<ParallelRunResult> {
    const run = await this.store.get(runId);
    if (!run) throw new Error("PARALLEL_RUN_NOT_FOUND");
    if (TERMINAL_STATUSES.includes(run.status)) return this.result(run, []);
    const unsafe = run.dispatches.filter((dispatch) => dispatch.state === "dispatched" || dispatch.state === "active");
    // A run whose writers all finished but which died before synthesis started is recoverable:
    // every workstream result is durable and committed, so only the synthesis step is missing.
    if (!unsafe.length && run.status === "executing" && !run.synthesis && run.plan) {
      const validation = validateEngineeringPlan(run.plan);
      const complete = validation.valid && run.plan.workstreams.every((stream) => run.workstreams.some((result) => result.workstreamId === stream.id && result.status === "completed"));
      const target = this.options.workspaceService.getWorkspace(run.workspaceId);
      const head = target ? (await this.git(target.rootPath, ["rev-parse", "HEAD"]).catch(() => ({ stdout: "" }))).stdout.trim() : "";
      if (complete && target && head === run.baseRevision) {
        const synthesisWorkspace = await this.options.workspaceService.createWorktree({ parentWorkspaceId: target.id, base: "head", runId, label: "synthesis", metadata: { synthesis: true, baseRevision: run.baseRevision } });
        run.synthesis = { workspaceId: synthesisWorkspace.id, worktreeId: synthesisWorkspace.id, branch: synthesisWorkspace.branch, order: validation.orderedWorkstreamIds!, included: [], conflicts: [] };
        run.status = "synthesizing"; await this.save(run); await this.emit(run, "synthesis.started", { recovered: true });
      }
    }
    if (unsafe.length || run.status !== "synthesizing" || !run.synthesis) {
      run.dispatches = run.dispatches.map((dispatch) => unsafe.some((candidate) => candidate.dispatchId === dispatch.dispatchId) ? { ...dispatch, state: "revalidation_required" } : dispatch);
      run.status = "blocked"; run.error = "PARALLEL_RECOVERY_REVALIDATION_REQUIRED"; await this.save(run);
      await this.emit(run, "parallel.recovery.revalidation_required", { reason: unsafe.length ? "UNSAFE_DISPATCHES" : "PHASE_NOT_RESUMABLE", workstreamIds: unsafe.map((dispatch) => dispatch.workstreamId) });
      return this.result(run, []);
    }
    const revalidation = await this.revalidateSynthesis(run);
    if (!revalidation.ok) {
      run.status = "blocked"; run.error = "PARALLEL_RECOVERY_REVALIDATION_REQUIRED"; await this.save(run);
      await this.emit(run, "parallel.recovery.revalidation_required", { reason: revalidation.reason });
      return this.result(run, []);
    }
    const target = this.options.workspaceService.getWorkspace(run.workspaceId);
    if (!target) { run.status = "blocked"; run.error = "PARALLEL_RECOVERY_REVALIDATION_REQUIRED"; await this.save(run); await this.emit(run, "parallel.recovery.revalidation_required", { reason: "TARGET_WORKSPACE_UNKNOWN" }); return this.result(run, []); }
    await this.emit(run, "parallel.recovery.resumed", { synthesisHead: revalidation.head, included: run.synthesis.included.map((included) => included.workstreamId), pending: run.synthesis.order.filter((id) => !run.synthesis!.included.some((included) => included.workstreamId === id)) });

    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true }); this.activeControllers.set(runId, controller);
    try {
      return await this.synthesizeAndPromote({ run, target, signal: controller.signal, verificationCommands: options.verificationCommands ?? run.verificationCommands ?? run.plan?.globalVerificationCommands ?? [], ...(options.privateAgentContext ? { privateAgentContext: options.privateAgentContext } : {}) });
    } catch (error) {
      run.status = controller.signal.aborted ? "cancelled" : "failed";
      run.error = controller.signal.aborted ? "PARALLEL_RUN_CANCELLED" : error instanceof Error ? error.message : String(error);
      await this.save(run); await this.emit(run, run.status === "cancelled" ? "parallel.run.cancelled" : "parallel.run.failed", { error: run.error });
      return this.result(run, []);
    } finally {
      if (run.status === "cancelled") await this.finalizeCancellation(run);
      options.signal?.removeEventListener("abort", onAbort); this.activeControllers.delete(runId);
    }
  }

  async startRun(input: ParallelRunOptions): Promise<ParallelRunResult> {
    const runId = input.runId ?? `parallel-${crypto.randomUUID()}`;
    const controller = new AbortController();
    const onAbort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", onAbort, { once: true }); this.activeControllers.set(runId, controller);
    const signal = controller.signal; const budget = input.budget ?? DEFAULT_PARALLEL_EXECUTION_BUDGET;
    const maxRevisionRounds = budget.maxRevisionRounds ?? DEFAULT_PARALLEL_EXECUTION_BUDGET.maxRevisionRounds;
    let run: DurableParallelRun | undefined;
    try {
      const target = await this.options.workspaceService.registerLocalWorkspace(input.workspacePath);
      const baseRevision = (await this.git(target.rootPath, ["rev-parse", "HEAD"])).stdout.trim(); const now = new Date().toISOString();
      if (this.options.persistence && !(await this.options.persistence.getSession(input.sessionId))) await this.options.persistence.upsertSession({ id: input.sessionId, title: input.goal.slice(0, 80), createdAt: now, updatedAt: now, status: "running" });
      run = { kind: "parallel_run", id: runId, sessionId: input.sessionId, workspaceId: target.id, goal: input.goal, status: "planning", baseRevision, workstreams: [], dispatches: [], contracts: [], usage: emptyParallelRunUsage(), createdAt: now, updatedAt: now }; await this.save(run); await this.emit(run, "parallel.plan.created");
      const planner = await this.options.agentRuntime.executeAgentRun({ runId, agentId: "planner", role: "planner", goal: input.goal, workspaceId: target.id, workspacePath: target.rootPath, permissions: { read: true, search: true, write: false, executeCommand: false, network: false }, structuredOutput: "engineering_plan", signal });
      this.record(run, [planner]);
      if (planner.status !== "completed" || !planner.structuredData) { run.status = "blocked"; run.error = planner.error ?? "PARALLEL_PLANNER_FAILED"; await this.save(run); return this.result(run, []); }
      const structured = planner.structuredData as EngineeringPlanResult;
      const plan: EngineeringPlan = { id: structured.id, goal: structured.goal, workstreams: structured.workstreams, globalVerificationCommands: structured.globalVerificationCommands };
      const validation = validateEngineeringPlan(plan, budget); run.plan = plan;
      if (!validation.valid) { run.status = "blocked"; run.error = `PARALLEL_PLAN_INVALID: ${validation.error}`; await this.save(run); return this.result(run, []); }
      run.verificationCommands = input.verificationCommands ?? plan.globalVerificationCommands ?? [];
      await this.emit(run, "parallel.plan.validated", { order: validation.orderedWorkstreamIds }); run.status = "executing"; await this.save(run);
      const registry = new WorkstreamContractRegistry();
      const consumersFor = (contractId: string) => plan.workstreams.filter((stream) => stream.contractsConsumed?.includes(contractId)).map((stream) => stream.id);
      const execute = async (workstream: EngineeringWorkstream): Promise<WorkstreamResult> => {
        let workspace: ForgeWorkspace | undefined; let lease: WorkspaceLease | undefined;
        try {
          if (signal.aborted) throw new Error("PARALLEL_RUN_CANCELLED");
          workspace = await this.options.workspaceService.createWorktree({ parentWorkspaceId: target.id, base: "head", runId, label: workstream.id, metadata: { workstreamId: workstream.id, baseRevision, dispatchId: `${runId}:${workstream.id}` } });
          run!.dispatches = [...run!.dispatches.filter((dispatch) => dispatch.workstreamId !== workstream.id), { workstreamId: workstream.id, dispatchId: `${runId}:${workstream.id}`, workspaceId: workspace.id, worktreeId: workspace.id, branch: workspace.branch, state: "dispatched" }]; await this.save(run!);
          lease = this.options.workspaceService.acquireLease(workspace.id, `${runId}:${workstream.id}`, "write"); await this.emit(run!, "workstream.dispatched", { workspaceId: workspace.id, branch: workspace.branch }, workstream.id); await this.emit(run!, "workstream.started", { workspaceId: workspace.id }, workstream.id);
          run!.dispatches = run!.dispatches.map((dispatch) => dispatch.workstreamId === workstream.id ? { ...dispatch, state: "active" } : dispatch); await this.save(run!);
          const contracts = registry.getForConsumer(workstream.id, workstream.contractsConsumed ?? []) ?? [];
          const coderPrivateContext = input.privateAgentContext?.[`coder:${workstream.id}`];
          const reviewerPrivateContext = input.privateAgentContext?.[`reviewer:${workstream.id}`];

          // Bounded revision loop.  Only structured public Reviewer findings cross back to the Coder.
          let coder!: Awaited<ReturnType<AgentRuntime["executeAgentRun"]>>; let review!: Awaited<ReturnType<AgentRuntime["executeAgentRun"]>>;
          let reviewData: ReviewResult | undefined; let reviewFeedback: string | undefined; let revisionRound = 0;
          let steerFeedback: string | undefined;
          for (;;) {
            coder = await this.options.agentRuntime.executeAgentRun({ runId: `${runId}:${workstream.id}`, agentId: "coder", role: "coder", goal: workstream.objective, taskPlan: JSON.stringify({ workstream: workstream.id, contractsConsumed: contracts }), workstreamScope: workstream.id, workspaceId: workspace.id, workspacePath: workspace.rootPath, permissions: { read: true, search: true, write: true, executeCommand: true, network: false }, ...(coderPrivateContext ? { initialContext: coderPrivateContext } : {}), ...(steerFeedback || reviewFeedback ? { reviewFeedback: steerFeedback ?? reviewFeedback } : {}), signal });
            if (signal.aborted || coder.status === "cancelled") throw new Error("PARALLEL_RUN_CANCELLED");
            await this.emit(run!, "workstream.reviewing", { revisionRound }, workstream.id);
            review = await this.options.agentRuntime.executeAgentRun({ runId: `${runId}:${workstream.id}:review${revisionRound ? `:${revisionRound}` : ""}`, agentId: "reviewer", role: "reviewer", goal: `Review workstream ${workstream.id}: ${workstream.objective}`, workstreamScope: workstream.id, workspaceId: workspace.id, workspacePath: workspace.rootPath, permissions: { read: true, search: true, write: false, executeCommand: false, network: false }, structuredOutput: "reviewer", ...(reviewerPrivateContext ? { initialContext: reviewerPrivateContext } : {}), signal });
            reviewData = review.structuredData as ReviewResult | undefined;
            this.record(run!, [coder, review]);
            if (coder.status !== "completed" || !reviewData || reviewData.verdict !== "pass") {
              if (coder.status !== "completed" || !reviewData || revisionRound >= maxRevisionRounds) break;
              revisionRound++;
              reviewFeedback = JSON.stringify({ verdict: "revision_required", findings: publicFindings(reviewData.findings) });
              await this.emit(run!, "workstream.revising", { revisionRound, findingIds: reviewData.findings.map((finding) => finding.id) }, workstream.id);
              continue;
            }
            // Reviewer passed: a queued steer scoped to THIS workstream still forces one replan
            // round here — it is consumed durably exactly once and is never visible to any other
            // workstream, whose dispatches, plans, and verification remain untouched.
            const steer = await this.takeScopedSteer(runId, workstream.id);
            if (!steer) break;
            revisionRound++;
            steerFeedback = `[User Steering Instruction]: ${steer.message}`;
            await this.emit(run!, "workstream.replanned", { steerId: steer.steerId, revisionRound }, workstream.id);
          }

          if (signal.aborted || review.status === "cancelled") throw new Error("PARALLEL_RUN_CANCELLED");
          const verification = await this.verify(workspace.rootPath, workstream.verificationCommands ?? [], signal, run!);
          const failed = coder.status !== "completed" || reviewData?.verdict !== "pass" || verification.some((result) => result.failed > 0);
          if (!failed) { const status = await this.git(workspace.rootPath, ["status", "--porcelain"]); if (status.stdout.trim()) { await this.git(workspace.rootPath, ["add", "-A"]); await this.git(workspace.rootPath, ["commit", "-m", `CodeForge workstream ${workstream.id}`]); } }
          const revision = (await this.git(workspace.rootPath, ["rev-parse", "HEAD"])).stdout.trim();
          const result: WorkstreamResult = { workstreamId: workstream.id, status: failed ? "blocked" : "completed", workspaceId: workspace.id, worktreeId: workspace.id, branch: workspace.branch, baseRevision, resultRevision: revision, changedFiles: coder.filesChanged, contractsProduced: [], review: reviewData ?? { verdict: "revision_required", findings: review.findings, summary: review.summary }, verification, evidence: [...coder.evidence, ...review.evidence], findings: review.findings };
          if (!failed) for (const contractId of workstream.contractsProduced ?? []) { const contract = publishedContract(contractId, workstream.id, consumersFor(contractId), revision, result.evidence); result.contractsProduced.push(contract); registry.publish(contract); await this.emit(run!, "contract.published", { contractId, revision }, workstream.id); }
          run!.workstreams = [...run!.workstreams.filter((item) => item.workstreamId !== workstream.id), result]; run!.dispatches = run!.dispatches.map((dispatch) => dispatch.workstreamId === workstream.id ? { ...dispatch, state: "completed" } : dispatch); run!.contracts = registry.all(); await this.save(run!); await this.emit(run!, failed ? "workstream.blocked" : "workstream.completed", { resultRevision: revision }, workstream.id); return result;
        } catch (error) {
          const status = signal.aborted ? "cancelled" : "failed";
          const result: WorkstreamResult = { workstreamId: workstream.id, status, workspaceId: workspace?.id ?? "", worktreeId: workspace?.id ?? "", branch: workspace?.branch, baseRevision, changedFiles: [], contractsProduced: [], review: { verdict: "revision_required", findings: [], summary: "Workstream execution failed" }, verification: [], evidence: [], findings: [] };
          run!.workstreams = [...run!.workstreams.filter((item) => item.workstreamId !== workstream.id), result]; run!.dispatches = run!.dispatches.map((dispatch) => dispatch.workstreamId === workstream.id ? { ...dispatch, state: status === "cancelled" ? "cancelled" : "revalidation_required" } : dispatch); await this.save(run!); await this.emit(run!, status === "cancelled" ? "workstream.cancelled" : "workstream.blocked", { error: error instanceof Error ? error.message : String(error) }, workstream.id); return result;
        } finally { if (lease) this.options.workspaceService.releaseLease(lease.leaseId, `${runId}:${workstream.id}`); }
      };
      const results = await scheduleWorkstreams({ plan, budget, signal, execute, isSuccessful: (result) => result.status === "completed", hasRequiredContracts: (stream) => stream.contractsConsumed?.length ? Boolean(registry.getForConsumer(stream.id, stream.contractsConsumed)) : true, onState: (id, status) => { if (status === "ready") this.emit(run!, "workstream.ready", {}, id); } });
      run.workstreams = [...results.values()]; run.contracts = registry.all(); await this.save(run);
      if (run.workstreams.length !== plan.workstreams.length || run.workstreams.some((result) => result.status !== "completed")) { run.status = signal.aborted ? "cancelled" : "blocked"; run.error = signal.aborted ? "PARALLEL_RUN_CANCELLED" : "PARALLEL_WORKSTREAM_BLOCKED"; await this.save(run); return this.result(run, []); }
      run.status = "synthesizing"; await this.save(run); await this.emit(run, "synthesis.started");
      const synthesisWorkspace = await this.options.workspaceService.createWorktree({ parentWorkspaceId: target.id, base: "head", runId, label: "synthesis", metadata: { synthesis: true, baseRevision } });
      run.synthesis = { workspaceId: synthesisWorkspace.id, worktreeId: synthesisWorkspace.id, branch: synthesisWorkspace.branch, order: validation.orderedWorkstreamIds!, included: [], conflicts: [] }; await this.save(run);
      return await this.synthesizeAndPromote({ run, target, signal, verificationCommands: run.verificationCommands ?? [], ...(input.privateAgentContext ? { privateAgentContext: input.privateAgentContext } : {}) });
    } catch (error) {
      if (!run) throw error;
      run.status = signal.aborted ? "cancelled" : "failed"; run.error = signal.aborted ? "PARALLEL_RUN_CANCELLED" : error instanceof Error ? error.message : String(error); await this.save(run); await this.emit(run, run.status === "cancelled" ? "parallel.run.cancelled" : "parallel.run.failed", { error: run.error }); return this.result(run, []);
    } finally {
      if (run?.status === "cancelled") await this.finalizeCancellation(run);
      input.signal?.removeEventListener("abort", onAbort); this.activeControllers.delete(runId);
    }
  }
}

export function createParallelAutonomousRunOrchestrator(options: ParallelOrchestratorOptions): ParallelAutonomousRunOrchestrator { return new ParallelAutonomousRunOrchestrator(options); }
