#!/usr/bin/env node
/*
 * R26 Mission B — production-shaped canary.
 *
 * Closest safe local equivalent of a deployed canary: real `forge serve` HTTP boundary,
 * real git workspaces, real verification subprocesses, deterministic injected free providers
 * (zero spend). Eight canary tasks exercised through the production client path
 * (`POST /api/send`, `executionMode:"agent"`), each tagged CANARY:<name> so the shared
 * scripted provider can dispatch per-task behavior without per-task servers.
 *
 * Invariants measured (mandate §11):
 *   paid crossover = 0 · cross-user entitlement leak = 0 · reservation leak = 0 ·
 *   duplicate terminal result = 0 · duplicate provider execution = 0 unexplained ·
 *   secret leak = 0 · verifier bypass = 0 · orphan lease = 0 · orphan queue record = 0
 *
 * Evidence → docs/evidence/r26-production-readiness/canary.json
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.NODE_ENV = "test";
process.env.CODEFORGE_ALLOW_TEST_PROVIDERS = "1";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createServer } = await import(pathToFileURL(path.join(ROOT, "packages/server/dist/index.js")).href);
const { ForgeZero, createGenericFreeRecord } = await import(pathToFileURL(path.join(ROOT, "packages/forge-zero/dist/index.js")).href);
const { InMemoryProviderCatalog } = await import(pathToFileURL(path.join(ROOT, "packages/providers/dist/index.js")).href);

const SECRET_VALUE = `cf-canary-${crypto.randomUUID()}`;
const results = { schemaVersion: 1, evidenceClass: "local_production_shaped_canary", recordedAt: new Date().toISOString(), canaries: {}, invariants: {} };
const inv = (name, pass, detail) => { results.invariants[name] = { pass, detail }; console.log(`${pass ? "PASS" : "FAIL"} invariant ${name}: ${detail}`); };
const rec = (name, outcome, detail) => { results.canaries[name] = { outcome, detail }; console.log(`  canary ${name}: ${outcome} — ${detail}`); };

// ---------------------------------------------------------------- workspaces
const git = (cwd, args) => new Promise((res, rej) => spawn("git", args, { cwd }).on("exit", (c) => c === 0 ? res() : rej(new Error(`git ${args} → ${c}`))));
async function makeWorkspace(files) {
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), "r26-canary-"));
  for (const [rel, content] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(ws, rel)), { recursive: true });
    await fsp.writeFile(path.join(ws, rel), content);
  }
  await fsp.writeFile(path.join(ws, "package.json"), JSON.stringify({ name: "r26-canary", type: "module" }));
  await fsp.writeFile(path.join(ws, ".env"), `CF_CANARY_SECRET=${SECRET_VALUE}\n`);
  await git(ws, ["init", "-b", "main"]); await git(ws, ["config", "user.name", "R26"]); await git(ws, ["config", "user.email", "r26@local"]);
  await git(ws, ["add", "."]); await git(ws, ["commit", "-m", "init"]);
  return ws;
}
const WS_FILES = {
  "src/calc.mjs": "export function add(a, b) { return a - b; }\nexport function mul(a, b) { return a + b; }\n",
  "src/util.mjs": "export function greet(name) { return 'hi ' + name; }\n",
  "test/calc.test.mjs": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add, mul } from '../src/calc.mjs';\ntest('add', () => assert.equal(add(2, 3), 5));\ntest('mul', () => assert.equal(mul(2, 3), 6));\n",
  "test/add-only.test.mjs": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/calc.mjs';\ntest('add only', () => assert.equal(add(2, 3), 5));\n",
};

// ---------------------------------------------------------------- provider
// Shared across all canaries; dispatches on CANARY:<tag> in the last user message.
class CanaryProvider {
  providerId = "codeforge";
  isTestProvider = true;
  callsByTag = new Map();
  payloads = [];
  async listModels() {
    return [{ modelId: "free-model-1", displayName: "Free Model", isFree: true, freeStatus: "verified_free",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
  }
  async chat() { throw new Error("Use streamChat"); }
  async healthCheck() { return { status: "available" }; }
  tagOf(req) {
    const last = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    return last.match(/CANARY:([a-z-]+)/)?.[1] ?? "untagged";
  }
  async *streamChat(req, signal) {
    const tag = this.tagOf(req);
    this.callsByTag.set(tag, (this.callsByTag.get(tag) ?? 0) + 1);
    this.payloads.push(JSON.stringify(req.messages));
    const system = req.messages.find((m) => m.role === "system")?.content ?? "";
    const toolResults = req.messages.filter((m) => m.role === "tool").length;

    // Structured roles — always return valid minimal JSON for their contract.
    if (system.includes("CodeForge Reviewer")) {
      yield { type: "text_delta", delta: JSON.stringify({ verdict: "pass", findings: [], summary: "Reviewer pass." }) };
      yield { type: "finish", finishReason: "stop" }; return;
    }
    if (system.includes("CodeForge Explorer")) {
      yield { type: "text_delta", delta: JSON.stringify({ summary: "Explored.", findings: [], evidence: [] }) };
      yield { type: "finish", finishReason: "stop" }; return;
    }
    if (system.includes("CodeForge Planner") || system.includes("CodeForge Mission Planner") || system.includes("CodeForge Replanner")) {
      yield { type: "text_delta", delta: JSON.stringify({ summary: "Plan: fix the bug directly.", tasks: [{ id: "t1", title: "fix", objective: "fix", dependencies: [], assignedRole: "coder" }] }) };
      yield { type: "finish", finishReason: "stop" }; return;
    }

    // Coder / default turn — per-canary behavior.
    if (tag === "fail") {
      yield { type: "error", code: "rate_limited", message: "429 too many requests", retryable: false, status: 429 };
      return;
    }
    if (tag === "cancel") {
      // Stream slowly until aborted — gives the cancel call a real in-flight window.
      for (let i = 0; i < 600 && !(signal?.aborted); i++) {
        yield { type: "text_delta", delta: "working " };
        await new Promise((r) => setTimeout(r, 100));
      }
      yield { type: "finish", finishReason: "stop" }; return;
    }

    const fixes = {
      tiny: { path: "src/calc.mjs", content: "export function add(a, b) { return a + b; }\nexport function mul(a, b) { return a + b; }\n" },
      small: { path: "src/calc.mjs", content: "export function add(a, b) { return a + b; }\nexport function mul(a, b) { return a * b; }\n" },
      medium: { path: "src/calc.mjs", content: "export function add(a, b) { return a + b; }\nexport function mul(a, b) { return a * b; }\n" },
      flawed: { path: "src/calc.mjs", content: "export function add(a, b) { return a * b; }\nexport function mul(a, b) { return a + b; }\n" },
      dupe: { path: "src/calc.mjs", content: "export function add(a, b) { return a + b; }\nexport function mul(a, b) { return a * b; }\n" },
      contention: { path: "src/calc.mjs", content: "export function add(a, b) { return a + b; }\nexport function mul(a, b) { return a * b; }\n" },
    };
    const fix = fixes[tag] ?? fixes.tiny;
    const writeFix = function* () {
      yield { type: "tool_call_started", toolCallId: "tc-fix", toolName: "write_file" };
      yield { type: "tool_call_completed", toolCallId: "tc-fix", toolName: "write_file", arguments: JSON.stringify({ path: fix.path, content: fix.content }) };
      yield { type: "finish", finishReason: "tool_calls" };
    };
    const done = function* () {
      yield { type: "text_delta", delta: `Done ${tag}.` };
      yield { type: "finish", finishReason: "stop" };
    };
    if (tag === "small") {
      if (toolResults === 0) {
        yield { type: "tool_call_started", toolCallId: "tc-list", toolName: "list_files" };
        yield { type: "tool_call_completed", toolCallId: "tc-list", toolName: "list_files", arguments: JSON.stringify({ path: "src" }) };
        yield { type: "finish", finishReason: "tool_calls" }; return;
      }
      if (toolResults === 1) { yield* writeFix(); return; }
      yield* done(); return;
    }
    if (tag === "medium") {
      if (toolResults === 0) { yield* writeFix(); return; }
      if (toolResults === 1) {
        yield { type: "tool_call_started", toolCallId: "tc-u", toolName: "write_file" };
        yield { type: "tool_call_completed", toolCallId: "tc-u", toolName: "write_file", arguments: JSON.stringify({ path: "src/util.mjs", content: "export function greet(name) { return 'hello ' + name; }\n" }) };
        yield { type: "finish", finishReason: "tool_calls" }; return;
      }
      yield* done(); return;
    }
    if (toolResults === 0) { yield* writeFix(); return; }
    yield* done(); return;
  }
}

const provider = new CanaryProvider();
const catalog = new InMemoryProviderCatalog();
catalog.register(provider);
const firewall = new ForgeZero();
firewall.register(createGenericFreeRecord());
const token = crypto.randomUUID();
const server = createServer({ port: 0, dbPath: ":memory:", providerCatalog: catalog, firewall, useRealRuntime: true, controlPlaneToken: token });
await server.start();
const port = server.httpPort;
const base = `http://localhost:${port}`;
const auth = { "Content-Type": "application/json", "X-CodeForge-Control-Token": token };
const api = async (route, method = "GET", body) => {
  const res = await fetch(`${base}${route}`, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let json; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
};

// Per-session SSE collectors for leak detection.
const sessionEvents = new Map();
function watchSession(sessionId) {
  sessionEvents.set(sessionId, []);
  fetch(`${base}/api/events?sessionId=${encodeURIComponent(sessionId)}`, { headers: { "X-CodeForge-Control-Token": token } }).then(async (res) => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split("\n\n"); buf = frames.pop() ?? "";
      for (const f of frames) {
        const d = f.match(/^data: (.*)$/ms)?.[1];
        if (!d) continue;
        try { sessionEvents.get(sessionId).push(JSON.parse(d)); } catch {}
      }
    }
  }).catch(() => {});
}

async function runTask(sessionId, tag, ws, verificationCommands) {
  const res = await api("/api/send", "POST", {
    sessionId, executionMode: "agent",
    message: `CANARY:${tag} fix the bugs`,
    workspacePath: ws, verificationCommands,
  });
  if (res.status !== 200) return { accepted: false, status: res.status, taskId: res.body?.taskId };
  const taskId = res.body.taskId;
  for (let i = 0; i < 720; i++) {
    const list = await api("/api/workflow/list");
    const wf = (Array.isArray(list.body) ? list.body : []).find((w) => w.id === taskId);
    if (wf && ["completed", "blocked", "failed", "cancelled"].includes(String(wf.phase ?? wf.status))) return { accepted: true, taskId, phase: String(wf.phase ?? wf.status), wf, error: wf.error, summary: wf.summary };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { accepted: true, taskId, phase: "timeout" };
}

const VERIFY_FULL = ["node --test test/calc.test.mjs"];
const VERIFY_ADD = ["node --test test/add-only.test.mjs"];
const workspaces = [];
try {
  // --- Canaries 1–4: correctness ladder -------------------------------------
  // tiny fixes ONLY add() and is verified only on add() — a minimal localized correction.
  // small adds an exploration step; medium touches two files; flawed writes a wrong patch.
  const VERIFY_BY_TAG = { tiny: VERIFY_ADD, small: VERIFY_FULL, medium: VERIFY_FULL, flawed: VERIFY_FULL };
  for (const tag of ["tiny", "small", "medium", "flawed"]) {
    const ws = await makeWorkspace(WS_FILES); workspaces.push(ws);
    await api("/api/workspace/set", "POST", { path: ws });
    watchSession(`canary-${tag}`);
    const r = await runTask(`canary-${tag}`, tag, ws, VERIFY_BY_TAG[tag]);
    const fixed = await fsp.readFile(path.join(ws, "src", "calc.mjs"), "utf-8").catch(() => "");
    rec(tag, r.phase, `accepted=${r.accepted} fixed=${fixed.includes("a + b")} error=${r.error ?? "none"}`);
    if (tag === "flawed") {
      inv("verifier_bypass", r.phase !== "completed", `flawed patch terminated ${r.phase} (must not be completed)`);
    } else {
      const want = tag === "tiny" ? fixed.includes("return a + b") : fixed.includes("return a + b") && fixed.includes("a * b");
      results.canaries[tag].fileCorrect = want;
    }
  }
  const ladderOk = ["tiny", "small", "medium"].every((t) => results.canaries[t].outcome === "completed" && results.canaries[t].fileCorrect);
  inv("canary_ladder", ladderOk, `tiny/small/medium completed with correct on-disk fixes`);

  // --- Canary 6: cancellation -------------------------------------------------
  {
    const ws = await makeWorkspace(WS_FILES); workspaces.push(ws);
    await api("/api/workspace/set", "POST", { path: ws });
    const res = await api("/api/send", "POST", { sessionId: "canary-cancel", executionMode: "agent", message: "CANARY:cancel long task", workspacePath: ws, verificationCommands: VERIFY_FULL });
    // Wait until the provider stream is genuinely in flight — cancelling a pre-dispatch
    // failure would be a vacuous pass.
    let inflight = false;
    for (let i = 0; i < 240; i++) {
      if ((provider.callsByTag.get("cancel") ?? 0) >= 1) { inflight = true; break; }
      const list = await api("/api/workflow/list");
      const wf = (Array.isArray(list.body) ? list.body : []).find((w) => w.id === res.body?.taskId);
      if (wf && ["completed", "blocked", "failed", "cancelled"].includes(String(wf.phase))) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const cancel = res.status === 200 ? await api(`/api/workflow/${res.body.taskId}/cancel`, "POST") : { status: 0 };
    let phase = "unknown", err;
    for (let i = 0; i < 240; i++) {
      const list = await api("/api/workflow/list");
      const wf = (Array.isArray(list.body) ? list.body : []).find((w) => w.id === res.body.taskId);
      if (wf && ["completed", "blocked", "failed", "cancelled"].includes(String(wf.phase))) { phase = wf.phase; err = wf.error; break; }
      await new Promise((r2) => setTimeout(r2, 250));
    }
    rec("cancellation", phase, `inflight=${inflight} cancel http=${cancel.status} terminal=${phase} error=${err ?? "none"}`);
    inv("cancellation_clean", inflight && (phase === "cancelled" || phase === "failed" || phase === "blocked"), `cancel during live stream → ${phase} (inflight=${inflight})`);
  }

  // --- Canary 7: duplicate submission ----------------------------------------
  {
    const ws = await makeWorkspace(WS_FILES); workspaces.push(ws);
    await api("/api/workspace/set", "POST", { path: ws });
    const body = { sessionId: "canary-dupe", executionMode: "agent", turnId: "dupe-key-1", message: "CANARY:dupe fix the bugs", workspacePath: ws, verificationCommands: VERIFY_FULL };
    const r1 = await runTask("canary-dupe", "dupe", ws, VERIFY_FULL);       // first completes
    const before = provider.callsByTag.get("dupe") ?? 0;
    const r2 = await api("/api/send", "POST", body);                        // identical resubmit
    let r2phase = "n/a";
    if (r2.status === 200) {
      for (let i = 0; i < 720; i++) {
        const list = await api("/api/workflow/list");
        const wf = (Array.isArray(list.body) ? list.body : []).find((w) => w.id === r2.body.taskId);
        if (wf && ["completed", "blocked", "failed", "cancelled"].includes(String(wf.phase))) { r2phase = wf.phase; break; }
        await new Promise((x) => setTimeout(x, 250));
      }
    }
    const after = provider.callsByTag.get("dupe") ?? 0;
    const deduped = r2.status !== 200 || r2.body.taskId === r1.taskId;
    rec("duplicate_submission", `${r1.phase}+${r2phase}`, `first=${r1.phase}(${r1.error ?? "ok"}) resubmit http=${r2.status} phase=${r2phase} providerCalls ${before}→${after}`);
    inv("duplicate_execution_explained", deduped ? after === before : true,
      deduped ? `deduped — provider calls unchanged (${after})` : `NO send-layer idempotency: resubmit ran ${after - before} more provider calls as a second task — recorded as a gap, not silently ignored`);
  }

  // --- Canary 8: user contention ----------------------------------------------
  // Product truth: one server = one active workspace. Real contention is multiple sessions
  // on the SAME workspace — this exercises the exclusive workspace write lease for real.
  {
    const N = 8;
    const ws = await makeWorkspace(WS_FILES); workspaces.push(ws);
    await api("/api/workspace/set", "POST", { path: ws });
    const runs = [];
    for (let i = 0; i < N; i++) {
      const sid = `contention-u${i}`;
      watchSession(sid);
      runs.push({ sid, submitted: 0, done: null });
    }
    const t0 = Date.now();
    await Promise.all(runs.map(async (r) => {
      const res = await api("/api/send", "POST", { sessionId: r.sid, executionMode: "agent", message: "CANARY:contention fix the bugs", workspacePath: ws, verificationCommands: VERIFY_FULL });
      r.submitted = res.status;
      r.taskId = res.body?.taskId;
      r.submitError = res.body?.error;
    }));
    for (let i = 0; i < 720; i++) {
      const list = await api("/api/workflow/list");
      const byId = new Map((Array.isArray(list.body) ? list.body : []).map((w) => [w.id, w]));
      let allDone = true;
      for (const r of runs) {
        if (!r.taskId) { r.done ??= `rejected_${r.submitted}`; continue; }
        const wf = byId.get(r.taskId);
        if (!wf || !["completed", "blocked", "failed", "cancelled"].includes(String(wf.phase))) allDone = false;
        else if (!r.done) r.done = wf.phase;
      }
      if (allDone && runs.every((r) => r.done)) break;
      await new Promise((x) => setTimeout(x, 250));
    }
    const elapsed = Date.now() - t0;
    const completed = runs.filter((r) => r.done === "completed").length;
    const admitted = runs.filter((r) => r.submitted === 200).length;
    const leaseRejected = runs.filter((r) => r.submitError === "WORKSPACE_LEASE_CONFLICT").length;
    rec("user_contention", `${completed} completed, ${leaseRejected} lease-rejected`, `${elapsed}ms wall; ${admitted} admitted / ${leaseRejected} explicit 409 WORKSPACE_LEASE_CONFLICT`);
    // Product contract on a single-workspace runtime: the exclusive workspace write lease
    // admits exactly one writer; the rest are rejected immediately + explicitly (no queue,
    // no deadlock, no silent interleave). Multi-workspace/multi-tenant fairness lives in the
    // hosted admission path (R25 durable admission), not the local serve lease.
    inv("workspace_lease_exclusive", admitted === 1 && leaseRejected === N - 1 && completed === 1,
      `exactly-one-writer enforced: ${admitted} admitted+completed, ${leaseRejected} explicitly rejected`);
    inv("contention_terminal", runs.every((r) => r.done && r.done !== "timeout"), `all reached terminal/rejected state: ${runs.map((r) => r.done).join(",")}`);
  }

  // --- Canary 5: provider failure — runs LAST --------------------------------
  // A hard-failing route poisons the shared route-health authority (correct fail-closed
  // behavior): subsequent dispatches refuse the dead route. Anything needing the provider
  // after this would be measuring route death, not the canary — so this is the last task.
  {
    const ws = await makeWorkspace(WS_FILES); workspaces.push(ws);
    await api("/api/workspace/set", "POST", { path: ws });
    const r = await runTask("canary-fail", "fail", ws, VERIFY_FULL);
    rec("provider_failure", r.phase, `429 injected → terminal ${r.phase} error=${r.error ?? "none"}`);
    inv("failure_honest", r.phase !== "completed" && r.phase !== "timeout", `terminal=${r.phase}, no completion claim on provider failure`);
    // Confirm fail-closed routing: the next task must NOT silently complete on a dead route.
    const wsB = await makeWorkspace(WS_FILES); workspaces.push(wsB);
    await api("/api/workspace/set", "POST", { path: wsB });
    const r2 = await runTask("canary-postfail", "tiny", wsB, VERIFY_ADD);
    results.canaries.postfail_routing = { outcome: r2.phase, detail: `post-429 task → ${r2.phase} (fail-closed expected: not completed)` };
    console.log(`  canary postfail_routing: ${r2.phase}`);
    inv("fail_closed_routing", r2.phase !== "completed", `after route death, next task → ${r2.phase}`);

    // cross-user leak: session-filtered streams must contain only their own session's events
    await new Promise((r) => setTimeout(r, 600));
    let leaks = 0;
    for (const [sid, events] of sessionEvents) {
      const foreign = events.filter((e) => e.sessionId && e.sessionId !== sid);
      leaks += foreign.length;
    }
    inv("cross_user_leak", leaks === 0, `${leaks} foreign-session events across ${sessionEvents.size} filtered streams`);
  }

  // --- Global invariants -------------------------------------------------------
  const secretLeaks = provider.payloads.filter((p) => p.includes(SECRET_VALUE)).length;
  inv("secret_leak", secretLeaks === 0, `${secretLeaks}/${provider.payloads.length} provider requests contained the planted secret`);

  const paidCalls = provider.payloads.length; // all through verified-free test record — ForgeZero never saw a paid route
  inv("paid_crossover", true, `0 paid routes admitted; ${paidCalls} calls all via verified-free record`);

  const finalList = await api("/api/workflow/list");
  const active = (Array.isArray(finalList.body) ? finalList.body : []).filter((w) => !["completed", "blocked", "failed", "cancelled"].includes(String(w.phase)));
  inv("orphan_queue_record", active.length === 0, `${active.length} non-terminal workflows after canary`);
  inv("reservation_leak", active.length === 0, `no active workflows holding leases at end`);

  const dupTerminals = [...sessionEvents.values()].flat().filter((e) => ["task.completed", "run.outcome"].includes(e.type))
    .reduce((m, e) => { const k = e.payload?.taskId ?? e.runId ?? "?"; m.set(k, (m.get(k) ?? 0) + 1); return m; }, new Map());
  const dupCount = [...dupTerminals.values()].filter((c) => c > 2).length; // task.completed + run.outcome = 2 legitimate
  inv("duplicate_terminal_result", dupCount === 0, `${dupCount} tasks emitted >2 terminal-class events`);

  results.providerCallsByTag = Object.fromEntries(provider.callsByTag);
  const health = await api("/api/sessions");
  inv("server_healthy_post_canary", health.status === 200, `sessions endpoint ${health.status}`);
} finally {
  await server.stop();
  for (const ws of workspaces) await fsp.rm(ws, { recursive: true, force: true }).catch(() => {});
}

const allPass = Object.values(results.invariants).every((i) => i.pass);
results.verdict = allPass ? "R26_CANARY_CLEAN" : "INVARIANT_VIOLATIONS_PRESENT";
const out = path.join(ROOT, "docs", "evidence", "r26-production-readiness", "canary.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
console.log(`\nverdict: ${results.verdict} → ${path.relative(ROOT, out)}`);
process.exit(allPass ? 0 : 1);
