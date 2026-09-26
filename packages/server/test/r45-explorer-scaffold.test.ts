import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import {
  type ProviderAdapter,
  type ProviderModel,
  type ChatRequest,
  type ChatResponse,
  type StreamEvent,
  InMemoryProviderCatalog,
} from "@codeforge/providers";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { createAgentRuntime } from "../src/agent-runtime.js";

class DeterministicScriptedProvider implements ProviderAdapter {
  readonly providerId: string;
  readonly isTestProvider = true;
  readonly requests: ChatRequest[] = [];
  private responses: Array<(req: ChatRequest) => AsyncIterable<StreamEvent>>;
  private callCount = 0;

  constructor(providerId: string, responses: Array<(req: ChatRequest) => AsyncIterable<StreamEvent>>) {
    this.providerId = providerId;
    this.responses = responses;
  }

  async listModels(): Promise<ProviderModel[]> {
    return [{
      modelId: "scripted-free",
      displayName: "Scripted Free Model",
      isFree: true,
      freeStatus: "verified_free",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    }];
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("Use streamChat");
  }

  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.requests.push(req);
    const handler = this.responses[this.callCount] ?? this.responses[this.responses.length - 1];
    this.callCount++;
    if (!handler) {
      yield { type: "text_delta", delta: "Default response" };
      yield { type: "finish", finishReason: "stop" };
      return;
    }
    for await (const ev of handler(req)) {
      if (signal?.aborted) return;
      yield ev;
    }
  }

  async healthCheck() {
    return { status: "available" as const };
  }
}

const EXPLORER_PERMISSIONS = { read: true, search: true, write: false, executeCommand: false, network: false };

function toolCall(id: string, name: string, args: Record<string, unknown>): (req: ChatRequest) => AsyncIterable<StreamEvent> {
  return async function* () {
    yield { type: "tool_call_started", toolCallId: id, toolName: name };
    yield { type: "tool_call_completed", toolCallId: id, toolName: name, arguments: JSON.stringify(args) };
    yield { type: "usage", usage: { inputTokens: 40, outputTokens: 15 } };
    yield { type: "finish", finishReason: "tool_calls" };
  };
}

function batchedToolCall(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): (req: ChatRequest) => AsyncIterable<StreamEvent> {
  return async function* () {
    for (const c of calls) {
      yield { type: "tool_call_started", toolCallId: c.id, toolName: c.name };
      yield { type: "tool_call_completed", toolCallId: c.id, toolName: c.name, arguments: JSON.stringify(c.args) };
    }
    yield { type: "usage", usage: { inputTokens: 60, outputTokens: 20 } };
    yield { type: "finish", finishReason: "tool_calls" };
  };
}

function textTurn(text: string): (req: ChatRequest) => AsyncIterable<StreamEvent> {
  return async function* () {
    yield { type: "text_delta", delta: text };
    yield { type: "usage", usage: { inputTokens: 60, outputTokens: 20 } };
    yield { type: "finish", finishReason: "stop" };
  };
}

const EXPLORER_JSON = JSON.stringify({
  summary: "Located the defect surface.",
  findings: [{ id: "f1", severity: "advisory", category: "architecture", message: "normalize drops negative rows" }],
  evidence: [{ kind: "file", ref: "src/normalize.mjs", description: "filter+round implementation" }],
});

describe("R45 — deterministic exploration brief + turn forensics", () => {
  let tmpDir: string;
  let persistence: ReturnType<typeof createSessionPersistence>;
  let eventStore: EventStore;
  let firewall: ForgeZero;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-r45-explorer-"));
    persistence = createSessionPersistence();
    eventStore = new EventStore();
    firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: "test-provider", modelId: "free-model-1" }));
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "tests"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src", "normalize.mjs"),
      "export function normalize(rows) {\n  return rows.filter((r) => r.amount >= 0).map((r) => ({ ...r, amount: Math.round(r.amount) }));\n}\n");
    await fs.writeFile(path.join(tmpDir, "src", "report.mjs"),
      "import { normalize } from './normalize.mjs';\nexport function totals(rows) {\n  const clean = normalize(rows);\n  return { sum: clean.reduce((a, r) => a + r.amount, 0), count: clean.length };\n}\n");
    await fs.writeFile(path.join(tmpDir, "tests", "report.test.mjs"),
      "import assert from 'node:assert';\nimport { totals } from '../src/report.mjs';\nconst r = totals([{ amount: 10 }, { amount: -3 }, { amount: 4.6 }]);\nassert.strictEqual(r.count, 3);\nassert.strictEqual(r.sum, 12);\nconsole.log('report ok');\n");
  });

  afterEach(async () => {
    persistence.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function runtimeFor(provider: ProviderAdapter) {
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    return createAgentRuntime({ sessionId: "test-session", eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: tmpDir });
  }

  it("delivers the orientation packet to the explorer and narrows the turn budget on strong coverage", async () => {
    const provider = new DeterministicScriptedProvider("test-provider", [
      textTurn(EXPLORER_JSON),
    ]);
    const runtime = runtimeFor(provider);
    const result = await runtime.executeAgentRun({
      runId: "run-explore-brief", agentId: "explorer", role: "explorer",
      goal: "The test `node tests/report.test.mjs` fails: totals come out wrong. Find the root cause; the defect is in normalize, not where the symptom appears.",
      workspaceId: "ws-1", workspacePath: tmpDir,
      permissions: EXPLORER_PERMISSIONS,
      structuredOutput: "explorer",
    });

    expect(result.status).toBe("completed");
    expect(provider.requests.length).toBe(1);
    const context = provider.requests[0]!.messages.map((m) => m.content).join("\n");
    expect(context).toContain("Pre-gathered Repository Orientation");
    expect(context).toContain("src/normalize.mjs");
    expect(context).toContain("src/report.mjs");

    const brief = result.contextMetrics?.explorationBrief;
    expect(brief).toBeDefined();
    expect(brief!.candidateFiles).toBeGreaterThanOrEqual(2);
    expect(brief!.symbolRecall.resolved).toBeGreaterThanOrEqual(1);

    const adaptive = result.contextMetrics?.adaptiveTurnBudget;
    expect(adaptive).toBeDefined();
    expect(adaptive!.original).toBe(10);
    expect(adaptive!.applied).toBe(4);
  });

  it("records a per-turn tool trace including batch size and per-call outcomes", async () => {
    const provider = new DeterministicScriptedProvider("test-provider", [
      batchedToolCall([
        { id: "t1", name: "read_file", args: { path: "src/report.mjs" } },
        { id: "t2", name: "read_file", args: { path: "src/normalize.mjs" } },
      ]),
      toolCall("t3", "read_file", { path: "tests/report.test.mjs" }),
      textTurn(EXPLORER_JSON),
    ]);
    const runtime = runtimeFor(provider);
    const result = await runtime.executeAgentRun({
      runId: "run-explore-trace", agentId: "explorer", role: "explorer",
      goal: "Investigate the report totals failure.",
      workspaceId: "ws-1", workspacePath: tmpDir,
      permissions: EXPLORER_PERMISSIONS,
      structuredOutput: "explorer",
    });

    expect(result.status).toBe("completed");
    const trace = result.contextMetrics?.toolTrace;
    expect(trace).toBeDefined();
    expect(trace!.length).toBe(2);
    expect(trace![0]!.turn).toBe(1);
    expect(trace![0]!.batchSize).toBe(2);
    expect(trace![0]!.calls.map((c) => c.target)).toEqual(["src/report.mjs", "src/normalize.mjs"]);
    expect(trace![0]!.calls.every((c) => c.outcome === "success")).toBe(true);
    expect(trace![1]!.batchSize).toBe(1);
    expect(trace![1]!.calls[0]!.target).toBe("tests/report.test.mjs");
  });

  it("keeps the full turn budget when the scaffold finds no coverage", async () => {
    const provider = new DeterministicScriptedProvider("test-provider", [
      textTurn(EXPLORER_JSON),
    ]);
    const runtime = runtimeFor(provider);
    // A goal with no indexable symbols or paths → no orientation packet → no narrowing.
    const result = await runtime.executeAgentRun({
      runId: "run-explore-empty", agentId: "explorer", role: "explorer",
      goal: "Look around.",
      workspaceId: "ws-1", workspacePath: tmpDir,
      permissions: EXPLORER_PERMISSIONS,
      structuredOutput: "explorer",
    });

    expect(result.status).toBe("completed");
    // No narrowing — either the brief did not run at all (no candidates) or it ran weak and
    // the runtime explicitly recorded keeping the full budget.
    const adaptive = result.contextMetrics?.adaptiveTurnBudget;
    if (adaptive !== undefined) {
      expect(adaptive.applied).toBe(adaptive.original);
      expect(adaptive.reason).toContain("weak");
    }
  });
});
