import { describe, it, expect } from "vitest";
import { OpenAICompatibleAdapter } from "../src/openai-compatible.js";
import { createGroqAdapter } from "../src/provider-factory.js";
import type { StreamEvent } from "../src/chat-types.js";

/**
 * R23 failure taxonomy (§13): an OpenAI-compatible host that fails AFTER its 200 response reports
 * the failure as an in-band `data: {"error":{...}}` frame. Before this suite existed the adapter
 * silently dropped that frame and reported a generic STREAM_INTERRUPTED — the dominant Groq
 * free-tier failure mode in the R23 evidence carried no provider message at all.
 */
function sseResponse(lines: string[], status = 200, trailingNewline = true): Response {
  return new Response(lines.join("\n") + (trailingNewline ? "\n" : ""), { status, headers: { "content-type": "text/event-stream" } });
}

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const adapter = (fetchFn: typeof fetch) => new OpenAICompatibleAdapter({ providerId: "groq", baseUrl: "https://example/v1", apiKey: "k-secret-123", fetchFn });
const req = { model: "m", messages: [{ role: "user" as const, content: "hi" }] };

describe("OpenAICompatibleAdapter in-band stream errors", () => {
  it("surfaces a rate-limit error frame as RATE_LIMITED with the provider message", async () => {
    const fetchFn = (async () => sseResponse([
      'data: {"error":{"message":"Rate limit reached for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Used 7900, Requested 3300. Please try again in 24.75s.","type":"tokens","code":"rate_limit_exceeded"}}',
    ])) as unknown as typeof fetch;
    const events = await collect(adapter(fetchFn).streamChat(req));
    const error = events.at(-1) as Extract<StreamEvent, { type: "error" }>;
    expect(error.type).toBe("error");
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.retryable).toBe(true);
    expect(error.status).toBe(429);
    expect(error.message).toContain("tokens per minute (TPM)");
    expect(error.message).toContain("after HTTP 200");
  });

  it("surfaces a Groq x_groq error frame and never leaks the credential", async () => {
    const fetchFn = (async () => sseResponse([
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
      'data: {"x_groq":{"error":{"message":"over capacity, key k-secret-123 throttled","type":"internal_server_error"}}}',
    ])) as unknown as typeof fetch;
    const events = await collect(adapter(fetchFn).streamChat(req));
    const error = events.at(-1) as Extract<StreamEvent, { type: "error" }>;
    expect(error.type).toBe("error");
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.retryable).toBe(true);
    expect(error.status).toBe(500);
    expect(error.message).not.toContain("k-secret-123");
    expect(error.message).toContain("over capacity");
  });

  it("classifies numeric error codes without message matching (403 → AUTH_ERROR, not retryable)", async () => {
    const fetchFn = (async () => sseResponse(['data: {"error":{"message":"forbidden","code":403}}'])) as unknown as typeof fetch;
    const events = await collect(adapter(fetchFn).streamChat(req));
    const error = events.at(-1) as Extract<StreamEvent, { type: "error" }>;
    expect(error.code).toBe("AUTH_ERROR");
    expect(error.retryable).toBe(false);
    expect(error.status).toBe(403);
  });

  it("treats finish_reason=error as a provider error, not a completed answer", async () => {
    const fetchFn = (async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"error"}]}',
      "data: [DONE]",
    ])) as unknown as typeof fetch;
    const events = await collect(adapter(fetchFn).streamChat(req));
    expect(events.some((e) => e.type === "finish")).toBe(false);
    expect((events.at(-1) as Extract<StreamEvent, { type: "error" }>).code).toBe("PROVIDER_ERROR");
  });

  it("accepts a terminal finish_reason without the [DONE] trailer as complete", async () => {
    const fetchFn = (async () => sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"c1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a\\"}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}',
    ])) as unknown as typeof fetch;
    const events = await collect(adapter(fetchFn).streamChat(req));
    const completed = events.find((e) => e.type === "tool_call_completed") as Extract<StreamEvent, { type: "tool_call_completed" }>;
    expect(completed.arguments).toBe('{"path":"a"}');
    expect(events.some((e) => e.type === "usage")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "finish", finishReason: "tool_calls" });
  });

  it("passes the real finish_reason through (length is a truncation, not a stop)", async () => {
    const fetchFn = (async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"x"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
      "data: [DONE]",
    ])) as unknown as typeof fetch;
    const events = await collect(adapter(fetchFn).streamChat(req));
    expect(events.at(-1)).toEqual({ type: "finish", finishReason: "length" });
  });

  it("reads a final frame that has no trailing newline", async () => {
    const fetchFn = (async () => sseResponse(['data: {"choices":[{"delta":{"content":"hi"}}]}', "data: [DONE]"], 200, false)) as unknown as typeof fetch;
    const events = await collect(adapter(fetchFn).streamChat(req));
    expect(events.at(-1)!.type).toBe("finish");
  });

  it("carries wire diagnostics on a genuinely interrupted stream", async () => {
    const fetchFn = (async () => sseResponse(['data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}'])) as unknown as typeof fetch;
    await expect(collect(adapter(fetchFn).streamChat(req))).rejects.toMatchObject({
      code: "STREAM_INTERRUPTED",
      retryable: true,
      status: 200,
      message: expect.stringMatching(/HTTP 200, \d+ byte\(s\), 1 frame\(s\), no terminal finish_reason/),
    });
  });

  it("reports the (redacted) body head when a 200 response carried no SSE frames at all", async () => {
    const fetchFn = (async () => new Response('{"error":{"message":"upstream hiccup for key k-secret-123"}}', { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(collect(adapter(fetchFn).streamChat(req))).rejects.toMatchObject({
      code: "STREAM_INTERRUPTED",
      message: expect.stringContaining("0 frame(s)"),
    });
    await expect(collect(adapter(fetchFn).streamChat(req))).rejects.toMatchObject({
      message: expect.stringContaining("upstream hiccup"),
    });
    await expect(collect(adapter(fetchFn).streamChat(req))).rejects.not.toMatchObject({
      message: expect.stringContaining("k-secret-123"),
    });
  });

  it("keeps an empty 200 body classified as an interruption (retryable)", async () => {
    const fetchFn = (async () => new Response("", { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    await expect(collect(adapter(fetchFn).streamChat(req))).rejects.toMatchObject({ code: "STREAM_INTERRUPTED", retryable: true, message: expect.stringContaining("0 byte(s)") });
  });

  it("applies to the factory-built Groq adapter", async () => {
    const fetchFn = (async () => sseResponse(['data: {"error":{"message":"Internal Server Error","type":"internal_server_error"}}'])) as unknown as typeof fetch;
    const events = await collect(createGroqAdapter({ apiKey: "g", fetchFn }).streamChat(req));
    expect((events.at(-1) as Extract<StreamEvent, { type: "error" }>).code).toBe("PROVIDER_ERROR");
  });
});
