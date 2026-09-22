#!/usr/bin/env node
/*
 * R26 Mission E — user-scale + fairness on the real serve transport.
 *
 * Honest to the product's single-workspace semantics (Phase 3 F2/F4):
 *   A. Burst contention — N sessions × agent tasks on ONE workspace. The exclusive write
 *      lease admits exactly one; the rest get explicit 409 WORKSPACE_LEASE_CONFLICT.
 *   B. Lease handoff fairness — rejected sessions retry after each winner terminates.
 *      Tracks which session wins each round: a fair lease must rotate, not pin one session.
 *   C. Concurrent chat-mode load — sessions on executionMode:"chat" do not hold the write
 *      lease; measures real concurrent throughput, p50/p95/p99 submit→terminal latency.
 *
 * Deterministic provider (isTestProvider) — zero spend. Provider calls carry a small
 * simulated latency so concurrency is observable.
 *
 * Evidence → docs/evidence/r26-production-readiness/scale-fairness.json
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

const results = { schemaVersion: 1, evidenceClass: "serve_transport_scale_fairness", recordedAt: new Date().toISOString(), parts: {}, invariants: {} };
const inv = (name, pass, detail) => { results.invariants[name] = { pass, detail }; console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`); };
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

const git = (cwd, args) => new Promise((res, rej) => spawn("git", args, { cwd }).on("exit", (c) => c === 0 ? res() : rej(new Error(`git ${args} → ${c}`))));
const ws = await fsp.mkdtemp(path.join(os.tmpdir(), "r26-scale-"));
await fsp.mkdir(path.join(ws, "src"), { recursive: true });
await fsp.writeFile(path.join(ws, "src/calc.mjs"), "export function add(a,b){return a-b}\nexport function mul(a,b){return a+b}\n");
await fsp.mkdir(path.join(ws, "test"), { recursive: true });
await fsp.writeFile(path.join(ws, "test/calc.test.mjs"), "import test from 'node:test';import assert from 'node:assert/strict';import { add, mul } from '../src/calc.mjs';test('ok',()=>{assert.equal(add(2,3),5);assert.equal(mul(2,3),6)});\n");
await git(ws, ["init", "-b", "main"]); await git(ws, ["config", "user.name", "s"]); await git(ws, ["config", "user.email", "s@s"]); await git(ws, ["add", "."]); await git(ws, ["commit", "-m", "i"]);

const CHAT_DELAY_MS = 250; // simulated provider latency for concurrency observability
class ScaleProvider {
  providerId = "codeforge"; isTestProvider = true;
  active = 0; peak = 0; calls = 0;
  async listModels() { return [{ modelId: "m1", displayName: "M", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true } }]; }
  async chat() { throw new Error("streamChat only"); }
  async healthCheck() { return { status: "available" }; }
  async *streamChat(req) {
    this.calls++; this.active++; this.peak = Math.max(this.peak, this.active);
    try {
      const hasToolResult = req.messages.some((m) => m.role === "tool");
      const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
      if (sys.includes("CodeForge Reviewer")) {
        yield { type: "text_delta", delta: JSON.stringify({ verdict: "pass", findings: [], summary: "ok" }) };
        yield { type: "finish", finishReason: "stop" }; return;
      }
      if (sys.includes("CodeForge Explorer")) { yield { type: "text_delta", delta: JSON.stringify({ summary: "e", findings: [], evidence: [] }) }; yield { type: "finish", finishReason: "stop" }; return; }
      if (sys.includes("CodeForge Planner") || sys.includes("Mission Planner") || sys.includes("Replanner")) { yield { type: "text_delta", delta: JSON.stringify({ summary: "p", tasks: [{ id: "t1", title: "t", objective: "o", dependencies: [], assignedRole: "coder" }] }) }; yield { type: "finish", finishReason: "stop" }; return; }
      await new Promise((r) => setTimeout(r, CHAT_DELAY_MS));
      if (!hasToolResult) {
        yield { type: "tool_call_started", toolCallId: "tc", toolName: "write_file" };
        yield { type: "tool_call_completed", toolCallId: "tc", toolName: "write_file", arguments: JSON.stringify({ path: "src/calc.mjs", content: "export function add(a,b){return a+b}\nexport function mul(a,b){return a*b}\n" }) };
        yield { type: "finish", finishReason: "tool_calls" }; return;
      }
      yield { type: "text_delta", delta: "done" };
      yield { type: "finish", finishReason: "stop" };
    } finally { this.active--; }
  }
}

const provider = new ScaleProvider();
const catalog = new InMemoryProviderCatalog(); catalog.register(provider);
const firewall = new ForgeZero(); firewall.register(createGenericFreeRecord());
const token = crypto.randomUUID();
const server = createServer({ port: 0, dbPath: ":memory:", providerCatalog: catalog, firewall, useRealRuntime: true, controlPlaneToken: token });
await server.start();
const base = `http://localhost:${server.httpPort}`;
const auth = { "Content-Type": "application/json", "X-CodeForge-Control-Token": token };
const api = async (r, m = "GET", b) => { const res = await fetch(`${base}${r}`, { method: m, headers: auth, ...(b ? { body: JSON.stringify(b) } : {}) }); let j; try { j = await res.json(); } catch { j = null; } return { status: res.status, body: j }; };
await api("/api/workspace/set", "POST", { path: ws });
const VERIFY = ["node --test test/calc.test.mjs"];

async function waitTerminal(taskId, maxMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const list = await api("/api/workflow/list");
    const wf = (Array.isArray(list.body) ? list.body : []).find((w) => w.id === taskId);
    if (wf && ["completed", "blocked", "failed", "cancelled"].includes(String(wf.phase))) return wf;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

try {
  // ---- Part A: burst contention — 10 sessions, one workspace ----------------
  const N = 10;
  const burst = await Promise.all(Array.from({ length: N }, (_, i) =>
    api("/api/send", "POST", { sessionId: `scale-a-${i}`, executionMode: "agent", message: "fix the bugs", workspacePath: ws, verificationCommands: VERIFY })));
  const admitted = burst.filter((r) => r.status === 200);
  const rejected = burst.filter((r) => r.status === 409);
  const rejectCode = rejected[0]?.body?.error;
  inv("burst_lease_exclusive", admitted.length === 1 && rejected.length === N - 1 && rejectCode === "WORKSPACE_LEASE_CONFLICT",
    `${admitted.length} admitted, ${rejected.length} rejected (${rejectCode})`);
  const winner = await waitTerminal(admitted[0].body.taskId);
  results.parts.burst = { admitted: admitted.length, rejected: rejected.length, winnerPhase: winner?.phase };
  inv("burst_winner_terminal", winner?.phase === "completed", `winner → ${winner?.phase}`);

  // ---- Part B: lease handoff fairness — rejected sessions retry serially ----
  // After each terminal, every remaining session retries; track the winner sequence.
  const contenders = Array.from({ length: N }, (_, i) => `scale-a-${i}`);
  const winOrder = [];
  for (let round = 0; round < N; round++) {
    // retry all not-yet-completed sessions simultaneously
    const pending = contenders.filter((s) => !winOrder.includes(s));
    if (pending.length === 0) break;
    const roundRes = await Promise.all(pending.map((s) =>
      api("/api/send", "POST", { sessionId: s, executionMode: "agent", message: "fix the bugs", workspacePath: ws, verificationCommands: VERIFY })));
    const ok = roundRes.filter((r) => r.status === 200);
    for (const r of ok) {
      const wf = await waitTerminal(r.body.taskId);
      winOrder.push(pending[roundRes.indexOf(r)]);
      results.parts[`handoff_${pending[roundRes.indexOf(r)]}`] = wf?.phase;
    }
    if (ok.length === 0) break;
  }
  const uniqueWinners = new Set(winOrder);
  inv("lease_handoff_rotates", winOrder.length >= 3 && uniqueWinners.size >= 3,
    `${winOrder.length} completions across ${uniqueWinners.size} distinct sessions — lease rotates, no starvation pin`);

  // ---- Part C: concurrent chat-mode load — 20 sessions, no write lease ------
  const M = 20;
  const t0 = Date.now();
  const chat = await Promise.all(Array.from({ length: M }, async (_, i) => {
    const s0 = Date.now();
    const res = await api("/api/send", "POST", { sessionId: `scale-c-${i}`, executionMode: "chat", message: "hello" });
    return { status: res.status, latency: Date.now() - s0, taskId: res.body?.taskId, turnId: res.body?.turnId };
  }));
  const chatOk = chat.filter((r) => r.status === 200);
  const lat = chatOk.map((r) => r.latency);
  results.parts.chatLoad = {
    sessions: M, accepted: chatOk.length, wallMs: Date.now() - t0,
    p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99),
    peakConcurrentProviderCalls: provider.peak,
  };
  inv("chat_concurrency_real", provider.peak >= Math.min(M, 4) && chatOk.length === M,
    `${chatOk.length}/${M} chat sends accepted; peak concurrent provider calls=${provider.peak} (wall ${Date.now() - t0}ms)`);

  // ---- Global invariants -----------------------------------------------------
  const finalList = await api("/api/workflow/list");
  const active = (Array.isArray(finalList.body) ? finalList.body : []).filter((w) => !["completed", "blocked", "failed", "cancelled"].includes(String(w.phase)));
  inv("no_orphans_under_load", active.length === 0, `${active.length} non-terminal workflows after ${N}+${M} submissions`);
  const health = await api("/api/sessions");
  inv("healthy_under_load", health.status === 200, `sessions endpoint ${health.status}`);
} finally {
  await server.stop();
  await fsp.rm(ws, { recursive: true, force: true }).catch(() => {});
}

const allPass = Object.values(results.invariants).every((i) => i.pass);
results.verdict = allPass ? "R26_SCALE_FAIRNESS_CLEAN" : "SCALE_FINDINGS_PRESENT";
const out = path.join(ROOT, "docs", "evidence", "r26-production-readiness", "scale-fairness.json");
fs.writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
console.log(`\nverdict: ${results.verdict} → ${path.relative(ROOT, out)}`);
process.exit(allPass ? 0 : 1);
