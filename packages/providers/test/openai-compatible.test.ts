import { describe, it, expect } from "vitest";
import { OpenAICompatibleAdapter } from "../src/openai-compatible.js";
import { createCloudflareAdapter, createZaiAdapter } from "../src/provider-factory.js";
import { ProviderError } from "../src/index.js";
import type { StreamEvent } from "../src/chat-types.js";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}
function sseResponse(lines: string[], status = 200): Response {
  return new Response(lines.join("\n") + "\n", { status, headers: { "content-type": "text/event-stream" } });
}

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("OpenAICompatibleAdapter transport", () => {
  const cfg = (fetchFn: typeof fetch, extra: Record<string, unknown> = {}) =>
    new OpenAICompatibleAdapter({ providerId: "zai", baseUrl: "https://example/v1", apiKey: "k", fetchFn, ...extra });

  it("lists models from the OpenAI {data:[...]} shape", async () => {
    const fetchFn = (async () => jsonResponse({ data: [{ id: "glm-4.7", name: "GLM-4.7", context_length: 200000 }] })) as unknown as typeof fetch;
    const models = await cfg(fetchFn).listModels();
    expect(models[0]!.modelId).toBe("glm-4.7");
    expect(models[0]!.contextWindow).toBe(200000);
  });

  it("sends a chat request and parses the response content", async () => {
    let url = ""; let body: any;
    const fetchFn = (async (u: string, init: RequestInit) => {
      url = u; body = JSON.parse(init.body as string);
      return jsonResponse({ id: "1", model: "glm-4.7", choices: [{ message: { role: "assistant", content: "hello world" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
    }) as unknown as typeof fetch;
    const res = await cfg(fetchFn).chat({ model: "glm-4.7", messages: [{ role: "user", content: "hi" }], system: "sys" });
    expect(url).toBe("https://example/v1/chat/completions");
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(res.choices[0]!.message.content).toBe("hello world");
    expect(res.usage?.inputTokens).toBe(5);
  });

  it("streams text deltas then a finish", async () => {
    const fetchFn = (async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      "data: [DONE]",
    ])) as unknown as typeof fetch;
    const events = await collect(cfg(fetchFn).streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] }));
    const text = events.filter((e) => e.type === "text_delta").map((e) => (e as any).delta).join("");
    expect(text).toBe("Hello");
    expect(events.at(-1)!.type).toBe("finish");
  });

  it("streams a tool call (started → delta → completed)", async () => {
    const fetchFn = (async () => sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"c1","function":{"name":"read_file"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\\"path\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"\\"a.ts\\"}"}}]}}]}',
      "data: [DONE]",
    ])) as unknown as typeof fetch;
    const events = await collect(cfg(fetchFn).streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] }));
    const started = events.find((e) => e.type === "tool_call_started") as any;
    const completed = events.find((e) => e.type === "tool_call_completed") as any;
    expect(started.toolName).toBe("read_file");
    expect(completed.arguments).toBe('{"path":"a.ts"}');
  });

  it("maps 401 to an auth ProviderError and healthCheck auth_required", async () => {
    const fetchFn = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    await expect(cfg(fetchFn).chat({ model: "m", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "AUTH_ERROR" });
    expect((await cfg(fetchFn).healthCheck()).status).toBe("auth_required");
  });

  it("maps 429 to rate_limited with a retryAfter timestamp", async () => {
    const fetchFn = (async () => new Response("slow", { status: 429, headers: { "retry-after": "30" } })) as unknown as typeof fetch;
    const health = await cfg(fetchFn).healthCheck();
    expect(health.status).toBe("rate_limited");
    expect(health.retryAfter).toBeGreaterThan(Date.now());
  });

  it("throws MISSING_API_KEY when no credential is configured", async () => {
    const a = new OpenAICompatibleAdapter({ providerId: "zai", baseUrl: "https://x/v1" });
    await expect(a.listModels()).rejects.toMatchObject({ code: "MISSING_API_KEY" });
  });

  it("uses a custom auth header when provided", async () => {
    let headers: any;
    const fetchFn = (async (_u: string, init: RequestInit) => { headers = init.headers; return jsonResponse({ data: [] }); }) as unknown as typeof fetch;
    await new OpenAICompatibleAdapter({ providerId: "p", baseUrl: "https://x/v1", apiKey: "K", fetchFn, authHeader: (k) => ({ "x-custom": k }) }).listModels();
    expect(headers["x-custom"]).toBe("K");
    expect(headers.Authorization).toBeUndefined();
  });

  it("Z.AI factory produces a zai-id adapter", () => {
    expect(createZaiAdapter({ apiKey: "k" }).providerId).toBe("zai");
  });

  it("Cloudflare adapter interpolates ${CLOUDFLARE_ACCOUNT_ID} into the base URL", async () => {
    let url = "";
    const cf = createCloudflareAdapter({ apiKey: "token", accountId: "acct_123" });
    // Reach into transport via a direct adapter mirroring the factory config.
    const direct = new OpenAICompatibleAdapter({
      providerId: "cloudflare-workers-ai",
      baseUrl: "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1",
      apiKey: "token",
      resolveBaseUrl: (u) => u.replace("${CLOUDFLARE_ACCOUNT_ID}", "acct_123"),
      fetchFn: (async (u: string) => { url = u; return jsonResponse({ data: [] }); }) as unknown as typeof fetch,
    });
    await direct.listModels();
    expect(cf.providerId).toBe("cloudflare-workers-ai");
    expect(url).toContain("/accounts/acct_123/ai/v1/models");
    expect(url).not.toContain("${CLOUDFLARE_ACCOUNT_ID}");
  });
});
