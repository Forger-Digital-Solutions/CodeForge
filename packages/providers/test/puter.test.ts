import { describe, expect, it, vi } from "vitest";
import { PuterSdkAdapter, type PuterSdkClient } from "../src/puter.js";
import type { ChatRequest, StreamEvent } from "../src/chat-types.js";

const request: ChatRequest = { model: "candidate:free", system: "Review a public fixture", messages: [{ role: "user", content: "Inspect the fixture" }],
  tools: [{ type: "function", function: { name: "read_file", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } } } } }], toolChoice: "required", maxTokens: 500 };

async function* chunks(values: unknown[]): AsyncIterable<unknown> { yield* values; }

function harness(values: unknown[] = []) {
  let owner = "user-a";
  const sdk: PuterSdkClient = { ai: { listModels: vi.fn(async () => []), chat: vi.fn(async () => chunks(values)) },
    auth: { getUser: vi.fn(async () => ({ uuid: "account-one" })), getMonthlyUsage: vi.fn(async () => ({ allowanceInfo: { remaining: 100 } })) } };
  const adapter = new PuterSdkAdapter({ sdk, ownerUserId: owner, currentUserId: () => owner, isTestProvider: true, timeoutMs: 50 });
  return { sdk, adapter, switchOwner: () => { owner = "user-b"; } };
}

async function events(adapter: PuterSdkAdapter): Promise<StreamEvent[]> {
  const result: StreamEvent[] = [];
  for await (const event of adapter.streamChat(request)) result.push(event);
  return result;
}

describe("Puter supported SDK transport without Free admission", () => {
  it("keeps catalog prices and free suffixes outside automatic billing admission", async () => {
    const h = harness();
    h.sdk.ai.listModels = vi.fn(async () => [{ id: "candidate:free", context: 64000, supports_tools: true, cost: { input: 0, output: 0 } }]);
    expect(await h.adapter.listModels()).toMatchObject([{ modelId: "candidate:free", isFree: false, freeStatus: "unknown", capabilities: { toolCalling: true, coding: false } }]);
    expect(h.adapter.canRoute()).toBe(false);
    expect(await h.adapter.accountObservation()).toEqual({ user: { uuid: "account-one" }, monthlyUsage: { allowanceInfo: { remaining: 100 } } });
    expect(h.sdk.ai.chat).not.toHaveBeenCalled();
  });

  it("maps normalized SDK messages, tool history and measured usage", async () => {
    const h = harness();
    h.sdk.ai.chat = vi.fn(async () => ({ model: "served-model", message: { content: null, tool_calls: [{ id: "call-one", type: "function", function: { name: "read_file", arguments: '{"path":"src/example.ts"}' } }] },
      finish_reason: "tool_calls", usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 } }));
    const response = await h.adapter.chat({ ...request, messages: [{ role: "tool", content: "fixture", toolCallId: "prior-call" }] });
    expect(response).toMatchObject({ model: "served-model", choices: [{ message: { content: "", toolCalls: [{ id: "call-one" }] }, finishReason: "tool_calls" }], usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 } });
    expect(h.sdk.ai.chat).toHaveBeenCalledWith([{ role: "system", content: request.system }, { role: "tool", content: "fixture", tool_call_id: "prior-call" }],
      expect.objectContaining({ normalize: true, stream: false, model: request.model, toolChoice: "required", max_tokens: 500, tools: request.tools }));
  });

  it("normalizes streamed tools and completes only after the documented final usage chunk", async () => {
    const h = harness([{ type: "reasoning", reasoning: "not emitted" }, { type: "tool_use", id: "call-one", name: "read_file", input: { path: "src/example.ts" } },
      { type: "usage", usage: { input_tokens: 10, output_tokens: 5 } }]);
    expect(await events(h.adapter)).toEqual([{ type: "tool_call_started", toolCallId: "call-one", toolName: "read_file" },
      { type: "tool_call_completed", toolCallId: "call-one", toolName: "read_file", arguments: '{"path":"src/example.ts"}' },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } }, { type: "finish", finishReason: "tool_calls" }]);
  });

  it("rejects truncated and empty streams without manufacturing completion", async () => {
    for (const values of [[], [{ type: "text", text: "partial" }]]) {
      const result = await events(harness(values).adapter);
      expect(result.some(event => event.type === "finish")).toBe(false);
      expect(result.at(-1)?.type).toBe("error");
    }
  });

  it("classifies in-band account quota errors and never leaks their sensitive message", async () => {
    const h = harness([{ type: "text", text: "partial" }, { type: "error", code: "too_many_requests", message: "fixture-secret-and-prompt" }]);
    const result = await events(h.adapter);
    expect(result.at(-1)).toMatchObject({ type: "error", code: "too_many_requests", status: 429, rateLimitScope: "provider", retryable: true });
    expect(JSON.stringify(result)).not.toContain("fixture-secret-and-prompt");
    expect(result.some(event => event.type === "finish")).toBe(false);
  });

  it("rejects duplicate tool calls and unsupported response shapes", async () => {
    const tool = { type: "tool_use", id: "call-one", name: "read_file", input: {} };
    expect((await events(harness([tool, tool]).adapter)).at(-1)).toMatchObject({ type: "error", code: "PUTER_OUTPUT_INVALID" });
    const h = harness();
    h.sdk.ai.chat = vi.fn(async () => ({ message: { content: "" }, finish_reason: "stop" }));
    await expect(h.adapter.chat(request)).rejects.toThrow("PUTER_EMPTY_RESPONSE");
  });

  it("refuses other owners and already cancelled requests before dispatch", async () => {
    const h = harness();
    h.switchOwner();
    expect((await events(h.adapter)).at(-1)).toMatchObject({ type: "error", code: "PUTER_OWNER_CHANGED" });
    expect(h.sdk.ai.chat).not.toHaveBeenCalled();
    const active = harness();
    const controller = new AbortController(); controller.abort();
    const result: StreamEvent[] = [];
    for await (const event of active.adapter.streamChat(request, controller.signal)) result.push(event);
    expect(result).toMatchObject([{ type: "error", code: "PUTER_CANCELLED" }]);
    expect(active.sdk.ai.chat).not.toHaveBeenCalled();
  });

  it("bounds stalled streams and recognizes revoked account observations", async () => {
    const h = harness();
    h.sdk.ai.chat = vi.fn(async () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }));
    expect((await events(h.adapter)).at(-1)).toMatchObject({ type: "error", code: "PUTER_TIMEOUT", retryable: true });
    h.sdk.auth.getUser = vi.fn(async () => { throw { code: "invalid_token", message: "fixture-token" }; });
    expect(await h.adapter.healthCheck()).toEqual({ status: "auth_required", error: "invalid_token" });
  });
});
