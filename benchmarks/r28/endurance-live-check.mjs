#!/usr/bin/env node
/**
 * R28 live endurance harness.
 *
 * Soaks ONE AgentRuntime/session with sequential real coder-role runs through a
 * verified-free route for a bounded wall-clock window, sampling process memory,
 * session DB size, event count, and per-iteration outcomes. The measured trend —
 * not a threshold assertion — is the evidence: linear resource growth per
 * iteration is expected; superlinear RSS/heap growth is a leak signal.
 */
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import { createBoundedAdapter } from "../r27/live-endurance.mjs";

const execFile = promisify(execFileCallback);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EVIDENCE_ROOT = path.resolve(REPOSITORY_ROOT, "docs", "evidence", "r28-capability-completion");
const LIVE_TASK_ROOT = path.resolve(REPOSITORY_ROOT, "benchmarks", "r23", "tasks");
const LIVE_MANIFEST_PATH = path.resolve(REPOSITORY_ROOT, "benchmarks", "r27", "manifest.json");

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

async function loadLockedTasks() {
  const manifest = JSON.parse(await readFile(LIVE_MANIFEST_PATH, "utf8"));
  const tasks = [];
  for (const entry of manifest.lockedTasks.filter((e) => e.liveEligible && e.class !== "large")) {
    const taskRoot = path.resolve(LIVE_TASK_ROOT, entry.sourceTaskId);
    try {
      const task = JSON.parse(await readFile(path.join(taskRoot, "task.json"), "utf8"));
      tasks.push({ locked: entry, taskRoot, task });
    } catch {}
  }
  if (tasks.length === 0) throw new Error("No live-eligible locked tasks available for endurance.");
  return tasks;
}

async function runVerifier(command, cwd, timeoutMs) {
  const argv = command.trim().split(/\s+/);
  try {
    await execFile(process.execPath, argv.slice(1), { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 });
    return true;
  } catch {
    return false;
  }
}

function linearSlope(samples, valueOf) {
  const xs = samples.map((_, i) => i);
  const ys = samples.map(valueOf);
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

async function main() {
  if (process.env.R28_LIVE_ENABLE !== "true") {
    throw new Error("R28_LIVE_ENABLE=true is required. This harness spends real provider requests.");
  }
  const providerId = requiredValue("R28_LIVE_PROVIDER");
  const modelId = requiredValue("R28_LIVE_MODEL");
  const minutes = boundedPositive("R28_ENDURANCE_MINUTES", 20, 240);
  const maxIterations = boundedPositive("R28_ENDURANCE_MAX_ITERATIONS", 40, 400);
  const maxRequests = boundedPositive("R28_LIVE_MAX_REQUESTS", 400, 2000);
  const maxOutputTokens = boundedPositive("R28_LIVE_MAX_OUTPUT_TOKENS", 4096, 4096);
  const perRunTimeoutMs = boundedPositive("R28_ENDURANCE_PER_RUN_MS", 8 * 60_000, 20 * 60_000);
  const deadline = Date.now() + minutes * 60_000;

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

  const tasks = await loadLockedTasks();
  const soakRoot = await mkdtemp(path.join(os.tmpdir(), "codeforge-r28-endurance-"));
  const dbPath = path.join(soakRoot, "session.sqlite");
  const persistence = createSessionPersistence({ dbPath });
  const eventStore = new EventStore();
  const sessionId = `r28-endurance-${randomUUID()}`;
  const requestRecords = [];
  const bounded = createBoundedAdapter(providerAdapter, maxRequests, maxOutputTokens, requestRecords);
  const catalog = new InMemoryProviderCatalog();
  catalog.register(bounded);
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

  const iterations = [];
  const samples = [];
  const startedAt = Date.now();

  for (let i = 0; i < maxIterations && Date.now() < deadline; i++) {
    const { locked, taskRoot, task } = tasks[i % tasks.length];
    const iterRoot = path.join(soakRoot, `iter-${i}`);
    const taskCopy = path.join(iterRoot, "task");
    const workspacePath = path.join(taskCopy, task.fixture);
    await cp(taskRoot, taskCopy, { recursive: true, force: false, errorOnExist: true });

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
    });
    runtime.setModelSelection({ providerId, modelId, lock: "route" });

    const signal = AbortSignal.timeout(Math.min(perRunTimeoutMs, Math.max(1_000, deadline - Date.now())));
    const iterStart = Date.now();
    let result;
    let runError;
    try {
      result = await runtime.executeAgentRun({
        runId: `endurance-${i}-${randomUUID()}`,
        agentId: "coder",
        role: "coder",
        goal: task.goal,
        workspaceId: `endurance-${i}`,
        workspacePath,
        permissions: { read: true, search: true, write: true, executeCommand: true, network: false },
        signal,
      });
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error);
    }

    // Hidden verifier materializes post-run per locked-task contract.
    let hiddenPassed = null;
    try {
      const hiddenSource = path.resolve(taskCopy, task.hidden);
      await cp(hiddenSource, path.join(workspacePath, task.hidden), { recursive: true, force: false, errorOnExist: true });
      hiddenPassed = await runVerifier(task.verifier.command, workspacePath, task.verifier.timeoutMs ?? 30_000);
    } catch {}

    const mem = process.memoryUsage();
    const dbSize = await stat(dbPath).then((s) => s.size).catch(() => 0);
    const eventCount = eventStore.getAll().length;
    samples.push({
      iteration: i,
      elapsedMs: Date.now() - startedAt,
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      dbSizeBytes: dbSize,
      eventCount,
      cumulativeRequests: requestRecords.length,
    });
    iterations.push({
      iteration: i,
      taskId: task.taskId,
      class: task.class,
      status: result?.status ?? null,
      runError: runError ?? null,
      hiddenVerifierPassed: hiddenPassed,
      wallClockMs: Date.now() - iterStart,
      requestsDuringIteration: requestRecords.length - (samples[i - 1]?.cumulativeRequests ?? 0),
      filesChanged: result?.filesChanged?.length ?? 0,
      abortedByDeadline: signal.aborted,
    });
  }

  await persistence.close();

  const completedIterations = iterations.filter((it) => it.status === "completed").length;
  const blockedIterations = iterations.filter((it) => it.status === "blocked").length;
  const failedIterations = iterations.filter((it) => it.status !== "completed" && it.status !== "blocked").length;

  const receipt = {
    schema: "r28-endurance-live-1",
    recordedAt: new Date().toISOString(),
    design: {
      topology: "single_session_sequential_executeAgentRun",
      providerId,
      modelId,
      minutesBudgeted: minutes,
      maxIterations,
      perRunTimeoutMs,
      tasksRotated: tasks.map((t) => t.task.taskId),
    },
    outcome: {
      iterations: iterations.length,
      completedIterations,
      blockedIterations,
      failedIterations,
      hiddenVerifierPassCount: iterations.filter((it) => it.hiddenVerifierPassed === true).length,
      totalInferenceRequests: requestRecords.length,
      wallClockMs: Date.now() - startedAt,
    },
    resourceTrends: {
      rssBytesPerIteration: linearSlope(samples, (s) => s.rssBytes),
      heapUsedBytesPerIteration: linearSlope(samples, (s) => s.heapUsedBytes),
      dbSizeBytesPerIteration: linearSlope(samples, (s) => s.dbSizeBytes),
      eventCountPerIteration: linearSlope(samples, (s) => s.eventCount),
      first: samples[0] ?? null,
      last: samples.at(-1) ?? null,
    },
    samples,
    iterations,
    honesty: {
      note: "Resource trends are per-iteration linear slopes over the soaked window; DB/event growth is expected-linear, RSS/heap superlinear growth is the leak signal. Iteration outcomes are recorded honestly — blocked and failed iterations count against liveness, not against the evidence.",
    },
  };

  await mkdir(EVIDENCE_ROOT, { recursive: true });
  const receiptPath = path.join(EVIDENCE_ROOT, "R28-ENDURANCE-LIVE-EVIDENCE.json");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  if (process.env.R28_LIVE_KEEP_WORKSPACE !== "true") await rm(soakRoot, { recursive: true, force: true }).catch(() => undefined);

  console.log(JSON.stringify({
    receiptPath: path.relative(REPOSITORY_ROOT, receiptPath),
    iterations: iterations.length,
    completedIterations,
    blockedIterations,
    failedIterations,
    wallClockMinutes: Math.round((Date.now() - startedAt) / 60000),
    totalInferenceRequests: requestRecords.length,
    rssSlopeBytesPerIter: Math.round(receipt.resourceTrends.rssBytesPerIteration),
    heapSlopeBytesPerIter: Math.round(receipt.resourceTrends.heapUsedBytesPerIteration),
  }, null, 2));
  process.exitCode = iterations.length >= 2 && failedIterations === 0 ? 0 : 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
