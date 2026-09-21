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
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { createGroqAdapter, createOpenRouterAdapter } from "@codeforge/providers";
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
const PROTOCOL_VERSION = "1.0.4";

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
  // Do NOT route this through git() — its .trim() strips the leading status column of the first
  // porcelain line (" M path" → "M path"), which would misalign the slice(3) path parse.
  const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8", windowsHide: true }).split(/\r?\n/).filter(Boolean);
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

// ---------------------------------------------------------------------------------------------
// Substitute routes (protocol §2.1, v1.0.4): provider-native pinning + capacity signals
// ---------------------------------------------------------------------------------------------
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
/** Registry-documented Groq free-plan caps (provider-definitions.ts → freeAccess.quota). */
const GROQ_FREE_DAILY_TOKENS = 200_000;
let lastGroqQuota; // { requests: {...}, tokens: {...}, observedAt } — filled by the adapter's onResponse

function quotaFromHeaders(observation) {
  const headers = new Map(observation.headers.map(([k, v]) => [k.toLowerCase(), v]));
  const num = (key) => (headers.has(key) ? Number(headers.get(key)) : undefined);
  return {
    providerId: observation.providerId,
    status: observation.status,
    requests: { limit: num("x-ratelimit-limit-requests"), remaining: num("x-ratelimit-remaining-requests"), reset: headers.get("x-ratelimit-reset-requests") },
    tokens: { limit: num("x-ratelimit-limit-tokens"), remaining: num("x-ratelimit-remaining-tokens"), reset: headers.get("x-ratelimit-reset-tokens") },
    retryAfter: headers.get("retry-after"),
    observedAt: new Date(observation.observedAt).toISOString(),
  };
}

/** Cumulative served tokens on the groq route across today's run records (ledger-derived, honest). */
function dailyTokensUsed(providerId) {
  const today = new Date().toISOString().slice(0, 10);
  let total = 0;
  for (const phase of ["qualification", "pilot", "main", "variance"]) {
    const dir = rawDir(phase);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json") || file.startsWith("campaign-")) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
        if (record.identity?.providerId !== providerId) continue;
        if (!String(record.identity?.startedAt ?? record.recordedAt ?? "").startsWith(today)) continue;
        for (const call of record.inference?.calls ?? []) total += call.totalTokens ?? 0;
      } catch { /* unreadable record — skip, gate stays conservative via headers */ }
    }
  }
  return total;
}

async function pinGroqModel(modelId) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY is not set");
  const catalogRes = await fetch(`${GROQ_BASE_URL}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!catalogRes.ok) throw new Error(`groq /models → HTTP ${catalogRes.status}`);
  const catalog = (await catalogRes.json()).data ?? [];
  const entry = catalog.find((model) => model.id === modelId);
  if (!entry) throw new Error(`model ${modelId} is not in the live Groq catalog`);
  // §2.1(3): tool support is verified by a live probe, not advertised metadata.
  const probe = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: "Call the echo tool with text \"pin\". Do not answer in prose." }],
      tools: [{ type: "function", function: { name: "echo", description: "Echoes the given text.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } } }],
      tool_choice: "required",
      max_tokens: 64,
    }),
  });
  lastGroqQuota = quotaFromHeaders({ providerId: "groq", modelId, status: probe.status, headers: [...probe.headers.entries()], observedAt: Date.now() });
  if (!probe.ok) throw new Error(`groq tool probe → HTTP ${probe.status} for ${modelId}`);
  const probeBody = await probe.json();
  const toolCalls = probeBody.choices?.[0]?.message?.tool_calls ?? [];
  if (toolCalls.length === 0) throw new Error(`model ${modelId} did not emit a tool call under tool_choice=required`);
  if (!probeBody.usage || typeof probeBody.usage.total_tokens !== "number") throw new Error(`model ${modelId} returned no usage payload — §2.1(4) fails`);
  // §2.1(1): ForgeZero admission under a verified free-access class is the eligibility authority.
  const firewall = new ForgeZero();
  const freeRecord = createGenericFreeRecord({ providerId: "groq", modelId, displayName: entry.id, contextWindow: entry.context_window, accessClass: "FREE_ALLOWANCE" });
  firewall.register(freeRecord);
  if (!firewall.eligibleModels().some((model) => model.providerId === "groq" && model.modelId === modelId)) {
    throw new Error(`ForgeZero refuses groq::${modelId} — the substitute route fails §2.1(1)`);
  }
  return {
    entry: { id: entry.id, name: entry.id, contextLength: entry.context_window, ownedBy: entry.owned_by, checkedAt: new Date().toISOString(), pricingVerification: "provider-free-tier-policy + ForgeZero FREE_ALLOWANCE admission + live rate-limit headers (§2.1b)", quotaAtPin: lastGroqQuota, toolProbe: { toolCallsEmitted: toolCalls.length, usage: probeBody.usage } },
    paidTwin: { id: `openrouter::${modelId}`, note: "equivalent-cost reference: same model's paid listing on the reference marketplace" },
    freeRecord,
  };
}

async function groqAllowance() {
  if (lastGroqQuota && Date.now() - Date.parse(lastGroqQuota.observedAt) < 120_000) {
    return { limit: lastGroqQuota.requests.limit, used: lastGroqQuota.requests.limit !== undefined && lastGroqQuota.requests.remaining !== undefined ? lastGroqQuota.requests.limit - lastGroqQuota.requests.remaining : undefined, remaining: lastGroqQuota.requests.remaining, remainingTokens: lastGroqQuota.tokens.remaining, dailyTokensUsed: dailyTokensUsed("groq"), source: "x-ratelimit headers (live adapter observation)", checkedAt: new Date().toISOString() };
  }
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY is not set");
  const probe = await fetch(`${GROQ_BASE_URL}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: flags.model ?? "openai/gpt-oss-120b", messages: [{ role: "user", content: "ok" }], max_tokens: 1 }) });
  lastGroqQuota = quotaFromHeaders({ providerId: "groq", status: probe.status, headers: [...probe.headers.entries()], observedAt: Date.now() });
  if (!probe.ok) throw new Error(`groq allowance probe → HTTP ${probe.status}`);
  await probe.json();
  return { limit: lastGroqQuota.requests.limit, used: lastGroqQuota.requests.limit !== undefined && lastGroqQuota.requests.remaining !== undefined ? lastGroqQuota.requests.limit - lastGroqQuota.requests.remaining : undefined, remaining: lastGroqQuota.requests.remaining, remainingTokens: lastGroqQuota.tokens.remaining, dailyTokensUsed: dailyTokensUsed("groq"), source: "x-ratelimit headers (probe)", checkedAt: new Date().toISOString() };
}

function allowance(providerId) {
  return providerId === "groq" ? groqAllowance() : dailyAllowance();
}

function capacityGate(allowanceData, observedCallsPerRun, providerId, observedRunTokens = []) {
  const sorted = [...observedCallsPerRun].sort((a, b) => a - b);
  const p90 = sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.floor(0.9 * sorted.length))] : 0;
  const needed = Math.ceil(1.15 * Math.max(40, p90));
  const ok = typeof allowanceData.remaining === "number" ? allowanceData.remaining >= needed : true;
  if (providerId !== "groq") return { needed, ok };
  // §6.3 v1.0.4: the documented daily token cap gates alongside the request window (same 15%
  // margin), estimated from observed per-run token totals. Minute-scale windows are governor
  // pacing, not allowance exhaustion.
  const sortedTokens = [...observedRunTokens].sort((a, b) => a - b);
  const p90Tokens = sortedTokens.length > 0 ? sortedTokens[Math.min(sortedTokens.length - 1, Math.floor(0.9 * sortedTokens.length))] : 0;
  const tokensNeeded = Math.ceil(1.15 * Math.max(60_000, p90Tokens));
  const dailyTokensOk = (allowanceData.dailyTokensUsed ?? 0) + tokensNeeded <= GROQ_FREE_DAILY_TOKENS * 0.85;
  return { needed, tokensNeeded, ok: ok && dailyTokensOk, dailyTokensOk };
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

async function runPairs({ phase, tasks, arms, repetitions, modeFlag, model, createProvider, freeRecord, routeListedUnitPrice, pricing, identity, live, providerId = "openrouter" }) {
  assertArmsDifferOnlyInSwitches();
  const scratchRoot = path.join(os.tmpdir(), "codeforge-r23", phase);
  fs.mkdirSync(scratchRoot, { recursive: true });
  const campaignId = `${phase}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const observedCalls = [];
  const observedRunTokens = [];
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
          const allowanceData = await allowance(providerId);
          const gate = capacityGate(allowanceData, observedCalls, providerId, observedRunTokens);
          log(`allowance remaining=${allowanceData.remaining}/${allowanceData.limit} (needed ≥ ${gate.needed} for the next run)${providerId === "groq" ? `; daily tokens used=${allowanceData.dailyTokensUsed}/${GROQ_FREE_DAILY_TOKENS}` : ""}`);
          if (!gate.ok) {
            logExclusion({ reason: "daily allowance below the §6.3 margin — pair voided, re-run whole next day", taskId: task.record.taskId, pairId, runId: null, protocolRule: "§6.3 daily allowance", allowance: allowanceData });
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
        if (typeof record.inference.totalTokens.value === "number") observedRunTokens.push(record.inference.totalTokens.value);
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
  // §2.1 substitute routes (v1.0.4): a free route on another provider is priced at the same
  // model's paid listing on the reference marketplace. Only exact model-id matches qualify.
  for (const sub of ["groq::openai/gpt-oss-120b", "groq::openai/gpt-oss-20b", "groq::qwen/qwen3.8-27b"]) {
    const orId = sub.split("::")[1];
    const listing = catalog.find((model) => model.id === orId && model.pricing?.prompt !== "0" && model.pricing?.completion !== "0");
    if (!listing) continue;
    prices[`openrouter::${listing.id}`] = price(listing, "https://openrouter.ai/api/v1/models (live catalog)");
    equivalents[sub] = { priceRef: `openrouter::${listing.id}`, rationale: "same model weights served by the substitute provider; priced at the reference marketplace's paid listing (§2.1 v1.0.4)" };
  }
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

async function liveSetup(modelId, providerId = "openrouter") {
  const digest = protocolDigest();
  const { tasks, manifestDigest } = await loadFrozenCorpus();
  const identity = identityBase(digest);
  const { snapshot, path: pricingPath } = loadPricing();
  if (providerId === "groq") {
    const pin = await pinGroqModel(modelId);
    const allowanceData = await groqAllowance();
    log(`pinned groq::${modelId}: ForgeZero FREE_ALLOWANCE admission + live tool probe, ctx ${pin.entry.contextLength}; equivalent ref ${pin.paidTwin.id}; quota remaining req=${allowanceData.remaining} tokens=${allowanceData.remainingTokens} (window); daily tokens used=${allowanceData.dailyTokensUsed}/${GROQ_FREE_DAILY_TOKENS}; pricing ${path.relative(ROOT, pricingPath)}`);
    const adapter = createGroqAdapter({ apiKey: process.env.GROQ_API_KEY, timeoutMs: 180_000, onResponse: (observation) => { lastGroqQuota = quotaFromHeaders(observation); } });
    return { tasks, identity, snapshot, pin, allowance: allowanceData, manifestDigest, createProvider: () => adapter, model: { providerId: "groq", modelId, routeClass: "groq_owner_dev_free_allowance" } };
  }
  const pin = await pinFreeModel(modelId);
  const allowanceData = await dailyAllowance();
  log(`pinned ${modelId}: $0/$0 confirmed, tools advertised, ctx ${pin.entry.contextLength}; paid twin ${pin.paidTwin?.id ?? "none"}; allowance ${allowanceData.remaining}/${allowanceData.limit} remaining; pricing ${path.relative(ROOT, pricingPath)}`);
  const adapter = createOpenRouterAdapter({ timeoutMs: 180_000 });
  return { tasks, identity, snapshot, pin, allowance: allowanceData, manifestDigest, createProvider: () => adapter, model: { providerId: "openrouter", modelId, routeClass: "openrouter_free_deposit_unlocked" } };
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
  const file = path.join(EVIDENCE, "pilot", "MODEL-PRESCREEN.json");
  const prior = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
  const taskId = flags.task ?? prior?.task ?? "qual-js-return-sign";
  const cap = Number(flags.cap ?? prior?.cap ?? 6);
  const results = [];
  const skipped = [];
  for (const modelId of candidates) {
    const prev = (prior?.candidates ?? []).find((c) => c.modelId === modelId);
    if (prev && prev.classification && prev.classification !== "infrastructure_void") {
      // §6.3: a provider-side failure before the first tool call is not a capability signal and
      // may be re-screened; every other outcome is a real result and must not be re-attempted.
      log(`=== pre-screen: ${modelId} — skipping (prior ${prev.classification} is a capability/reliability result, not infrastructure)`);
      skipped.push({ modelId, priorClassification: prev.classification });
      continue;
    }
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
  // Merge into any prior file: candidates keep a complete attempts[] history; nothing is
  // overwritten — a re-screened candidate's new attempt is appended and its headline fields move
  // to the latest attempt.
  const byId = new Map();
  for (const c of prior?.candidates ?? []) byId.set(c.modelId, { ...c, attempts: [...(c.attempts ?? [{ recordedAt: prior.recordedAt, passed: c.passed, classification: c.classification, wallClockMs: c.wallClockMs, modelCalls: c.modelCalls, totalTokens: c.totalTokens, runId: c.runId, reason: c.reason }])] });
  const attemptAt = new Date().toISOString();
  for (const r of results) {
    const attempt = { recordedAt: attemptAt, passed: r.passed, classification: r.classification ?? "ineligible", wallClockMs: r.wallClockMs ?? null, modelCalls: r.modelCalls ?? null, totalTokens: r.totalTokens ?? null, runId: r.runId ?? null, reason: r.reason };
    const prev = byId.get(r.modelId);
    if (prev) {
      prev.attempts.push(attempt);
      Object.assign(prev, { passed: r.passed, classification: attempt.classification, wallClockMs: attempt.wallClockMs, modelCalls: attempt.modelCalls, totalTokens: attempt.totalTokens, runId: attempt.runId, reason: attempt.reason });
    } else {
      byId.set(r.modelId, { modelId: r.modelId, ...attempt, attempts: [attempt] });
    }
  }
  const all = [...byId.values()];
  const passers = all.filter((r) => r.passed).sort((a, b) => a.wallClockMs - b.wallClockMs);
  const advancing = passers.slice(0, cap).map((r) => r.modelId);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ recordedAt: new Date().toISOString(), protocolRule: "§2.2 pre-screen (v1.0.3): one single-agent qualification task; passers ranked by wall time; outcome-blind cap; infrastructure_void candidates may be re-screened (§6.3), all attempts preserved", task: taskId, cap, candidates: all, ...(skipped.length > 0 ? { skippedReScreen: skipped } : {}), advancing }, null, 2)}
`);
  log(`pre-screen written → ${path.relative(ROOT, file)}; ${passers.length}/${all.length} passed; advancing: ${advancing.join(", ") || "(none)"}`);
}

async function modeQualify() {
  const providerId = flags.provider ?? "openrouter";
  const models = list(flags.models) ?? (() => {
    const file = path.join(EVIDENCE, "pilot", "MODEL-PRESCREEN.json");
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf8")).advancing;
  })();
  if (!models || models.length === 0) throw new Error("qualify requires --models a:free,b:free or a MODEL-PRESCREEN.json with advancing candidates");
  const results = [];
  for (const modelId of models) {
    log(`=== qualification: ${providerId}::${modelId} ===`);
    let setup;
    try {
      setup = await liveSetup(modelId, providerId);
    } catch (error) {
      results.push({ modelId, providerId, eligible: false, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const chosen = selectTasks(setup.tasks, list(flags.tasks), { qualification: true });
    const result = await runPairs({ phase: "qualification", tasks: chosen, arms: ["optimized"], repetitions: 1, modeFlag: flags.mode === "single" ? "single_agent_run" : "orchestrated", model: setup.model, createProvider: setup.createProvider, freeRecord: setup.pin.freeRecord, routeListedUnitPrice: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 }, pricing: setup.snapshot, identity: setup.identity, live: true, providerId });
    writeCampaignSummary("qualification", result, { model: modelId, providerId, pin: setup.pin.entry, allowanceAtStart: setup.allowance, identity: setup.identity });
    const runs = result.summary;
    const records = runs.map((run) => JSON.parse(fs.readFileSync(path.join(rawDir("qualification"), `${run.runId}.json`), "utf8")));
    const hangsOrUpstream = records.filter((record) => record.inference.calls.some((call) => call.outcome === "error" && (call.rateLimited || (call.httpStatus ?? 0) >= 500 || /hang|timeout/i.test(call.errorCode ?? "")))).length;
    const malformedToolCalls = records.filter((record) => record.outcome.stopReason.toLowerCase().includes("invalid") || record.notes.some((note) => /malformed/i.test(note))).length;
    results.push({
      modelId,
      providerId,
      eligible: true,
      tasks: runs.length,
      tasksExpected: chosen.length,
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
  // Protocol §2.2 scoring: reliability + capability only (efficiency fields are recorded but not
  // scored). A winner must clear the qualification bar — every selected task verified_complete,
  // zero hangs/upstream 429|5xx, zero malformed tool-call runs. The best-scoring candidate that
  // fails the bar is the `leader`, not a winner; pilot/main refuse to run on an unqualified model.
  const qualified = (r) => r.eligible === true && r.verified === r.tasksExpected && r.hangsOrUpstreamFailures === 0 && r.malformedToolCallRuns === 0;
  const ranked = results.filter((r) => r.eligible).sort((a, b) => (b.verified - a.verified) || (a.hangsOrUpstreamFailures - b.hangsOrUpstreamFailures) || (a.malformedToolCallRuns - b.malformedToolCallRuns) || (a.medianWallMs - b.medianWallMs));
  const winner = ranked.find(qualified)?.modelId ?? null;
  const selection = { recordedAt: new Date().toISOString(), protocolVersion: PROTOCOL_VERSION, protocolRule: "§2.2 — reliability and capability only; tokens are not a scoring input; winner requires all tasks verified, zero upstream failures, zero malformed runs", candidates: results.map((r) => ({ ...r, qualified: r.eligible ? qualified(r) : false })), winner, winnerProvider: ranked.find(qualified)?.providerId ?? null, leader: ranked[0]?.modelId ?? null, ranking: ranked.map((r) => r.modelId) };
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
  const providerId = flags.provider ?? "openrouter";
  if (!modelId) throw new Error(`${phase} requires --model <exact model id>`);
  const setup = await liveSetup(modelId, providerId);
  const selectionPath = path.join(EVIDENCE, "pilot", "MODEL-SELECTION.json");
  if (fs.existsSync(selectionPath)) {
    const selection = JSON.parse(fs.readFileSync(selectionPath, "utf8"));
    const providerMismatch = selection.winnerProvider && selection.winnerProvider !== providerId;
    if (selection.winner && (selection.winner !== modelId || providerMismatch) && !flags["override-selection"]) throw new Error(`MODEL-SELECTION.json names ${selection.winnerProvider ? `${selection.winnerProvider}::` : ""}${selection.winner}; refusing to run ${phase} on ${providerId}::${modelId} (protocol §2.2). Pass --override-selection only with a documented reason.`);
  } else if (phase !== "pilot" || !flags["override-selection"]) {
    throw new Error("pilot/MODEL-SELECTION.json is missing — run the qualification round first (protocol §2.2)");
  }
  const chosen = selectTasks(setup.tasks, list(flags.tasks), { qualification: false });
  const repetitions = Number(flags.reps ?? 1);
  const modeFlag = flags.mode === "single" ? "single_agent_run" : "orchestrated";
  const arms = list(flags.arms) ?? ["control", "optimized"];
  const result = await runPairs({ phase, tasks: chosen, arms, repetitions, modeFlag, model: setup.model, createProvider: setup.createProvider, freeRecord: setup.pin.freeRecord, routeListedUnitPrice: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 }, pricing: setup.snapshot, identity: setup.identity, live: true, providerId });
  writeCampaignSummary(phase, result, { model: modelId, providerId, pin: setup.pin.entry, paidTwin: setup.pin.paidTwin, allowanceAtStart: setup.allowance, allowanceAtEnd: await allowance(providerId).catch(() => null), identity: setup.identity, mode: modeFlag, repetitions, taskManifestDigest: setup.manifestDigest });
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
