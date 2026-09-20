import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { DEFAULT_EXECUTION_BUDGETS, ERROR_CODES } from "@codeforge/agent";
import { InMemoryProviderCatalog, type ChatRequest, type ChatResponse, type ProviderAdapter, type ProviderModel, type StreamEvent } from "@codeforge/providers";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { createAgentRuntime } from "../src/agent-runtime.js";

/**
 * R21: exhausting a budget is never success.
 *
 * Found by the ForgeGreen A/B harness: `stopReason` was initialised to "completed", so a run
 * whose model was still calling tools when the model-turn budget ran out fell out of the loop
 * and was reported `completed` with the canned summary "Completed the requested work and
 * verification." — for explorers, coders and reviewers alike. The orchestrator then treated an
 * exhausted reviewer's silence as approval. Both are closed here.
 */

type Responder = (req: ChatRequest) => AsyncIterable<StreamEvent>;
class ScriptedProvider implements ProviderAdapter {
  readonly providerId = "test-provider";
  readonly isTestProvider = true;
  requests: ChatRequest[] = [];
  constructor(private readonly responders: Responder[]) {}
  async listModels(): Promise<ProviderModel[]> {
    return [{ modelId: "scripted-free", displayName: "S", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
  }
  async chat(_req: ChatRequest): Promise<ChatResponse> { throw new Error("Use streamChat"); }
  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.requests.push(req);
    const responder = this.responders[Math.min(this.requests.length - 1, this.responders.length - 1)]!;
    for await (const event of responder(req)) { if (signal?.aborted) return; yield event; }
  }
  async healthCheck() { return { status: "available" as const }; }
}
let counter = 0;
const readTurn = (file: string): Responder => {
  const id = `tc-${++counter}`;
  return async function* () {
    yield { type: "tool_call_started", toolCallId: id, toolName: "read_file" };
    yield { type: "tool_call_delta", toolCallId: id, delta: JSON.stringify({ path: file }) };
    yield { type: "tool_call_completed", toolCallId: id, toolName: "read_file", arguments: JSON.stringify({ path: file }) };
    yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20 } };
    yield { type: "finish", finishReason: "tool_calls" };
  };
};
const finalTurn = (text: string): Responder => async function* () {
  yield { type: "text_delta", delta: text };
  yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20 } };
  yield { type: "finish", finishReason: "stop" };
};

describe("R21 agent budget honesty — running out of turns is blocked, never completed", () => {
  let dir: string;
  let persistence: ReturnType<typeof createSessionPersistence>;
  let firewall: ForgeZero;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "r21-budget-"));
    for (let index = 0; index < 40; index += 1) await fs.writeFile(path.join(dir, `f${index}.txt`), `file ${index}\n`, "utf-8");
    persistence = createSessionPersistence();
    firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: "test-provider", modelId: "free-model-1" }));
    counter = 0;
  });
  afterEach(async () => { persistence.close(); await fs.rm(dir, { recursive: true, force: true }); });

  for (const role of ["explorer", "coder", "reviewer", "planner"] as const) {
    it(`[${role}] a model that never stops calling tools ends blocked with AGENT_MODEL_TURN_LIMIT`, async () => {
      const budget = DEFAULT_EXECUTION_BUDGETS[role] ?? DEFAULT_EXECUTION_BUDGETS.default!;
      const provider = new ScriptedProvider(Array.from({ length: budget.maxModelTurns + 5 }, (_, index) => readTurn(`f${index % 40}.txt`)));
      const catalog = new InMemoryProviderCatalog();
      catalog.register(provider);
      const runtime = createAgentRuntime({ sessionId: `r21-budget-${role}`, eventStore: new EventStore(), persistence, firewall, providerCatalog: catalog, workspacePath: dir });
      const result = await runtime.executeAgentRun({ runId: `r21-budget-${role}`, agentId: role, role, goal: "never finish", workspaceId: "ws", workspacePath: dir, permissions: { read: true, search: true, write: role === "coder", executeCommand: false, network: false } });
      expect(provider.requests).toHaveLength(budget.maxModelTurns);
      expect(result.status).toBe("blocked");
      expect(result.stopReason).toBe("budget_exhausted");
      expect(result.error).toBe(ERROR_CODES.AGENT_MODEL_TURN_LIMIT);
      expect(result.summary).toContain("without finishing");
      expect(result.summary).not.toContain("Completed the requested work");
      expect(result.structuredData).toBeUndefined();
    });
  }

  it("a model that finishes on its last allowed turn is still completed (no false blocking)", async () => {
    const budget = DEFAULT_EXECUTION_BUDGETS.explorer!;
    const provider = new ScriptedProvider([...Array.from({ length: budget.maxModelTurns - 1 }, (_, index) => readTurn(`f${index}.txt`)), finalTurn("Exploration summary.")]);
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const runtime = createAgentRuntime({ sessionId: "r21-budget-edge", eventStore: new EventStore(), persistence, firewall, providerCatalog: catalog, workspacePath: dir });
    const result = await runtime.executeAgentRun({ runId: "r21-budget-edge", agentId: "explorer", role: "explorer", goal: "finish exactly at the budget", workspaceId: "ws", workspacePath: dir, permissions: { read: true, search: true, write: false, executeCommand: false, network: false } });
    expect(provider.requests).toHaveLength(budget.maxModelTurns);
    expect(result.status).toBe("completed");
    expect(result.stopReason).toBe("completed");
    expect(result.summary).toBe("Exploration summary.");
  });

  it("the efficiency receipt counts suppressions from the final turn", async () => {
    // Two identical reads: the second is suppressed on the very last turn before the model answers.
    const provider = new ScriptedProvider([readTurn("f1.txt"), readTurn("f1.txt"), finalTurn("done")]);
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const runtime = createAgentRuntime({ sessionId: "r21-receipt", eventStore: new EventStore(), persistence, firewall, providerCatalog: catalog, workspacePath: dir });
    const result = await runtime.executeAgentRun({ runId: "r21-receipt", agentId: "explorer", role: "explorer", goal: "reread", workspaceId: "ws", workspacePath: dir, permissions: { read: true, search: true, write: false, executeCommand: false, network: false } });
    expect(result.status).toBe("completed");
    expect(result.toolExecutions).toHaveLength(1);
    expect(result.contextMetrics?.efficiencyReceipt?.duplicateActionsSuppressed).toBe(1);
  });
});
