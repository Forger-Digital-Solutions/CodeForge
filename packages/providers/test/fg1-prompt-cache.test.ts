import { describe, it, expect } from "vitest";
import { AnthropicAdapter } from "../src/anthropic.js";
import { OpenAICompatibleAdapter } from "../src/openai-compatible.js";
import type { ChatRequest } from "../src/chat-types.js";

function captureFetch(bodyRef: { value?: unknown }, responseBody: unknown) {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    bodyRef.value = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(JSON.stringify(responseBody), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const baseRequest: ChatRequest = {
  model: "claude-sonnet-4-5",
  messages: [{ role: "user", content: "Hello" }],
  system: "You are CodeForge.",
  maxTokens: 128,
};

describe("FG-1A provider prompt-cache capability", () => {
  it("Anthropic reports explicit capability with telemetry for known cache-capable models", () => {
    const adapter = new AnthropicAdapter({ apiKey: "test" });
    const capability = adapter.getPromptCacheCapability("claude-sonnet-4-5");
    expect(capability.mode).toBe("explicit");
    expect(capability.telemetryAvailable).toBe(true);
    expect(capability.minCacheableTokens).toBeGreaterThan(0);
  });

  it("Anthropic fails closed to unsupported for unknown models", () => {
    const adapter = new AnthropicAdapter({ apiKey: "test" });
    expect(adapter.getPromptCacheCapability("totally-unknown-model").mode).toBe("unsupported");
    expect(adapter.getPromptCacheCapability("totally-unknown-model").telemetryAvailable).toBe(false);
  });

  it("Anthropic shapes cache_control onto the stable system + last tool prefix only, preserving ordering", async () => {
    const captured: { value?: unknown } = {};
    const adapter = new AnthropicAdapter({
      apiKey: "test",
      fetchFn: captureFetch(captured, {
        id: "msg-1",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 64, cache_creation_input_tokens: 36 },
      }),
    });
    await adapter.chat({
      ...baseRequest,
      tools: [
        { type: "function", function: { name: "read_file", description: "d1", parameters: { type: "object", properties: {} } } },
        { type: "function", function: { name: "list_files", description: "d2", parameters: { type: "object", properties: {} } } },
      ],
    });
    const body = captured.value as {
      system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
      tools: Array<Record<string, unknown>>;
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system[0]!.text).toBe("You are CodeForge.");
    expect(body.system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools.at(-1)).toMatchObject({ name: "list_files", cache_control: { type: "ephemeral" } });
    expect(body.tools[0]).not.toHaveProperty("cache_control");
    // Message ordering/content is untouched by cache shaping.
    expect(body.messages).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("Anthropic invokes unknown-capability models with the exact legacy request shape (fail closed)", async () => {
    const captured: { value?: unknown } = {};
    const adapter = new AnthropicAdapter({
      apiKey: "test",
      fetchFn: captureFetch(captured, { id: "msg-2", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 10, output_tokens: 2 } }),
    });
    await adapter.chat({ ...baseRequest, model: "unknown-model-x" });
    const body = captured.value as { system: unknown; tools?: Array<Record<string, unknown>> };
    expect(body.system).toBe("You are CodeForge.");
    expect(JSON.stringify(body.system)).not.toContain("cache_control");
  });

  it("Anthropic parses provider cache telemetry from non-streaming responses", async () => {
    const captured: { value?: unknown } = {};
    const adapter = new AnthropicAdapter({
      apiKey: "test",
      fetchFn: captureFetch(captured, {
        id: "msg-3",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 },
      }),
    });
    const response = await adapter.chat(baseRequest);
    expect(response.usage?.cachedInputTokens).toBe(80);
    expect(response.usage?.cacheWriteTokens).toBe(20);
    expect(response.usage?.inputTokens).toBe(100);
  });

  it("Anthropic parses cache telemetry from message_start in streaming and does not invent it when absent", async () => {
    const withTelemetry = new AnthropicAdapter({
      apiKey: "test",
      fetchFn: (async () => new Response(
        [
          'data: {"type":"message_start","message":{"usage":{"input_tokens":200,"cache_read_input_tokens":150,"cache_creation_input_tokens":50}}}',
          'data: {"type":"message_delta","delta":{"type":"text_delta","text":"hi"},"usage":{"output_tokens":7}}',
          'data: {"type":"message_stop"}',
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )) as typeof fetch,
    });
    const events = [];
    for await (const event of withTelemetry.streamChat(baseRequest)) events.push(event);
    const usage = events.find((event) => event.type === "usage");
    expect(usage).toMatchObject({ usage: { inputTokens: 200, outputTokens: 7, cachedInputTokens: 150, cacheWriteTokens: 50 } });

    const withoutTelemetry = new AnthropicAdapter({
      apiKey: "test",
      fetchFn: (async () => new Response(
        [
          'data: {"type":"message_start","message":{"usage":{"input_tokens":200}}}',
          'data: {"type":"message_delta","usage":{"output_tokens":7}}',
          'data: {"type":"message_stop"}',
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )) as typeof fetch,
    });
    const plainEvents = [];
    for await (const event of withoutTelemetry.streamChat(baseRequest)) plainEvents.push(event);
    const plainUsage = plainEvents.find((event) => event.type === "usage") as { usage: { cachedInputTokens?: number } } | undefined;
    expect(plainUsage?.usage.cachedInputTokens).toBeUndefined();
  });

  it("OpenAI-compatible adapters report automatic mode and parse cached_tokens only when reported", () => {
    const adapter = new OpenAICompatibleAdapter({ providerId: "zai", apiKey: "test", baseUrl: "https://example.invalid" });
    const capability = adapter.getPromptCacheCapability("any-model");
    expect(capability.mode).toBe("automatic");
    expect(capability.telemetryAvailable).toBe(true);
    expect(capability.constraints?.join(" ")).toContain("only when the provider reports");
  });
});
