import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRouterAdapter } from "../src/openrouter.js";
import type { CredentialStore } from "../src/index.js";
import type { StreamEvent } from "../src/chat-types.js";

const fakeCredentials: CredentialStore = {
  get: () => "test-key",
  set: () => {},
  delete: () => {},
  has: () => true,
};

function sseResponse(lines: string[]): Response {
  const body = lines.map((line) => `data: ${line}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function collect(adapter: OpenRouterAdapter): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of adapter.streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] })) events.push(event);
  return events;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpenRouterAdapter — in-band stream failures are never silent", () => {
  it("surfaces an upstream error object sent after the 200 stream started as an error event", async () => {
    // Found during R5 free-route qualification: an in-band `error` chunk was skipped as a chunk
    // without choices, so a failed route produced an empty "stop" that looked like a model answer
    // (no failover, and qualification scored the silence as the model's inability to edit).
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ id: "r", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }),
      JSON.stringify({ id: "r", error: { code: 502, message: "Provider returned error" }, choices: [{ index: 0, delta: {}, finish_reason: "error" }] }),
      "[DONE]",
    ])));
    const events = await collect(new OpenRouterAdapter({ credentialStore: fakeCredentials }));
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error && error.type === "error" ? error.code : "").toBe("502");
    expect(error && error.type === "error" ? error.retryable : false).toBe(true);
    expect(error && error.type === "error" ? error.message : "").toContain("Provider returned error");
    expect(events.some((e) => e.type === "finish")).toBe(false);
  });

  it("rejects a 200 stream with no usable choices instead of reporting a clean finish", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ id: "r", choices: [] }),
      "[DONE]",
    ])));
    const events = await collect(new OpenRouterAdapter({ credentialStore: fakeCredentials }));
    const error = events.find((event) => event.type === "error");
    expect(error && error.type === "error" ? error.code : "").toBe("EMPTY_COMPLETION");
    expect(error && error.type === "error" ? error.message : "").toContain("no usable completion choices");
    expect(events.some((event) => event.type === "finish")).toBe(false);
  });

  it("reports the upstream finish reason instead of an unconditional stop", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ id: "r", choices: [{ index: 0, delta: { content: "partial" } }] }),
      JSON.stringify({ id: "r", choices: [{ index: 0, delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 5, completion_tokens: 400, total_tokens: 405 } }),
      "[DONE]",
    ])));
    const events = await collect(new OpenRouterAdapter({ credentialStore: fakeCredentials }));
    const finish = events.find((e) => e.type === "finish");
    expect(finish && finish.type === "finish" ? finish.finishReason : "").toBe("length");
    expect(events.some((e) => e.type === "text_delta" && e.delta === "partial")).toBe(true);
  });

  it("still ends a clean answer with stop", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ id: "r", choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] }),
      "[DONE]",
    ])));
    const events = await collect(new OpenRouterAdapter({ credentialStore: fakeCredentials }));
    const finish = events.find((e) => e.type === "finish");
    expect(finish && finish.type === "finish" ? finish.finishReason : "").toBe("stop");
  });

  it("does not convert a connection/stream interruption after partial output into a clean finish", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ id: "r", choices: [{ index: 0, delta: { content: "partial" } }] }),
    ])));
    const events = await collect(new OpenRouterAdapter({ credentialStore: fakeCredentials }));
    const error = events.find((event) => event.type === "error");
    expect(error && error.type === "error" ? error.code : "").toBe("STREAM_INTERRUPTED");
    expect(events.some((event) => event.type === "finish")).toBe(false);
  });
});

describe("R48 — parallel tool-call stream assembly", () => {
  it("keeps interleaved parallel tool calls separated by their provider index", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ id: "r", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "search_files", arguments: "{\"query" } }] } }] }),
      JSON.stringify({ id: "r", choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "read_file", arguments: "{\"path" } }] } }] }),
      JSON.stringify({ id: "r", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\":\"auth\"}" } }] } }] }),
      JSON.stringify({ id: "r", choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: "\":\"src/a.ts\"}" } }] } }] }),
      JSON.stringify({ id: "r", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 } }),
      "[DONE]",
    ])));
    const events = await collect(new OpenRouterAdapter({ credentialStore: fakeCredentials }));
    const completed = events.filter((e) => e.type === "tool_call_completed") as Array<Extract<StreamEvent, { type: "tool_call_completed" }>>;
    expect(completed).toHaveLength(2);
    const byId = new Map(completed.map((e) => [e.toolCallId, e]));
    expect(byId.get("call_a")?.arguments).toBe('{"query":"auth"}');
    expect(byId.get("call_b")?.toolName).toBe("read_file");
    expect(byId.get("call_b")?.arguments).toBe('{"path":"src/a.ts"}');
  });
});

describe("R48 — stream served-model identity", () => {
  it("carries the upstream-reported model on the finish event", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ id: "r", model: "deepseek/deepseek-v4.1-flash", choices: [{ index: 0, delta: { content: "ok" } }] }),
      JSON.stringify({ id: "r", model: "deepseek/deepseek-v4.1-flash", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      "[DONE]",
    ])));
    const events = await collect(new OpenRouterAdapter({ credentialStore: fakeCredentials }));
    const finish = events.find((e) => e.type === "finish");
    expect(finish).toMatchObject({ type: "finish", finishReason: "stop", model: "deepseek/deepseek-v4.1-flash" });
  });

  it("leaves finish.model absent — honest unverified — when the upstream never reports it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ id: "r", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }),
      "[DONE]",
    ])));
    const events = await collect(new OpenRouterAdapter({ credentialStore: fakeCredentials }));
    const finish = events.find((e) => e.type === "finish");
    expect(finish).toMatchObject({ type: "finish", finishReason: "stop" });
    expect(finish && finish.type === "finish" ? finish.model : "sentinel").toBeUndefined();
  });
});
