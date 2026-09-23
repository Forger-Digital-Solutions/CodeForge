#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { PROVIDER_DEFINITIONS } from "@codeforge/model-registry";
import {
  EnvironmentCredentialStore,
  InMemoryProviderCatalog,
  ProviderError,
  createProviderAdapterFromDefinition,
} from "@codeforge/providers";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { createAgentRuntime } from "@codeforge/server";

const execFile = promisify(execFileCallback);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EVIDENCE_ROOT = path.resolve(REPOSITORY_ROOT, "docs", "evidence", "r27-intelligence-perfection");
const LIVE_TASK_ROOT = path.resolve(REPOSITORY_ROOT, "benchmarks", "r23", "tasks");
const LIVE_MANIFEST_PATH = path.resolve(REPOSITORY_ROOT, "benchmarks", "r27", "manifest.json");

function requireEnabled() {
  if (process.env.R27_LIVE_ENABLE !== "true") {
    throw new Error("R27_LIVE_ENABLE=true is required. The harness never spends a provider request by default.");
  }
}

function boundedPositive(name, fallback, max) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be an integer from 1 through ${max}.`);
  }
  return value;
}

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function resolveEvidenceDirectory() {
  const configured = requiredValue("R27_LIVE_EVIDENCE_DIR");
  const directory = path.resolve(REPOSITORY_ROOT, configured);
  const prefix = `${EVIDENCE_ROOT}${path.sep}`;
  if (directory !== EVIDENCE_ROOT && !directory.startsWith(prefix)) {
    throw new Error("R27_LIVE_EVIDENCE_DIR must stay under docs/evidence/r27-intelligence-perfection.");
  }
  return directory;
}

function parseNodeCommand(command) {
  const argv = command.trim().split(/\s+/);
  if (argv[0] !== "node" || argv.length < 2 || argv.some((entry) => !/^[A-Za-z0-9_./-]+$/.test(entry))) {
    throw new Error(`Only a simple locked 'node …' verifier command is supported, received: ${command}`);
  }
  return argv.slice(1);
}

async function runVerifier(command, cwd, timeoutMs) {
  const args = parseNodeCommand(command);
  const startedAt = Date.now();
  try {
    const result = await execFile(process.execPath, args, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
    return {
      command,
      passed: true,
      elapsedMs: Date.now() - startedAt,
      outputHash: sha256(`${result.stdout}\n${result.stderr}`),
    };
  } catch (error) {
    const detail = error && typeof error === "object" ? error : {};
    const stdout = typeof detail.stdout === "string" ? detail.stdout : "";
    const stderr = typeof detail.stderr === "string" ? detail.stderr : "";
    return {
      command,
      passed: false,
      elapsedMs: Date.now() - startedAt,
      exitCode: typeof detail.code === "number" ? detail.code : undefined,
      outputHash: sha256(`${stdout}\n${stderr}`),
    };
  }
}

export function createBoundedAdapter(inner, maxRequests, maxOutputTokens, records) {
  const rejectAfterOutputCapViolation = () => {
    if (records.some((record) => record.outputCapExceeded === true)) {
      throw new ProviderError("R27 live run stopped before another dispatch because the provider reported output above the configured ceiling.", "R27_LIVE_OUTPUT_CAP");
    }
  };
  const observeOutput = (record, outputTokens) => {
    record.outputTokens = outputTokens;
    if (typeof outputTokens === "number" && outputTokens > maxOutputTokens) {
      record.outputCapExceeded = true;
      record.outcome = "output_cap_exceeded";
    }
  };
  const guarded = {
    providerId: inner.providerId,
    isTestProvider: inner.isTestProvider,
    supportsDispatchIdentity: inner.supportsDispatchIdentity,
    listModels: () => inner.listModels(),
    healthCheck: () => inner.healthCheck(),
    getPromptCacheCapability: inner.getPromptCacheCapability
      ? (modelId) => inner.getPromptCacheCapability(modelId)
      : undefined,
    async chat(request) {
      rejectAfterOutputCapViolation();
      if (records.length >= maxRequests) throw new ProviderError("R27 live request ceiling reached before dispatch", "R27_LIVE_REQUEST_CAP");
      const startedAt = Date.now();
      const record = { requestNumber: records.length + 1, kind: "chat", elapsedMs: 0, firstUsefulEventMs: null, inputTokens: null, outputTokens: null, outputCapExceeded: false, outcome: "started" };
      records.push(record);
      try {
        const response = await inner.chat(request);
        record.elapsedMs = Date.now() - startedAt;
        record.inputTokens = response.usage?.inputTokens ?? null;
        observeOutput(record, response.usage?.outputTokens ?? null);
        if (record.outcome === "started") record.outcome = "completed";
        return response;
      } catch (error) {
        record.elapsedMs = Date.now() - startedAt;
        record.outcome = error instanceof Error ? error.name : "error";
        throw error;
      }
    },
    async *streamChat(request, signal) {
      rejectAfterOutputCapViolation();
      if (records.length >= maxRequests) throw new ProviderError("R27 live request ceiling reached before dispatch", "R27_LIVE_REQUEST_CAP");
      const startedAt = Date.now();
      const record = { requestNumber: records.length + 1, kind: "stream", elapsedMs: 0, firstUsefulEventMs: null, inputTokens: null, outputTokens: null, outputCapExceeded: false, outcome: "started" };
      records.push(record);
      try {
        for await (const event of inner.streamChat(request, signal)) {
          if (record.firstUsefulEventMs === null && (event.type === "text_delta" || event.type === "tool_call_started" || event.type === "tool_call_completed")) {
            record.firstUsefulEventMs = Date.now() - startedAt;
          }
          if (event.type === "usage") {
            record.inputTokens = event.usage.inputTokens ?? null;
            observeOutput(record, event.usage.outputTokens ?? null);
          }
          yield event;
        }
        record.elapsedMs = Date.now() - startedAt;
        if (record.outcome === "started") record.outcome = "completed";
      } catch (error) {
        record.elapsedMs = Date.now() - startedAt;
        record.outcome = error instanceof Error ? error.name : "error";
        throw error;
      }
    },
  };
  return guarded;
}

async function loadLockedTask(taskId) {
  const manifest = JSON.parse(await readFile(LIVE_MANIFEST_PATH, "utf8"));
  const locked = manifest.lockedTasks.find((entry) => entry.sourceTaskId === taskId);
  if (!locked?.liveEligible) throw new Error(`Task '${taskId}' is not an R27 live-eligible digest-locked task.`);
  const taskRoot = path.resolve(LIVE_TASK_ROOT, taskId);
  if (!taskRoot.startsWith(`${LIVE_TASK_ROOT}${path.sep}`)) throw new Error("Task path escaped the locked corpus.");
  const task = JSON.parse(await readFile(path.join(taskRoot, "task.json"), "utf8"));
  if (task.taskId !== taskId || typeof task.goal !== "string" || typeof task.hidden !== "string" || !task.permissions || !Array.isArray(task.visibleVerification)) {
    throw new Error(`Locked task '${taskId}' has an invalid task contract.`);
  }
  return { locked, taskRoot, task };
}

async function main() {
  requireEnabled();
  const providerId = requiredValue("R27_LIVE_PROVIDER");
  const modelId = requiredValue("R27_LIVE_MODEL");
  const taskId = requiredValue("R27_LIVE_TASK_ID");
  const evidenceDirectory = resolveEvidenceDirectory();
  const maxRequests = boundedPositive("R27_LIVE_MAX_REQUESTS", 4, 6);
  const maxOutputTokens = boundedPositive("R27_LIVE_MAX_OUTPUT_TOKENS", 256, 512);
  const maxContextTokens = boundedPositive("R27_LIVE_MAX_CONTEXT_TOKENS", 12_000, 16_000);
  const timeoutMs = boundedPositive("R27_LIVE_TIMEOUT_MS", 90_000, 300_000);
  // ContextAssembler reserves 3,000 system + 3,000 tool-schema + 4,096 output tokens before
  // its safety margin. A smaller budget reaches its truthful kernel-capacity failure without a
  // provider request, so reject it at the harness boundary with an actionable configuration error.
  if (maxContextTokens < 12_000) {
    throw new Error("R27_LIVE_MAX_CONTEXT_TOKENS must be at least 12000 so the AgentRuntime can retain its kernel after fixed prompt/output reservations.");
  }
  const definition = PROVIDER_DEFINITIONS[providerId];
  if (!definition?.implemented || definition.freeAccess.class !== "FREE_API" || definition.freeAccess.spillover !== "NONE") {
    throw new Error("The live harness permits only implemented FREE_API providers whose definition declares no paid spillover.");
  }

  const credentialStore = new EnvironmentCredentialStore();
  if (!credentialStore.has(providerId)) throw new Error(`No credential is configured for '${providerId}'.`);
  const providerResponses = [];
  const inner = createProviderAdapterFromDefinition(definition, {
    credentialStore,
    timeoutMs: Math.min(timeoutMs, 30_000),
    onResponse: (observation) => providerResponses.push({
      modelId: observation.modelId ?? null,
      status: observation.status,
      headers: observation.headers,
      observedAt: observation.observedAt,
    }),
  });
  if (!inner) throw new Error(`No adapter is implemented for '${providerId}'.`);
  const listedModels = await inner.listModels();
  const selected = listedModels.find((model) => model.modelId === modelId);
  if (!selected || !selected.isFree || selected.freeStatus !== "verified_free") {
    throw new Error(`'${providerId}/${modelId}' is not currently reported as verified free by the live catalog.`);
  }
  if (!Number.isInteger(selected.contextWindow) || selected.contextWindow <= 0) {
    throw new Error(`'${providerId}/${modelId}' has no positive catalog-declared context window, so the live harness will not guess one.`);
  }

  const { locked, taskRoot, task } = await loadLockedTask(taskId);
  const runId = `r27-live-${randomUUID()}`;
  const runRoot = await mkdtemp(path.join(os.tmpdir(), "codeforge-r27-live-"));
  const taskCopy = path.join(runRoot, "task");
  const workspacePath = path.join(taskCopy, task.fixture);
  await cp(taskRoot, taskCopy, { recursive: true, force: false, errorOnExist: true });

  const requestRecords = [];
  const adapter = createBoundedAdapter(inner, maxRequests, maxOutputTokens, requestRecords);
  const catalog = new InMemoryProviderCatalog();
  catalog.register(adapter);
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
  const persistence = createSessionPersistence({ dbPath: path.join(runRoot, "session.sqlite") });
  const eventStore = new EventStore();
  const runtime = createAgentRuntime({
    sessionId: runId,
    eventStore,
    persistence,
    firewall,
    providerCatalog: catalog,
    workspacePath,
  });
  await runtime.init();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("R27_LIVE_WALL_CLOCK_CAP")), timeoutMs);
  const memoryBefore = process.memoryUsage();
  const startedAt = Date.now();
  let result;
  let runtimeError;
  try {
    result = await runtime.executeAgentRun({
      runId,
      agentId: "coder",
      role: task.role,
      goal: task.goal,
      workspaceId: `r27-${taskId}`,
      workspacePath,
      permissions: task.permissions,
      modelSelection: { providerId, modelId, lock: "route" },
      executionBudget: {
        maxModelTurns: maxRequests,
        maxToolCalls: Math.min(8, maxRequests * 2),
        maxWriteToolCalls: Math.min(4, maxRequests),
        maxCommandExecutions: 0,
        maxContextTokens,
        maxOutputTokens,
      },
      signal: controller.signal,
    });
  } catch (error) {
    runtimeError = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timeout);
  }
  const visibleVerification = [];
  for (const command of task.visibleVerification) visibleVerification.push(await runVerifier(command, workspacePath, 30_000));
  // The locked corpus keeps hidden checks outside the model-visible fixture. Its verifier imports
  // the fixture's ../src path, so materialize it only after the run inside that isolated fixture.
  const hiddenSource = path.resolve(taskCopy, task.hidden);
  if (!hiddenSource.startsWith(`${taskCopy}${path.sep}`)) throw new Error("Hidden verifier path escaped the locked task copy.");
  await cp(hiddenSource, path.join(workspacePath, task.hidden), { recursive: true, force: false, errorOnExist: true });
  const hiddenVerification = await runVerifier(task.verifier.command, workspacePath, task.verifier.timeoutMs ?? 30_000);
  const memoryAfter = process.memoryUsage();
  const receipt = {
    schema: "r27-live-agent-runtime-receipt-1",
    recordedAt: new Date().toISOString(),
    runId,
    task: {
      r27TaskId: locked.r27TaskId,
      sourceTaskId: task.taskId,
      taskClass: task.class,
      corpusDigest: locked.treeDigest,
    },
    configuration: {
      providerId,
      modelId,
      routeLock: "route",
      topology: "single_coder_agent_runtime",
      forgeGreen: "not_measured_by_this_harness",
      maxRequests,
      maxOutputTokens,
      maxContextTokens,
      timeoutMs,
    },
    provider: {
      inferenceRequestCount: requestRecords.length,
      requests: requestRecords,
      observedResponses: providerResponses,
      providerReportedUsage: result?.usage ?? null,
    },
    runtime: result
      ? {
          status: result.status,
          stopReason: result.stopReason,
          error: result.error ?? null,
          summaryHash: sha256(result.summary),
          findings: result.findings.length,
          evidence: result.evidence.length,
          filesChanged: result.filesChanged,
          toolCalls: result.toolExecutions.length,
          toolFailures: result.toolExecutions.filter((tool) => tool.success === false).length,
          context: result.contextMetrics ?? null,
          eventTypes: eventStore.getAll().reduce((counts, event) => {
            counts[event.type] = (counts[event.type] ?? 0) + 1;
            return counts;
          }, {}),
        }
      : { status: "runtime_exception", error: runtimeError ?? "unknown runtime exception" },
    verification: {
      visible: visibleVerification,
      hidden: hiddenVerification,
      allPassed: visibleVerification.every((entry) => entry.passed) && hiddenVerification.passed,
    },
    completionGate: "not_invoked: this harness measures the actual AgentRuntime loop; full workflow/mission completion remains a separate proof surface.",
    timing: {
      wallClockMs: Date.now() - startedAt,
      timedOut: controller.signal.aborted,
    },
    memory: {
      rssBefore: memoryBefore.rss,
      rssAfter: memoryAfter.rss,
      heapUsedBefore: memoryBefore.heapUsed,
      heapUsedAfter: memoryAfter.heapUsed,
    },
  };
  await mkdir(evidenceDirectory, { recursive: true });
  const receiptPath = path.join(evidenceDirectory, `${runId}.json`);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  await persistence.close();
  if (process.env.R27_LIVE_KEEP_WORKSPACE !== "true") await rm(runRoot, { recursive: true, force: true });
  console.log(JSON.stringify({ receiptPath: path.relative(REPOSITORY_ROOT, receiptPath), status: receipt.runtime.status, verificationPassed: receipt.verification.allPassed, inferenceRequests: receipt.provider.inferenceRequestCount, wallClockMs: receipt.timing.wallClockMs }, null, 2));
  process.exitCode = receipt.runtime.status === "completed" && receipt.verification.allPassed ? 0 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
