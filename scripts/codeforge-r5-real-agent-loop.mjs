#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  createOpenRouterAdapter,
  InMemoryProviderCatalog,
} from "@codeforge/providers";
import {
  NormalizedModelRegistry,
  discoverAndVerifyFree,
} from "@codeforge/model-registry";
import { ForgeZero } from "@codeforge/forge-zero";
import { ForgeRouter } from "@codeforge/router";
import { CodeForgeServer } from "@codeforge/server";
import { evaluateCompletion } from "@codeforge/workflow";

const reportPath = path.resolve("docs/codeforge-real-agent-loop-r5-certification.json");
const markdownPath = path.resolve("docs/codeforge-real-agent-loop-r5-certification-report.md");
const startedAt = new Date().toISOString();
const evidence = {
  certification: "CodeForge R5 real end-to-end coding agent loop",
  startedAt,
  verdict: "CODEFORGE_R5_REAL_AGENT_LOOP_BLOCKED",
  provider: {},
  stages: {},
  checks: [],
  negativeVerification: {},
};

function check(id, passed, detail) {
  evidence.checks.push({ id, passed, detail });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(base, pathname, init = {}) {
  const response = await fetch(`${base}${pathname}`, init);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 1_000) }; }
  if (!response.ok) {
    const error = new Error(`${init.method ?? "GET"} ${pathname} failed with ${response.status}: ${JSON.stringify(body)}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function connectSse(base, sessionId, lastSeq) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events?sessionId=${encodeURIComponent(sessionId)}&lastSeq=${lastSeq}`, { signal: controller.signal });
  if (!response.ok || !response.body) throw new Error(`SSE connection failed with ${response.status}`);
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
      steps: [{
        id: "edit",
        description: "Edit a file",
        status: "completed",
        kind: "edit",
        targetPath: "src/example.mjs",
        risk: "moderate",
        requiresApproval: false,
      }],
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
      command: "npm test",
      failures: [{ test: "negative", message: "intentional failure" }],
    },
    analysis: {
      hasFailures: true,
      summary: "intentional failure",
      diagnostics: [],
      suggestedRepairs: [],
      isRepairable: false,
    },
    review: {
      approved: true,
      issues: [],
      findings: [],
      diffs: [{
        path: "src/example.mjs",
        changeType: "modified",
        additions: 1,
        deletions: 1,
        diff: "-old\n+new",
        beforeHash: "before",
        afterHash: "after",
      }],
      summary: "diff present",
    },
  });
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured");

  const provider = createOpenRouterAdapter({ timeoutMs: 90_000 });
  const liveModels = await provider.listModels();
  const registry = new NormalizedModelRegistry();
  registry.loadSnapshot();
  const { records, verifiedCount } = discoverAndVerifyFree(
    registry,
    provider.providerId,
    liveModels.map((model) => ({
      modelId: model.modelId,
      displayName: model.displayName,
      isFree: model.isFree,
      contextWindow: model.contextWindow,
      toolCalling: model.capabilities.toolCalling,
      vision: model.capabilities.vision,
    })),
  );
  const discoveryFirewall = new ForgeZero();
  records.forEach((record) => discoveryFirewall.register(record));
  const ranked = new ForgeRouter({ firewall: discoveryFirewall }).topVerifiedFree(
    { taskType: "coding", estimatedContextTokens: 16_000, requiredCapabilities: ["coding", "toolCalling"] },
    20,
  );
  const preferred = records.find((record) => /north-mini-code/i.test(record.modelId));
  const selected = preferred ?? ranked[0]?.model;
  if (!selected) throw new Error(`No verified-free OpenRouter coding/tool route found among ${liveModels.length} live models`);
  evidence.provider = {
    id: provider.providerId,
    liveModelCount: liveModels.length,
    verifiedFreeCount: verifiedCount,
    selectedModel: `${selected.providerId}::${selected.modelId}`,
    selectedAccessClass: selected.accessClass,
    selectedTier: selected.tier,
  };
  check("live-free-provider-discovery", verifiedCount > 0, `${verifiedCount} verified-free models discovered from the live provider catalog`);
  check("free-route-selected", selected.freeStatus === "verified_free" && selected.costProfile?.isFree === true, "selected route is ForgeZero verified-free and $0");

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeforge-r5-real-loop-"));
  const workspace = path.join(tempRoot, "workspace");
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.mkdir(path.join(workspace, "test"), { recursive: true });
  await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({
    name: "codeforge-r5-disposable",
    private: true,
    type: "module",
    scripts: { test: "node --test" },
  }, null, 2));
  await fs.writeFile(path.join(workspace, "src", "calculator.mjs"), "export function add(a, b) { return a - b; }\n");
  await fs.writeFile(path.join(workspace, "test", "calculator.test.mjs"), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from '../src/calculator.mjs';",
    "test('add returns the sum', () => assert.equal(add(2, 3), 5));",
    "",
  ].join("\n"));

  const firewall = new ForgeZero();
  records.forEach((record) => firewall.register(record));
  const catalog = new InMemoryProviderCatalog();
  catalog.register(provider);
  const server = new CodeForgeServer({
    port: 0,
    dbPath: path.join(tempRoot, "sessions.db"),
    providerCatalog: catalog,
    firewall,
    useRealRuntime: true,
  });
  try {
    await server.start();
    const base = `http://127.0.0.1:${server.httpPort}`;
    const sessionId = `r5-${crypto.randomUUID()}`;
    evidence.stages.server = { started: true, transport: "HTTP + SSE", persistence: "SQLite" };
    await requestJson(base, "/api/workspace/set", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: workspace }) });
    await requestJson(base, "/api/model-selection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, providerId: selected.providerId, modelId: selected.modelId }) });
    const selectedState = await requestJson(base, `/api/model-selection?sessionId=${encodeURIComponent(sessionId)}`);
    check("model-selection-persisted", selectedState.modelId === selected.modelId && selectedState.providerId === selected.providerId, "HTTP model selection round-tripped from durable runtime state");

    const sse = await connectSse(base, sessionId, 0);
    const send = await requestJson(base, "/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        executionMode: "agent",
        message: "Fix the calculator bug. Inspect the repository first with list_files/read_file, use an exact edit_file change to make add return a + b, then run npm test. Keep the existing API and test behavior intact.",
        verificationCommands: ["npm test"],
      }),
    });
    const taskId = send.taskId;
    const turnId = send.turnId;
    if (!taskId || !turnId) throw new Error(`Workflow start did not return taskId/turnId: ${JSON.stringify(send)}`);
    evidence.stages.execution = { taskId, turnId, executionMode: send.executionMode, runtime: send.runtime };
    const steer = await requestJson(base, `/api/workflow/${encodeURIComponent(taskId)}/steer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, steerId: `r5-steer-${taskId}`, message: "Preserve the public add function signature while repairing the implementation." }),
    }).catch((error) => ({ status: error.status ?? 0, error: error.message }));
    evidence.stages.steering = steer;
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
        await requestJson(base, `/api/approvals/${encodeURIComponent(approval.approvalId)}/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: "allow_once" }),
        });
      }
      const turn = (snapshot.turns ?? []).find((candidate) => candidate.id === turnId);
      if (turn && ["completed", "failed", "blocked", "cancelled"].includes(turn.status)) break;
      await sleep(500);
    }
    if (!snapshot) throw new Error("No durable session snapshot was returned");
    const terminalTurn = snapshot.turns?.find((candidate) => candidate.id === turnId);
    const replay = await connectSse(base, sessionId, firstSseSeq);
    await sleep(500);
    await replay.stop();
    const events = snapshot.events ?? [];
    const seqs = events.map((event) => event.seq).filter((seq) => typeof seq === "number");
    const uniqueSeqs = new Set(seqs);
    const toolEvents = events.filter((event) => ["tool.call_started", "tool.execution_started", "tool.execution_completed", "tool.execution_failed"].includes(event.type));
    const verificationItems = (snapshot.workItems ?? []).filter((item) => item.kind === "run_inspection" || item.kind === "evidence");
    const finalResponse = (snapshot.workItems ?? []).find((item) => item.kind === "agent_final_response" && item.turnId === turnId);
    const changed = await fs.readFile(path.join(workspace, "src", "calculator.mjs"), "utf8");
    evidence.stages.persistence = {
      durableEventCount: events.length,
      firstSseEventCount: sse.events.length,
      reconnectEventCount: replay.events.length,
      maxSeq: Math.max(0, ...seqs),
      toolEventTypes: [...new Set(toolEvents.map((event) => event.type))],
      verificationItemKinds: verificationItems.map((item) => item.kind),
      finalResponseSource: finalResponse?.source,
    };
    evidence.stages.result = {
      turnStatus: terminalTurn?.status,
      sessionStatus: snapshot.session?.status,
      fileContent: changed,
      finalResponse: finalResponse?.response,
      taskCompleted: events.some((event) => event.type === "task.completed"),
      forgeVerifyRecorded: verificationItems.some((item) => item.kind === "run_inspection" && Boolean(item.verification)),
    };
    check("real-workflow-terminal", terminalTurn?.status === "completed", `durable workflow turn status=${terminalTurn?.status ?? "missing"}`);
    check("real-tool-loop", toolEvents.some((event) => event.type === "tool.execution_completed"), `${toolEvents.length} durable tool events observed`);
    check("real-file-change", /return a \+ b/u.test(changed), "the disposable repository was changed by the agent");
    check("real-verification", verificationItems.some((item) => item.kind === "run_inspection" && Boolean(item.verification)), "ForgeVerify/run inspection evidence persisted");
    check("completion-event", events.some((event) => event.type === "task.completed"), "task.completed was emitted after the workflow completion gate");
    check("durable-final-response", typeof finalResponse?.response === "string" && finalResponse.response.length > 0, "final response is reconstructable from a persisted work item");
    check("sse-reconnect", replay.events.every((event) => typeof event.seq === "number") && new Set(replay.events.map((event) => event.seq)).size === replay.events.length, "reconnect replay contained ordered, non-duplicate durable events");
    check("event-sequence", seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]) && uniqueSeqs.size === seqs.length, "durable events have strictly increasing unique sequence numbers");
    check("steering-boundary", steer.ok === true, `steering endpoint accepted=${steer.ok === true}`);
    check("approval-boundary", approved.size > 0, `${approved.size} real approval request(s) resolved through HTTP`);
  } finally {
    await server.stop();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  const negative = failedVerificationGate();
  evidence.negativeVerification = {
    outcome: negative.outcome,
    blockerCodes: negative.blockers.map((blocker) => blocker.code),
  };
  check("adversarial-verification-rejection", negative.outcome === "failed" && negative.blockers.some((blocker) => blocker.code === "verification_failed"), "a failing verifier cannot pass the completion gate");

  const allPassed = evidence.checks.every((item) => item.passed);
  evidence.verdict = allPassed ? "CODEFORGE_R5_REAL_AGENT_LOOP_CERTIFIED" : "CODEFORGE_R5_REAL_AGENT_LOOP_BLOCKED";
  if (!allPassed) {
    evidence.blockingReasons = evidence.checks.filter((item) => !item.passed).map((item) => `${item.id}: ${item.detail}`);
  }
}

try {
  await main();
} catch (error) {
  evidence.blockingReasons = [error instanceof Error ? error.message : String(error)];
}

evidence.completedAt = new Date().toISOString();
await fs.writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`);
const failed = evidence.checks.filter((item) => !item.passed);
const markdown = [
  "# CodeForge R5 — Real End-to-End Agent Loop Certification",
  "",
  `- Verdict: **${evidence.verdict}**`,
  `- Started: ${evidence.startedAt}`,
  `- Completed: ${evidence.completedAt}`,
  `- Provider: ${evidence.provider.selectedModel ?? "not reached"}`,
  "",
  "## Evidence",
  "",
  ...evidence.checks.map((item) => `- ${item.passed ? "PASS" : "BLOCKED"} — ${item.id}: ${item.detail}`),
  "",
  "## Durable trace",
  "",
  `- Provider discovery: ${evidence.provider.liveModelCount ?? "n/a"} live models, ${evidence.provider.verifiedFreeCount ?? "n/a"} verified-free models.`,
  `- Selected route: ${evidence.provider.selectedModel ?? "n/a"}.`,
  `- Durable event count: ${evidence.stages.persistence?.durableEventCount ?? "n/a"}.`,
  `- Tool event types: ${(evidence.stages.persistence?.toolEventTypes ?? []).join(", ") || "none"}.`,
  `- Verification records: ${(evidence.stages.persistence?.verificationItemKinds ?? []).join(", ") || "none"}.`,
  `- Persisted final response source: ${evidence.stages.persistence?.finalResponseSource ?? "none"}.`,
  "",
  "## Negative control",
  "",
  `- Failing verification gate outcome: ${evidence.negativeVerification.outcome ?? "not reached"}.`,
  `- Blockers: ${(evidence.negativeVerification.blockerCodes ?? []).join(", ") || "none"}.`,
  "",
  ...(failed.length > 0 ? ["## Blocking reasons", "", ...failed.map((item) => `- ${item.id}: ${item.detail}`), ""] : []),
].join("\n");
await fs.writeFile(markdownPath, `${markdown}\n`);
console.log(JSON.stringify({ verdict: evidence.verdict, reportPath, markdownPath, blockingReasons: evidence.blockingReasons ?? [] }, null, 2));
process.exit(evidence.verdict === "CODEFORGE_R5_REAL_AGENT_LOOP_CERTIFIED" ? 0 : 1);
