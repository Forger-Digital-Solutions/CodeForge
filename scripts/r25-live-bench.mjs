#!/usr/bin/env node
/*
 * R25 live paired benchmark — real-provider control/optimized runs on the frozen R25 corpus.
 * Sibling of scripts/r23-efficiency-bench.mjs with the same safety invariants:
 * $0 route pinning, ForgeZero admission, allowance gating, production-shaped probe gate,
 * cost halt, exclusion ledger, and per-run evidence records.
 *
 *   node scripts/r25-live-bench.mjs dry-run [--tasks id1,id2] [--arms control,optimized]
 *   node scripts/r25-live-bench.mjs snapshot-pricing
 *   node scripts/r25-live-bench.mjs probe-gate --provider groq --models qwen/qwen3.8-27b [--n 2]
 *   node scripts/r25-live-bench.mjs pilot --provider groq --model qwen/qwen3.8-27b [--tasks ...] [--reps 1]
 */
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { createGroqAdapter, createOpenRouterAdapter } from "@codeforge/providers";
import { agentToolDefinitions } from "@codeforge/server";
import {
  CONTROL_ARM,
  OPTIMIZED_ARM,
  R23_HARNESS_VERSION,
  assertArmsDifferOnlyInSwitches,
  environmentFingerprint,
  loadTaskCorpus,
  parsePricingSnapshot,
  runTaskArm,
  verifyManifest,
} from "@codeforge/forgegreen-campaign";
import { REFERENCE_STEPS, referenceSummary } from "../benchmarks/r25/reference-solutions.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const TASKS_ROOT = path.join(ROOT, "benchmarks", "r25", "tasks");
const MANIFEST_PATH = path.join(ROOT, "benchmarks", "r25", "manifest.json");
const EVIDENCE = path.join(ROOT, "docs", "evidence", "r25-live-reality", "bench");
const PROTOCOL_VERSION = "r25-live-1.0.0";

const [mode, ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i += 1) {
  const arg = rest[i];
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const next = rest[i + 1];
  if (next === undefined || next.startsWith("--")) flags[key] = true;
  else { flags[key] = next; i += 1; }
}
const list = (value) => (typeof value === "string" ? value.split(",").map((v) => v.trim()).filter(Boolean) : undefined);
const log = (message) => console.log(`[r25] ${new Date().toISOString()} ${message}`);
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true }).trim();

function treeState() {
  const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8", windowsHide: true }).split(/\r?\n/).filter(Boolean);
  const dirtyFiles = porcelain.map((line) => line.slice(3).trim()).filter((file) => !file.replaceAll("\\", "/").startsWith("docs/evidence/r25-live-reality/"));
  return { commit: git(["rev-parse", "HEAD"]), dirty: dirtyFiles.length > 0, dirtyFiles };
}

function identityBase(manifestDigest) {
  const state = treeState();
  if (state.dirty && !flags["allow-dirty"]) throw new Error(`CodeForge tree is dirty (${state.dirtyFiles.length} file(s)); commit first or pass --allow-dirty:\n  ${state.dirtyFiles.join("\n  ")}`);
  const fingerprint = environmentFingerprint({ os: `${os.platform()} ${os.release()}`, cpuModel: os.cpus()[0]?.model ?? "unknown", cpus: os.cpus().length, totalMemBytes: os.totalmem(), nodeVersion: process.version, codeforgeCommit: state.commit, protocolDigest: manifestDigest, harnessVersion: R23_HARNESS_VERSION });
  return { protocolVersion: PROTOCOL_VERSION, protocolDigest: manifestDigest, corpusManifestDigest: manifestDigest, codeforgeCommit: state.commit, codeforgeTreeDirty: state.dirty, ...(state.dirty ? { dirtyFiles: state.dirtyFiles } : {}), environmentFingerprint: fingerprint, environment: { os: `${os.platform()} ${os.release()}`, cpuModel: os.cpus()[0]?.model, cpus: os.cpus().length, totalMemGB: Math.round(os.totalmem() / 2 ** 30), node: process.version } };
}

async function loadFrozenCorpus() {
  const gen = spawnSync(process.execPath, [path.join(ROOT, "benchmarks", "r25", "generate-tasks.mjs")], { encoding: "utf8", windowsHide: true });
  if (gen.status !== 0) throw new Error(`r25 corpus generation failed: ${gen.stderr}`);
  if (!fs.existsSync(MANIFEST_PATH)) throw new Error("benchmarks/r25/manifest.json is missing — freeze it first");
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const check = await verifyManifest(TASKS_ROOT, manifest);
  if (!check.ok) throw new Error(`r25 manifest mismatch — frozen tasks may not be edited:\n  ${check.mismatches.join("\n  ")}`);
  if (check.unlisted.length > 0) throw new Error(`tasks on disk but not in the manifest: ${check.unlisted.join(", ")}`);
  const tasks = await loadTaskCorpus(TASKS_ROOT);
  return { manifest, tasks, manifestDigest: sha256(fs.readFileSync(MANIFEST_PATH)) };
}

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

function loadPricing() {
  const dir = path.join(EVIDENCE, "cost");
  const candidates = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => /^pricing-snapshot-.*\.json$/.test(name)).sort() : [];
  const chosen = flags.pricing ?? (candidates.length > 0 ? path.join(dir, candidates[candidates.length - 1]) : undefined);
  if (!chosen) {
    return { snapshot: parsePricingSnapshot({ snapshotId: "r25-fixture", frozenAt: new Date().toISOString(), currency: "USD", equivalents: {}, marketReference: { priceRef: "fixture::reference", rationale: "no pricing snapshot — economics recorded as $0 route unit price only" }, prices: { "fixture::reference": { id: "fixture::reference", inputPerMillionUsd: 3, outputPerMillionUsd: 15, source: "fixture", retrievedAt: new Date().toISOString() } } }), path: "(none)" };
  }
  return { snapshot: parsePricingSnapshot(JSON.parse(fs.readFileSync(chosen, "utf8"))), path: chosen };
}

// ---------------------------------------------------------------------------------------------
// Live route pinning + allowance
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
  if (!modelId.endsWith(":free")) throw new Error(`refusing non-:free model ${modelId}`);
  if (entry.pricing?.prompt !== "0" || entry.pricing?.completion !== "0") throw new Error(`model ${modelId} is not priced $0/$0 in the live catalog — refusing`);
  if (!(entry.supported_parameters ?? []).includes("tools")) throw new Error(`model ${modelId} does not advertise tool support`);
  const twin = catalog.find((model) => model.id === modelId.replace(/:free$/, ""));
  return {
    entry: { id: entry.id, name: entry.name, contextLength: entry.context_length, pricing: entry.pricing, supportedParameters: entry.supported_parameters, checkedAt: new Date().toISOString() },
    paidTwin: twin ? { id: twin.id, pricing: twin.pricing } : undefined,
    freeRecord: createGenericFreeRecord({
      providerId: "openrouter", modelId, displayName: entry.name ?? modelId, contextWindow: entry.context_length,
      capabilities: { text: true, coding: true, toolCalling: true, vision: (entry.architecture?.input_modalities ?? []).includes("image"), structuredOutput: (entry.supported_parameters ?? []).includes("structured_outputs") || (entry.supported_parameters ?? []).includes("response_format"), longContext: (entry.context_length ?? 0) >= 100_000 },
    }),
  };
}

async function openRouterAllowance() {
  const data = (await openRouterJson("/api/v1/auth/key")).data;
  const free = data.free_model_daily_requests ?? {};
  return { limit: free.limit, used: free.used, remaining: free.remaining, usage: data.usage, usageDaily: data.usage_daily, checkedAt: new Date().toISOString() };
}

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const GROQ_FREE_DAILY_TOKENS = 200_000;
let lastGroqQuota;

function quotaFromHeaders(observation) {
  const headers = new Map(observation.headers.map(([k, v]) => [k.toLowerCase(), v]));
  const num = (key) => (headers.has(key) ? Number(headers.get(key)) : undefined);
  return {
    providerId: observation.providerId, status: observation.status,
    requests: { limit: num("x-ratelimit-limit-requests"), remaining: num("x-ratelimit-remaining-requests"), reset: headers.get("x-ratelimit-reset-requests") },
    tokens: { limit: num("x-ratelimit-limit-tokens"), remaining: num("x-ratelimit-remaining-tokens"), reset: headers.get("x-ratelimit-reset-tokens") },
    retryAfter: headers.get("retry-after"), observedAt: new Date(observation.observedAt).toISOString(),
  };
}

function servedCallsOnRoute(providerId, modelId) {
  const calls = [];
  for (const phase of ["dry_run", "pilot", "main"]) {
    const dir = rawDir(phase);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json") || file.startsWith("campaign-")) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
        if (record.identity?.providerId !== providerId) continue;
        if (modelId !== undefined && record.identity?.modelId !== modelId) continue;
        for (const call of record.inference?.calls ?? []) {
          if (!(call.totalTokens > 0)) continue;
          const endedAt = Date.parse(call.endedAt ?? call.startedAt ?? "");
          if (Number.isFinite(endedAt)) calls.push({ endedAt, tokens: call.totalTokens });
        }
      } catch { /* unreadable record — skip */ }
    }
  }
  return calls.sort((a, b) => a.endedAt - b.endedAt);
}

function dailyTokensUsed(providerId, modelId) {
  const today = new Date().toISOString().slice(0, 10);
  return servedCallsOnRoute(providerId, modelId).filter((c) => new Date(c.endedAt).toISOString().startsWith(today)).reduce((sum, c) => sum + c.tokens, 0);
}

function modelledDailyTokenBucket(providerId, modelId, cap) {
  const rate = cap / 86_400_000;
  let level = cap;
  let last;
  for (const call of servedCallsOnRoute(providerId, modelId)) {
    if (last !== undefined) level = Math.min(cap, level + rate * Math.max(0, call.endedAt - last));
    level -= call.tokens;
    last = call.endedAt;
  }
  if (last !== undefined) level = Math.min(cap, level + rate * Math.max(0, Date.now() - last));
  return Math.max(0, Math.round(level));
}

async function pinGroqModel(modelId) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY is not set");
  const catalogRes = await fetch(`${GROQ_BASE_URL}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!catalogRes.ok) throw new Error(`groq /models → HTTP ${catalogRes.status}`);
  const catalog = (await catalogRes.json()).data ?? [];
  const entry = catalog.find((model) => model.id === modelId);
  if (!entry) throw new Error(`model ${modelId} is not in the live Groq catalog`);
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
  if (!probeBody.usage || typeof probeBody.usage.total_tokens !== "number") throw new Error(`model ${modelId} returned no usage payload`);
  const firewall = new ForgeZero();
  const freeRecord = createGenericFreeRecord({ providerId: "groq", modelId, displayName: entry.id, contextWindow: entry.context_window, accessClass: "FREE_ALLOWANCE" });
  firewall.register(freeRecord);
  if (!firewall.eligibleModels().some((model) => model.providerId === "groq" && model.modelId === modelId)) {
    throw new Error(`ForgeZero refuses groq::${modelId}`);
  }
  return {
    entry: { id: entry.id, name: entry.id, contextLength: entry.context_window, ownedBy: entry.owned_by, checkedAt: new Date().toISOString(), pricingVerification: "provider-free-tier-policy + ForgeZero FREE_ALLOWANCE admission + live rate-limit headers", quotaAtPin: lastGroqQuota, toolProbe: { toolCallsEmitted: toolCalls.length, usage: probeBody.usage } },
    paidTwin: { id: `openrouter::${modelId}`, note: "equivalent-cost reference: same model's paid listing on the reference marketplace" },
    freeRecord,
  };
}

async function groqAllowance() {
  const groqModelId = flags.model ?? "openai/gpt-oss-120b";
  if (lastGroqQuota && Date.now() - Date.parse(lastGroqQuota.observedAt) < 120_000) {
    return { limit: lastGroqQuota.requests.limit, used: lastGroqQuota.requests.limit !== undefined && lastGroqQuota.requests.remaining !== undefined ? lastGroqQuota.requests.limit - lastGroqQuota.requests.remaining : undefined, remaining: lastGroqQuota.requests.remaining, remainingTokens: lastGroqQuota.tokens.remaining, dailyTokensUsed: dailyTokensUsed("groq", groqModelId), dailyTokenBucketLevel: modelledDailyTokenBucket("groq", groqModelId, GROQ_FREE_DAILY_TOKENS), source: "x-ratelimit headers (live adapter observation)", checkedAt: new Date().toISOString() };
  }
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY is not set");
  const probe = await fetch(`${GROQ_BASE_URL}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: groqModelId, messages: [{ role: "user", content: "ok" }], max_tokens: 1 }) });
  lastGroqQuota = quotaFromHeaders({ providerId: "groq", status: probe.status, headers: [...probe.headers.entries()], observedAt: Date.now() });
  if (!probe.ok) throw new Error(`groq allowance probe → HTTP ${probe.status}`);
  await probe.json();
  return { limit: lastGroqQuota.requests.limit, used: lastGroqQuota.requests.limit !== undefined && lastGroqQuota.requests.remaining !== undefined ? lastGroqQuota.requests.limit - lastGroqQuota.requests.remaining : undefined, remaining: lastGroqQuota.requests.remaining, remainingTokens: lastGroqQuota.tokens.remaining, dailyTokensUsed: dailyTokensUsed("groq", groqModelId), dailyTokenBucketLevel: modelledDailyTokenBucket("groq", groqModelId, GROQ_FREE_DAILY_TOKENS), source: "x-ratelimit headers (probe)", checkedAt: new Date().toISOString() };
}

const allowance = (providerId) => (providerId === "groq" ? groqAllowance() : openRouterAllowance());

function capacityGate(allowanceData, observedCallsPerRun, providerId, observedRunTokens = []) {
  const sorted = [...observedCallsPerRun].sort((a, b) => a - b);
  const p90 = sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.floor(0.9 * sorted.length))] : 0;
  const needed = Math.ceil(1.15 * Math.max(40, p90));
  const ok = typeof allowanceData.remaining === "number" ? allowanceData.remaining >= needed : true;
  if (providerId !== "groq") return { needed, ok };
  const sortedTokens = [...observedRunTokens].sort((a, b) => a - b);
  const p90Tokens = sortedTokens.length > 0 ? sortedTokens[Math.min(sortedTokens.length - 1, Math.floor(0.9 * sortedTokens.length))] : 0;
  const tokensNeeded = Math.ceil(1.15 * Math.max(60_000, p90Tokens));
  const bucketLevel = allowanceData.dailyTokenBucketLevel ?? Math.max(0, GROQ_FREE_DAILY_TOKENS - (allowanceData.dailyTokensUsed ?? 0));
  const dailyTokensOk = bucketLevel >= tokensNeeded + GROQ_FREE_DAILY_TOKENS * 0.15;
  return { needed, tokensNeeded, ok: ok && dailyTokensOk, dailyTokensOk, dailyTokenBucketLevel: bucketLevel };
}

// ---------------------------------------------------------------------------------------------
// Production-shaped probe gate — never start a round into a saturated upstream.
// ---------------------------------------------------------------------------------------------
const PROBE_GATE_PATH = path.join(EVIDENCE, "supply", "probe-gates.jsonl");
const PROBE_GATE_FRESH_MS = 30 * 60_000;

function probeGateAdapter(providerId) {
  if (providerId === "groq") return createGroqAdapter({ apiKey: process.env.GROQ_API_KEY, timeoutMs: 60_000 });
  if (providerId === "openrouter") return createOpenRouterAdapter({ timeoutMs: 60_000 });
  throw new Error(`probe-gate: no adapter for provider ${providerId}`);
}

function productionShapedRequest(modelId) {
  const fixture = Array.from({ length: 60 }, (_, i) => `export function helper${i}(a, b) {\n  // computes something for case ${i}\n  return (a * ${i}) + b - ${i % 7};\n}\n`).join("\n");
  return {
    model: modelId,
    system: "You are CodeForge, an autonomous software engineering agent.\n\nYou help users with coding tasks by reading files, writing code, and executing commands.\n\nMake the smallest complete change, run verification appropriate to the risk, and stop using tools once the requirements and checks pass. Do not repeat successful reads, edits, or commands without new evidence.\n\nWork methodically and keep explanations concise and evidence-based.",
    messages: [
      { role: "user", content: "Task: `computeTotal` in src/cart.js returns the wrong sign for refunds. Fix it and run `npm test`. Only touch src/cart.js." },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "src/cart.js" }) } }] },
      { role: "tool", content: fixture, toolCallId: "call_1" },
      { role: "user", content: "Continue. Decide the next single tool call." },
    ],
    tools: agentToolDefinitions(),
    maxTokens: 4096,
  };
}

async function runProbeGate(providerId, modelId, n = 2, spacingMs = 8000) {
  const adapter = probeGateAdapter(providerId);
  const request = productionShapedRequest(modelId);
  const probes = [];
  for (let i = 0; i < n; i += 1) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, spacingMs));
    const startedAt = Date.now();
    const probe = { startedAt: new Date(startedAt).toISOString(), served: false, toolCalls: 0, usage: null, failure: null, latencyMs: 0 };
    try {
      for await (const event of adapter.streamChat(request)) {
        if (event.type === "tool_call_completed") probe.toolCalls += 1;
        else if (event.type === "usage") probe.usage = { inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens, totalTokens: event.usage.totalTokens };
        else if (event.type === "error") { probe.failure = { code: event.code, status: event.status ?? null, message: String(event.message).slice(0, 300) }; break; }
        else if (event.type === "finish") probe.served = probe.failure === null;
      }
    } catch (error) {
      probe.failure = { code: error?.code ?? "THROWN", status: error?.status ?? null, message: String(error?.message ?? error).slice(0, 300) };
    }
    probe.latencyMs = Date.now() - startedAt;
    probes.push(probe);
    log(`probe ${i + 1}/${n} ${providerId}::${modelId}: ${probe.served ? `served (${probe.toolCalls} tool call(s), ${probe.latencyMs} ms)` : `FAILED ${probe.failure?.code ?? "?"}${probe.failure?.status ? ` http=${probe.failure.status}` : ""}: ${probe.failure?.message ?? ""}`}`);
  }
  const served = probes.filter((probe) => probe.served).length;
  const gate = { recordedAt: new Date().toISOString(), providerId, modelId, n, served, verdict: served === n ? "open" : "closed", probes };
  fs.mkdirSync(path.dirname(PROBE_GATE_PATH), { recursive: true });
  fs.appendFileSync(PROBE_GATE_PATH, `${JSON.stringify(gate)}\n`);
  log(`probe gate ${providerId}::${modelId}: ${gate.verdict.toUpperCase()} (${served}/${n} served)`);
  return gate;
}

function latestProbeGate(providerId, modelId) {
  if (!fs.existsSync(PROBE_GATE_PATH)) return undefined;
  const lines = fs.readFileSync(PROBE_GATE_PATH, "utf8").split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const gate = JSON.parse(lines[i]);
      if (gate.providerId !== providerId || gate.modelId !== modelId) continue;
      if (Date.now() - Date.parse(gate.recordedAt) > PROBE_GATE_FRESH_MS) return undefined;
      return gate;
    } catch { /* skip unreadable line */ }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Scripted reference model for dry runs (deterministic, $0, test-mode only)
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
  const answer = referenceSummary(task.record.taskId);
  const explorerSummary = task.record.answerKey ? answer : `Relevant module: ${firstPath}`;
  const reviewerVerdict = task.record.answerKey ? JSON.stringify({ verdict: "revision_required", findings: [{ id: "f1", severity: "blocking", category: "correctness", message: "defect present" }], summary: answer }) : JSON.stringify({ verdict: "pass", findings: [], summary: "Change matches the goal and is minimal." });
  const scripts = {
    explorer: [toolTurn("list_files", { path: ".", recursive: false }), toolTurn("read_file", { path: firstPath }), finalTurn(JSON.stringify({ summary: explorerSummary, findings: [], evidence: [{ kind: "file", ref: firstPath, description: "primary file" }] }))],
    planner: [finalTurn(JSON.stringify({ summary: "Single coder change verified by the repository checks", tasks: [{ id: "t1", title: "Apply change", objective: task.record.goal.slice(0, 120), dependencies: [], assignedRole: "coder" }, { id: "t2", title: "Review", objective: "Independent review of the change", dependencies: ["t1"], assignedRole: "reviewer" }], planningIntent: { targetSelection: [`target ${firstPath}`], constraints: ["preserve existing behaviour; smallest change only"], uncertainties: ["assume the repository checks are the acceptance test"], verification: ["run the visible verification commands and the repository tests"], completionEvidence: ["verification passes and the diff is reviewed"] } }))],
    coder: [...coderSteps, finalTurn(answer)],
    reviewer: [toolTurn("read_file", { path: firstPath }), finalTurn(reviewerVerdict)],
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
function selectTasks(tasks, wanted) {
  const chosen = tasks.filter((task) => !wanted || wanted.includes(task.record.taskId));
  if (chosen.length === 0) throw new Error("no tasks selected");
  return chosen;
}

function orderFor(taskIndex, repetition) {
  return (taskIndex + repetition) % 2 === 0 ? "control-first" : "optimized-first";
}

async function runPairs({ phase, tasks, arms, repetitions, modeFlag, model, createProvider, freeRecord, routeListedUnitPrice, pricing, identity, live, providerId = "openrouter" }) {
  assertArmsDifferOnlyInSwitches();
  const scratchRoot = path.join(os.tmpdir(), "codeforge-r25", phase);
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
      const executionMode = task.record.role === "explorer" || task.record.role === "reviewer" ? "single_agent_run" : modeFlag;
      const pairRecords = [];
      for (const armId of sequence) {
        if (!arms.includes(armId)) continue;
        if (live) {
          const allowanceData = await allowance(providerId);
          const gate = capacityGate(allowanceData, observedCalls, providerId, observedRunTokens);
          log(`allowance remaining=${allowanceData.remaining}/${allowanceData.limit} (needed ≥ ${gate.needed})${providerId === "groq" ? `; daily tokens used=${allowanceData.dailyTokensUsed}/${GROQ_FREE_DAILY_TOKENS}` : ""}`);
          if (!gate.ok) {
            logExclusion({ reason: "allowance below the safety margin — pair voided, re-run when quota refills", taskId: task.record.taskId, pairId, runId: null, allowance: allowanceData });
            for (const done of pairRecords) logExclusion({ reason: "sibling arm voided with the pair", taskId: task.record.taskId, pairId, runId: done.identity.runId });
            log("stopping: allowance exhausted");
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
          logExclusion({ reason: `harness_error: ${message.slice(0, 500)}`, taskId: task.record.taskId, pairId, runId: null });
          for (const done of pairRecords) logExclusion({ reason: "sibling arm voided with the pair", taskId: task.record.taskId, pairId, runId: done.identity.runId });
          break;
        }
        const { record, violations } = output;
        if (violations.length > 0) {
          log(`✖ invariant violations on ${record.identity.runId}: ${violations.join("; ")}`);
          record.notes.push(...violations.map((violation) => `INVARIANT VIOLATION: ${violation}`));
          logExclusion({ reason: `invariant violations: ${violations.join("; ")}`, taskId: task.record.taskId, pairId, runId: record.identity.runId });
        }
        writeRecord(phase, record);
        pairRecords.push(record);
        observedCalls.push(record.inference.modelCalls);
        if (typeof record.inference.totalTokens.value === "number") observedRunTokens.push(record.inference.totalTokens.value);
        const tokens = record.inference.totalTokens.value;
        log(`✔ ${record.outcome.classification} · calls=${record.inference.modelCalls} tokens=${tokens ?? "UNKNOWN"} wall=${Math.round(record.time.wallClockMs / 1000)}s verifier=${record.outcome.verifierPassed} authority=${record.outcome.completionAuthority} (${Math.round((Date.now() - startedAt) / 1000)}s)`);
        summary.push({ taskId: task.record.taskId, arm: armId, repetition, classification: record.outcome.classification, modelCalls: record.inference.modelCalls, totalTokens: tokens ?? null, wallClockMs: record.time.wallClockMs, runId: record.identity.runId });
        if (record.outcome.classification === "infrastructure_void") {
          logExclusion({ reason: record.outcome.completionReason, taskId: task.record.taskId, pairId, runId: record.identity.runId, protocolRule: "infrastructure_void — single-arm re-run allowed once" });
        }
        if (live && record.economics.actualCostUsd.value !== undefined && record.economics.actualCostUsd.value > 0) {
          log(`✖ HALT: run ${record.identity.runId} reports actual cost ${record.economics.actualCostUsd.value} > 0`);
          return { campaignId, summary, stopped: "cost" };
        }
      }
    }
  }
  return { campaignId, summary };
}

function writeCampaignSummary(phase, result, extra) {
  const dir = rawDir(phase);
  const file = path.join(dir, `campaign-${result.campaignId}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ campaignId: result.campaignId, phase, recordedAt: new Date().toISOString(), ...extra, stopped: result.stopped ?? null, runs: result.summary }, null, 2)}\n`);
  const verified = result.summary.filter((run) => run.classification === "verified_complete").length;
  log(`campaign ${result.campaignId}: ${result.summary.length} run(s), ${verified} verified → ${path.relative(ROOT, file)}`);
}

// ---------------------------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------------------------
async function modeDryRun() {
  process.env.CODEFORGE_ALLOW_TEST_PROVIDERS = "1";
  const { tasks, manifestDigest } = await loadFrozenCorpus();
  const identity = identityBase(manifestDigest);
  const { snapshot, path: pricingPath } = loadPricing();
  const chosen = selectTasks(tasks, list(flags.tasks));
  const arms = list(flags.arms) ?? ["control", "optimized"];
  const modeFlag = flags.mode === "single" ? "single_agent_run" : "orchestrated";
  log(`dry run: ${chosen.length} task(s) × arms [${arms.join(", ")}] in ${modeFlag} with the scripted reference model; pricing ${pricingPath}`);
  const result = await runPairs({ phase: "dry_run", tasks: chosen, arms, repetitions: 1, modeFlag, model: { providerId: "scripted", modelId: "scripted-free", routeClass: "fixture" }, createProvider: (task) => scriptedReferenceProvider(task), routeListedUnitPrice: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 }, pricing: snapshot, identity, live: false });
  writeCampaignSummary("dry_run", result, { model: "scripted-free", identity, mode: modeFlag });
}

async function modeSnapshotPricing() {
  const catalog = (await openRouterJson("/api/v1/models")).data;
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  const prices = {};
  const equivalents = {};
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
  if (market) {
    prices[`openrouter::${market.id}`] = price(market, "https://openrouter.ai/api/v1/models (live catalog)");
  }
  for (const sub of ["groq::openai/gpt-oss-120b", "groq::openai/gpt-oss-20b", "groq::qwen/qwen3.8-27b"]) {
    const orId = sub.split("::")[1];
    const listing = catalog.find((model) => model.id === orId && model.pricing?.prompt !== "0" && model.pricing?.completion !== "0");
    if (!listing) continue;
    prices[`openrouter::${listing.id}`] = price(listing, "https://openrouter.ai/api/v1/models (live catalog)");
    equivalents[sub] = { priceRef: `openrouter::${listing.id}`, rationale: "same model weights served by the substitute provider; priced at the reference marketplace's paid listing" };
  }
  const snapshot = parsePricingSnapshot({
    snapshotId: `r25-openrouter-${day}`, frozenAt: now, currency: "USD", equivalents,
    marketReference: market ? { priceRef: `openrouter::${market.id}`, rationale: "named reference frontier coding model — a reference, never a saving" } : { priceRef: "openrouter::(none)", rationale: "no market reference found" },
    prices,
  });
  const dir = path.join(EVIDENCE, "cost");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `pricing-snapshot-${day}.json`);
  fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  log(`pricing snapshot ${snapshot.snapshotId}: ${Object.keys(equivalents).length} free routes with paid twins → ${path.relative(ROOT, file)}`);
}

async function modeProbeGate() {
  const providerId = flags.provider ?? "openrouter";
  const models = list(flags.models);
  if (!models || models.length === 0) throw new Error("probe-gate requires --models <id>[,<id>]");
  for (const modelId of models) await runProbeGate(providerId, modelId, Number(flags.n ?? 2), Number(flags["spacing-ms"] ?? 8000));
}

async function liveSetup(modelId, providerId) {
  const { tasks, manifestDigest } = await loadFrozenCorpus();
  const identity = identityBase(manifestDigest);
  const { snapshot, path: pricingPath } = loadPricing();
  if (providerId === "groq") {
    const pin = await pinGroqModel(modelId);
    const allowanceData = await groqAllowance();
    log(`pinned groq::${modelId}: ForgeZero FREE_ALLOWANCE admission + live tool probe, ctx ${pin.entry.contextLength}; quota remaining req=${allowanceData.remaining} tokens=${allowanceData.remainingTokens} (window); daily tokens used=${allowanceData.dailyTokensUsed}/${GROQ_FREE_DAILY_TOKENS}; pricing ${path.relative(ROOT, pricingPath)}`);
    const adapter = createGroqAdapter({ apiKey: process.env.GROQ_API_KEY, timeoutMs: 180_000, onResponse: (observation) => { lastGroqQuota = quotaFromHeaders(observation); } });
    return { tasks, identity, snapshot, pin, allowance: allowanceData, manifestDigest, createProvider: () => adapter, model: { providerId: "groq", modelId, routeClass: "groq_owner_dev_free_allowance" } };
  }
  const pin = await pinFreeModel(modelId);
  const allowanceData = await openRouterAllowance();
  log(`pinned ${modelId}: $0/$0 confirmed, tools advertised, ctx ${pin.entry.contextLength}; paid twin ${pin.paidTwin?.id ?? "none"}; allowance ${allowanceData.remaining}/${allowanceData.limit} remaining; pricing ${path.relative(ROOT, pricingPath)}`);
  const adapter = createOpenRouterAdapter({ timeoutMs: 180_000 });
  return { tasks, identity, snapshot, pin, allowance: allowanceData, manifestDigest, createProvider: () => adapter, model: { providerId: "openrouter", modelId, routeClass: "openrouter_free_deposit_unlocked" } };
}

async function modeLivePairs(phase) {
  const modelId = flags.model;
  const providerId = flags.provider ?? "openrouter";
  if (!modelId) throw new Error(`${phase} requires --model <exact model id>`);
  const gate = latestProbeGate(providerId, modelId) ?? await runProbeGate(providerId, modelId, Number(flags.n ?? 2), Number(flags["spacing-ms"] ?? 8000));
  if (gate.verdict !== "open" && !flags["force-gate"]) {
    throw new Error(`probe gate CLOSED for ${providerId}::${modelId} (${gate.served}/${gate.n} served at ${gate.recordedAt}) — round not started; pass --force-gate to override (recorded)`);
  }
  const setup = await liveSetup(modelId, providerId);
  const chosen = selectTasks(setup.tasks, list(flags.tasks));
  const repetitions = Number(flags.reps ?? 1);
  const modeFlag = flags.mode === "single" ? "single_agent_run" : "orchestrated";
  const arms = list(flags.arms) ?? ["control", "optimized"];
  const result = await runPairs({ phase, tasks: chosen, arms, repetitions, modeFlag, model: setup.model, createProvider: setup.createProvider, freeRecord: setup.pin.freeRecord, routeListedUnitPrice: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 }, pricing: setup.snapshot, identity: setup.identity, live: true, providerId });
  writeCampaignSummary(phase, result, { model: modelId, providerId, pin: setup.pin.entry, paidTwin: setup.pin.paidTwin, allowanceAtStart: setup.allowance, allowanceAtEnd: await allowance(providerId).catch(() => null), identity: setup.identity, mode: modeFlag, repetitions, taskManifestDigest: setup.manifestDigest, probeGate: { recordedAt: gate.recordedAt, verdict: gate.verdict, served: gate.served, n: gate.n, forced: gate.verdict !== "open" } });
}

const modes = {
  "snapshot-pricing": modeSnapshotPricing,
  "dry-run": modeDryRun,
  "probe-gate": modeProbeGate,
  pilot: () => modeLivePairs("pilot"),
  main: () => modeLivePairs("main"),
};

if (!mode || !modes[mode]) {
  console.error(`usage: r25-live-bench.mjs <${Object.keys(modes).join("|")}> [flags]`);
  process.exit(2);
}
try {
  await modes[mode]();
} catch (error) {
  console.error(`[r25] FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`.replace(/sk-or-[A-Za-z0-9_-]+/g, "[REDACTED]").replace(/gsk_[A-Za-z0-9_-]+/g, "[REDACTED]"));
  process.exit(1);
}
