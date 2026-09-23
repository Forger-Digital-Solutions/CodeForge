#!/usr/bin/env node
/**
 * R28 technical demo — a narrated, replayable demonstration of the product
 * working end-to-end against a real free provider route.
 *
 * Scenes:
 *   1. Boot the production server wired exactly as the desktop wires it.
 *   2. Routing fabric: live verified-free model catalog + ForgeAuto registry.
 *   3. Workspace: set workspace, repository index status.
 *   4. Task: a real workflow run, narrated through its phase transitions.
 *   5. Verdict: completion gate + independent hidden verifier + persisted items.
 *   6. Fail-closed: ForgeZero refuses an unregistered route live.
 *
 * Produces docs/evidence/r28-capability-completion/R28-TECHNICAL-DEMO-TRANSCRIPT.{json,md}
 */
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ForgeZero } from "@codeforge/forge-zero";
import { NormalizedModelRegistry, PROVIDER_DEFINITIONS, discoverAndVerifyFree } from "@codeforge/model-registry";
import { EnvironmentCredentialStore, InMemoryProviderCatalog, createProviderAdapterFromDefinition } from "@codeforge/providers";
import { createServer, generateControlPlaneToken } from "@codeforge/server";

const execFile = promisify(execFileCallback);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EVIDENCE = path.resolve(REPO, "docs", "evidence", "r28-capability-completion");
const TASK_ID = process.env.R28_DEMO_TASK_ID ?? "qual-js-return-sign";

const lines = [];
const say = (text) => { lines.push(text); console.log(text); };
const code = (text) => { lines.push(`    ${text}`); console.log(`    ${text}`); };

async function main() {
  const providerId = process.env.R28_LIVE_PROVIDER ?? "openrouter";
  const modelId = process.env.R28_LIVE_MODEL ?? "nex-agi/nex-n2.5-mini:free";
  const definition = PROVIDER_DEFINITIONS[providerId];
  if (!definition?.implemented || !["FREE_API", "FREE_DEV_ENDPOINT"].includes(definition.freeAccess.class) || definition.freeAccess.spillover !== "NONE") {
    throw new Error("Demo requires an implemented free-class provider with no paid spillover.");
  }
  const credentialStore = new EnvironmentCredentialStore();
  if (!credentialStore.has(providerId)) throw new Error(`No credential configured for '${providerId}'.`);

  say(`# CodeForge R28 technical demo — ${new Date().toISOString()}`);
  say("");
  say("Scene 1 — boot the production server with desktop-identical provider wiring.");

  const adapter = createProviderAdapterFromDefinition(definition, { credentialStore, timeoutMs: 30_000 });
  const providerCatalog = new InMemoryProviderCatalog();
  providerCatalog.register(adapter);
  const modelRegistry = new NormalizedModelRegistry();
  await modelRegistry.refresh().catch(() => {});
  const listed = await adapter.listModels();
  const live = listed.map((m) => ({ modelId: m.modelId, isFree: m.isFree, displayName: m.displayName, contextWindow: m.contextWindow, toolCalling: m.capabilities?.toolCalling ?? false, vision: m.capabilities?.vision ?? false, structuredOutput: m.capabilities?.structuredOutput ?? false }));
  const discovery = discoverAndVerifyFree(modelRegistry, providerId, live);
  const firewall = new ForgeZero();
  for (const rec of discovery.records) firewall.register(rec);
  code(`provider '${providerId}' live catalog: ${listed.length} models listed, ${discovery.verifiedCount} verified free → ForgeZero`);

  const runRoot = await mkdtemp(path.join(os.tmpdir(), "codeforge-r28-demo-"));
  const controlPlaneToken = generateControlPlaneToken();
  const server = createServer({ port: 0, dbPath: path.join(runRoot, "codeforge.db"), controlPlaneToken, firewall, providerCatalog });
  await server.start();
  const port = server.httpPort;
  code(`server listening on 127.0.0.1:${port} — the same createServer the desktop embeds`);

  const api = async (method, apiPath, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${apiPath}`, {
      method,
      headers: { "Content-Type": "application/json", "X-CodeForge-Control-Token": controlPlaneToken },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    return { status: res.status, json: JSON.parse(await res.text().catch(() => "{}")) };
  };

  say("");
  say("Scene 2 — routing fabric: what the model selector actually sees.");
  const models = await api("GET", "/api/models");
  const freeModels = (models.json ?? []).filter((m) => m.freeStatus === "verified_free");
  code(`/api/models → ${(models.json ?? []).length} records, ${freeModels.length} verified-free`);
  for (const m of freeModels.slice(0, 5)) code(`  · ${m.providerId}/${m.id} — ${m.displayName ?? ""}`.trim());
  const unauth = await fetch(`http://127.0.0.1:${port}/api/workflow/list`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
  code(`unauthenticated /api/workflow/list → HTTP ${unauth?.status ?? "unreachable"} (control-plane bearer enforced)`);

  say("");
  say("Scene 3 — workspace.");
  const taskRoot = path.resolve(REPO, "benchmarks", "r23", "tasks", TASK_ID);
  const task = JSON.parse(await readFile(path.join(taskRoot, "task.json"), "utf8"));
  const taskCopy = path.join(runRoot, "task");
  const workspacePath = path.join(taskCopy, task.fixture);
  await cp(taskRoot, taskCopy, { recursive: true, force: false, errorOnExist: true });
  const ws = await api("POST", "/api/workspace/set", { path: workspacePath });
  code(`/api/workspace/set → ${ws.status} (${path.basename(workspacePath)})`);
  const idx = await api("GET", "/api/repository-index/status");
  code(`/api/repository-index/status → ${idx.status} ${JSON.stringify(idx.json).slice(0, 140)}`);

  say("");
  say(`Scene 4 — task: "${task.goal.slice(0, 100)}${task.goal.length > 100 ? "…" : ""}"`);
  const sessionId = `demo-${Date.now()}`;
  const ms = await api("POST", "/api/model-selection", { sessionId, providerId, modelId });
  code(`/api/model-selection → ${ms.status} ${JSON.stringify(ms.json.selection ?? ms.json).slice(0, 140)}`);
  const run = await api("POST", "/api/workflow/run", { sessionId, message: task.goal, workspacePath, verificationCommands: task.visibleVerification });
  code(`/api/workflow/run → ${run.status} taskId=${run.json.taskId}`);

  let lastPhase = "";
  let terminal = null;
  const deadline = Date.now() + (Number.parseInt(process.env.R28_DEMO_TIMEOUT_MS ?? "900000", 10) || 900000);
  const seenApproval = new Set();
  while (Date.now() < deadline) {
    const poll = await api("GET", `/api/workflow/${run.json.taskId}`);
    if (poll.status === 200) {
      const phase = poll.json.task?.phase ?? poll.json.task?.status;
      if (phase && phase !== lastPhase) { lastPhase = phase; code(`  …phase → ${phase}`); }
      for (const item of poll.json.workItems ?? []) {
        if (item.kind === "approval" && !item.decision && !item.cancelledAt && !seenApproval.has(item.id)) {
          seenApproval.add(item.id);
          await api("POST", `/api/approvals/${item.id}/resolve`, { sessionId, decision: "allow_once" });
          code(`  …approval ${item.id.slice(0, 8)} → allow_once (supervised)`);
        }
      }
      if (["completed", "blocked", "failed", "cancelled"].includes(poll.json.task?.phase) || ["complete", "blocked", "quota_exhausted", "failed_safely", "cancelled"].includes(poll.json.task?.status)) {
        terminal = poll.json;
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  if (!terminal) throw new Error("Demo workflow never reached a terminal state.");

  say("");
  say("Scene 5 — verdict.");
  const inspection = [...(terminal.workItems ?? [])].reverse().find((i) => i.kind === "run_inspection");
  code(`workflow status=${terminal.task?.status} phase=${terminal.task?.phase}`);
  code(`completion gate outcome=${inspection?.completion?.outcome ?? "n/a"} — "${(inspection?.completion?.rationale ?? "").slice(0, 120)}"`);
  const hiddenSource = path.resolve(taskCopy, task.hidden);
  await cp(hiddenSource, path.join(workspacePath, task.hidden), { recursive: true, force: false, errorOnExist: true });
  const argv = task.verifier.command.trim().split(/\s+/);
  let hidden = { passed: false };
  try { await execFile(process.execPath, argv.slice(1), { cwd: workspacePath, timeout: task.verifier.timeoutMs ?? 30_000 }); hidden = { passed: true }; } catch { hidden = { passed: false }; }
  code(`hidden verifier → ${hidden.passed ? "PASS" : "FAIL"} (independent of the workflow's own verification)`);
  code(`persisted work items: ${[...new Set((terminal.workItems ?? []).map((i) => i.kind))].join(", ")}`);
  code(`events: ${(terminal.events ?? []).length}`);

  say("");
  say("Scene 6 — fail-closed: ForgeZero refuses a route it never verified.");
  const bogus = await api("POST", "/api/model-selection", { sessionId, providerId, modelId: "anthropic/claude-3.5-sonnet" });
  code(`/api/model-selection unverified route → ${bogus.status} ${JSON.stringify(bogus.json).slice(0, 140)}`);

  say("");
  const verdict = terminal.task?.status === "complete" && inspection?.completion?.outcome === "completed" && hidden.passed && bogus.status === 400;
  say(`**Demo verdict: ${verdict ? "COMPLETE" : "INCOMPLETE"}** — workflow ${terminal.task?.status}, gate ${inspection?.completion?.outcome ?? "n/a"}, hidden verifier ${hidden.passed ? "pass" : "fail"}, unverified route refused=${bogus.status === 400}`);

  await server.stop().catch(() => {});
  await mkdir(EVIDENCE, { recursive: true });
  await writeFile(path.join(EVIDENCE, "R28-TECHNICAL-DEMO-TRANSCRIPT.md"), lines.join("\n") + "\n", "utf8");
  await writeFile(path.join(EVIDENCE, "R28-TECHNICAL-DEMO-TRANSCRIPT.json"), JSON.stringify({
    schema: "r28-technical-demo-1",
    recordedAt: new Date().toISOString(),
    task: { sourceTaskId: task.taskId, class: task.class },
    route: { providerId, modelId },
    scenes: { verifiedFreeRoutes: discovery.verifiedCount, listedModels: listed.length, unauthenticatedStatus: unauth?.status ?? null, approvalsSupervised: seenApproval.size },
    result: { workflowStatus: terminal.task?.status, workflowPhase: terminal.task?.phase, completionOutcome: inspection?.completion?.outcome ?? null, hiddenVerifierPassed: hidden.passed, unverifiedRouteStatus: bogus.status, events: (terminal.events ?? []).length },
    transcript: lines,
  }, null, 2) + "\n", "utf8");
  if (process.env.R28_LIVE_KEEP_WORKSPACE !== "true") await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
  process.exitCode = verdict ? 0 : 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
