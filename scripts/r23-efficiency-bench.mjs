#!/usr/bin/env node
/**
 * R23 efficiency benchmark runner (protocol: docs/benchmarks/codeforge-efficiency-protocol-r23.md).
 *
 *   node scripts/r23-efficiency-bench.mjs freeze-manifest
 *   node scripts/r23-efficiency-bench.mjs snapshot-pricing [--market-ref <provider/model>]
 *   node scripts/r23-efficiency-bench.mjs dry-run   [--mode orchestrated|single] [--tasks a,b] [--arms control,optimized]
 *   node scripts/r23-efficiency-bench.mjs prescreen [--models a:free,b:free] [--task qual-js-return-sign] [--cap 6]
 *   node scripts/r23-efficiency-bench.mjs qualify   [--models a:free,b:free] [--tasks qual-...]   (defaults to the pre-screen's advancing list)
 *   node scripts/r23-efficiency-bench.mjs pilot     --model <id> [--tasks a,b] [--reps 1] [--mode orchestrated|single]
 *   node scripts/r23-efficiency-bench.mjs main      --model <id> [--tasks a,b] [--reps 1]
 *   node scripts/r23-efficiency-bench.mjs variance  --model <id> --tasks a,b --reps 3
 *
 * Every mode: regenerates the corpus and verifies it against the frozen manifest, verifies the
 * protocol digest, refuses a dirty CodeForge tree unless --allow-dirty (dirty files are recorded),
 * and writes raw run records under docs/evidence/r23-efficiency-proof/raw/<phase>/.
 * Live modes additionally: exact-pin the `:free` model after re-checking $0 in the live catalog,
 * and refuse to start a run that does not fit the remaining daily allowance (§6.3).
 */
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGenericFreeRecord } from "@codeforge/forge-zero";
import { createOpenRouterAdapter } from "@codeforge/providers";
import {
  CONTROL_ARM,
  OPTIMIZED_ARM,
  R23_HARNESS_VERSION,
  assertArmsDifferOnlyInSwitches,
  environmentFingerprint,
  freezeManifest,
  loadTaskCorpus,
  parsePricingSnapshot,
  runTaskArm,
  verifyManifest,
} from "@codeforge/forgegreen-campaign";
import { REFERENCE_STEPS, referenceSummary } from "../benchmarks/r23/reference-solutions.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const TASKS_ROOT = path.join(ROOT, "benchmarks", "r23", "tasks");
const MANIFEST_PATH = path.join(ROOT, "benchmarks", "r23", "manifest.json");
const EVIDENCE = path.join(ROOT, "docs", "evidence", "r23-efficiency-proof");
const PROTOCOL_PATH = path.join(ROOT, "docs", "benchmarks", "codeforge-efficiency-protocol-r23.md");
const PROTOCOL_DIGEST_PATH = path.join(EVIDENCE, "protocol", "PROTOCOL-DIGEST.txt");
const PROTOCOL_VERSION = "1.0.2";

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
const [mode, ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i += 1) {
  const arg = rest[i];
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const next = rest[i + 1];
  if (next === undefined || next.startsWith("--")) flags[key] = true;
  else {
    flags[key] = next;
    i += 1;
  }
}
const list = (value) => (typeof value === "string" ? value.split(",").map((v) => v.trim()).filter(Boolean) : undefined);

function log(message) {
  console.log(`[r23] ${new Date().toISOString()} ${message}`);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true }).trim();
}

// ---------------------------------------------------------------------------------------------
// Preconditions shared by every mode
// ---------------------------------------------------------------------------------------------
function protocolDigest() {
  const digest = sha256(fs.readFileSync(PROTOCOL_PATH));
  const recorded = fs.readFileSync(PROTOCOL_DIGEST_PATH, "utf8").match(/sha256:\s*([0-9a-f]{64})/)?.[1];
  if (recorded !== digest) throw new Error(`protocol digest mismatch: file ${digest.slice(0, 12)} vs recorded ${String(recorded).slice(0, 12)} — the protocol changed after freezing; bump the version and re-freeze deliberately`);
  return digest;
}

function regenerateCorpus() {
  const result = spawnSync(process.execPath, [path.join(ROOT, "benchmarks", "r23", "generate-tasks.mjs")], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`corpus generation failed: ${result.stderr}`);
}

async function loadFrozenCorpus() {
  regenerateCorpus();
  if (!fs.existsSync(MANIFEST_PATH)) throw new Error("benchmarks/r23/manifest.json is missing — run freeze-manifest first");
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const check = await verifyManifest(TASKS_ROOT, manifest);
  if (!check.ok) throw new Error(`task manifest mismatch (protocol §4.3 forbids editing frozen tasks):\n  ${check.mismatches.join("\n  ")}`);
  if (check.unlisted.length > 0) throw new Error(`tasks on disk but not in the frozen manifest: ${check.unlisted.join(", ")}`);
  const tasks = await loadTaskCorpus(TASKS_ROOT);
  return { manifest, tasks, manifestDigest: sha256(fs.readFileSync(MANIFEST_PATH)) };
}

function treeState() {
  const porcelain = git(["status", "--porcelain"]).split(/\r?\n/).filter(Boolean);
  // Regenerated corpus files are ignored (see .gitignore); anything else dirties the tree.
  const dirtyFiles = porcelain.map((line) => line.slice(3).trim());
  return { commit: git(["rev-parse", "HEAD"]), dirty: dirtyFiles.length > 0, dirtyFiles };
}

function identityBase(digest) {
  const state = treeState();
  if (state.dirty && !flags["allow-dirty"]) throw new Error(`CodeForge tree is dirty (${state.dirtyFiles.length} file(s)); commit first or pass --allow-dirty (dirty files are recorded in every run):\n  ${state.dirtyFiles.join("\n  ")}`);
  const fingerprint = environmentFingerprint({ os: `${os.platform()} ${os.release()}`, cpuModel: os.cpus()[0]?.model ?? "unknown", cpus: os.cpus().length, totalMemBytes: os.totalmem(), nodeVersion: process.version, codeforgeCommit: state.commit, protocolDigest: digest, harnessVersion: R23_HARNESS_VERSION });
  return { protocolVersion: PROTOCOL_VERSION, protocolDigest: digest, codeforgeCommit: state.commit, codeforgeTreeDirty: state.dirty, ...(state.dirty ? { dirtyFiles: state.dirtyFiles } : {}), environmentFingerprint: fingerprint, environment: { os: `${os.platform()} ${os.release()}`, cpuModel: os.cpus()[0]?.model, cpus: os.cpus().length, totalMemGB: Math.round(os.totalmem() / 2 ** 30), node: process.version } };
}

function loadPricing() {
  const dir = path.join(EVIDENCE, "cost");
  const candidates = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => /^pricing-snapshot-.*\.json$/.test(name)).sort() : [];
  const chosen = flags.pricing ?? (candidates.length > 0 ? path.join(dir, candidates[candidates.length - 1]) : undefined);
  if (!chosen) throw new Error("no pricing snapshot found under docs/evidence/r23-efficiency-proof/cost — run snapshot-pricing first");
  return { snapshot: parsePricingSnapshot(JSON.parse(fs.readFileSync(chosen, "utf8"))), path: chosen };
}

// ---------------------------------------------------------------------------------------------
// Raw evidence writing
// ---------------------------------------------------------------------------------------------
function rawDir(phase) {
  const dir = path.join(EVIDENCE, "raw", phase);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeRecord(phase, record) {
  const dir = rawDir(phase);
  fs.writeFileSync(path.join(dir, `${record.identity.runId}.json`), `${JSON.stringify(record, null, 2)}\n`);
  fs.appendFileSync(path.join(dir, "runs.jsonl"), `${JSON.stringify(record)}\n`);
}

function logExclusion(entry) {
  fs.mkdirSync(path.join(EVIDENCE, "raw"), { recursive: true });
  fs.appendFileSync(path.join(EVIDENCE, "raw", "exclusions.jsonl"), `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`);
}

// ---------------------------------------------------------------------------------------------
// Live route: $0 pin + capacity gate
// ---------------------------------------------------------------------------------------------
async function openRouterJson(pathname) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  const response = await fetch(`https://openrouter.ai${pathname}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!response.ok) throw new Error(`OpenRouter ${pathname} → HTTP ${response.status}`);
  return response.json();
}

async function pinFreeModel(modelId) {
  const catalog = (await openRouterJson("/api/v1/models")).data;
  const entry = catalog.find((model) => model.id === modelId);
  if (!entry) throw new Error(`model ${modelId} is not in the live OpenRouter catalog`);
  if (!modelId.endsWith(":free")) throw new Error(`refusing non-:free model ${modelId} (protocol §2.1)`);
  if (entry.pricing?.prompt !== "0" || entry.pricing?.completion !== "0") throw new Error(`model ${modelId} is not priced $0/$0 in the live catalog (prompt=${entry.pricing?.prompt}, completion=${entry.pricing?.completion}) — refusing`);
  if (!(entry.supported_parameters ?? []).includes("tools")) throw new Error(`model ${modelId} does not advertise tool support`);
  const twin = catalog.find((model) => model.id === modelId.replace(/:free$/, ""));
  return {
    entry: { id: entry.id, name: entry.name, contextLength: entry.context_length, pricing: entry.pricing, supportedParameters: entry.supported_parameters, checkedAt: new Date().toISOString() },
    paidTwin: twin ? { id: twin.id, pricing: twin.pricing } : undefined,
    freeRecord: createGenericFreeRecord({
      providerId: "openrouter",
      modelId,
      displayName: entry.name ?? modelId,
      contextWindow: entry.context_length,
      capabilities: { text: true, coding: true, toolCalling: true, vision: (entry.architecture?.input_modalities ?? []).includes("image"), structuredOutput: (entry.supported_parameters ?? []).includes("structured_outputs") || (entry.supported_parameters ?? []).includes("response_format"), longContext: (entry.context_length ?? 0) >= 100_000 },
    }),
  };
}

async function dailyAllowance() {
  const data = (await openRouterJson("/api/v1/auth/key")).data;
  const free = data.free_model_daily_requests ?? {};
  return { limit: free.limit, used: free.used, remaining: free.remaining, usage: data.usage, usageDaily: data.usage_daily, checkedAt: new Date().toISOString() };
}

function capacityGate(allowance, observedCallsPerRun) {
  const sorted = [...observedCallsPerRun].sort((a, b) => a - b);
  const p90 = sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.floor(0.9 * sorted.length))] : 0;
  const needed = Math.ceil(1.15 * Math.max(40, p90));
  return { needed, ok: typeof allowance.remaining === "number" ? allowance.remaining >= needed : true };
}

// ---------------------------------------------------------------------------------------------
// Scripted reference model for dry runs (role-aware, deterministic, $0)
// ---------------------------------------------------------------------------------------------
function detectRole(req) {
  const system = req.system ?? req.messages.find((m) => m.role === "system")?.content ?? "";
  if (system.includes("You are CodeForge Explorer")) return "explorer";
  if (system.includes("You are CodeForge Planner")) return "planner";
  if (system.includes("You are CodeForge Reviewer")) return "reviewer";
  return "coder";
}

function scriptedReferenceProvider(task) {
  const steps = REFERENCE_STEPS[task.record.taskId] ?? [];
  let counter = 0;
  const toolTurn = (name, args) => {
    const id = `tc-${++counter}`;
    return async function* () {
      yield { type: "tool_call_started", toolCallId: id, toolName: name };
      yield { type: "tool_call_delta", toolCallId: id, delta: JSON.stringify(args) };
      yield { type: "tool_call_completed", toolCallId: id, toolName: name, arguments: JSON.stringify(args) };
      yield { type: "usage", usage: { inputTokens: 900 + 300 * counter, outputTokens: 60, costUsd: 0 } };
      yield { type: "finish", finishReason: "tool_calls" };
    };
  };
  const finalTurn = (text) => async function* () {
    yield { type: "text_delta", delta: text };
    yield { type: "usage", usage: { inputTokens: 1200 + 300 * counter, outputTokens: 80, costUsd: 0 } };
    yield { type: "finish", finishReason: "stop" };
  };
  const firstPath = steps[0]?.path ?? "README.md";
  const coderSteps = [];
  for (const step of steps) {
    if (step.kind === "edit") coderSteps.push(toolTurn("read_file", { path: step.path }), toolTurn("edit_file", { path: step.path, oldText: step.from, newText: step.to }));
    else coderSteps.push(toolTurn("write_file", { path: step.path, content: step.content }));
  }
  const explorerSummary = task.record.answerKey ? referenceSummary(task.record.taskId) : `Relevant module: ${firstPath}`;
  const scripts = {
    explorer: [toolTurn("list_files", { path: ".", recursive: false }), toolTurn("read_file", { path: task.record.answerKey ? "src/net/webhook-dispatcher.js" : firstPath }), finalTurn(JSON.stringify({ summary: explorerSummary, findings: [], evidence: [{ kind: "file", ref: firstPath, description: "primary file" }] }))],
    // The planner contract (planning-contract.ts) requires explicit intent dimensions; a bare task list is rejected.
    planner: [finalTurn(JSON.stringify({ summary: "Single coder change verified by the repository checks", tasks: [{ id: "t1", title: "Apply change", objective: task.record.goal.slice(0, 120), dependencies: [], assignedRole: "coder" }, { id: "t2", title: "Review", objective: "Independent review of the change", dependencies: ["t1"], assignedRole: "reviewer" }], planningIntent: { targetSelection: [`target ${firstPath}`], constraints: ["preserve existing behaviour; smallest change only"], uncertainties: ["assume the repository checks are the acceptance test"], verification: ["run the visible verification commands and the repository tests"], completionEvidence: ["verification passes and the diff is reviewed"] } }))],
    coder: [...coderSteps, finalTurn(referenceSummary(task.record.taskId))],
    reviewer: [toolTurn("read_file", { path: firstPath }), finalTurn(JSON.stringify({ verdict: "pass", findings: [], summary: "Change matches the goal and is minimal." }))],
  };
  const cursors = new Map();
  return {
    providerId: "scripted",
    isTestProvider: true,
    async listModels() {
      return [{ modelId: "scripted-free", displayName: "Scripted reference", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
    },
    async chat() {
      throw new Error("use streamChat");
    },
    async *streamChat(req, signal) {
      const role = detectRole(req);
      const cursor = cursors.get(role) ?? 0;
      const script = scripts[role];
      const responder = script[Math.min(cursor, script.length - 1)];
      cursors.set(role, cursor + 1);
      for await (const event of responder(req)) {
        if (signal?.aborted) return;
        yield event;
      }
    },
    async healthCheck() {
      return { status: "available" };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Pair execution
// ---------------------------------------------------------------------------------------------
function orderFor(taskIndex, repetition) {
  const controlFirst = (taskIndex + repetition) % 2 === 0;
  return controlFirst ? "control-first" : "optimized-first";
}

async function runPairs({ phase, tasks, arms, repetitions, modeFlag, model, createProvider, freeRecord, routeListedUnitPrice, pricing, identity, live }) {
  assertArmsDifferOnlyInSwitches();
  const scratchRoot = path.join(os.tmpdir(), "codeforge-r23", phase);
  fs.mkdirSync(scratchRoot, { recursive: true });
  const campaignId = `${phase}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const observedCalls = [];
  const summary = [];
  for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
    const task = tasks[taskIndex];
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const pairId = `${campaignId}-${task.record.taskId}-r${repetition}`;
      const pairOrder = orderFor(taskIndex, repetition);
      const sequence = pairOrder === "control-first" ? ["control", "optimized"] : ["optimized", "control"];
      const executionMode = task.record.role === "explorer" ? "single_agent_run" : modeFlag;
      const pairRecords = [];
      for (const armId of sequence) {
        if (!arms.includes(armId)) continue;
        if (live) {
          const allowance = await dailyAllowance();
          const gate = capacityGate(allowance, observedCalls);
          log(`allowance remaining=${allowance.remaining}/${allowance.limit} (needed ≥ ${gate.needed} for the next run)`);
          if (!gate.ok) {
            logExclusion({ reason: "daily allowance below the §6.3 margin — pair voided, re-run whole next day", taskId: task.record.taskId, pairId, runId: null, protocolRule: "§6.3 daily allowance", allowance });
            for (const done of pairRecords) logExclusion({ reason: "sibling arm voided with the pair (§6.3)", taskId: task.record.taskId, pairId, runId: done.identity.runId, protocolRule: "§6.3 daily allowance" });
            log("stopping: allowance exhausted for today");
            return { campaignId, summary, stopped: "allowance" };
          }
        }
        const arm = armId === "control" ? CONTROL_ARM : OPTIMIZED_ARM;
        log(`▶ ${task.record.taskId} [${armId}] rep ${repetition} (${executionMode}, order ${pairOrder})`);
        const startedAt = Date.now();
        let output;
        try {
          output = await runTaskArm({
            task, arm, armId, executionMode, model,
            createProvider: () => createProvider(task),
            freeRecord, routeListedUnitPrice, pricing,
            identity: { ...identity, campaignId, phase, pairId, pairOrder, repetition },
            scratchRoot,
            sampleGpu: true,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log(`✖ harness error on ${task.record.taskId} [${armId}]: ${message.slice(0, 300)}`);
          logExclusion({ reason: `harness_error: ${message.slice(0, 500)}`, taskId: task.record.taskId, pairId, runId: null, protocolRule: "§7 harness_error voids the pair" });
          for (const done of pairRecords) logExclusion({ reason: "sibling arm voided with the pair (§7 harness_error)", taskId: task.record.taskId, pairId, runId: done.identity.runId, protocolRule: "§7" });
          break;
        }
        const { record, violations } = output;
        if (violations.length > 0) {
          log(`✖ invariant violations on ${record.identity.runId}: ${violations.join("; ")}`);
          record.notes.push(...violations.map((violation) => `INVARIANT VIOLATION: ${violation}`));
          logExclusion({ reason: `invariant violations: ${violations.join("; ")}`, taskId: task.record.taskId, pairId, runId: record.identity.runId, protocolRule: "§16 instrumentation gate" });
        }
        writeRecord(phase, record);
        pairRecords.push(record);
        observedCalls.push(record.inference.modelCalls);
        const tokens = record.inference.totalTokens.value;
        log(`✔ ${record.outcome.classification} · calls=${record.inference.modelCalls} tokens=${tokens ?? "UNKNOWN"} wall=${Math.round(record.time.wallClockMs / 1000)}s verifier=${record.outcome.verifierPassed} authority=${record.outcome.completionAuthority} (${Math.round((Date.now() - startedAt) / 1000)}s)`);
        summary.push({ taskId: task.record.taskId, arm: armId, repetition, classification: record.outcome.classification, modelCalls: record.inference.modelCalls, totalTokens: tokens ?? null, wallClockMs: record.time.wallClockMs, runId: record.identity.runId });
        if (record.outcome.classification === "infrastructure_void") {
          logExclusion({ reason: record.outcome.completionReason, taskId: task.record.taskId, pairId, runId: record.identity.runId, protocolRule: "§6.3 infrastructure_void (single-arm re-run allowed once)" });
        }
        if (live && record.economics.actualCostUsd.value !== undefined && record.economics.actualCostUsd.value > 0) {
          log(`✖ HALT: run ${record.identity.runId} reports actual cost ${record.economics.actualCostUsd.value} > 0 (protocol §2.1)`);
          return { campaignId, summary, stopped: "cost" };
        }
      }
    }
  }
  return { campaignId, summary };
}

// ---------------------------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------------------------
async function modeFreezeManifest() {
  regenerateCorpus();
  const batch = flags.batch ?? "batch-1";
  const manifest = await freezeManifest(TASKS_ROOT, batch);
  if (fs.existsSync(MANIFEST_PATH) && !flags.force) {
    const existing = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    const check = await verifyManifest(TASKS_ROOT, existing);
    if (check.ok && check.unlisted.length === 0) {
      log(`manifest already frozen and matches (${existing.tasks.length} tasks) — nothing to do`);
      return;
    }
    if (check.mismatches.length > 0) throw new Error(`frozen tasks changed on disk (${check.mismatches.join("; ")}); a frozen task may not be edited (§4.3). Use --force only to append a new batch after voiding.`);
    // Only unlisted tasks: append them as the named batch, keeping existing entries verbatim.
    manifest.tasks = [...existing.tasks, ...manifest.tasks.filter((entry) => check.unlisted.includes(entry.taskId)).map((entry) => ({ ...entry, batch }))];
    manifest.frozenAt = existing.frozenAt;
  }
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.mkdirSync(path.join(EVIDENCE, "protocol"), { recursive: true });
  fs.copyFileSync(MANIFEST_PATH, path.join(EVIDENCE, "protocol", "task-manifest.json"));
  log(`froze ${manifest.tasks.length} tasks → ${path.relative(ROOT, MANIFEST_PATH)} (sha256 ${sha256(fs.readFileSync(MANIFEST_PATH)).slice(0, 16)}…)`);
}

async function modeSnapshotPricing() {
  const catalog = (await openRouterJson("/api/v1/models")).data;
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  const prices = {};
  const equivalents = {};
  // Catalog prices are per token as decimal strings; convert to USD per 1M and round away float noise.
  const perMillion = (value) => Math.round(Number(value) * 1e6 * 1e9) / 1e9;
  const price = (model, source) => ({ id: `openrouter::${model.id}`, displayName: model.name, inputPerMillionUsd: perMillion(model.pricing.prompt), outputPerMillionUsd: perMillion(model.pricing.completion), ...(model.pricing.input_cache_read ? { cacheReadPerMillionUsd: perMillion(model.pricing.input_cache_read) } : {}), source, retrievedAt: now });
  const free = catalog.filter((model) => model.pricing?.prompt === "0" && model.pricing?.completion === "0" && (model.supported_parameters ?? []).includes("tools"));
  for (const model of free) {
    const twin = catalog.find((candidate) => candidate.id === model.id.replace(/:free$/, ""));
    if (!twin || twin.id === model.id) continue;
    prices[`openrouter::${twin.id}`] = price(twin, "https://openrouter.ai/api/v1/models (live catalog)");
    equivalents[`openrouter::${model.id}`] = { priceRef: `openrouter::${twin.id}`, rationale: "paid listing of the same model on the same provider" };
  }
  const marketPreference = list(flags["market-ref"]) ?? ["anthropic/claude-sonnet-5", "anthropic/claude-sonnet-4.5", "anthropic/claude-sonnet-4", "anthropic/claude-opus-5"];
  const market = marketPreference.map((id) => catalog.find((model) => model.id === id)).find(Boolean);
  if (!market) throw new Error(`no market reference model found among ${marketPreference.join(", ")}`);
  prices[`openrouter::${market.id}`] = price(market, "https://openrouter.ai/api/v1/models (live catalog)");
  const snapshot = parsePricingSnapshot({
    snapshotId: `openrouter-${day}`,
    frozenAt: now,
    currency: "USD",
    equivalents,
    marketReference: { priceRef: `openrouter::${market.id}`, rationale: "named reference frontier coding model; expresses what the same tokens would cost on a typical premium paid API — a reference, never a saving" },
    prices,
  });
  const dir = path.join(EVIDENCE, "cost");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `pricing-snapshot-${day}.json`);
  fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  log(`pricing snapshot ${snapshot.snapshotId}: ${Object.keys(equivalents).length} free routes with paid twins, market ref ${market.id} → ${path.relative(ROOT, file)}`);
  for (const [route, eq] of Object.entries(equivalents)) log(`  ${route} → ${eq.priceRef} ($${prices[eq.priceRef].inputPerMillionUsd}/$${prices[eq.priceRef].outputPerMillionUsd} per 1M)`);
}

function selectTasks(tasks, wanted, { qualification }) {
  const chosen = tasks.filter((task) => {
    const isQual = task.record.tags.includes("qualification");
    if (qualification !== undefined && isQual !== qualification) return false;
    return !wanted || wanted.includes(task.record.taskId);
  });
  if (chosen.length === 0) throw new Error("no tasks selected");
  return chosen;
}

async function modeDryRun() {
  // The scripted reference model is a TEST provider; ForgeZero refuses it outside test mode by
  // design (production must never route inference through a scripted provider). Dry runs are the
  // one place that opt-in is legitimate — it is set here, for this process only, and the live
  // modes never set it.
  process.env.CODEFORGE_ALLOW_TEST_PROVIDERS = "1";
  const digest = protocolDigest();
  const { tasks } = await loadFrozenCorpus();
  const identity = identityBase(digest);
  const { snapshot, path: pricingPath } = fs.existsSync(path.join(EVIDENCE, "cost")) && fs.readdirSync(path.join(EVIDENCE, "cost")).some((f) => f.startsWith("pricing-snapshot-")) ? loadPricing() : { snapshot: parsePricingSnapshot({ snapshotId: "dry-run-fixture", frozenAt: new Date().toISOString(), currency: "USD", equivalents: {}, marketReference: { priceRef: "fixture::reference", rationale: "dry run" }, prices: { "fixture::reference": { id: "fixture::reference", inputPerMillionUsd: 3, outputPerMillionUsd: 15, source: "fixture", retrievedAt: new Date().toISOString() } } }), path: "(fixture)" };
  const chosen = selectTasks(tasks, list(flags.tasks), { qualification: undefined });
  const arms = list(flags.arms) ?? ["control", "optimized"];
  const modeFlag = flags.mode === "single" ? "single_agent_run" : "orchestrated";
  log(`dry run: ${chosen.length} task(s) × arms [${arms.join(", ")}] in ${modeFlag} with the scripted reference model; pricing ${pricingPath}`);
  const result = await runPairs({ phase: "dry_run", tasks: chosen, arms, repetitions: 1, modeFlag, model: { providerId: "scripted", modelId: "scripted-free", routeClass: "fixture" }, createProvider: (task) => scriptedReferenceProvider(task), routeListedUnitPrice: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 }, pricing: snapshot, identity, live: false });
  writeCampaignSummary("dry_run", result, { model: "scripted-free", identity, mode: modeFlag });
}

async function liveSetup(modelId) {
  const digest = protocolDigest();
  const { tasks, manifestDigest } = await loadFrozenCorpus();
  const identity = identityBase(digest);
  const { snapshot, path: pricingPath } = loadPricing();
  const pin = await pinFreeModel(modelId);
  const allowance = await dailyAllowance();
  log(`pinned ${modelId}: $0/$0 confirmed, tools advertised, ctx ${pin.entry.contextLength}; paid twin ${pin.paidTwin?.id ?? "none"}; allowance ${allowance.remaining}/${allowance.limit} remaining; pricing ${path.relative(ROOT, pricingPath)}`);
  const adapter = createOpenRouterAdapter({ timeoutMs: 180_000 });
  return { tasks, identity, snapshot, pin, allowance, manifestDigest, createProvider: () => adapter, model: { providerId: "openrouter", modelId, routeClass: "openrouter_free_deposit_unlocked" } };
}

function writeCampaignSummary(phase, result, extra) {
  const dir = rawDir(phase);
  const file = path.join(dir, `campaign-${result.campaignId}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ campaignId: result.campaignId, phase, recordedAt: new Date().toISOString(), ...extra, stopped: result.stopped ?? null, runs: result.summary }, null, 2)}\n`);
  const verified = result.summary.filter((run) => run.classification === "verified_complete").length;
  log(`campaign ${result.campaignId}: ${result.summary.length} run(s), ${verified} verified → ${path.relative(ROOT, file)}`);
}

/**
 * Protocol §2.2 pre-screen: one qualification task per candidate, single-agent mode, optimized
 * runtime switches. Outcome-blind cap: the six passers with the lowest wall time go on to the
 * full round. Candidates default to every tool-capable `:free` model in the live catalog.
 */
async function modePrescreen() {
  const catalog = (await openRouterJson("/api/v1/models")).data;
  const candidates = list(flags.models) ?? catalog
    .filter((model) => model.pricing?.prompt === "0" && model.pricing?.completion === "0" && (model.supported_parameters ?? []).includes("tools") && model.id !== "openrouter/free")
    .map((model) => model.id);
  const taskId = flags.task ?? "qual-js-return-sign";
  const results = [];
  for (const modelId of candidates) {
    log(`=== pre-screen: ${modelId} ===`);
    let setup;
    try {
      setup = await liveSetup(modelId);
    } catch (error) {
      results.push({ modelId, passed: false, reason: `ineligible: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    const chosen = selectTasks(setup.tasks, [taskId], { qualification: true });
    const result = await runPairs({ phase: "qualification", tasks: chosen, arms: ["optimized"], repetitions: 1, modeFlag: "single_agent_run", model: setup.model, createProvider: setup.createProvider, freeRecord: setup.pin.freeRecord, routeListedUnitPrice: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 }, pricing: setup.snapshot, identity: setup.identity, live: true });
    if (result.stopped) {
      results.push({ modelId, passed: false, reason: `campaign stopped: ${result.stopped}` });
      if (result.stopped === "allowance") break;
      continue;
    }
    const run = result.summary[0];
    const record = run ? JSON.parse(fs.readFileSync(path.join(rawDir("qualification"), `${run.runId}.json`), "utf8")) : undefined;
    const malformed = record ? record.outcome.stopReason.toLowerCase().includes("invalid") || record.inference.calls.some((call) => call.outcome === "error" && !call.rateLimited && (call.httpStatus ?? 0) < 500) : false;
    const passed = Boolean(run && run.classification === "verified_complete" && !malformed);
    results.push({ modelId, passed, classification: run?.classification ?? "no_run", wallClockMs: run?.wallClockMs ?? null, modelCalls: run?.modelCalls ?? null, totalTokens: run?.totalTokens ?? null, runId: run?.runId ?? null, reason: passed ? "verified_complete" : run ? `${run.classification}${malformed ? " (malformed/tool-call error)" : ""}` : "no run" });
    log(`  → ${passed ? "PASS" : "FAIL"} ${run?.classification ?? "no_run"} calls=${run?.modelCalls ?? "—"} wall=${run ? Math.round(run.wallClockMs / 1000) : "—"}s`);
  }
  const passers = results.filter((r) => r.passed).sort((a, b) => a.wallClockMs - b.wallClockMs);
  const cap = Number(flags.cap ?? 6);
  const advancing = passers.slice(0, cap).map((r) => r.modelId);
  const dir = path.join(EVIDENCE, "pilot");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "MODEL-PRESCREEN.json");
  fs.writeFileSync(file, `${JSON.stringify({ recordedAt: new Date().toISOString(), protocolRule: "§2.2 pre-screen (v1.0.2): one single-agent qualification task; passers ranked by wall time; outcome-blind cap", task: taskId, cap, candidates: results, advancing }, null, 2)}
`);
  log(`pre-screen written → ${path.relative(ROOT, file)}; ${passers.length}/${results.length} passed; advancing: ${advancing.join(", ") || "(none)"}`);
}

async function modeQualify() {
  const models = list(flags.models) ?? (() => {
    const file = path.join(EVIDENCE, "pilot", "MODEL-PRESCREEN.json");
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf8")).advancing;
  })();
  if (!models || models.length === 0) throw new Error("qualify requires --models a:free,b:free or a MODEL-PRESCREEN.json with advancing candidates");
  const results = [];
  for (const modelId of models) {
    log(`=== qualification: ${modelId} ===`);
    let setup;
    try {
      setup = await liveSetup(modelId);
    } catch (error) {
      results.push({ modelId, eligible: false, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const chosen = selectTasks(setup.tasks, list(flags.tasks), { qualification: true });
    const result = await runPairs({ phase: "qualification", tasks: chosen, arms: ["optimized"], repetitions: 1, modeFlag: flags.mode === "single" ? "single_agent_run" : "orchestrated", model: setup.model, createProvider: setup.createProvider, freeRecord: setup.pin.freeRecord, routeListedUnitPrice: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 }, pricing: setup.snapshot, identity: setup.identity, live: true });
    writeCampaignSummary("qualification", result, { model: modelId, pin: setup.pin.entry, allowanceAtStart: setup.allowance, identity: setup.identity });
    const runs = result.summary;
    const records = runs.map((run) => JSON.parse(fs.readFileSync(path.join(rawDir("qualification"), `${run.runId}.json`), "utf8")));
    const hangsOrUpstream = records.filter((record) => record.inference.calls.some((call) => call.outcome === "error" && (call.rateLimited || (call.httpStatus ?? 0) >= 500 || /hang|timeout/i.test(call.errorCode ?? "")))).length;
    const malformedToolCalls = records.filter((record) => record.outcome.stopReason.toLowerCase().includes("invalid") || record.notes.some((note) => /malformed/i.test(note))).length;
    results.push({
      modelId,
      eligible: true,
      tasks: runs.length,
      verified: runs.filter((run) => run.classification === "verified_complete").length,
      falseComplete: runs.filter((run) => run.classification === "false_complete").length,
      hangsOrUpstreamFailures: hangsOrUpstream,
      malformedToolCallRuns: malformedToolCalls,
      medianWallMs: median(runs.map((run) => run.wallClockMs)),
      medianCalls: median(runs.map((run) => run.modelCalls)),
      medianTokens: median(runs.map((run) => run.totalTokens).filter((value) => typeof value === "number")),
      runIds: runs.map((run) => run.runId),
      stopped: result.stopped ?? null,
    });
  }
  // Protocol §2.2 scoring: reliability + capability only (efficiency fields are recorded but not scored).
  const ranked = results.filter((r) => r.eligible).sort((a, b) => (b.verified - a.verified) || (a.hangsOrUpstreamFailures - b.hangsOrUpstreamFailures) || (a.malformedToolCallRuns - b.malformedToolCallRuns) || (a.medianWallMs - b.medianWallMs));
  const selection = { recordedAt: new Date().toISOString(), protocolRule: "§2.2 — reliability and capability only; tokens are not a scoring input", candidates: results, winner: ranked[0]?.modelId ?? null, ranking: ranked.map((r) => r.modelId) };
  const dir = path.join(EVIDENCE, "pilot");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "MODEL-SELECTION.json");
  if (fs.existsSync(file) && !flags.force) {
    const existing = JSON.parse(fs.readFileSync(file, "utf8"));
    selection.previousRounds = [...(existing.previousRounds ?? []), { recordedAt: existing.recordedAt, winner: existing.winner, candidates: existing.candidates }];
  }
  fs.writeFileSync(file, `${JSON.stringify(selection, null, 2)}\n`);
  log(`model selection written → ${path.relative(ROOT, file)}; winner: ${selection.winner}`);
  for (const r of results) log(`  ${r.modelId}: ${r.eligible ? `verified ${r.verified}/${r.tasks}, false-complete ${r.falseComplete}, hangs/upstream ${r.hangsOrUpstreamFailures}, median wall ${Math.round((r.medianWallMs ?? 0) / 1000)}s` : `INELIGIBLE: ${r.reason}`}`);
}

function median(values) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function modeLivePairs(phase) {
  const modelId = flags.model;
  if (!modelId) throw new Error(`${phase} requires --model <exact :free id>`);
  const setup = await liveSetup(modelId);
  const selectionPath = path.join(EVIDENCE, "pilot", "MODEL-SELECTION.json");
  if (fs.existsSync(selectionPath)) {
    const selection = JSON.parse(fs.readFileSync(selectionPath, "utf8"));
    if (selection.winner && selection.winner !== modelId && !flags["override-selection"]) throw new Error(`MODEL-SELECTION.json names ${selection.winner}; refusing to run ${phase} on ${modelId} (protocol §2.2). Pass --override-selection only with a documented reason.`);
  } else if (phase !== "pilot" || !flags["override-selection"]) {
    throw new Error("pilot/MODEL-SELECTION.json is missing — run the qualification round first (protocol §2.2)");
  }
  const chosen = selectTasks(setup.tasks, list(flags.tasks), { qualification: false });
  const repetitions = Number(flags.reps ?? 1);
  const modeFlag = flags.mode === "single" ? "single_agent_run" : "orchestrated";
  const arms = list(flags.arms) ?? ["control", "optimized"];
  const result = await runPairs({ phase, tasks: chosen, arms, repetitions, modeFlag, model: setup.model, createProvider: setup.createProvider, freeRecord: setup.pin.freeRecord, routeListedUnitPrice: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 }, pricing: setup.snapshot, identity: setup.identity, live: true });
  writeCampaignSummary(phase, result, { model: modelId, pin: setup.pin.entry, paidTwin: setup.pin.paidTwin, allowanceAtStart: setup.allowance, allowanceAtEnd: await dailyAllowance().catch(() => null), identity: setup.identity, mode: modeFlag, repetitions, taskManifestDigest: setup.manifestDigest });
}

const modes = {
  "freeze-manifest": modeFreezeManifest,
  "snapshot-pricing": modeSnapshotPricing,
  "dry-run": modeDryRun,
  prescreen: modePrescreen,
  qualify: modeQualify,
  pilot: () => modeLivePairs("pilot"),
  main: () => modeLivePairs("main"),
  variance: () => modeLivePairs("variance"),
};

if (!mode || !modes[mode]) {
  console.error(`usage: r23-efficiency-bench.mjs <${Object.keys(modes).join("|")}> [flags]`);
  process.exit(2);
}
try {
  await modes[mode]();
} catch (error) {
  console.error(`[r23] FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`.replace(/sk-or-[A-Za-z0-9_-]+/g, "[REDACTED]"));
  process.exit(1);
}
