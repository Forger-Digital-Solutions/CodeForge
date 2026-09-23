#!/usr/bin/env node
/**
 * R28 ForgeGreen live matched-pair harness (executeAgentRun path).
 *
 * The production ForgeGreen measurement path lives in AgentRuntime.executeAgentRun's
 * finally block (r0 telemetry, sustainability receipt, efficiency ledger, optimization
 * decisions). This harness drives the SAME digest-locked task fixture through two
 * real coder-role agent runs on the SAME verified-free route, with the only arm
 * difference being the advisor itself:
 *
 *   - control:    createAgentRuntime({ forgeGreen: createForgeGreenAdvisor({ enabled: false }) })
 *   - experiment: createAgentRuntime({ forgeGreen: createForgeGreenAdvisor({ enabled: true }) })
 *
 * Per the r1r causality audit this disables advisor-owned caches, stable-prefix
 * observations, model-request deduplication, and verification recommendations while
 * tool-output compression and duplicate/no-progress supervision run in BOTH arms.
 * All measurements are read back from the run's own persisted records — never
 * harness-side estimates.
 */
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { PROVIDER_DEFINITIONS } from "@codeforge/model-registry";
import {
  EnvironmentCredentialStore,
  InMemoryProviderCatalog,
  createProviderAdapterFromDefinition,
} from "@codeforge/providers";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { TaskAuthority, createLease } from "@codeforge/permissions";
import { createAgentRuntime } from "@codeforge/server";
import { createForgeGreenAdvisor } from "@codeforge/forge-green";
import { createBoundedAdapter } from "../r27/live-endurance.mjs";

const execFile = promisify(execFileCallback);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EVIDENCE_ROOT = path.resolve(REPOSITORY_ROOT, "docs", "evidence", "r28-capability-completion");
const LIVE_TASK_ROOT = path.resolve(REPOSITORY_ROOT, "benchmarks", "r23", "tasks");
const LIVE_MANIFEST_PATH = path.resolve(REPOSITORY_ROOT, "benchmarks", "r27", "manifest.json");

const FG_KINDS = [
  "forgegreen_r0_telemetry",
  "forgegreen_sustainability_receipt",
  "forgegreen_optimization_decision",
  "forgegreen_optimization_receipt",
  "forgegreen_ledger",
];

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function boundedPositive(name, fallback, max) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0 || value > max) throw new Error(`${name} must be 1..${max}.`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function loadLockedTask(taskId) {
  const manifest = JSON.parse(await readFile(LIVE_MANIFEST_PATH, "utf8"));
  const locked = manifest.lockedTasks.find((entry) => entry.sourceTaskId === taskId);
  if (!locked?.liveEligible) throw new Error(`Task '${taskId}' is not an R27 live-eligible digest-locked task.`);
  const taskRoot = path.resolve(LIVE_TASK_ROOT, taskId);
  const task = JSON.parse(await readFile(path.join(taskRoot, "task.json"), "utf8"));
  return { locked, taskRoot, task };
}

async function runVerifier(command, cwd, timeoutMs) {
  const argv = command.trim().split(/\s+/);
  const startedAt = Date.now();
  try {
    const result = await execFile(process.execPath, argv.slice(1), { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 });
    return { command, passed: true, elapsedMs: Date.now() - startedAt, outputHash: sha256(`${result.stdout}\n${result.stderr}`) };
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    return { command, passed: false, elapsedMs: Date.now() - startedAt, exitCode: typeof error?.code === "number" ? error.code : undefined, outputHash: sha256(`${stdout}\n${stderr}`) };
  }
}

const metric = (m) => (m && typeof m === "object" && "value" in m ? m.value ?? null : m ?? null);

function summarizeR0(t) {
  if (!t) return null;
  const m = t.model ?? {};
  const c = t.context ?? {};
  const tl = t.tools ?? {};
  return {
    telemetryId: t.telemetryId ?? null,
    routeClass: metric(t.routeClass),
    taskCompletionStatus: metric(t.taskCompletionStatus),
    stopReason: metric(t.stopReason),
    wallTimeMs: metric(t.wallTimeMs),
    forgeGreenOverheadMs: metric(t.forgeGreenOverheadMs),
    model: {
      providerAttempts: metric(m.providerAttempts),
      modelAttempts: metric(m.modelAttempts),
      inputTokens: metric(m.inputTokens),
      cachedInputTokens: metric(m.cachedInputTokens),
      outputTokens: metric(m.outputTokens),
      totalTokens: metric(m.totalTokens),
      effectiveUncachedInputTokens: metric(m.effectiveUncachedInputTokens),
      stablePromptCacheHits: metric(m.stablePromptCacheHits),
      providerPromptCacheReports: metric(m.providerPromptCacheReports),
    },
    context: {
      initialContextBytes: metric(c.initialContextBytes),
      modelContextBytes: metric(c.modelContextBytes),
      stablePromptBytes: metric(c.stablePromptBytes),
    },
    tools: {
      toolCalls: metric(tl.toolCalls),
      executedToolCalls: metric(tl.executedToolCalls),
      failedToolCalls: metric(tl.failedToolCalls),
      duplicateEquivalentToolCalls: metric(tl.duplicateEquivalentToolCalls),
      rawToolOutputBytes: metric(tl.rawToolOutputBytes),
      bytesDeliveredToModelContext: metric(tl.bytesDeliveredToModelContext),
      compressionBytesAvoided: metric(tl.compression?.bytesAvoided),
      compressionRatio: metric(tl.compression?.ratio),
    },
    retries: {
      retryCount: metric(t.retries?.retryCount),
      reasons: (t.retries?.reasons ?? []).map((r) => ({ reason: r.reason, count: metric(r.count) })),
    },
  };
}

function summarizeSustainability(r) {
  if (!r) return null;
  return {
    receiptId: r.receiptId ?? null,
    measurementStatus: r.measurementStatus ?? null,
    failureReasonCodes: r.measurementFailureReasonCodes ?? [],
    tokenAccounting: r.tokenAccounting ?? null,
    toolAccounting: r.toolAccounting ?? null,
    verificationAccounting: r.verificationAccounting ?? null,
    baselineKinds: (r.baselines ?? []).map((b) => ({ kind: b.baselineKind, basis: b.comparisonBasis })),
    energyEstimate: r.energyEstimate ? { estimatorId: r.energyEstimate.estimatorId, confidence: r.energyEstimate.confidence } : null,
    contextPopulation: r.contextPopulation ?? null,
  };
}

async function runArm({ arm, forgeGreenEnabled, providerAdapter, firewall, providerId, modelId, task, taskCopy, workspacePath, runRoot, maxRequests, maxOutputTokens, deadline }) {
  const requestRecords = [];
  const bounded = createBoundedAdapter(providerAdapter, maxRequests, maxOutputTokens, requestRecords);
  const catalog = new InMemoryProviderCatalog();
  catalog.register(bounded);
  const persistence = createSessionPersistence({ dbPath: path.join(runRoot, `session-${arm}.sqlite`) });
  const eventStore = new EventStore();
  const sessionId = `r28-fg-${arm}-${randomUUID()}`;
  const authority = new TaskAuthority(
    createLease({ sessionId, workspaceRoot: workspacePath, permissionMode: "full_autonomy", planMode: "auto" }),
  );
  const runtime = createAgentRuntime({
    sessionId,
    eventStore,
    persistence,
    firewall,
    providerCatalog: catalog,
    workspacePath,
    demoMode: false,
    authorityFor: () => authority,
    forgeGreen: createForgeGreenAdvisor({ enabled: forgeGreenEnabled }),
  });
  runtime.setModelSelection({ providerId, modelId, lock: "route" });

  const signal = AbortSignal.timeout(Math.max(1_000, deadline - Date.now()));
  const startedAt = Date.now();
  let result;
  let runError;
  try {
    result = await runtime.executeAgentRun({
      runId: `fg-ab-${arm}-${randomUUID()}`,
      agentId: "coder",
      role: "coder",
      goal: task.goal,
      workspaceId: `fg-ab-${arm}`,
      workspacePath,
      permissions: { read: true, search: true, write: true, executeCommand: true, network: false },
      signal,
    });
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error);
  }
  const wallClockMs = Date.now() - startedAt;

  const eventTypes = eventStore.getAll().reduce((counts, event) => {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
    return counts;
  }, {});

  const byKind = {};
  for (const kind of FG_KINDS) {
    const items = await persistence.getWorkItemsByKind(kind).catch(() => []);
    byKind[kind] = items.map((item) => item.record);
  }
  await persistence.close();

  return {
    arm,
    forgeGreenEnabled,
    runError,
    status: result?.status ?? null,
    summary: result?.summary ?? null,
    filesChanged: result?.filesChanged ?? null,
    provider: { inferenceRequestCount: requestRecords.length, requests: requestRecords },
    timing: { wallClockMs, aborted: signal.aborted },
    eventTypes,
    persistedCounts: Object.fromEntries(FG_KINDS.map((k) => [k, byKind[k].length])),
    r0Telemetry: summarizeR0(byKind.forgegreen_r0_telemetry[0]),
    sustainabilityReceipt: summarizeSustainability(byKind.forgegreen_sustainability_receipt.at(-1)),
    optimizationDecisions: byKind.forgegreen_optimization_decision,
    optimizationReceipts: byKind.forgegreen_optimization_receipt,
    ledgerRecords: byKind.forgegreen_ledger.length,
  };
}

async function main() {
  if (process.env.R28_LIVE_ENABLE !== "true") {
    throw new Error("R28_LIVE_ENABLE=true is required. This harness spends real provider requests.");
  }
  const providerId = requiredValue("R28_LIVE_PROVIDER");
  const modelId = requiredValue("R28_LIVE_MODEL");
  const taskId = requiredValue("R28_LIVE_TASK_ID");
  const maxRequests = boundedPositive("R28_LIVE_MAX_REQUESTS", 40, 120);
  const maxOutputTokens = boundedPositive("R28_LIVE_MAX_OUTPUT_TOKENS", 4096, 4096);
  const timeoutMs = boundedPositive("R28_LIVE_TIMEOUT_MS", 20 * 60_000, 45 * 60_000);
  const deadline = Date.now() + timeoutMs;

  const definition = PROVIDER_DEFINITIONS[providerId];
  if (!definition?.implemented || definition.freeAccess.class !== "FREE_API" || definition.freeAccess.spillover !== "NONE") {
    throw new Error("Only implemented FREE_API providers with no paid spillover are permitted.");
  }
  const credentialStore = new EnvironmentCredentialStore();
  if (!credentialStore.has(providerId)) throw new Error(`No credential configured for '${providerId}'.`);
  const providerAdapter = createProviderAdapterFromDefinition(definition, { credentialStore, timeoutMs: 30_000 });
  if (!providerAdapter) throw new Error("No provider adapter could be constructed.");
  const listedModels = await providerAdapter.listModels();
  const selected = listedModels.find((model) => model.modelId === modelId);
  if (!selected || !selected.isFree || selected.freeStatus !== "verified_free") {
    throw new Error(`'${providerId}/${modelId}' is not currently verified free by the live catalog.`);
  }

  const { locked, taskRoot, task } = await loadLockedTask(taskId);

  const firewallFor = () => {
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({
      providerId,
      modelId,
      displayName: selected.displayName,
      contextWindow: selected.contextWindow,
      capabilities: selected.capabilities,
      accessClass: "FREE_ROUTED",
      authMode: "API_KEY",
      costProfile: {
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
        cacheReadCostPerMillion: 0,
        cacheWriteCostPerMillion: 0,
        isFree: true,
        paidFallbackPossible: false,
        paidFallbackDisabled: true,
        source: `${providerId}:live-catalog`,
      },
    }));
    return firewall;
  };

  const arms = [];
  for (const [arm, enabled] of [
    ["control_forgegreen_off", false],
    ["experiment_forgegreen_on", true],
  ]) {
    const runRoot = await mkdtemp(path.join(os.tmpdir(), `codeforge-r28-fg-${arm}-`));
    const taskCopy = path.join(runRoot, "task");
    const workspacePath = path.join(taskCopy, task.fixture);
    await cp(taskRoot, taskCopy, { recursive: true, force: false, errorOnExist: true });

    const armResult = await runArm({
      arm,
      forgeGreenEnabled: enabled,
      providerAdapter,
      firewall: firewallFor(),
      providerId,
      modelId,
      task,
      taskCopy,
      workspacePath,
      runRoot,
      maxRequests,
      maxOutputTokens,
      deadline,
    });

    // Visible verification inside the arm workspace, then the hidden verifier contract.
    const visibleVerification = [];
    for (const command of task.visibleVerification ?? []) {
      visibleVerification.push(await runVerifier(command, workspacePath, 30_000));
    }
    const hiddenSource = path.resolve(taskCopy, task.hidden);
    let hiddenVerification;
    try {
      await cp(hiddenSource, path.join(workspacePath, task.hidden), { recursive: true, force: false, errorOnExist: true });
      hiddenVerification = await runVerifier(task.verifier.command, workspacePath, task.verifier.timeoutMs ?? 30_000);
    } catch (error) {
      hiddenVerification = { command: task.verifier.command, passed: false, error: error instanceof Error ? error.message : String(error) };
    }
    armResult.verification = { visible: visibleVerification, hidden: hiddenVerification };
    armResult.runRoot = runRoot;
    arms.push(armResult);
  }

  const [control, experiment] = arms;
  const diff = (a, b) => (typeof a === "number" && typeof b === "number" ? b - a : null);
  const comparison = control.r0Telemetry && experiment.r0Telemetry
    ? {
        wallTimeMsDelta: diff(control.r0Telemetry.wallTimeMs, experiment.r0Telemetry.wallTimeMs),
        forgeGreenOverheadMs: { control: control.r0Telemetry.forgeGreenOverheadMs, experiment: experiment.r0Telemetry.forgeGreenOverheadMs },
        inputTokensDelta: diff(control.r0Telemetry.model.inputTokens, experiment.r0Telemetry.model.inputTokens),
        effectiveUncachedInputTokens: { control: control.r0Telemetry.model.effectiveUncachedInputTokens, experiment: experiment.r0Telemetry.model.effectiveUncachedInputTokens },
        cachedInputTokens: { control: control.r0Telemetry.model.cachedInputTokens, experiment: experiment.r0Telemetry.model.cachedInputTokens },
        stablePromptCacheHits: { control: control.r0Telemetry.model.stablePromptCacheHits, experiment: experiment.r0Telemetry.model.stablePromptCacheHits },
        stablePromptBytes: { control: control.r0Telemetry.context.stablePromptBytes, experiment: experiment.r0Telemetry.context.stablePromptBytes },
        modelContextBytesDelta: diff(control.r0Telemetry.context.modelContextBytes, experiment.r0Telemetry.context.modelContextBytes),
        outputTokensDelta: diff(control.r0Telemetry.model.outputTokens, experiment.r0Telemetry.model.outputTokens),
        toolCallsDelta: diff(control.r0Telemetry.tools.toolCalls, experiment.r0Telemetry.tools.toolCalls),
        duplicateEquivalentToolCalls: { control: control.r0Telemetry.tools.duplicateEquivalentToolCalls, experiment: experiment.r0Telemetry.tools.duplicateEquivalentToolCalls },
        compressionBytesAvoided: { control: control.r0Telemetry.tools.compressionBytesAvoided, experiment: experiment.r0Telemetry.tools.compressionBytesAvoided },
      }
    : null;

  const receipt = {
    schema: "r28-forgegreen-matched-pair-2",
    recordedAt: new Date().toISOString(),
    design: {
      topology: "agent_runtime_executeAgentRun",
      measurementPath: "ForgeGreen telemetry/receipts persist in executeAgentRun's finally — the workflow startTurn path does not record them",
      armDifference: "forgeGreen advisor enabled:false vs enabled:true (advisor-owned caches, stable-prefix observations, model-request deduplication, verification recommendations); compression + duplicate/no-progress supervision run in BOTH arms per r1r causality audit",
      task: { sourceTaskId: task.taskId, class: task.class, corpusDigest: locked.treeDigest },
      providerId,
      modelId,
      role: "coder",
      maxRequestsPerArm: maxRequests,
      maxOutputTokens,
    },
    arms: {
      control: { ...control, runRoot: undefined },
      experiment: { ...experiment, runRoot: undefined },
    },
    comparison,
    honesty: {
      singlePair: true,
      note: "One matched pair cannot separate advisor effect from model-output stochasticity; values are observed provider receipts and persisted product records, not causal proof of magnitude.",
    },
  };

  await mkdir(EVIDENCE_ROOT, { recursive: true });
  const receiptPath = path.join(EVIDENCE_ROOT, "R28-FORGEGREEN-AB-LIVE-EVIDENCE.json");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  for (const arm of arms) {
    if (arm.runRoot && process.env.R28_LIVE_KEEP_WORKSPACE !== "true") {
      await rm(arm.runRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const telemetryPersisted = (control.persistedCounts.forgegreen_r0_telemetry ?? 0) > 0 && (experiment.persistedCounts.forgegreen_r0_telemetry ?? 0) > 0;
  console.log(JSON.stringify({
    receiptPath: path.relative(REPOSITORY_ROOT, receiptPath),
    statuses: { control: control.status, experiment: experiment.status },
    hiddenVerifierPassed: { control: control.verification.hidden.passed, experiment: experiment.verification.hidden.passed },
    telemetryPersistedBothArms: telemetryPersisted,
    requests: { control: control.provider.inferenceRequestCount, experiment: experiment.provider.inferenceRequestCount },
    comparison,
  }, null, 2));
  process.exitCode = telemetryPersisted ? 0 : 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
