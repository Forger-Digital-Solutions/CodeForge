import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { createForgeGreenAdvisor } from "@codeforge/forge-green";
import { InMemoryProviderCatalog, type ChatMessage, type ChatRequest, type ProviderAdapter, type StreamEvent } from "@codeforge/providers";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { createAgentRuntime } from "../src/agent-runtime.js";
import { createModelExecutionAdapter } from "../src/model-execution-adapter.js";

const unusableAssistant = (message: ChatMessage): boolean => message.role === "assistant" && message.content.trim() === "" && (message.toolCalls?.length ?? 0) === 0;

function provider(capture: (request: ChatRequest) => StreamEvent[]): ProviderAdapter {
  return {
    providerId: "history-provider", isTestProvider: true, listModels: async () => [], healthCheck: async () => ({ status: "available" }), chat: async () => { throw new Error("stream only"); },
    streamChat: async function* (request): AsyncIterable<StreamEvent> {
      if (request.messages.some(unusableAssistant)) throw new Error("400 invalid assistant message: must have content or tool calls");
      yield* capture(request);
    },
  };
}

function fleet(adapter: ProviderAdapter) {
  const firewall = new ForgeZero();
  firewall.register(createGenericFreeRecord({ providerId: adapter.providerId, modelId: "history-model" }));
  const catalog = new InMemoryProviderCatalog();
  catalog.register(adapter);
  return { firewall, catalog };
}

describe("R73 provider conversation after cap-starved completion", () => {
  it("projects an old journal without blank assistant entries while retaining partial text and tool pairing", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Inspect the source" },
      { role: "assistant", content: "", toolCalls: [{ id: "read", type: "function", function: { name: "read_file", arguments: '{"path":"source.mjs"}' } }] },
      { role: "tool", content: "", toolCallId: "read" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "  \n\t", toolCalls: [] },
      { role: "assistant", content: '{"verdict":"pass",' },
      { role: "user", content: "Return the complete verdict" },
    ];
    const before = structuredClone(messages);
    const requests: ChatRequest[] = [];
    const adapter = provider((request) => { requests.push(request); return [{ type: "text_delta", delta: "Complete response" }, { type: "finish", finishReason: "stop" }]; });
    const { firewall, catalog } = fleet(adapter);
    const execution = createModelExecutionAdapter(catalog, firewall, createForgeGreenAdvisor({ enabled: true }));
    const modelSelection = { providerId: adapter.providerId, modelId: "history-model" };
    const result = await execution.execute({ modelSelection, messages });
    expect(result.text).toBe("Complete response");
    expect(requests[0]?.messages).toEqual([messages[0], messages[1], messages[2], messages[5], messages[6]]);
    const replay = await execution.execute({ modelSelection, messages: messages.filter((message) => !unusableAssistant(message)) });
    expect(requests).toHaveLength(1);
    expect(replay.optimization?.duplicateSuppressed).toBe(true);
    expect(messages).toEqual(before);
  });

  it.each(["", "  \n\t"])("continues one bounded Coder repair after an empty cap response %j, preserving the edit and forensic records", async (capText) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "r73-empty-history-"));
    await fs.writeFile(path.join(workspace, "source.mjs"), "export const limit = 4;\n");
    await fs.writeFile(path.join(workspace, "source.test.mjs"), "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { limit } from './source.mjs'; test('correct boundary', () => assert.equal(limit, 3));\n");
    const requests: ChatRequest[] = [];
    const toolCalls = [
      { name: "read_file", args: { path: "source.mjs" } },
      { name: "edit_file", args: { path: "source.mjs", oldText: "limit = 4", newText: "limit = 3" } },
      { name: "run_command", args: { command: "node --test source.test.mjs" } },
    ];
    const adapter = provider((request) => {
      const callIndex = requests.length;
      requests.push(request);
      const call = toolCalls[callIndex];
      if (call) return [{ type: "tool_call_completed", toolCallId: `tool-${callIndex}`, toolName: call.name, arguments: JSON.stringify(call.args) }, { type: "finish", finishReason: "tool_calls" }];
      if (callIndex === 3) return [{ type: "text_delta", delta: capText }, { type: "usage", usage: { inputTokens: 100, outputTokens: 4_096, reasoningTokens: 3_900 } }, { type: "finish", finishReason: "length" }];
      return [{ type: "text_delta", delta: "Corrected the source; the actual boundary test passed." }, { type: "finish", finishReason: "stop" }];
    });
    const { firewall, catalog } = fleet(adapter);
    const persistence = createSessionPersistence({ dbPath: ":memory:" });
    const runtime = createAgentRuntime({ sessionId: "history-session", workspacePath: workspace, eventStore: new EventStore(), persistence, firewall, providerCatalog: catalog });
    try {
      const result = await runtime.executeAgentRun({ runId: "history-run", agentId: "coder", role: "coder", goal: "Limit must equal three", workspaceId: "isolated", workspacePath: workspace,
        permissions: { read: true, search: true, write: true, executeCommand: true, network: false }, roleRouting: true,
        executionBudget: { maxModelTurns: 6, maxToolCalls: 8, maxContextTokens: 32_000 } });
      expect(result.status).toBe("completed");
      expect(requests).toHaveLength(5);
      expect(requests.every((request) => request.temperature === 0.7)).toBe(true);
      expect(requests[4]?.messages.some((message) => message.role === "user" && message.content.includes("previous reply was"))).toBe(true);
      expect(requests[4]?.messages.filter((message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0)).toHaveLength(3);
      expect(result.usage.requestCount).toBe(5);
      expect(result.usage.reasoningTokens).toBe(3_900);
      expect(result.toolExecutions.filter((execution) => execution.toolName === "edit_file")).toHaveLength(1);
      expect(result.toolExecutions.find((execution) => execution.toolName === "run_command")?.output).toContain("pass 1");
      expect(await fs.readFile(path.join(workspace, "source.mjs"), "utf8")).toBe("export const limit = 3;\n");
      const journal = (await persistence.getWorkItemsByKind("agent_run_journal"))[0] as unknown as { messages: ChatMessage[]; telemetry: { structuredOutput: { truncationRepairs: number } } };
      expect(journal.messages.some((message) => message.role === "assistant" && message.content === capText && (message.toolCalls?.length ?? 0) === 0)).toBe(true);
      expect(journal.telemetry.structuredOutput.truncationRepairs).toBe(1);
      const turns = await persistence.getWorkItemsByKind("agent_model_turn") as unknown as Array<{ finishReason?: string; reasoningTokens?: number }>;
      expect(turns.some((turn) => turn.finishReason === "length")).toBe(true);
    } finally { await runtime.shutdown(); await persistence.close(); await fs.rm(workspace, { recursive: true, force: true }); }
  });
});
