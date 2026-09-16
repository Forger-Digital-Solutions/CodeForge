#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGroqAdapter, InMemoryProviderCatalog } from "@codeforge/providers";
import { ForgeZero } from "@codeforge/forge-zero";
import { NormalizedModelRegistry, verifyAllowanceViaProbe } from "@codeforge/model-registry";
import { ForgeRouter } from "@codeforge/router";
import { CodeForgeServer } from "@codeforge/server";
import { evaluateCompletion } from "@codeforge/workflow";

const MODEL_ID = "openai/gpt-oss-20b";
const startedAt = new Date().toISOString();
const runId = `r5-groq-${crypto.randomUUID()}`;
const evidenceDir = path.resolve("docs/evidence/post-paid-auto-r1");
const evidencePath = path.join(evidenceDir, `${runId}.json`);
const markdownPath = path.join(evidenceDir, `${runId}.md`);
const evidence = {
  schemaVersion: 1,
  runId,
  certification: "CodeForge R5 exact Groq real end-to-end agent loop",
  startedAt,
  verdict: "CODEFORGE_R5_EXTERNAL_CAPACITY_NOT_READY",
  provider: { id: "groq", modelId: MODEL_ID, credentialPresent: Boolean(process.env.GROQ_API_KEY) },
  stages: {},
  checks: [],
  negativeVerification: {},
};

function check(id, passed, detail) {
  evidence.checks.push({ id, passed, detail });
}

function safeError(error) {
  return error instanceof Error ? error.message.slice(0, 240) : "unknown failure";
}

async function requestJson(base, pathname, init = {}) {
  const response = await fetch(`${base}${pathname}`, init);
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${pathname} failed with HTTP ${response.status}`);
  return body;
}

async function connectSse(base, sessionId, lastSeq) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events?sessionId=${encodeURIComponent(sessionId)}&lastSeq=${lastSeq}`, { signal: controller.signal });
  if (!response.ok || !response.body) throw new Error(`SSE connection failed with HTTP ${response.status}`);
  const reader = response.body.getReader();
  const events = [];
  let buffer = "";
  const consume = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += new TextDecoder().decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
          if (!data) continue;
          try {
            const parsed = JSON.parse(data);
            if (typeof parsed.seq === "number") events.push(parsed);
          } catch { }
        }
      }
    } catch { }
  })();
  return {
    events,
    async stop() {
      controller.abort();
      try { await reader.cancel(); } catch { }
      await consume;
    },
  };
}

function failedVerificationGate() {
  return evaluateCompletion({
    plan: {
      id: "negative-plan",
      taskId: "negative-task",
      title: "Negative verification",
      status: "approved",
      revision: 1,
      steps: [{ id: "edit", description: "Edit a file", status: "completed", kind: "edit", targetPath: "src/example.mjs", risk: "moderate", requiresApproval: false }],
      createdAt: startedAt,
      updatedAt: startedAt,
    },
    verification: {
      passed: 0,
      failed: 1,
      skipped: 0,
      durationMs: 1,
      output: "intentional failing verifier",
      exitCode: 1,
      command: "npm.cmd test",
      failures: [{ test: "negative", message: "intentional failure" }],
    },
    analysis: { hasFailures: true, summary: "intentional failure", diagnostics: [], suggestedRepairs: [], isRepairable: false },
    review: {
      approved: true,
      issues: [],
      findings: [],
      diffs: [{ path: "src/example.mjs", changeType: "modified", additions: 1, deletions: 1, diff: "-old\n+new", beforeHash: "before", afterHash: "after" }],
      summary: "diff present",
    },
  });
}

async function main() {
  if (!process.env.GROQ_API_KEY?.trim()) throw new Error("GROQ_API_KEY is not configured");

  const provider = createGroqAdapter({ apiKey: process.env.GROQ_API_KEY, timeoutMs: 90_000 });
  const liveModels = await provider.listModels();
  const exactLive = liveModels.filter((model) => model.modelId === MODEL_ID);
  evidence.provider.liveModelCount = liveModels.length;
  evidence.provider.exactModelListed = exactLive.length === 1;
  check("exact-model-listed", exactLive.length === 1, `Groq live catalog contains ${MODEL_ID}: ${exactLive.length === 1}`);
  if (exactLive.length !== 1) throw new Error(`Groq live catalog did not contain the exact model ${MODEL_ID}`);

  const registry = new NormalizedModelRegistry();
  registry.loadSnapshot();
  let probeTextDeltas = 0;
  let probeFinish = false;
  const qualification = await verifyAllowanceViaProbe(
    registry,
    "groq",
    exactLive.map((model) => ({ modelId: model.modelId, isFree: model.isFree, displayName: model.displayName, contextWindow: model.contextWindow, toolCalling: model.capabilities.toolCalling })),
    async (modelId) => {
      try {
        for await (const event of provider.streamChat({ model: modelId, messages: [{ role: "user", content: "Reply only OK." }], maxTokens: 32 })) {
          if (event.type === "text_delta") probeTextDeltas += 1;
          if (event.type === "finish") probeFinish = true;
        }
        return { ok: probeTextDeltas > 0 && probeFinish };
      } catch {
        return { ok: false };
      }
    },
  );
  evidence.provider.verifiedFreeCount = qualification.verifiedCount;
  evidence.provider.qualificationProbe = { textDeltas: probeTextDeltas, finish: probeFinish, method: "single exact-model live allowance probe" };
  check("free-allowance-qualified", qualification.verifiedCount === 1, `Groq allowance probe verified ${qualification.verifiedCount} exact model route(s)`);
  if (qualification.verifiedCount !== 1) {
    evidence.verdict = "CODEFORGE_R5_EXTERNAL_CAPACITY_NOT_READY";
    throw new Error("Exact Groq route did not pass the live allowance probe");
  }

  const selected = qualification.records.find((record) => record.modelId === MODEL_ID);
  if (!selected) throw new Error("Exact Groq record was not produced by allowance verification");
  const discoveryFirewall = new ForgeZero();
  discoveryFirewall.register(selected);
  const ranked = new ForgeRouter({ firewall: discoveryFirewall }).topVerifiedFree({ taskType: "coding", estimatedContextTokens: 16_000, requiredCapabilities: ["coding", "toolCalling"] }, 5);
  check("exact-free-route-selected", ranked[0]?.model.modelId === MODEL_ID && ranked[0]?.model.providerId === "groq", "ForgeRouter selected only the exact verified Groq route");
  if (ranked[0]?.model.modelId !== MODEL_ID) throw new Error("Exact Groq route was not selected by ForgeRouter");

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeforge-r5-groq-real-loop-"));
  const workspace = path.join(tempRoot, "workspace");
  let server;
  try {
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.mkdir(path.join(workspace, "test"), { recursive: true });
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "codeforge-r5-groq-disposable", private: true, type: "module", scripts: { test: "node --test" } }, null, 2));
    await fs.writeFile(path.join(workspace, "src", "calculator.mjs"), "export function add(a, b) { return a - b; }\n");
    await fs.writeFile(path.join(workspace, "test", "calculator.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/calculator.mjs';\ntest('add returns the sum', () => assert.equal(add(2, 3), 5));\n");

    const firewall = new ForgeZero();
    qualification.records.forEach((record) => firewall.register(record));
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    server = new CodeForgeServer({ port: 0, dbPath: path.join(tempRoot, "sessions.db"), providerCatalog: catalog, firewall, useRealRuntime: true });
    await server.start();
    const base = `http://127.0.0.1:${server.httpPort}`;
    const sessionId = `${runId}-session`;
    evidence.stages.server = { started: true, transport: "HTTP + SSE", persistence: "SQLite", providerCatalog: ["groq"] };
    await requestJson(base, "/api/workspace/set", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: workspace }) });
    const selectedState = await requestJson(base, "/api/model-selection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, providerId: "groq", modelId: MODEL_ID }) });
    check("model-selection-persisted", selectedState.selection?.modelId === MODEL_ID && selectedState.selection?.providerId === "groq", "Exact Groq selection was accepted by the authoritative runtime boundary");

    const sse = await connectSse(base, sessionId, 0);
    const send = await requestJson(base, "/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        executionMode: "agent",
        message: "Fix the calculator bug. Inspect the repository first with list_files using path '.' and read_file using the exact source path, use an exact edit_file change to make add return a + b, then run npm.cmd test. Keep the existing API and test behavior intact. After the final tool call, stop using tools and return a concise text summary of the change and verification result.",
        verificationCommands: ["npm.cmd test"],
      }),
    });
    const taskId = send.taskId;
    const turnId = send.turnId;
    if (!taskId || !turnId) throw new Error("Workflow start did not return taskId/turnId");
    evidence.stages.execution = { taskId, turnId, executionMode: send.executionMode, runtime: send.runtime };
    const steer = await requestJson(base, `/api/workflow/${encodeURIComponent(taskId)}/steer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, steerId: `${runId}-steer`, message: "Preserve the public add function signature while repairing the implementation." }),
    }).catch(() => ({ ok: false }));
    evidence.stages.steering = { accepted: steer.ok === true };
    await sse.stop();
    const firstSseSeq = Math.max(0, ...sse.events.map((event) => event.seq));

    const deadline = Date.now() + 240_000;
    let snapshot;
    const approved = new Set();
    while (Date.now() < deadline) {
      snapshot = await requestJson(base, `/api/sessions/${encodeURIComponent(sessionId)}`);
      for (const approval of snapshot.pendingApprovals ?? []) {
        if (approved.has(approval.approvalId)) continue;
        approved.add(approval.approvalId);
        await requestJson(base, `/api/approvals/${encodeURIComponent(approval.approvalId)}/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "allow_once" }) });
      }
      const turn = (snapshot.turns ?? []).find((candidate) => candidate.id === turnId);
      if (turn && ["completed", "failed", "blocked", "cancelled"].includes(turn.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!snapshot) throw new Error("No durable session snapshot was returned");
    const terminalTurn = snapshot.turns?.find((candidate) => candidate.id === turnId);
    const replay = await connectSse(base, sessionId, firstSseSeq);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await replay.stop();
    const events = snapshot.events ?? [];
    const seqs = events.map((event) => event.seq).filter((seq) => typeof seq === "number");
    const toolEvents = events.filter((event) => ["tool.call_started", "tool.execution_started", "tool.execution_completed", "tool.execution_failed"].includes(event.type));
    const verificationItems = (snapshot.workItems ?? []).filter((item) => item.kind === "run_inspection" || item.kind === "evidence");
    const finalResponse = (snapshot.workItems ?? []).find((item) => item.kind === "agent_final_response" && item.turnId === turnId)
      ?? (snapshot.workItems ?? []).find((item) => typeof item.response === "string" && item.response.length > 0 && (!item.turnId || item.turnId === turnId));
    const changed = await fs.readFile(path.join(workspace, "src", "calculator.mjs"), "utf8");
    const uniqueSeqs = new Set(seqs);
    evidence.stages.persistence = { durableEventCount: events.length, firstSseEventCount: sse.events.length, reconnectEventCount: replay.events.length, maxSeq: Math.max(0, ...seqs), toolEventTypes: [...new Set(toolEvents.map((event) => event.type))], verificationItemKinds: verificationItems.map((item) => item.kind), finalResponseSource: finalResponse?.source };
    evidence.stages.result = { turnStatus: terminalTurn?.status, sessionStatus: snapshot.session?.status, fileChanged: /return a \+ b;/u.test(changed), taskCompleted: events.some((event) => event.type === "task.completed"), forgeVerifyRecorded: verificationItems.some((item) => item.kind === "run_inspection" && Boolean(item.verification)), finalResponsePresent: typeof finalResponse?.response === "string" && finalResponse.response.length > 0 };
    evidence.stages.workItems = (snapshot.workItems ?? []).map((item) => ({ kind: item.kind, turnId: item.turnId, source: item.source, hasResponse: typeof item.response === "string" && item.response.length > 0 }));
    evidence.stages.failures = {
      turnError: typeof terminalTurn?.error === "string" ? terminalTurn.error.slice(0, 240) : undefined,
      failedToolEvents: toolEvents.filter((event) => event.type === "tool.execution_failed").map((event) => ({
        tool: typeof event.payload?.toolName === "string" ? event.payload.toolName : undefined,
        error: typeof event.payload?.error === "string" ? event.payload.error.slice(0, 240) : undefined,
      })),
    };
    check("real-workflow-terminal", terminalTurn?.status === "completed", `durable workflow turn status=${terminalTurn?.status ?? "missing"}`);
    check("real-tool-loop", toolEvents.some((event) => event.type === "tool.execution_completed"), `${toolEvents.length} durable tool events observed`);
    check("real-file-change", /return a \+ b;/u.test(changed), "the disposable repository was changed by the exact Groq agent");
    check("real-verification", verificationItems.some((item) => item.kind === "run_inspection" && Boolean(item.verification)), "ForgeVerify/run inspection evidence persisted");
    check("completion-event", events.some((event) => event.type === "task.completed"), "task.completed was emitted after the completion gate");
    check("durable-final-response", typeof finalResponse?.response === "string" && finalResponse.response.length > 0, "final response is reconstructable from a persisted work item");
    check("sse-reconnect", replay.events.every((event) => typeof event.seq === "number") && new Set(replay.events.map((event) => event.seq)).size === replay.events.length, "reconnect replay contained ordered, non-duplicate durable events");
    check("event-sequence", seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]) && uniqueSeqs.size === seqs.length, "durable events have strictly increasing unique sequence numbers");
    check("steering-boundary", steer.ok === true, `steering endpoint accepted=${steer.ok === true}`);
    check("approval-boundary", approved.size > 0, `${approved.size} real approval request(s) resolved through HTTP`);
  } finally {
    if (server) await server.stop();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  const negative = failedVerificationGate();
  evidence.negativeVerification = { outcome: negative.outcome, blockerCodes: negative.blockers.map((blocker) => blocker.code) };
  check("adversarial-verification-rejection", negative.outcome === "failed" && negative.blockers.some((blocker) => blocker.code === "verification_failed"), "a failing verifier cannot pass the completion gate");
  const allPassed = evidence.checks.every((item) => item.passed);
  evidence.verdict = allPassed ? "CODEFORGE_R5_REAL_AGENT_LOOP_CERTIFIED" : "CODEFORGE_R5_REAL_AGENT_LOOP_BLOCKED";
  if (!allPassed) evidence.blockingReasons = evidence.checks.filter((item) => !item.passed).map((item) => `${item.id}: ${item.detail}`);
}

try {
  await main();
} catch (error) {
  evidence.blockingReasons = [safeError(error)];
}

evidence.completedAt = new Date().toISOString();
await fs.mkdir(path.dirname(evidencePath), { recursive: true });
await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
const failed = evidence.checks.filter((item) => !item.passed);
const markdown = [
  "# CodeForge R5 — Exact Groq Real Agent Loop",
  "",
  `- Run: \`${evidence.runId}\``,
  `- Verdict: **${evidence.verdict}**`,
  `- Started: ${evidence.startedAt}`,
  `- Completed: ${evidence.completedAt}`,
  `- Route: \`groq::${MODEL_ID}\``,
  "",
  "## Evidence",
  "",
  ...evidence.checks.map((item) => `- ${item.passed ? "PASS" : "BLOCKED"} — ${item.id}: ${item.detail}`),
  "",
  "## Safety boundaries",
  "",
  "- Only the exact Groq adapter and exact `openai/gpt-oss-20b` route were constructed.",
  "- The agent edited a disposable synthetic workspace; no repository files were used as the task target.",
  "- No provider response body, credential, or secret was persisted.",
  "- The negative control confirms a failing verifier cannot pass Completion Gate.",
  "",
  ...(failed.length > 0 ? ["## Blocking reasons", "", ...failed.map((item) => `- ${item.id}: ${item.detail}`), ""] : []),
].join("\n");
await fs.writeFile(markdownPath, `${markdown}\n`, "utf8");
console.log(JSON.stringify({ runId: evidence.runId, verdict: evidence.verdict, evidencePath, markdownPath, blockingReasons: evidence.blockingReasons ?? [] }, null, 2));
process.exit(evidence.verdict === "CODEFORGE_R5_REAL_AGENT_LOOP_CERTIFIED" ? 0 : 1);
