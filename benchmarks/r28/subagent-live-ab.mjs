#!/usr/bin/env node
/**
 * R28 Subagent live matched-pair harness.
 *
 * Runs the SAME digest-locked task through the production
 * AutonomousRunOrchestrator → SubagentManager → AgentRuntime path twice on the
 * SAME verified-free route, with the only arm difference being topology:
 *   - arm A: topology "fixed_r1" (the certified full team: 2 explorers →
 *     planner → coder → reviewer → ForgeVerify)
 *   - arm B: adaptive (the classifier decides the smallest useful team)
 *
 * This is the live counterpart the R27 evidence required: "paired live
 * free-route topology runs with the same repository state, model budget,
 * verifier, and completion criteria; record only observed provider receipts
 * and preserve quota or availability blockers."
 *
 * Production wiring is mirrored: subagentsR1Enabled + getAgentRuntime — the
 * configuration under which explorer/planner/coder/reviewer children execute
 * through the real model route (without it, children run deterministic local
 * executors and there is nothing live to measure).
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
import {
  createAgentRuntime,
  createAutonomousRunOrchestrator,
  createWorkspaceService,
} from "@codeforge/server";
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
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be an integer from 1 through ${max}.`);
  }
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

async function git(cwd, args) {
  return execFile("git", args, { cwd, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
}

async function runHiddenVerifier(command, cwd, timeoutMs) {
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

async function runArm({ arm, topology, providerAdapter, firewall, providerId, modelId, task, workspacePath, runRoot, maxRequests, maxOutputTokens, deadline }) {
  const requestRecords = [];
  const bounded = createBoundedAdapter(providerAdapter, maxRequests, maxOutputTokens, requestRecords);
  const catalog = new InMemoryProviderCatalog();
  catalog.register(bounded);
  const persistence = createSessionPersistence({ dbPath: path.join(runRoot, `session-${arm}.sqlite`) });
  const eventStore = new EventStore();
  const sessionId = `r28-subagent-${arm}-${randomUUID()}`;
  const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: path.join(runRoot, "worktrees") });
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

  const orchestrator = createAutonomousRunOrchestrator({
    workspaceService,
    persistence,
    getAgentRuntime: () => runtime,
    subagentsR1Enabled: true,
  });

  const remaining = Math.max(1_000, deadline - Date.now());
  const signal = AbortSignal.timeout(remaining);
  const startedAt = Date.now();
  let result;
  let runError;
  try {
    result = await orchestrator.startRun({
      sessionId,
      workspacePath,
      goal: task.goal,
      verificationCommands: task.visibleVerification,
      signal,
      ...(topology ? { topology } : {}),
    });
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error);
  }
  const wallClockMs = Date.now() - startedAt;

  await persistence.close();

  return {
    arm,
    requestedTopology: topology ?? "adaptive",
    runError,
    result: result
      ? {
          runId: result.runId,
          status: result.status,
          summary: result.summary,
          changedFiles: result.changedFiles,
          completion: result.completion ?? null,
          review: { passed: result.review?.passed ?? null, findingCount: result.review?.findings?.length ?? 0 },
          verification: (result.verification ?? []).map((v) => ({ command: v.command, passed: v.passed, exitCode: v.exitCode })),
          integration: result.integration,
          counters: result.counters ?? null,
          topologyDecision: result.topology ?? null,
        }
      : null,
    provider: { inferenceRequestCount: requestRecords.length, requests: requestRecords },
    timing: { wallClockMs, aborted: signal.aborted },
  };
}

async function main() {
  if (process.env.R28_LIVE_ENABLE !== "true") {
    throw new Error("R28_LIVE_ENABLE=true is required. This harness spends real provider requests.");
  }
  const providerId = requiredValue("R28_LIVE_PROVIDER");
  const modelId = requiredValue("R28_LIVE_MODEL");
  const taskId = requiredValue("R28_LIVE_TASK_ID");
  const maxRequests = boundedPositive("R28_LIVE_MAX_REQUESTS", 80, 200);
  const maxOutputTokens = boundedPositive("R28_LIVE_MAX_OUTPUT_TOKENS", 4096, 4096);
  const timeoutMs = boundedPositive("R28_LIVE_TIMEOUT_MS", 40 * 60_000, 60 * 60_000);
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
  for (const [arm, topology] of [
    ["fixed_r1", "fixed_r1"],
    ["adaptive", undefined],
  ]) {
    const runRoot = await mkdtemp(path.join(os.tmpdir(), `codeforge-r28-subagent-${arm}-`));
    const taskCopy = path.join(runRoot, "task");
    const workspacePath = path.join(taskCopy, task.fixture);
    await cp(taskRoot, taskCopy, { recursive: true, force: false, errorOnExist: true });

    // The orchestrator is git-native (checkpoints, worktrees, integration); the locked task
    // fixture is a plain directory, so arm-local git state is initialized identically per arm.
    await git(workspacePath, ["init", "-q"]);
    await git(workspacePath, ["config", "core.autocrlf", "false"]);
    await git(workspacePath, ["config", "user.email", "r28-live@codeforge.local"]);
    await git(workspacePath, ["config", "user.name", "R28 Live"]);
    await git(workspacePath, ["add", "-A"]);
    await git(workspacePath, ["commit", "-qm", "r28 locked fixture baseline"]);

    const armResult = await runArm({
      arm,
      topology,
      providerAdapter,
      firewall: firewallFor(),
      providerId,
      modelId,
      task,
      workspacePath,
      runRoot,
      maxRequests,
      maxOutputTokens,
      deadline,
    });

    // Hidden verifier materializes only after the run — the locked-task contract.
    const hiddenSource = path.resolve(taskCopy, task.hidden);
    let hiddenVerification = { command: task.verifier.command, passed: false, skipped: "materialization failed" };
    try {
      await cp(hiddenSource, path.join(workspacePath, task.hidden), { recursive: true, force: false, errorOnExist: true });
      hiddenVerification = await runHiddenVerifier(task.verifier.command, workspacePath, task.verifier.timeoutMs ?? 30_000);
    } catch (error) {
      hiddenVerification = { command: task.verifier.command, passed: false, error: error instanceof Error ? error.message : String(error) };
    }
    armResult.verification = { hidden: hiddenVerification };
    armResult.runRoot = runRoot;
    arms.push(armResult);
  }

  const [fixed, adaptive] = arms;
  const comparison = {
    inferenceRequests: { fixed_r1: fixed.provider.inferenceRequestCount, adaptive: adaptive.provider.inferenceRequestCount },
    wallClockMs: { fixed_r1: fixed.timing.wallClockMs, adaptive: adaptive.timing.wallClockMs },
    statuses: { fixed_r1: fixed.result?.status ?? fixed.runError ?? "no_result", adaptive: adaptive.result?.status ?? adaptive.runError ?? "no_result" },
    completionOutcomes: { fixed_r1: fixed.result?.completion?.outcome ?? null, adaptive: adaptive.result?.completion?.outcome ?? null },
    hiddenVerifierPassed: { fixed_r1: fixed.verification.hidden.passed, adaptive: adaptive.verification.hidden.passed },
    childrenSpawned: { fixed_r1: fixed.result?.counters?.childrenSpawned ?? null, adaptive: adaptive.result?.counters?.childrenSpawned ?? null },
    topologyResolved: { fixed_r1: fixed.result?.topologyDecision?.plan?.topology ?? "fixed_r1", adaptive: adaptive.result?.topologyDecision?.plan?.topology ?? null },
    complexityTier: adaptive.result?.topologyDecision?.complexity?.tier ?? null,
  };

  const receipt = {
    schema: "r28-subagent-matched-pair-1",
    recordedAt: new Date().toISOString(),
    design: {
      topology: "autonomous_orchestrator_subagent_manager_agent_runtime",
      productionWiring: "subagentsR1Enabled=true + getAgentRuntime — the configuration under which all child roles execute through the real model route",
      armDifference: "fixed_r1 explicit topology vs adaptive classifier on the same goal/repo/model/budget",
      task: { sourceTaskId: task.taskId, class: task.class, corpusDigest: locked.treeDigest },
      providerId,
      modelId,
      maxRequestsPerArm: maxRequests,
      maxOutputTokens,
    },
    arms: {
      fixed_r1: { ...fixed, runRoot: undefined },
      adaptive: { ...adaptive, runRoot: undefined },
    },
    comparison,
    honesty: {
      singlePair: true,
      note: "One matched pair cannot separate topology effect from model-output stochasticity; reported values are observed provider receipts, and quota/availability blockers are preserved rather than retried away.",
    },
  };

  await mkdir(EVIDENCE_ROOT, { recursive: true });
  const receiptPath = path.join(EVIDENCE_ROOT, "R28-SUBAGENT-AB-LIVE-EVIDENCE.json");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  for (const arm of arms) {
    if (arm.runRoot && process.env.R28_LIVE_KEEP_WORKSPACE !== "true") {
      await rm(arm.runRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const bothReachedTerminal = Boolean(fixed.result) && Boolean(adaptive.result);
  console.log(JSON.stringify({
    receiptPath: path.relative(REPOSITORY_ROOT, receiptPath),
    bothReachedTerminal,
    comparison,
  }, null, 2));
  process.exitCode = bothReachedTerminal ? 0 : 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
