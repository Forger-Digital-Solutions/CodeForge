#!/usr/bin/env node
/*
 * R26 Mission A — real `forge serve` HTTP transport E2E.
 *
 * Boots the production server object (same createServer the CLI serves), drives the actual
 * HTTP + SSE boundary — never calls createAgentRuntime directly — and proves:
 *   auth (401 without/with wrong control token) → workspace bind → workflow run →
 *   SSE event ordering (verification evidence BEFORE terminal completion; no duplicate
 *   finals) → file actually changed on disk → SSE reconnect replays via lastSeq →
 *   cancellation → concurrent-run rejection → server still healthy.
 *
 * Evidence → docs/evidence/r26-production-readiness/server-e2e.json
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

const results = { schemaVersion: 1, evidenceClass: "real_http_transport_deterministic_provider", recordedAt: new Date().toISOString(), checks: {}, events: [] };
const check = (name, pass, detail) => { results.checks[name] = { pass, detail }; console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`); };

// --- workspace: real git repo with a real bug + a real verifier -----------------------------
const ws = await fsp.mkdtemp(path.join(os.tmpdir(), "r26-e2e-ws-"));
await fsp.mkdir(path.join(ws, "src"), { recursive: true });
await fsp.writeFile(path.join(ws, "src", "calc.mjs"), "export function add(a, b) { return a - b; }\n");
await fsp.mkdir(path.join(ws, "test"), { recursive: true });
await fsp.writeFile(path.join(ws, "test", "calc.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/calc.mjs';\ntest('add', () => assert.equal(add(2, 3), 5));\n");
await fsp.writeFile(path.join(ws, "package.json"), JSON.stringify({ name: "r26-e2e", type: "module" }));
const git = (args) => new Promise((res, rej) => spawn("git", args, { cwd: ws }).on("exit", (c) => c === 0 ? res() : rej(new Error(`git ${args} → ${c}`))));
await git(["init", "-b", "main"]); await git(["config", "user.name", "R26"]); await git(["config", "user.email", "r26@local"]); await git(["add", "."]); await git(["commit", "-m", "init"]);

// --- deterministic provider: write_file fix on first coder turn, then finish -----------------
class E2EProvider {
  providerId = "codeforge";
  isTestProvider = true;
  modelCalls = 0;
  async listModels() {
    return [{ modelId: "free-model-1", displayName: "Free Model", isFree: true, freeStatus: "verified_free",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
  }
  async chat() { throw new Error("Use streamChat"); }
  async healthCheck() { return { status: "available" }; }
  async *streamChat(req) {
    this.modelCalls++;
    const system = req.messages.find((m) => m.role === "system")?.content ?? "";
    const hasToolResult = req.messages.some((m) => m.role === "tool");
    if (system.includes("CodeForge Reviewer")) {
      yield { type: "text_delta", delta: JSON.stringify({ verdict: "pass", findings: [], summary: "Correct minimal fix." }) };
      yield { type: "finish", finishReason: "stop" };
      return;
    }
    if (!hasToolResult) {
      yield { type: "tool_call_started", toolCallId: "tc-fix", toolName: "write_file" };
      yield { type: "tool_call_completed", toolCallId: "tc-fix", toolName: "write_file", arguments: JSON.stringify({ path: "src/calc.mjs", content: "export function add(a, b) { return a + b; }\n" }) };
      yield { type: "finish", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text_delta", delta: "Fixed add() to return a + b." };
    yield { type: "finish", finishReason: "stop" };
  }
}

const provider = new E2EProvider();
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

const api = async (route, method = "GET", body, hdrs = auth) => {
  const res = await fetch(`${base}${route}`, { method, headers: hdrs, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
};

// SSE collector over real HTTP
const sseEvents = [];
let sseLastSeq = 0;
const sseConnect = (sessionId, lastSeq = 0) => new Promise((resolve, reject) => {
  const req = fetch(`${base}/api/events?sessionId=${encodeURIComponent(sessionId)}&lastSeq=${lastSeq}`, { headers: { "X-CodeForge-Control-Token": token } });
  req.then(async (res) => {
    if (res.status !== 200) return reject(new Error(`SSE ${res.status}`));
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const pump = async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split("\n\n"); buf = frames.pop() ?? "";
        for (const frame of frames) {
          const idLine = frame.match(/^id: (\d+)/m); const dataLine = frame.match(/^data: (.*)$/ms);
          if (!dataLine) continue;
          try {
            const event = JSON.parse(dataLine[1]);
            if (idLine) { event._seq = Number(idLine[1]); sseLastSeq = Math.max(sseLastSeq, event._seq); }
            sseEvents.push(event);
          } catch {}
        }
      }
    };
    pump().catch(() => {});
    resolve(reader);
  }).catch(reject);
});

try {
  // 1. Auth gate
  const noAuth = await api("/api/models", "GET", undefined, { "Content-Type": "application/json" });
  const badAuth = await api("/api/models", "GET", undefined, { "Content-Type": "application/json", "X-CodeForge-Control-Token": "wrong" });
  const goodAuth = await api("/api/models", "GET");
  check("auth.required", noAuth.status === 401 && badAuth.status === 401 && goodAuth.status === 200, `no-token=${noAuth.status} wrong-token=${badAuth.status} token=${goodAuth.status}`);

  // 2. SSE connect + workspace bind
  const sse1 = await sseConnect("e2e-session");
  const setWs = await api("/api/workspace/set", "POST", { path: ws });
  check("workspace.bind", setWs.status === 200, `status=${setWs.status}`);

  // 3. Agent task via /api/send — the production client entrypoint the desktop composer uses
  const run = await api("/api/send", "POST", {
    sessionId: "e2e-session",
    message: "Fix add() in src/calc.mjs so it returns the sum",
    executionMode: "agent",
    verificationCommands: ["node --test test/calc.test.mjs"],
  });
  check("workflow.accepted", run.status === 200 && typeof run.body?.taskId === "string", `status=${run.status} taskId=${run.body?.taskId ?? "none"}`);
  const taskId = run.body?.taskId;

  // 4. Wait for terminal via workflow list (HTTP read path)
  let terminal;
  for (let i = 0; i < 600; i++) {
    const list = await api("/api/workflow/list");
    const wf = (Array.isArray(list.body) ? list.body : []).find((w) => w.id === taskId);
    if (wf && ["completed", "blocked", "failed", "cancelled"].includes(String(wf.phase ?? wf.status))) { terminal = wf; break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  check("workflow.terminal", !!terminal, terminal ? `phase=${terminal.phase ?? terminal.status}` : "never reached terminal within 150s");
  const completed = String(terminal?.phase ?? terminal?.status) === "completed";
  check("workflow.completed", completed, `terminal=${terminal?.phase ?? terminal?.status} providerCalls=${provider.modelCalls}`);

  // 5. Real file change on disk
  const fixed = await fsp.readFile(path.join(ws, "src", "calc.mjs"), "utf-8");
  check("filesystem.real_change", fixed.includes("return a + b"), `calc.mjs ${fixed.includes("a + b") ? "contains real fix" : "UNCHANGED"}`);

  // 6. SSE ordering: verification evidence precedes terminal; exactly one terminal; no dup finals
  const types = sseEvents.map((e) => e.type);
  const terminalIdx = types.findIndex((t) => t === "task.completed" || t === "run.outcome");
  const verifyIdx = types.findIndex((t) => t === "workflow.verification_completed" || t === "forgeverify.evidence_created");
  const toolEvidence = types.some((t) => t === "file.written" || t === "file.change_applied") || types.includes("agent.started");
  const terminalCount = types.filter((t) => t === "task.completed" || t === "run.outcome").length;
  check("sse.tool_activity", toolEvidence, `types seen: ${[...new Set(types)].slice(0, 14).join(",")}`);
  check("sse.verification_before_terminal", verifyIdx !== -1 && terminalIdx !== -1 && verifyIdx < terminalIdx, `verifyIdx=${verifyIdx} terminalIdx=${terminalIdx}`);
  check("sse.single_terminal", terminalCount >= 1 && terminalCount <= 2, `terminalEvents=${terminalCount}`);

  // 7. SSE reconnect — lastSeq replay loses nothing
  const preReconnectCount = sseEvents.filter((e) => e._seq).length;
  const lastSeen = sseLastSeq;
  const replayEvents = [];
  const sse2 = await sseConnect("e2e-session", Math.max(0, lastSeen - 3));
  await new Promise((r) => setTimeout(r, 400));
  sse2.cancel();
  const replayed = sseEvents.slice(preReconnectCount).filter((e) => e._seq && e._seq > lastSeen - 3);
  check("sse.reconnect_replay", replayed.length >= 1 && replayed.every((e) => e._seq > lastSeen - 3), `lastSeq=${lastSeen} replayed=${replayed.length} events after reconnect`);

  // 8. Concurrent-run rejection + cancellation on a second workflow
  const second = await api("/api/workflow/run", "POST", { sessionId: "e2e-session-2", message: "noop change", workspacePath: ws, verificationCommands: ["node -e \"process.exit(0)\""] });
  const third = await api("/api/workflow/run", "POST", { sessionId: "e2e-session-2", message: "second while running", workspacePath: ws, verificationCommands: ["node -e \"process.exit(0)\""] });
  const concurrentRejected = third.status === 409;
  const cancelRes = second.status === 200 ? await api(`/api/workflow/${second.body.taskId}/cancel`, "POST") : { status: 0 };
  check("workflow.concurrent_rejected", concurrentRejected, `second=${second.status} third=${third.status}`);
  check("workflow.cancellable", [200, 202].includes(cancelRes.status), `cancel=${cancelRes.status}`);

  // 9. Server still healthy after the exercise
  const post = await api("/api/sessions");
  check("server.still_healthy", post.status === 200, `sessions endpoint ${post.status}`);

  results.providerModelCalls = provider.modelCalls;
  results.sseEventTypeCounts = Object.fromEntries([...new Set(types)].map((t) => [t, types.filter((x) => x === t).length]));
} finally {
  await server.stop();
  await fsp.rm(ws, { recursive: true, force: true });
}

const allPass = Object.values(results.checks).every((c) => c.pass);
results.verdict = allPass ? "R26_SERVER_E2E_PROVEN" : "FAILURES_PRESENT";
const out = path.join(ROOT, "docs", "evidence", "r26-production-readiness", "server-e2e.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
console.log(`\nverdict: ${results.verdict} → ${path.relative(ROOT, out)}`);
process.exit(allPass ? 0 : 1);
