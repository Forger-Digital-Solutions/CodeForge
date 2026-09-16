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
});
