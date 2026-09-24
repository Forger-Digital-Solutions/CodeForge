#!/usr/bin/env node
/**
 * R29 live workflow-completion harness.
 *
 * Drives a digest-locked R23/R27 task through the production WorkflowService →
 * WorkflowEngine → AgentRuntime path with a real free provider route, ending at
 * the canonical completion authority `evaluateCompletion`. Unlike the R27
 * harness (which measured the AgentRuntime loop only), this harness's success
 * criterion is the workflow's own completion-gated terminal state plus an
 * independent hidden verifier.
 *
 * Hard bounds are mandatory: request ceiling, per-response output ceiling,
 * wall-clock ceiling, free-only route, disposable workspace, full receipts.
 */
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
} from "@codeforge/providers";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { TaskAuthority, createLease } from "@codeforge/permissions";
import { createAgentRuntime, createWorkflowService } from "@codeforge/server";
import { createBoundedAdapter } from "../r27/live-endurance.mjs";

const execFile = promisify(execFileCallback);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EVIDENCE_ROOT = path.resolve(REPOSITORY_ROOT, "docs", "evidence", "r29-release-closure");
const LIVE_TASK_ROOT = path.resolve(REPOSITORY_ROOT, "benchmarks", "r23", "tasks");
const LIVE_MANIFEST_PATH = path.resolve(REPOSITORY_ROOT, "benchmarks", "r27", "manifest.json");

function requireEnabled() {
  if (process.env.R29_LIVE_ENABLE !== "true") {
    throw new Error("R29_LIVE_ENABLE=true is required. The harness never spends a provider request by default.");
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
  const configured = requiredValue("R29_LIVE_EVIDENCE_DIR");
  const directory = path.resolve(REPOSITORY_ROOT, configured);
  const prefix = `${EVIDENCE_ROOT}${path.sep}`;
  if (directory !== EVIDENCE_ROOT && !directory.startsWith(prefix)) {
    throw new Error("R29_LIVE_EVIDENCE_DIR must stay under docs/evidence/r29-release-closure.");
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
      output: `${result.stdout}\n${result.stderr}`.slice(0, 4_000),
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
      output: `${stdout}\n${stderr}`.slice(0, 4_000),
    };
  }
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

async function waitForRunInspection(persistence, taskId, deadlineMs) {
  while (Date.now() < deadlineMs) {
    const item = await persistence.getWorkItem(taskId).catch(() => undefined);
    if (item && item.kind === "run_inspection") return item;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return undefined;
}

async function main() {
  requireEnabled();
  const providerId = requiredValue("R29_LIVE_PROVIDER");
  const modelId = requiredValue("R29_LIVE_MODEL");
  const taskId = requiredValue("R29_LIVE_TASK_ID");
  const evidenceDirectory = resolveEvidenceDirectory();
  // The workflow path runs plan→implement→verify→(repair)→review→gate. One implement turn alone
  // can take several model iterations, and a repair cycle adds more; the request ceiling bounds
  // spend, not success.
  const maxRequests = boundedPositive("R29_LIVE_MAX_REQUESTS", 24, 60);
  // Per-request output ceiling. The runtime sends provider max_tokens=4096, so a
  // harness ceiling below that measures discipline, not room — medium tasks with
  // file-write payloads legitimately exceed 1024. The spend bound stays via the
  // request ceiling; 4096 matches the product's own per-request bound.
  const maxOutputTokens = boundedPositive("R29_LIVE_MAX_OUTPUT_TOKENS", 512, 4096);
  const timeoutMs = boundedPositive("R29_LIVE_TIMEOUT_MS", 20 * 60_000, 30 * 60_000);
  const permissionMode = process.env.R29_LIVE_PERMISSION_MODE === "ask_more" ? "ask_more" : "full_autonomy";

  const definition = PROVIDER_DEFINITIONS[providerId];
  if (!definition?.implemented || definition.freeAccess.class !== "FREE_API" || definition.freeAccess.spillover !== "NONE") {
    throw new Error("The live harness permits only implemented FREE_API providers whose definition declares no paid spillover.");
  }

  const credentialStore = new EnvironmentCredentialStore();
  if (!credentialStore.has(providerId)) throw new Error(`No credential is configured for '${providerId}'.`);
  const providerResponses = [];
  const inner = createProviderAdapterFromDefinitionInner(definition, credentialStore, providerResponses);
  const listedModels = await inner.listModels();
  const selected = listedModels.find((model) => model.modelId === modelId);
  if (!selected || !selected.isFree || selected.freeStatus !== "verified_free") {
    throw new Error(`'${providerId}/${modelId}' is not currently reported as verified free by the live catalog.`);
  }
  if (!Number.isInteger(selected.contextWindow) || selected.contextWindow <= 0) {
    throw new Error(`'${providerId}/${modelId}' has no positive catalog-declared context window, so the live harness will not guess one.`);
  }

  const { locked, taskRoot, task } = await loadLockedTask(taskId);
  const runId = `r29-live-${randomUUID()}`;
  const runRoot = await mkdtemp(path.join(os.tmpdir(), "codeforge-r29-live-"));
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
  const sessionId = `r29-session-${randomUUID()}`;
  const authorityReceipts = [];
  const authority = new TaskAuthority(
    createLease({ sessionId, workspaceRoot: workspacePath, permissionMode, planMode: "auto" }),
    (receipt) => authorityReceipts.push(receipt),
  );

  const runtimeCache = new Map();
  const workflowService = createWorkflowService({
    eventStore,
    persistence,
    workspacePath,
    useRealRuntime: true,
    authorityFor: () => authority,
    getOrCreateRuntime: (runtimeSessionId) => {
      let runtime = runtimeCache.get(runtimeSessionId);
      if (!runtime) {
        runtime = createAgentRuntime({
          sessionId: runtimeSessionId,
          eventStore,
          persistence,
          firewall,
          providerCatalog: catalog,
          workspacePath,
          demoMode: false,
          authorityFor: () => authority,
        });
        runtime.setModelSelection({ providerId, modelId, lock: "route" });
        runtimeCache.set(runtimeSessionId, runtime);
      }
      return runtime;
    },
  });
  await workflowService.init();

  const memoryBefore = process.memoryUsage();
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const { taskId: workflowTaskId } = await workflowService.startWorkflow({
    sessionId,
    message: task.goal,
    workspacePath,
    verificationCommands: task.visibleVerification,
  });

  const inspection = await waitForRunInspection(persistence, workflowTaskId, deadline);
  const wallClockMs = Date.now() - startedAt;

  // Independent hidden verifier — materialized only after the run, exactly like R27.
  const hiddenSource = path.resolve(taskCopy, task.hidden);
  if (!hiddenSource.startsWith(`${taskCopy}${path.sep}`)) throw new Error("Hidden verifier path escaped the locked task copy.");
  await cp(hiddenSource, path.join(workspacePath, task.hidden), { recursive: true, force: false, errorOnExist: true });
  const hiddenVerification = await runVerifier(task.verifier.command, workspacePath, task.verifier.timeoutMs ?? 30_000);
  const memoryAfter = process.memoryUsage();

  const completion = inspection?.completion ?? null;
  const workflowStatus = inspection?.status ?? "no_terminal_record";
  const verificationAttempts = inspection?.verificationAttempts ?? [];
  const eventTypes = eventStore.getAll().reduce((counts, event) => {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
    return counts;
  }, {});

  const receipt = {
    schema: "r29-live-workflow-completion-receipt-1",
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
      topology: "workflow_service_agent_runtime",
      permissionMode,
      planMode: "auto",
      maxRequests,
      maxOutputTokens,
      timeoutMs,
      completionAuthority: "evaluateCompletion via WorkflowEngine",
    },
    provider: {
      inferenceRequestCount: requestRecords.length,
      requests: requestRecords,
      observedResponses: providerResponses,
    },
    workflow: {
      taskId: workflowTaskId,
      status: workflowStatus,
      phase: inspection?.phase ?? null,
      completion,
      diffs: (inspection?.diffs ?? []).map((diff) => ({ path: diff.path, changeType: diff.changeType, additions: diff.additions, deletions: diff.deletions, diff: diff.diff })),
      verificationAttempts: verificationAttempts.map((attempt) => ({
        attempt: attempt.attempt,
        verifiers: (attempt.verifiers ?? []).map((verifier) => ({ id: verifier.id, kind: verifier.kind, status: verifier.status, exitCode: verifier.exitCode })),
      })),
      review: inspection?.review ?? null,
      forgeVerifySummary: inspection?.verification ?? null,
      repairs: inspection?.repairs ?? [],
    },
    authority: {
      receiptCount: authorityReceipts.length,
      decisions: authorityReceipts.reduce((counts, receipt) => {
        const key = `${receipt.decision}:${receipt.tier}`;
        counts[key] = (counts[key] ?? 0) + 1;
        return counts;
      }, {}),
      asksUnanswered: authorityReceipts.filter((receipt) => receipt.decision === "ask").length,
    },
    verification: {
      hidden: hiddenVerification,
      workflowAllPassed: verificationAttempts.length > 0 && verificationAttempts.at(-1).verifiers?.every((verifier) => verifier.status === "passed"),
    },
    eventTypes,
    timing: { wallClockMs, deadlineHit: !inspection },
    memory: {
      rssBefore: memoryBefore.rss,
      rssAfter: memoryAfter.rss,
      heapUsedBefore: memoryBefore.heapUsed,
      heapUsedAfter: memoryAfter.heapUsed,
    },
    ...(process.env.R29_LIVE_KEEP_WORKSPACE === "true" ? { retainedWorkspace: workspacePath } : {}),
  };

  await mkdir(evidenceDirectory, { recursive: true });
  const receiptPath = path.join(evidenceDirectory, `${runId}.json`);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  await persistence.close();
  if (process.env.R29_LIVE_KEEP_WORKSPACE !== "true") {
    const resolvedRunRoot = path.resolve(runRoot);
    if (path.dirname(resolvedRunRoot) !== path.resolve(os.tmpdir()) || !path.basename(resolvedRunRoot).startsWith("codeforge-r29-live-")) {
      throw new Error("Refusing to remove a run directory outside the R29 temporary root.");
    }
    await rm(resolvedRunRoot, { recursive: true, force: true });
  }

  const success = workflowStatus === "completed" && completion?.outcome === "completed" && hiddenVerification.passed;
  console.log(JSON.stringify({
    receiptPath: path.relative(REPOSITORY_ROOT, receiptPath),
    workflowStatus,
    completionOutcome: completion?.outcome ?? null,
    hiddenVerifierPassed: hiddenVerification.passed,
    inferenceRequests: requestRecords.length,
    wallClockMs,
  }, null, 2));
  process.exitCode = success ? 0 : 2;
}

// Kept separate so the R27 adapter factory signature stays untouched.
import { createProviderAdapterFromDefinition } from "@codeforge/providers";
function createProviderAdapterFromDefinitionInner(definition, credentialStore, providerResponses) {
  const inner = createProviderAdapterFromDefinition(definition, {
    credentialStore,
    timeoutMs: 30_000,
    onResponse: (observation) => providerResponses.push({
      modelId: observation.modelId ?? null,
      status: observation.status,
      headers: observation.headers,
      observedAt: observation.observedAt,
    }),
  });
  if (!inner) throw new Error("No provider adapter could be constructed for the requested provider.");
  return inner;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
