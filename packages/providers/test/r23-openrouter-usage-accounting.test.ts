import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRouterAdapter } from "../src/openrouter.js";
import type { CredentialStore } from "../src/index.js";
import type { StreamEvent } from "../src/chat-types.js";

/**
 * R23 measurement instrumentation (M3): the OpenRouter adapter must request usage accounting and
 * surface the provider's cached / reasoning / cost details exactly as reported — present when the
 * provider reports them, ABSENT (never zero-by-default) when it does not. These fields feed the
 * R23 per-call ledger; inventing a value here would corrupt every downstream efficiency metric.
 */

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

function usageOf(events: StreamEvent[]) {
  const usage = events.find((event) => event.type === "usage");
  if (!usage || usage.type !== "usage") throw new Error("no usage event");
  return usage.usage;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("R23 — OpenRouter usage accounting", () => {
  it("opts into usage accounting on every request body (stream and non-stream)", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse([
        JSON.stringify({ id: "r", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }),
        "[DONE]",
      ]))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "r", model: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new OpenRouterAdapter({ credentialStore: fakeCredentials });
    await collect(adapter);
    await adapter.chat({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse((call[1] as RequestInit).body as string) as { usage?: { include?: boolean } };
      expect(body.usage).toEqual({ include: true });
    }
  });

  it("surfaces cached, reasoning and cost details exactly as the provider reported them", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ id: "r", choices: [{ index: 0, delta: { content: "answer" } }] }),
      JSON.stringify({
        id: "r",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 80,
          total_tokens: 1280,
          cost: 0,
          prompt_tokens_details: { cached_tokens: 900 },
          completion_tokens_details: { reasoning_tokens: 32 },
        },
      }),
      "[DONE]",
    ])));
    const usage = usageOf(await collect(new OpenRouterAdapter({ credentialStore: fakeCredentials })));
    expect(usage.inputTokens).toBe(1200);
    expect(usage.outputTokens).toBe(80);
    expect(usage.totalTokens).toBe(1280);
    expect(usage.cachedInputTokens).toBe(900);
    expect(usage.reasoningTokens).toBe(32);
    // A reported $0 is a real measurement (the `:free` route), distinct from "not reported".
    expect(usage.costUsd).toBe(0);
  });

  it("leaves detail fields ABSENT when the provider omits them — never zero by default", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ id: "r", choices: [{ index: 0, delta: { content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }),
      "[DONE]",
    ])));
    const usage = usageOf(await collect(new OpenRouterAdapter({ credentialStore: fakeCredentials })));
    expect(usage.inputTokens).toBe(10);
    expect("cachedInputTokens" in usage).toBe(false);
    expect("reasoningTokens" in usage).toBe(false);
    expect("costUsd" in usage).toBe(false);
  });

  it("drops malformed detail values (negative, NaN, non-numeric) instead of recording them", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({
        id: "r",
        choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: -1, prompt_tokens_details: { cached_tokens: "900" }, completion_tokens_details: { reasoning_tokens: null } },
      }),
      "[DONE]",
    ])));
    const usage = usageOf(await collect(new OpenRouterAdapter({ credentialStore: fakeCredentials })));
    expect("cachedInputTokens" in usage).toBe(false);
    expect("reasoningTokens" in usage).toBe(false);
    expect("costUsd" in usage).toBe(false);
  });

  it("parses the same details on the non-streaming path", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "r", model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55, cost: 0.000123, prompt_tokens_details: { cached_tokens: 40 } },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const response = await new OpenRouterAdapter({ credentialStore: fakeCredentials }).chat({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(response.usage?.cachedInputTokens).toBe(40);
    expect(response.usage?.costUsd).toBe(0.000123);
    expect(response.usage && "reasoningTokens" in response.usage).toBe(false);
  });
});
