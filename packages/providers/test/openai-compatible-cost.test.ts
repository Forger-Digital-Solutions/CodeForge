import { describe, expect, it } from "vitest";
import { OpenAICompatibleAdapter } from "../src/openai-compatible.js";
import type { StreamEvent } from "../src/chat-types.js";

const request = { model: "fixture-model", messages: [{ role: "user" as const, content: "fixture" }], maxTokens: 16 };
const response = (usage: unknown, stream: boolean): Response => stream
  ? new Response([
      `data: ${JSON.stringify({ model: request.model, choices: [{ delta: { content: "fixture" } }] })}`,
      `data: ${JSON.stringify({ model: request.model, choices: [{ delta: {}, finish_reason: "stop" }], usage })}`,
      "data: [DONE]", "",
    ].join("\n\n"), { headers: { "content-type": "text/event-stream" } })
  : new Response(JSON.stringify({ model: request.model, choices: [{ message: { content: "fixture" }, finish_reason: "stop" }], usage }));
const adapter = (usage: unknown, stream: boolean): OpenAICompatibleAdapter => new OpenAICompatibleAdapter({
  providerId: "fixture-cost", baseUrl: "https://example.com/v1", apiKey: "synthetic-cost-key", requireExactServedModel: true,
  fetchFn: async () => response(usage, stream),
});
async function streamedUsage(usage: unknown) {
  const events: StreamEvent[] = [];
  for await (const event of adapter(usage, true).streamChat(request)) events.push(event);
  const measured = events.find(event => event.type === "usage");
  if (measured?.type !== "usage") throw new Error("Expected usage event");
  return measured.usage;
}

describe("compatible transport reported billing cost", () => {
  it.each([0, 0.0001, 2.25])("preserves a measured cost of %s in chat and SSE", async cost => {
    const usage = { prompt_tokens: 3, completion_tokens: 1, cost };
    expect((await adapter(usage, false).chat(request)).usage?.costUsd).toBe(cost);
    expect((await streamedUsage(usage)).costUsd).toBe(cost);
  });

  it("preserves normalized aliases and uses the larger of two reported costs", async () => {
    const usage = { prompt_tokens: 3, completion_tokens: 1, cost: 0.002, costUsd: 0.003 };
    expect((await adapter(usage, false).chat(request)).usage?.costUsd).toBe(0.003);
    expect((await streamedUsage({ ...usage, cost: undefined })).costUsd).toBe(0.003);
  });

  it("keeps missing cost unknown rather than manufacturing a zero", async () => {
    const usage = { prompt_tokens: 3, completion_tokens: 1 };
    expect((await adapter(usage, false).chat(request)).usage).not.toHaveProperty("costUsd");
    expect(await streamedUsage(usage)).not.toHaveProperty("costUsd");
  });

  it.each([null, -1, "0.01", {}, true])("rejects a present malformed cost %j without exposing it", async cost => {
    const usage = { prompt_tokens: 3, completion_tokens: 1, cost };
    await expect(adapter(usage, false).chat(request)).rejects.toMatchObject({ code: "MALFORMED_USAGE_COST", message: "Provider returned invalid usage cost", retryable: false });
    await expect(streamedUsage(usage)).rejects.toMatchObject({ code: "MALFORMED_USAGE_COST", retryable: false });
  });
});
