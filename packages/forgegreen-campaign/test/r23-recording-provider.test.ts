import { describe, expect, it } from "vitest";
import type { ChatRequest, ChatResponse, ProviderAdapter, ProviderModel, StreamEvent } from "@codeforge/providers";
import { ProviderError } from "@codeforge/providers";
import { RecordingProviderAdapter, isRateLimit, modelWaitMs, rateLimitWaitMs } from "../src/r23/recording-provider.js";

/**
 * R23 M4 — measurement golden tests for the per-model-call ledger (protocol §6.4, §16).
 * Known-token, retry, rate-limit and abandoned-stream fixtures: the ledger must record exactly
 * what the provider reported and mark everything else UNKNOWN.
 */

type Script = (req: ChatRequest) => AsyncIterable<StreamEvent>;

class ScriptedAdapter implements ProviderAdapter {
  readonly providerId = "scripted";
  readonly isTestProvider = true;
  private calls = 0;
  constructor(private readonly scripts: Script[]) {}
  async listModels(): Promise<ProviderModel[]> {
    return [{ modelId: "m", displayName: "m", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
  }
  async chat(): Promise<ChatResponse> {
    throw new Error("unused");
  }
  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const script = this.scripts[Math.min(this.calls, this.scripts.length - 1)]!;
    this.calls += 1;
    for await (const event of script(req)) {
      if (signal?.aborted) return;
      yield event;
    }
  }
  async healthCheck() {
    return { status: "available" as const };
  }
}

const request = (messages: ChatRequest["messages"] = [{ role: "user", content: "hello world" }]): ChatRequest => ({ model: "m", messages, tools: [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object", properties: {} } } }] });

async function drain(adapter: RecordingProviderAdapter, req: ChatRequest, signal?: AbortSignal): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of adapter.streamChat(req, signal)) events.push(event);
  return events;
}

function clock(start = 1_700_000_000_000, stepMs = 100): () => number {
  let t = start;
  return () => (t += stepMs);
}

describe("R23 recording provider — known-token fixture", () => {
  it("records provider-reported usage exactly and never invents missing detail fields", async () => {
    const adapter = new RecordingProviderAdapter(
      new ScriptedAdapter([
        async function* () {
          yield { type: "text_delta", delta: "answer" };
          yield { type: "usage", usage: { inputTokens: 1234, outputTokens: 56, cachedInputTokens: 1000, reasoningTokens: 7, costUsd: 0 } };
          yield { type: "finish", finishReason: "stop" };
        },
        async function* () {
          yield { type: "text_delta", delta: "second" };
          yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } };
          yield { type: "finish", finishReason: "stop" };
        },
      ]),
      { now: clock() },
    );
    await drain(adapter, request());
    await drain(adapter, request([{ role: "user", content: "hello world" }, { role: "assistant", content: "answer" }, { role: "user", content: "more" }]));
    expect(adapter.calls).toHaveLength(2);
    const [first, second] = adapter.calls;
    expect(first!.usageSource).toBe("PROVIDER_REPORTED");
    expect(first!.promptTokens).toBe(1234);
    expect(first!.completionTokens).toBe(56);
    expect(first!.totalTokens).toBe(1290);
    expect(first!.cachedPromptTokens).toBe(1000);
    expect(first!.reasoningTokens).toBe(7);
    expect(first!.providerReportedCostUsd).toBe(0);
    expect(first!.finishReason).toBe("stop");
    expect(first!.outcome).toBe("ok");
    expect(first!.rateLimited).toBe(false);
    expect(first!.responseBytes).toBe(Buffer.byteLength("answer"));
    expect(first!.messageCountByRole).toEqual({ user: 1 });
    expect(first!.toolDefinitionCount).toBe(1);
    // Second call: no cached / reasoning / cost reported → fields ABSENT, not zero.
    expect(second!.promptTokens).toBe(10);
    expect("cachedPromptTokens" in second!).toBe(false);
    expect("reasoningTokens" in second!).toBe(false);
    expect("providerReportedCostUsd" in second!).toBe(false);
    expect(second!.messageCountByRole).toEqual({ user: 2, assistant: 1 });
    // The conversation digest changes with the prefix; request bytes grow with the conversation.
    expect(first!.conversationDigest).not.toBe(second!.conversationDigest);
    expect(second!.requestBytes).toBeGreaterThan(first!.requestBytes);
    // Deterministic clock: the recorder reads it at start, at the first event, and at the end,
    // so each call spans exactly two ticks of latency and one tick to first event.
    expect(first!.timeToFirstEventMs).toBe(100);
    expect(first!.latencyMs).toBe(200);
    expect(modelWaitMs(adapter.calls)).toBe(400);
  });

  it("marks a call UNKNOWN when the provider never emits a usage event", async () => {
    const adapter = new RecordingProviderAdapter(new ScriptedAdapter([
      async function* () {
        yield { type: "text_delta", delta: "no usage here" };
        yield { type: "finish", finishReason: "stop" };
      },
    ]));
    await drain(adapter, request());
    const [call] = adapter.calls;
    expect(call!.usageSource).toBe("UNKNOWN");
    expect(call!.promptTokens).toBeUndefined();
    expect(call!.completionTokens).toBeUndefined();
    expect(call!.outcome).toBe("ok");
  });

  it("captures emitted tool calls with argument hashes and sizes", async () => {
    const adapter = new RecordingProviderAdapter(new ScriptedAdapter([
      async function* () {
        yield { type: "tool_call_started", toolCallId: "tc1", toolName: "read_file" };
        yield { type: "tool_call_delta", toolCallId: "tc1", delta: "{\"path\":\"src/a.ts\"}" };
        yield { type: "tool_call_completed", toolCallId: "tc1", toolName: "read_file", arguments: "{\"path\":\"src/a.ts\"}" };
        yield { type: "usage", usage: { inputTokens: 50, outputTokens: 12 } };
        yield { type: "finish", finishReason: "tool_calls" };
      },
    ]));
    await drain(adapter, request());
    expect(adapter.calls[0]!.toolCallsEmitted).toBe(1);
    expect(adapter.calls[0]!.finishReason).toBe("tool_calls");
    expect(adapter.requests[0]!.emittedToolCalls).toEqual([
      expect.objectContaining({ id: "tc1", name: "read_file", argumentsBytes: Buffer.byteLength("{\"path\":\"src/a.ts\"}"), arguments: "{\"path\":\"src/a.ts\"}" }),
    ]);
    expect(adapter.requests[0]!.emittedToolCalls[0]!.argumentsHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("R23 recording provider — failure fixtures", () => {
  it("commits an in-band error event to the ledger even when the consumer abandons the stream at that event", async () => {
    const adapter = new RecordingProviderAdapter(new ScriptedAdapter([
      async function* () {
        yield { type: "text_delta", delta: "partial" };
        yield { type: "error", code: "502", message: "Provider returned error", retryable: true, status: 502 };
        yield { type: "finish", finishReason: "error" };
      },
    ]));
    // Mimic ModelExecutionAdapter: throw on the first error event, which closes the generator.
    await expect((async () => {
      for await (const event of adapter.streamChat(request())) {
        if (event.type === "error") throw new ProviderError(event.message, event.code, event.retryable);
      }
    })()).rejects.toThrow("Provider returned error");
    expect(adapter.calls).toHaveLength(1);
    const [call] = adapter.calls;
    expect(call!.outcome).toBe("error");
    expect(call!.errorCode).toBe("502");
    expect(call!.httpStatus).toBe(502);
    expect(call!.retryable).toBe(true);
    expect(call!.usageSource).toBe("UNKNOWN");
    expect(call!.rateLimited).toBe(false);
    expect(call!.responseBytes).toBe(Buffer.byteLength("partial"));
  });

  it("commits a thrown provider error (HTTP-level failure before any event)", async () => {
    const adapter = new RecordingProviderAdapter(new ScriptedAdapter([
      // eslint-disable-next-line require-yield
      async function* () {
        throw new ProviderError("OpenRouter error (429): free-models-per-day", "RATE_LIMITED", true, { status: 429, retryAfter: Date.now() + 30_000 });
      },
    ]));
    await expect(drain(adapter, request())).rejects.toThrow("free-models-per-day");
    const [call] = adapter.calls;
    expect(call!.outcome).toBe("error");
    expect(call!.errorCode).toBe("RATE_LIMITED");
    expect(call!.httpStatus).toBe(429);
    expect(call!.rateLimited).toBe(true);
    expect(call!.retryAfterMs).toBeGreaterThan(0);
    expect(call!.timeToFirstEventMs).toBeUndefined();
  });

  it("retry fixture: N failures then success yield exactly N error records and one ok record", async () => {
    const failing: Script = async function* () {
      yield { type: "error", code: "PROVIDER_ERROR", message: "upstream 503", retryable: true, status: 503 };
    };
    const ok: Script = async function* () {
      yield { type: "text_delta", delta: "done" };
      yield { type: "usage", usage: { inputTokens: 20, outputTokens: 3 } };
      yield { type: "finish", finishReason: "stop" };
    };
    const adapter = new RecordingProviderAdapter(new ScriptedAdapter([failing, failing, failing, ok]));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        for await (const event of adapter.streamChat(request())) {
          if (event.type === "error") throw new ProviderError(event.message, event.code, true);
        }
      } catch {
        // retry
      }
    }
    expect(adapter.calls.map((call) => call.outcome)).toEqual(["error", "error", "error", "ok"]);
    expect(adapter.calls.filter((call) => call.outcome === "error")).toHaveLength(3);
    expect(adapter.calls[3]!.promptTokens).toBe(20);
  });

  it("rate-limit fixture: attributes the gap after a 429 to rate-limit wait, not to agent work", async () => {
    const now = clock(1_700_000_000_000, 100);
    const adapter = new RecordingProviderAdapter(new ScriptedAdapter([
      async function* () {
        yield { type: "error", code: "RATE_LIMITED", message: "429 Too Many Requests", status: 429, retryable: true };
      },
      async function* () {
        yield { type: "text_delta", delta: "ok" };
        yield { type: "usage", usage: { inputTokens: 5, outputTokens: 1 } };
        yield { type: "finish", finishReason: "stop" };
      },
    ]), { now });
    try {
      for await (const event of adapter.streamChat(request())) {
        if (event.type === "error") throw new Error(event.message);
      }
    } catch {
      // paced retry: consume 20 clock ticks (2,000 ms) of waiting
      for (let i = 0; i < 20; i += 1) now();
    }
    await drain(adapter, request());
    expect(adapter.calls[0]!.rateLimited).toBe(true);
    expect(adapter.calls[1]!.outcome).toBe("ok");
    const wait = rateLimitWaitMs(adapter.calls);
    // Gap between call 0 end and call 1 start = 20 ticks + the tick consumed by call 1's start.
    expect(wait).toBe(2100);
    expect(modelWaitMs(adapter.calls)).toBe(adapter.calls[0]!.latencyMs + adapter.calls[1]!.latencyMs);
  });

  it("abort fixture: an aborted stream is recorded as aborted, not as an error or a success", async () => {
    const controller = new AbortController();
    const adapter = new RecordingProviderAdapter(new ScriptedAdapter([
      async function* () {
        yield { type: "text_delta", delta: "start" };
        controller.abort();
        yield { type: "text_delta", delta: "never delivered" };
      },
    ]));
    await drain(adapter, request(), controller.signal);
    expect(adapter.calls[0]!.outcome).toBe("aborted");
    expect(adapter.calls[0]!.usageSource).toBe("UNKNOWN");
  });

  it("classifies rate limits from status, code, or message", () => {
    expect(isRateLimit(undefined, 429, undefined)).toBe(true);
    expect(isRateLimit("RATE_LIMITED", undefined, undefined)).toBe(true);
    expect(isRateLimit("PROVIDER_ERROR", 503, "rate limit exceeded")).toBe(true);
    expect(isRateLimit("PROVIDER_ERROR", 503, "upstream unavailable")).toBe(false);
  });
});
