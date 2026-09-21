import { execFile as execFileCallback } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ForgeZero, createGenericFreeRecord, type FreeModelRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, defaultCapacityGovernor, type ProviderAdapter, type ProviderCapacityGovernor } from "@codeforge/providers";
import { EventStore, createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import {
  createAgentRuntime,
  createAutonomousRunOrchestrator,
  createWorkspaceEventAdapter,
  createWorkspaceService,
  type AgentRuntimeResult,
  type AutonomousRunResult,
} from "@codeforge/server";
import { analyzeFailures, evaluateCompletion, reviewDiff, runVerification, type CompletionGateDecision } from "@codeforge/workflow";
import { materializeArm, armConfigurationDigest, type ArmConfiguration } from "./arms.js";
import { analyzeContext, traceFromRequests } from "./context-analysis.js";
import { LocalResourceSampler } from "./local-resources.js";
import { computeEconomics, type PricingSnapshot } from "./pricing.js";
import { RecordingProviderAdapter, modelWaitMs, rateLimitWaitMs } from "./recording-provider.js";
import {
  R23_BENCHMARK_VERSION,
  R23_PROTOCOL_ID,
  R23_RUN_RECORD_SCHEMA_VERSION,
  derived,
  measured,
  runRecordInvariantViolations,
  unknownMetric,
  validateRunRecord,
  type ArmId,
  type MeasuredNumber,
  type ModelCallRecord,
  type RunClassification,
  type RunRecord,
} from "./run-record.js";
import { answerMatches, copyTree, diffStats, hashTree, runHiddenVerifier, snapshotTree, type LoadedTask, type HiddenVerifierOutcome } from "./tasks.js";

const execFile = promisify(execFileCallback);

export const R23_HARNESS_VERSION = "r23-harness-1.0.0";

export type ExecutionMode = "single_agent_run" | "orchestrated";

export interface RunIdentityInput {
  campaignId: string;
  phase: RunRecord["identity"]["phase"];
  pairId: string;
  pairOrder: RunRecord["identity"]["pairOrder"];
  repetition: number;
  protocolVersion: string;
  protocolDigest: string;
  codeforgeCommit: string;
  codeforgeTreeDirty: boolean;
  dirtyFiles?: string[];
  environmentFingerprint: string;
}

export interface RunTaskOptions {
  task: LoadedTask;
  arm: ArmConfiguration;
  armId: ArmId;
  executionMode: ExecutionMode;
  model: { providerId: string; modelId: string; routeClass: string };
  /** Builds the real (or scripted) adapter; the harness wraps it in the recording adapter. */
  createProvider: () => ProviderAdapter;
  /** ForgeZero record for the exact route. The caller is responsible for having verified $0. */
  freeRecord?: FreeModelRecord;
  routeListedUnitPrice?: { inputPerMillionUsd: number; outputPerMillionUsd: number };
  identity: RunIdentityInput;
  pricing: PricingSnapshot;
  scratchRoot: string;
  /** Protocol §6.3: 20 minutes of active time by default. */
  wallClockCapMs?: number;
  /** Incremental ledger sink (restart fixture, M4): called after every model call. */
  onCall?: (record: ModelCallRecord) => void | Promise<void>;
  signal?: AbortSignal;
  now?: () => number;
  sampleGpu?: boolean;
  /** Injectable runtime construction hook for tests that need to observe the runtime. */
  runtimeOptionsOverride?: Record<string, unknown>;
}

export interface RunTaskOutput {
  record: RunRecord;
  violations: string[];
  scratchDir: string;
  /** Present only for `single_agent_run`. */
  agentResult?: AgentRuntimeResult;
  /** Present only for `orchestrated`. */
  orchestratorResult?: AutonomousRunResult;
  verifier?: HiddenVerifierOutcome;
}

export function environmentFingerprint(input: { os: string; cpuModel: string; cpus: number; totalMemBytes: number; nodeVersion: string; codeforgeCommit: string; protocolDigest: string; harnessVersion: string }): string {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return stdout.trim();
}

async function initGitRepo(dir: string): Promise<string> {
  await git(dir, ["init", "-q"]);
  for (const [key, value] of [["user.name", "R23 Harness"], ["user.email", "r23@codeforge.invalid"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]] as const) await git(dir, ["config", key, value]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "r23 starting tree", "--allow-empty"]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function classify(input: {
  runtimeStatus: RunRecord["outcome"]["runtimeStatus"];
  stopReason: string;
  claimedComplete: boolean;
  verifiedComplete: boolean;
  verifierPassed: boolean | undefined;
  completionAuthority: RunRecord["outcome"]["completionAuthority"];
  forbidden: boolean;
  calls: readonly ModelCallRecord[];
  timedOut: boolean;
  harnessError?: string;
}): { classification: RunClassification; reason: string } {
  if (input.harnessError) return { classification: "harness_error", reason: input.harnessError };
  if (input.forbidden) return { classification: "security_blocked", reason: "forbidden action observed" };
  if (input.verifiedComplete) return { classification: "verified_complete", reason: "claimed complete; hidden verifier passed; completion authority PASS" };
  if (input.claimedComplete) return { classification: "false_complete", reason: `claimed complete but ${input.verifierPassed === false ? "hidden verifier failed" : input.completionAuthority !== "PASS" ? `completion authority ${input.completionAuthority}` : "verification incomplete"}` };
  if (input.timedOut) return { classification: "timeout", reason: "wall-clock cap reached" };
  const stop = input.stopReason.toLowerCase();
  if (stop.includes("turn_limit") || stop.includes("budget") || stop.includes("tool_limit")) return { classification: "budget_exhausted", reason: input.stopReason };
  const lastCall = input.calls[input.calls.length - 1];
  const providerTerminal = lastCall && lastCall.outcome === "error";
  if (providerTerminal || stop.includes("provider")) {
    const firstToolCall = input.calls.findIndex((call) => call.toolCallsEmitted > 0);
    if (firstToolCall === -1) return { classification: "infrastructure_void", reason: `provider failure before the model's first tool call (${lastCall?.errorCode ?? input.stopReason})` };
    return { classification: "provider_failure", reason: `provider failure after work began (${lastCall?.errorCode ?? input.stopReason})` };
  }
  if (stop.includes("tool")) return { classification: "tool_failure", reason: input.stopReason };
  if (stop.includes("permission") || stop.includes("denied") || stop.includes("blocked")) return { classification: "security_blocked", reason: input.stopReason };
  return { classification: "verification_failed", reason: `run ended ${input.runtimeStatus} (${input.stopReason}) without a completion claim` };
}

/**
 * Run one task in one arm and produce its run record. The workspace, index cache, ForgeGreen
 * cache and session database are all fresh per run; nothing is shared between arms or runs.
 */
export async function runTaskArm(options: RunTaskOptions): Promise<RunTaskOutput> {
  const now = options.now ?? (() => Date.now());
  const startedAtMs = now();
  const runId = `r23-${options.identity.phase}-${options.task.record.taskId}-${options.armId}-r${options.identity.repetition}-${crypto.randomUUID().slice(0, 8)}`;
  const scratchDir = path.join(options.scratchRoot, runId);
  const workspaceDir = path.join(scratchDir, "workspace");
  const verifyDir = path.join(scratchDir, "verify");
  const runDir = path.join(scratchDir, "run");
  await fs.mkdir(runDir, { recursive: true });
  await copyTree(options.task.fixtureDir, workspaceDir);
  const startingTreeHash = await hashTree(workspaceDir);
  const beforeSnapshot = await snapshotTree(workspaceDir);
  const notes: string[] = [
    "inert switches on this execution path: memoryDelivery (mission memory is not used by the autonomous run path) and verificationReuse (FG-12F has no production caller) — recorded for provenance, identical in both arms",
  ];

  if (options.executionMode === "orchestrated") await initGitRepo(workspaceDir);

  const sampler = new LocalResourceSampler();
  sampler.start();

  const recorder = new RecordingProviderAdapter(options.createProvider(), { now, ...(options.onCall ? { onCall: (record) => options.onCall!(record) } : {}) });
  const catalog = new InMemoryProviderCatalog();
  catalog.register(recorder);
  const firewall = new ForgeZero();
  firewall.register(options.freeRecord ?? createGenericFreeRecord({ providerId: options.model.providerId, modelId: options.model.modelId }));

  const material = await materializeArm(options.arm, runDir);
  // The process-wide capacity governor is production behaviour (shared pacing across runs); wrap
  // `acquire` so proactive pacing waits are measured instead of being counted as agent work.
  let pacingWaitMs = 0;
  const governor = new Proxy(defaultCapacityGovernor, {
    get(target, property, receiver) {
      if (property === "acquire") {
        return async (...args: Parameters<ProviderCapacityGovernor["acquire"]>) => {
          const waitStarted = now();
          try {
            return await target.acquire(...args);
          } finally {
            pacingWaitMs += Math.max(0, now() - waitStarted);
          }
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const persistence: ISessionPersistence = createSessionPersistence({ dbPath: path.join(runDir, "sessions.db") });
  const eventStore = new EventStore();
  const sessionId = `r23-session-${runId}`;
  const runtime = createAgentRuntime({
    sessionId,
    eventStore,
    persistence,
    firewall,
    providerCatalog: catalog,
    workspacePath: workspaceDir,
    forgeGreen: material.forgeGreen,
    efficiencyControls: material.efficiencyControls,
    repositoryIntelligenceFactory: material.repositoryIntelligenceFactory,
    ...(material.forgeGreenCacheStore ? { forgeGreenCacheStore: material.forgeGreenCacheStore } : {}),
    capacityGovernor: governor,
    ...options.runtimeOptionsOverride,
  });
  runtime.setModelSelection({ providerId: options.model.providerId, modelId: options.model.modelId, lock: "route" });

  const capMs = options.wallClockCapMs ?? 20 * 60_000;
  const controller = new AbortController();
  const capTimer = setTimeout(() => controller.abort(new Error("R23_WALL_CLOCK_CAP")), capMs);
  capTimer.unref?.();
  options.signal?.addEventListener("abort", () => controller.abort(options.signal?.reason), { once: true });
  let timedOut = false;
  controller.signal.addEventListener("abort", () => { if (now() - startedAtMs >= capMs) timedOut = true; }, { once: true });

  let agentResult: AgentRuntimeResult | undefined;
  let orchestratorResult: AutonomousRunResult | undefined;
  let completion: CompletionGateDecision | undefined;
  let runtimeStatus: RunRecord["outcome"]["runtimeStatus"] = "failed";
  let stopReason = "unknown";
  let summary = "";
  let runtimeError: string | undefined;
  let harnessError: string | undefined;
  let endingTreeDir = workspaceDir;
  let topology = options.arm.topology === "single_agent" ? "tiny" : "adaptive";
  let subagentCount = 0;
  let filesChangedReported: string[] = [];
  let forgeGreenReasonCodes: string[] = [];
  let efficiency: { duplicateActionsSuppressed: number; toolOutputBytesAvoided: number; canonicalCacheHits: number; canonicalCacheMisses: number } = { duplicateActionsSuppressed: 0, toolOutputBytesAvoided: 0, canonicalCacheHits: 0, canonicalCacheMisses: 0 };
  let bootstrap = { contextBytes: 0, selectedFiles: 0, candidateFiles: 0 };
  let verificationMs = 0;
  const adapter = createWorkspaceEventAdapter({ sessionId, eventStore, persistence });

  const agentStartedMs = now();
  try {
    if (options.executionMode === "single_agent_run") {
      agentResult = await runtime.executeAgentRun({
        runId,
        agentId: options.task.record.role,
        role: options.task.record.role,
        goal: options.task.record.goal,
        workspaceId: `ws-${runId}`,
        workspacePath: workspaceDir,
        permissions: options.task.record.permissions,
        modelSelection: { providerId: options.model.providerId, modelId: options.model.modelId },
        signal: controller.signal,
        adapter,
        // Investigation tasks run the production explorer contract: the report must be a valid
        // structured explorer result (summary + findings + evidence), exactly as an explorer child
        // in the orchestrator must deliver it.
        ...(options.task.record.role === "explorer" ? { structuredOutput: "explorer" as const } : {}),
        ...(options.task.record.maxModelTurns ? { executionBudget: { maxModelTurns: options.task.record.maxModelTurns, maxToolCalls: 50, maxWriteToolCalls: 30, maxCommandExecutions: 20, maxContextTokens: 64_000, maxOutputTokens: 4_096 } } : {}),
      });
      runtimeStatus = agentResult.status;
      stopReason = String(agentResult.stopReason);
      summary = agentResult.status === "completed" && agentResult.structuredData && "summary" in agentResult.structuredData ? String((agentResult.structuredData as { summary: string }).summary) : agentResult.summary;
      runtimeError = agentResult.error;
      filesChangedReported = agentResult.filesChanged;
      const receipt = agentResult.contextMetrics?.efficiencyReceipt;
      forgeGreenReasonCodes = (receipt?.reasonCodes ?? []).map(String);
      efficiency = {
        duplicateActionsSuppressed: receipt?.duplicateActionsSuppressed ?? 0,
        toolOutputBytesAvoided: receipt?.toolOutputBytesAvoided ?? 0,
        canonicalCacheHits: receipt?.canonicalCacheHits ?? 0,
        canonicalCacheMisses: receipt?.canonicalCacheMisses ?? 0,
      };
      bootstrap = { contextBytes: agentResult.contextMetrics?.contextBytes ?? 0, selectedFiles: agentResult.contextMetrics?.selectedFileCount ?? 0, candidateFiles: agentResult.contextMetrics?.candidateFileCount ?? 0 };
      if (options.task.record.role === "explorer") {
        // Read-only investigation (protocol §5, v1.0.1): there is no change to verify, so the
        // completion authority is the production explorer contract itself — the run must end
        // `completed` with a validated structured explorer result. The hidden verifier (tree
        // intact) and the answer key remain the correctness check.
        const delivered = agentResult.status === "completed" && agentResult.structuredData !== undefined;
        completion = {
          outcome: delivered ? "completed" : agentResult.status === "blocked" ? "blocked" : "failed",
          // "plan_steps_unfinished" is the closest production blocker code: the inspect step did not
          // finish with a deliverable report.
          blockers: delivered ? [] : [{ code: "plan_steps_unfinished", severity: "blocking", message: "explorer run did not deliver a validated structured result" }],
          advisories: [],
          rationale: "investigation task: authority = validated explorer structured result",
        } satisfies CompletionGateDecision;
        notes.push("investigation task: completion authority is the validated explorer structured result (no ForgeVerify obligation for a read-only report)");
      } else {
      // Completion authority through the same production gate: ForgeVerify on the task's visible
      // verification commands (fresh in both arms in this mode) + deterministic diff review.
      const verifyStarted = now();
      const report = await runVerification(workspaceDir, options.task.record.visibleVerification, { signal: controller.signal, runId, timeoutMs: options.task.record.verifier.timeoutMs }).catch((error: unknown) => {
        notes.push(`visible verification threw: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
        return undefined;
      });
      verificationMs = now() - verifyStarted;
      if (report) {
        const review = await reviewDiff(workspaceDir, { beforeSnapshots: beforeSnapshot, signal: controller.signal }).catch(() => undefined);
        const nowIso = new Date(now()).toISOString();
        completion = evaluateCompletion({
          plan: { id: `plan-${runId}`, taskId: options.task.record.taskId, title: options.task.record.goal.slice(0, 80), status: "approved", revision: 1, createdAt: nowIso, updatedAt: nowIso, steps: [{ id: "implement", description: "Implement the task", status: agentResult.status === "completed" ? "completed" : "failed", kind: "edit", risk: "moderate", requiresApproval: false }, { id: "verify", description: "Verify", status: report.overallStatus === "passed" ? "completed" : "failed", kind: "verify", risk: "safe", requiresApproval: false }] },
          verification: report,
          analysis: analyzeFailures(report),
          review: review ?? { approved: true, issues: [], findings: [], diffs: [], summary: "diff review unavailable" },
          budgetExhausted: agentResult.status === "blocked" && /TURN_LIMIT|BUDGET|TOOL_LIMIT/i.test(String(agentResult.stopReason)),
        });
      }
      }
    } else {
      const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: path.join(runDir, "worktrees") });
      const orchestrator = createAutonomousRunOrchestrator({ workspaceService, persistence, agentRuntime: runtime });
      orchestratorResult = await orchestrator.startRun({
        sessionId,
        workspacePath: workspaceDir,
        goal: options.task.record.goal,
        verificationCommands: options.task.record.visibleVerification,
        verificationTimeoutMs: options.task.record.verifier.timeoutMs,
        adapter,
        signal: controller.signal,
        ...(options.arm.topology === "single_agent" ? { topology: "tiny" as const } : {}),
      });
      runtimeStatus = orchestratorResult.status;
      stopReason = orchestratorResult.integration.reason ?? orchestratorResult.status;
      summary = orchestratorResult.summary;
      completion = orchestratorResult.completion;
      filesChangedReported = orchestratorResult.changedFiles;
      topology = orchestratorResult.topology?.plan.topology ?? topology;
      subagentCount = orchestratorResult.counters.childrenSpawned;
      verificationMs = orchestratorResult.verification.reduce((sum, result) => sum + result.durationMs, 0);
      const reviewCodes = [...new Set(orchestratorResult.review.findings.map((finding) => `${finding.severity}:${finding.category}`))];
      if (reviewCodes.length > 0) notes.push(`review findings: ${reviewCodes.join(", ")}`);
      if (/requires a shell and cannot enter ForgeVerify/i.test(orchestratorResult.summary)) notes.push("verification_capability_gap: ForgeVerify's autonomous path admits only node/npm/npx verifiers; this task's visible verification command could not run (product finding, identical in both arms)");
      if (orchestratorResult.integration.reason === "REVIEW_REVISION_LIMIT") notes.push("deterministic_review_blocked: the run exhausted review revisions on blocking deterministic findings (see review findings note)");
      if (orchestratorResult.integration.status !== "integrated" && orchestratorResult.integration.worktreeId) {
        const worktree = workspaceService.getWorkspace(orchestratorResult.integration.worktreeId);
        if (worktree) endingTreeDir = worktree.rootPath;
      }
    }
  } catch (error) {
    runtimeStatus = controller.signal.aborted ? "cancelled" : "failed";
    const message = error instanceof Error ? error.message : String(error);
    runtimeError = message.slice(0, 500);
    stopReason = controller.signal.aborted ? (timedOut ? "R23_WALL_CLOCK_CAP" : "cancelled") : "runtime_threw";
    if (!controller.signal.aborted && !/PROVIDER_|RATE_LIMIT|429|5\d\d|ECONN|ETIMEDOUT|timed out/i.test(message)) harnessError = `runtime threw outside the provider path: ${runtimeError}`;
  } finally {
    clearTimeout(capTimer);
  }
  const agentEndedMs = now();

  // Hidden verifier on a copy of the ending tree (protocol §5).
  const verifier = await runHiddenVerifier(options.task, endingTreeDir, verifyDir, { signal: options.signal }).catch((error: unknown) => {
    notes.push(`hidden verifier could not run: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
    return undefined;
  });
  const endingTreeHash = await hashTree(endingTreeDir);
  const afterSnapshot = await snapshotTree(endingTreeDir);
  const diff = diffStats(beforeSnapshot, afterSnapshot);
  const resources = await sampler.stop({ sampleGpu: options.sampleGpu ?? false });

  const claimedComplete = runtimeStatus === "completed";
  const answerOk = options.task.record.answerKey ? answerMatches(summary, options.task.record.answerKey) : true;
  const verifierPassed = verifier ? verifier.passed && answerOk : undefined;
  if (verifier && !answerOk) notes.push("investigation answer key not satisfied by the final summary");
  const completionAuthority: RunRecord["outcome"]["completionAuthority"] = completion ? (completion.outcome === "completed" ? "PASS" : completion.outcome === "blocked" ? "BLOCKED" : "FAIL") : "NOT_RUN";
  // Forbidden actions (protocol §5.4): any file outside the workspace is impossible through the
  // runtime's path security; network is leased off. We assert the observable invariant we can:
  // the ending tree never contains the hidden verifier files.
  const forbidden = [...afterSnapshot.keys()].some((file) => file.startsWith(`${options.task.record.hidden}/`));
  const verifiedComplete = claimedComplete && verifierPassed === true && completionAuthority === "PASS" && !forbidden;
  const { classification, reason } = classify({ runtimeStatus, stopReason, claimedComplete, verifiedComplete, verifierPassed, completionAuthority, forbidden, calls: recorder.calls, timedOut, harnessError });

  const calls = recorder.calls;
  const reported = calls.filter((call) => call.usageSource === "PROVIDER_REPORTED");
  const allReported = calls.length > 0 && reported.length === calls.length;
  const sumField = (pick: (call: ModelCallRecord) => number | undefined, label: string): MeasuredNumber => {
    if (!allReported) return unknownMetric(calls.length === 0 ? "no model calls" : `${calls.length - reported.length} call(s) without provider usage`);
    let total = 0;
    for (const call of reported) {
      const value = pick(call);
      if (value === undefined) return unknownMetric(`${label} not reported on every call`);
      total += value;
    }
    return measured(total, "PROVIDER");
  };
  const totalInput = sumField((call) => call.promptTokens, "prompt tokens");
  const totalOutput = sumField((call) => call.completionTokens, "completion tokens");
  const cached = sumField((call) => call.cachedPromptTokens, "cached tokens");
  const reasoning = sumField((call) => call.reasoningTokens, "reasoning tokens");
  const totalTokens: MeasuredNumber = totalInput.value !== undefined && totalOutput.value !== undefined ? derived(totalInput.value + totalOutput.value, "PROVIDER", "input + output") : unknownMetric("input or output unknown");
  const uncached: MeasuredNumber = totalInput.value !== undefined && cached.value !== undefined && cached.value <= totalInput.value ? derived(totalInput.value - cached.value, "PROVIDER", "input − cached") : unknownMetric("cached unknown");

  const trace = traceFromRequests(recorder.requests);
  const promptBytes = recorder.requests.reduce((sum, request) => sum + request.requestBytes, 0);
  const context = analyzeContext(recorder.requests, trace, { bootstrapFileContents: beforeSnapshot, ...(totalInput.value !== undefined ? { promptTokens: totalInput.value, promptBytes } : {}) });

  const byTool: RunRecord["activity"]["byTool"] = {};
  for (const call of trace) {
    const entry = byTool[call.toolName] ?? { requested: 0, executed: 0, suppressed: 0 };
    entry.requested += 1;
    byTool[call.toolName] = entry;
  }
  const toolExecutions = agentResult?.toolExecutions ?? [];
  for (const execution of toolExecutions) {
    const entry = byTool[execution.toolName] ?? { requested: 0, executed: 0, suppressed: 0 };
    entry.executed += 1;
    byTool[execution.toolName] = entry;
  }
  const countTools = (predicate: (name: string) => boolean) => trace.filter((call) => predicate(call.toolName.toLowerCase())).length;

  const economics = computeEconomics(calls, `${options.model.providerId}::${options.model.modelId}`, options.pricing, options.routeListedUnitPrice);
  const rateWait = rateLimitWaitMs(calls);
  const wallClockMs = agentEndedMs - startedAtMs + (verifier?.durationMs ?? 0);

  const record: RunRecord = {
    schemaVersion: R23_RUN_RECORD_SCHEMA_VERSION,
    identity: {
      benchmarkVersion: R23_BENCHMARK_VERSION,
      protocolId: R23_PROTOCOL_ID,
      protocolVersion: options.identity.protocolVersion,
      protocolDigest: options.identity.protocolDigest,
      harnessVersion: R23_HARNESS_VERSION,
      campaignId: options.identity.campaignId,
      phase: options.identity.phase,
      runId,
      pairId: options.identity.pairId,
      taskId: options.task.record.taskId,
      taskClass: options.task.record.class,
      taskLanguage: options.task.record.language,
      repoSizeClass: options.task.record.repoSizeClass,
      arm: options.armId,
      armConfigurationDigest: armConfigurationDigest(options.arm),
      pairOrder: options.identity.pairOrder,
      repetition: options.identity.repetition,
      codeforgeCommit: options.identity.codeforgeCommit,
      codeforgeTreeDirty: options.identity.codeforgeTreeDirty,
      ...(options.identity.dirtyFiles ? { dirtyFiles: options.identity.dirtyFiles } : {}),
      startingTreeHash,
      endingTreeHash,
      taskDigest: options.task.digest,
      modelId: options.model.modelId,
      providerId: options.model.providerId,
      routeClass: options.model.routeClass,
      forgeGreenEnabled: options.arm.forgeGreenAdvisor,
      subagentsEnabled: options.arm.topology === "adaptive",
      topology: `${options.executionMode}:${topology}`,
      environmentFingerprint: options.identity.environmentFingerprint,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date(now()).toISOString(),
    },
    outcome: {
      runtimeStatus,
      stopReason,
      claimedComplete,
      verifierRan: verifier !== undefined,
      ...(verifierPassed !== undefined ? { verifierPassed } : {}),
      ...(verifier && verifier.exitCode !== null ? { verifierExitCode: verifier.exitCode } : {}),
      ...(verifier ? { verifierDurationMs: verifier.durationMs } : {}),
      completionAuthority,
      completionBlockers: completion?.blockers.map((blocker) => blocker.code) ?? [],
      forbiddenActionObserved: forbidden,
      verifiedComplete,
      falseComplete: claimedComplete && !verifiedComplete,
      classification,
      completionReason: reason,
      ...(verifier?.testsPassed !== undefined ? { testsPassed: verifier.testsPassed } : {}),
      ...(verifier?.testsFailed !== undefined ? { testsFailed: verifier.testsFailed } : {}),
      filesChanged: diff.filesChanged.length > 0 ? diff.filesChanged : [...filesChangedReported].sort(),
      linesAdded: diff.linesAdded,
      linesRemoved: diff.linesRemoved,
      ...(runtimeError ? { runtimeError } : {}),
    },
    inference: {
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalTokens,
      cachedInputTokens: cached,
      uncachedInputTokens: uncached,
      reasoningTokens: reasoning,
      modelCalls: calls.length,
      callsWithProviderUsage: reported.length,
      failedModelCalls: calls.filter((call) => call.outcome === "error").length,
      // A retried call is one issued immediately after a failed call (the agent re-asked).
      retriedModelCalls: calls.filter((call, index) => index > 0 && calls[index - 1]!.outcome === "error").length,
      rateLimitedCalls: calls.filter((call) => call.rateLimited).length,
      providerFailovers: Math.max(0, new Set(calls.map((call) => call.providerId)).size - 1),
      modelFailovers: Math.max(0, new Set(calls.map((call) => call.requestedModelId)).size - 1),
      duplicateRequestsSuppressed: forgeGreenReasonCodes.filter((code) => code === "duplicate_request_suppressed").length,
      calls,
    },
    context: {
      transmittedContextBytes: context.transmittedContextBytes,
      finalConversationBytes: context.finalConversationBytes,
      providerStatelessnessRepeatBytes: context.providerStatelessnessRepeatBytes,
      avoidableDuplicateBytes: context.avoidableDuplicateBytes,
      avoidableDuplicateTokens: context.avoidableDuplicateTokens,
      avoidableDuplicateEvents: context.avoidableDuplicateEvents,
      avoidableDuplicateBytesWithinRole: context.avoidableDuplicateBytesWithinRole,
      avoidableDuplicateBytesCrossRole: context.avoidableDuplicateBytesCrossRole,
      finalComposition: context.finalComposition,
      bootstrapContextBytes: bootstrap.contextBytes,
      bootstrapSelectedFiles: bootstrap.selectedFiles,
      bootstrapCandidateFiles: bootstrap.candidateFiles,
      canonicalCacheHits: efficiency.canonicalCacheHits,
      canonicalCacheMisses: efficiency.canonicalCacheMisses,
      toolOutputBytesAvoidedByCompression: efficiency.toolOutputBytesAvoided,
      providerCacheHitCalls: calls.filter((call) => (call.cachedPromptTokens ?? 0) > 0).length,
      ...(context.promptTokensPerByte !== undefined ? { promptTokensPerByte: context.promptTokensPerByte } : {}),
    },
    activity: {
      role: options.task.record.role,
      toolCallsRequested: trace.length,
      toolCallsExecuted: toolExecutions.length,
      toolCallsFailed: toolExecutions.filter((execution) => execution.success === false).length,
      duplicateActionsSuppressed: efficiency.duplicateActionsSuppressed,
      byTool,
      fileReads: countTools((name) => name === "read_file"),
      fileWrites: countTools((name) => name === "write_file" || name === "edit_file" || name === "write_patch" || name === "apply_patch"),
      searches: countTools((name) => name === "search_files" || name === "search_workspace" || name.startsWith("repo_")),
      listings: countTools((name) => name === "list_files"),
      shellCalls: countTools((name) => name === "run_command" || name === "execute_command"),
      browserCalls: countTools((name) => name.startsWith("browser_")),
      mcpCalls: countTools((name) => name.startsWith("mcp__")),
      pluginCalls: countTools((name) => name.startsWith("plugin__")),
      subagentCount,
      subagentModelCalls: 0,
    },
    time: {
      wallClockMs,
      activeAgentMs: Math.max(0, agentEndedMs - agentStartedMs - rateWait - pacingWaitMs - verificationMs),
      modelWaitMs: modelWaitMs(calls),
      pacingWaitMs,
      toolMs: toolExecutions.length > 0 ? measured(toolExecutions.reduce((sum, execution) => sum + (execution.durationMs ?? 0), 0), "RUNTIME", "Σ tool execution durations") : unknownMetric("no tool execution records available in this mode"),
      verificationMs,
      rateLimitWaitMs: rateWait,
      forgeGreenOverheadMs: unknownMetric("not joined in this record"),
    },
    economics: {
      pricingSnapshotId: economics.pricingSnapshotId,
      actualCostUsd: economics.actualCostUsd,
      equivalentPublicApiCostUsd: economics.equivalentPublicApiCostUsd,
      equivalentPublicApiPriceRef: economics.equivalentPublicApiPriceRef,
      equivalentMarketCostUsd: economics.equivalentMarketCostUsd,
      equivalentMarketPriceRef: economics.equivalentMarketPriceRef,
    },
    resources: {
      cpuUserMs: resources.cpuUserMs,
      cpuSystemMs: resources.cpuSystemMs,
      peakRssBytes: resources.peakRssBytes,
      providerResponseBytes: measured(calls.reduce((sum, call) => sum + call.responseBytes, 0), "HARNESS"),
      providerRequestBytes: measured(calls.reduce((sum, call) => sum + call.requestBytes, 0), "HARNESS"),
      gpuPowerDrawWattsIdleSample: resources.gpuPowerDrawWattsIdleSample,
      sampler: resources.sampler,
    },
    telemetry: {
      efficiencyReasonCodes: forgeGreenReasonCodes,
    },
    notes,
  };

  // Join the runtime's R0 telemetry id when the run persisted one (single-agent runs use `runId`).
  try {
    const item = await persistence.getWorkItem(`forgegreen-r0-telemetry-${runId}`);
    if (item?.kind === "forgegreen_r0_telemetry") {
      const telemetry = item.record as { telemetryId?: string; tools?: { toolDurationMs?: { value?: number } }; forgeGreenOverheadMs?: { value?: number } };
      if (telemetry.telemetryId) record.telemetry.forgeGreenR0TelemetryId = telemetry.telemetryId;
      if (typeof telemetry.tools?.toolDurationMs?.value === "number") record.time.toolMs = measured(telemetry.tools.toolDurationMs.value, "RUNTIME");
      if (typeof telemetry.forgeGreenOverheadMs?.value === "number") record.time.forgeGreenOverheadMs = measured(telemetry.forgeGreenOverheadMs.value, "RUNTIME");
    }
  } catch {
    // telemetry join is best effort; the record stays valid without it
  }

  await material.dispose();
  persistence.close();

  const validated = validateRunRecord(record);
  const violations = runRecordInvariantViolations(validated);
  return { record: validated, violations, scratchDir, ...(agentResult ? { agentResult } : {}), ...(orchestratorResult ? { orchestratorResult } : {}), ...(verifier ? { verifier } : {}) };
}
