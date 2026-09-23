#!/usr/bin/env node
/**
 * R28 dogfood live check.
 *
 * Uses the product the way the product is used: the production CodeForge
 * server (the same createServer the desktop embeds via initializeServer),
 * wired exactly as the desktop wires it — a real provider adapter built by
 * createProviderAdapterFromDefinition over EnvironmentCredentialStore, plus a
 * ForgeZero verified-free record produced from the adapter's own live
 * listModels() (the same registration path as discoverProviderFreeInner).
 *
 * Then the real user flow end-to-end through the production API surface:
 *   workspace/set → model-selection → workflow/run → poll to terminal →
 *   hidden verifier — on a disposable copy of a locked R23 task fixture, with
 *   the per-process control-plane bearer the product itself issues.
 *
 * Honest boundary: provider registration happens in-process instead of inside
 * Electron main; the adapter construction and every API call are the real
 * production code path. `forge serve` is not used because the CLI entry point
 * intentionally ships no provider connections — the desktop owns that wiring.
 */
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ForgeZero } from "@codeforge/forge-zero";
import { NormalizedModelRegistry, PROVIDER_DEFINITIONS, discoverAndVerifyFree } from "@codeforge/model-registry";
import {
  EnvironmentCredentialStore,
  InMemoryProviderCatalog,
  createProviderAdapterFromDefinition,
} from "@codeforge/providers";
import { createServer, generateControlPlaneToken } from "@codeforge/server";

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

async function runVerifier(command, cwd, timeoutMs) {
  const argv = command.trim().split(/\s+/);
  const startedAt = Date.now();
  try {
    await execFile(process.execPath, argv.slice(1), { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 });
    return { command, passed: true, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return { command, passed: false, elapsedMs: Date.now() - startedAt, exitCode: typeof error?.code === "number" ? error.code : undefined };
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  if (process.env.R28_LIVE_ENABLE !== "true") {
    throw new Error("R28_LIVE_ENABLE=true is required. This harness drives the real product against a real provider.");
  }
  const providerId = requiredValue("R28_LIVE_PROVIDER");
  const modelId = requiredValue("R28_LIVE_MODEL");
  const taskId = requiredValue("R28_LIVE_TASK_ID");
  const deadline = Date.now() + Math.min(Number.parseInt(process.env.R28_LIVE_TIMEOUT_MS ?? "1200000", 10) || 1200000, 1800000);

  const definition = PROVIDER_DEFINITIONS[providerId];
  const permittedClasses = new Set(["FREE_API", "FREE_DEV_ENDPOINT"]);
  if (!definition?.implemented || !permittedClasses.has(definition.freeAccess.class) || definition.freeAccess.spillover !== "NONE") {
    throw new Error("Only implemented free-class providers with no paid spillover are permitted.");
  }
  const credentialStore = new EnvironmentCredentialStore();
  if (!credentialStore.has(providerId)) throw new Error(`No credential configured for '${providerId}'.`);

  // Same wiring the desktop main performs: adapter from definition over the
  // environment credential store, registered into the catalog the server owns.
  const adapter = createProviderAdapterFromDefinition(definition, { credentialStore, timeoutMs: 30_000 });
  if (!adapter) throw new Error("No provider adapter could be constructed.");
  const providerCatalog = new InMemoryProviderCatalog();
  providerCatalog.register(adapter);

  // The identical registration the desktop's discoverProviderFreeInner performs
  // (apps/desktop/src/main.ts:1031): listModels() → LiveModelInfo[] →
  // discoverAndVerifyFree against the normalized registry → firewall.register.
  // Only a live-catalog verified-free model earns a ForgeZero record.
  const modelRegistry = new NormalizedModelRegistry();
  await modelRegistry.refresh().catch(() => {});
  const listedModels = await adapter.listModels();
  const selected = listedModels.find((model) => model.modelId === modelId);
  if (!selected || !selected.isFree) {
    throw new Error(`'${providerId}/${modelId}' is not currently listed free by the live catalog.`);
  }
  const live = listedModels.map((m) => ({
    modelId: m.modelId,
    isFree: m.isFree,
    displayName: m.displayName,
    contextWindow: m.contextWindow,
    toolCalling: m.capabilities?.toolCalling ?? false,
    vision: m.capabilities?.vision ?? false,
    structuredOutput: m.capabilities?.structuredOutput ?? false,
  }));
  const discovery = discoverAndVerifyFree(modelRegistry, providerId, live);
  const firewall = new ForgeZero();
  for (const rec of discovery.records) firewall.register(rec);
  if (!discovery.records.some((rec) => rec.providerId === providerId && rec.modelId === modelId)) {
    throw new Error(`'${providerId}/${modelId}' did not verify free through discoverAndVerifyFree (${discovery.verifiedCount} routes verified).`);
  }

  const manifest = JSON.parse(await readFile(LIVE_MANIFEST_PATH, "utf8"));
  const locked = manifest.lockedTasks.find((entry) => entry.sourceTaskId === taskId);
  if (!locked?.liveEligible) throw new Error(`Task '${taskId}' is not live-eligible.`);
  const taskRoot = path.resolve(LIVE_TASK_ROOT, taskId);
  const task = JSON.parse(await readFile(path.join(taskRoot, "task.json"), "utf8"));

  const runRoot = await mkdtemp(path.join(os.tmpdir(), "codeforge-r28-dogfood-"));
  const taskCopy = path.join(runRoot, "task");
  const workspacePath = path.join(taskCopy, task.fixture);
  await cp(taskRoot, taskCopy, { recursive: true, force: false, errorOnExist: true });

  const controlPlaneToken = generateControlPlaneToken();
  const dbPath = path.join(runRoot, "codeforge.db");
  const server = createServer({ port: 0, dbPath, controlPlaneToken, firewall, providerCatalog });
  await server.start();
  const port = server.httpPort ?? 0;
  if (!port) throw new Error("Server started without reporting a port.");

  const transcript = [];
  const api = async (method, apiPath, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${apiPath}`, {
      method,
      headers: { "Content-Type": "application/json", "X-CodeForge-Control-Token": controlPlaneToken },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
    transcript.push({ method, path: apiPath, status: res.status, response: json });
    return { status: res.status, json };
  };

  let result = { phase: "startup" };
  try {
    // Bearer discipline is part of the dogfood: prove unauthenticated is rejected first.
    const unauth = await fetch(`http://127.0.0.1:${port}/api/workflow/list`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    transcript.push({ method: "GET", path: "/api/workflow/list (no token)", status: unauth?.status ?? "unreachable" });

    const sessionId = `dogfood-${randomUUID()}`;

    result.phase = "workspace_set";
    const ws = await api("POST", "/api/workspace/set", { path: workspacePath });
    if (ws.status !== 200) throw new Error(`workspace/set ${ws.status}: ${JSON.stringify(ws.json)}`);

    result.phase = "model_selection";
    const ms = await api("POST", "/api/model-selection", { sessionId, providerId, modelId });
    if (ms.status !== 200) throw new Error(`model-selection ${ms.status}: ${JSON.stringify(ms.json)}`);

    result.phase = "workflow_run";
    const run = await api("POST", "/api/workflow/run", {
      sessionId,
      message: task.goal,
      workspacePath,
      verificationCommands: task.visibleVerification,
    });
    if (run.status !== 200) throw new Error(`workflow/run ${run.status}: ${JSON.stringify(run.json)}`);
    const workflowTaskId = run.json.taskId;

    result.phase = "polling";
    const TERMINAL_PHASES = new Set(["completed", "blocked", "failed", "cancelled"]);
    const TERMINAL_STATUSES = new Set(["complete", "blocked", "quota_exhausted", "failed_safely", "cancelled"]);
    const supervision = { approvalsResolved: 0, questionsAnswered: 0 };
    const seen = new Set();
    let terminal;
    while (Date.now() < deadline) {
      const poll = await api("GET", `/api/workflow/${workflowTaskId}`);
      if (poll.status !== 200) {
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      // Supervised dogfood: approvals and questions surface as work items; a
      // real user resolves them through the same endpoints the renderer calls.
      for (const item of poll.json.workItems ?? []) {
        if (item.kind === "approval" && !item.decision && !item.cancelledAt && !seen.has(`a:${item.id}`)) {
          seen.add(`a:${item.id}`);
          const resolution = await api("POST", `/api/approvals/${item.id}/resolve`, { sessionId, decision: "allow_once" });
          if (resolution.status === 200) supervision.approvalsResolved++;
        } else if (item.kind === "question" && item.answer === undefined && !seen.has(`q:${item.id}`)) {
          seen.add(`q:${item.id}`);
          const resolution = await api("POST", `/api/questions/${item.id}/resolve`, {
            sessionId,
            answer: "Proceed with your best judgment within the task goal.",
          });
          if (resolution.status === 200) supervision.questionsAnswered++;
        }
      }
      const phase = poll.json.task?.phase;
      const status = poll.json.task?.status;
      if ((phase && TERMINAL_PHASES.has(phase)) || (status && TERMINAL_STATUSES.has(status))) {
        terminal = poll.json;
        break;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (!terminal) throw new Error("workflow never reached a terminal state inside the deadline");

    result.phase = "hidden_verifier";
    const hiddenSource = path.resolve(taskCopy, task.hidden);
    if (!hiddenSource.startsWith(`${taskCopy}${path.sep}`)) throw new Error("Hidden verifier path escaped the locked task copy.");
    await cp(hiddenSource, path.join(workspacePath, task.hidden), { recursive: true, force: false, errorOnExist: true });
    const hiddenVerification = await runVerifier(task.verifier.command, workspacePath, task.verifier.timeoutMs ?? 30_000);

    const workItems = terminal.workItems ?? [];
    const kinds = {};
    for (const item of workItems) kinds[item.kind] = (kinds[item.kind] ?? 0) + 1;
    const inspection = [...workItems].reverse().find((item) => item.kind === "run_inspection");

    result = {
      phase: "terminal",
      workflowTaskId,
      workflowStatus: terminal.task?.status ?? null,
      workflowPhase: terminal.task?.phase ?? null,
      completion: inspection?.completion ?? null,
      supervision,
      workItemKinds: kinds,
      eventCount: (terminal.events ?? []).length,
      hiddenVerification,
      transcriptDigest: sha256(JSON.stringify(transcript)),
    };
  } finally {
    await server.stop?.().catch(() => {});
  }

  const receipt = {
    schema: "r28-dogfood-2",
    recordedAt: new Date().toISOString(),
    design: {
      entryPoint: "createServer — the production server the desktop embeds (initializeServer)",
      providerWiring: "createProviderAdapterFromDefinition + EnvironmentCredentialStore + InMemoryProviderCatalog — identical to apps/desktop/src/main.ts registerProviderAdapter; ForgeZero record produced from live listModels() verified-free, identical to discoverProviderFreeInner",
      cliNote: "forge serve was evaluated and rejected for this proof: the CLI entry point ships no provider connections by design (the desktop owns provider wiring) — recorded honestly rather than worked around",
      apiPath: "workspace/set → model-selection → workflow/run → workflow/:id polling",
      task: { sourceTaskId: task.taskId, class: task.class, corpusDigest: locked.treeDigest },
      providerId,
      modelId,
    },
    result,
    transcript,
  };

  await mkdir(EVIDENCE_ROOT, { recursive: true });
  const receiptPath = path.join(EVIDENCE_ROOT, "R28-DOGFOOD-EVIDENCE.json");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  if (process.env.R28_LIVE_KEEP_WORKSPACE !== "true") await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);

  const completed = result.workflowStatus === "complete" && result.completion?.outcome === "completed" && result.hiddenVerification?.passed === true;
  console.log(JSON.stringify({
    receiptPath: path.relative(REPOSITORY_ROOT, receiptPath),
    phase: result.phase,
    workflowStatus: result.workflowStatus,
    completionOutcome: result.completion?.outcome ?? null,
    hiddenVerifierPassed: result.hiddenVerification?.passed ?? null,
    apiCalls: transcript.length,
  }, null, 2));
  process.exitCode = completed ? 0 : 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
