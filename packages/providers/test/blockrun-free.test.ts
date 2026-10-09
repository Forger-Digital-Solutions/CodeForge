import { describe, expect, it } from "vitest";
import { createBlockRunFreeAdapter, mapBlockRunFreeModel } from "../src/blockrun-free.js";
import { createProviderAdapterById } from "../src/provider-factory.js";
import type { StreamEvent } from "../src/chat-types.js";
import { gatewayRateLimitScope } from "../src/gateway-rate-limit.js";

const MODEL = "nvidia/llama-3.2-11b-vision";
const raw = { id: MODEL, billing_mode: "free", available: true, pricing: { input: 0, output: 0 }, categories: ["chat", "vision"], context_window: 128_000 };
const request = { model: MODEL, messages: [{ role: "user" as const, content: "public synthetic fixture" }] };
const catalog = () => new Response(JSON.stringify({ data: [raw] }), { status: 200 });
const completion = (model = MODEL) => new Response(JSON.stringify({ id: "r1", model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), { status: 200 });

describe("BlockRun anonymous Free transport", () => {
  it("requires installed-client authority and sends no credential or payment headers", async () => {
    expect(createProviderAdapterById("blockrun-free-direct")).toBeUndefined();
    const observed: Array<{ target: string; init: RequestInit }> = [];
    const adapter = createBlockRunFreeAdapter({ fetchFn: (async (target: string, init: RequestInit) => {
      observed.push({ target, init });
      return target.endsWith("/models") ? catalog() : completion();
    }) as typeof fetch });
    expect((await adapter.chat(request)).model).toBe(MODEL);
    expect(observed.map((call) => call.target)).toEqual(["https://blockrun.ai/api/v1/models", "https://blockrun.ai/api/v1/chat/completions"]);
    for (const call of observed) {
      expect(call.init.headers).toEqual({ "Content-Type": "application/json" });
      expect(call.init.redirect).toBe("manual");
    }
  });

  it("requires all explicit economic and availability facts", () => {
    expect(mapBlockRunFreeModel(raw)?.freeStatus).toBe("verified_free");
    for (const patch of [
      { billing_mode: "paid" }, { billing_mode: undefined }, { available: false }, { available: undefined },
      { pricing: { input: null, output: null } }, { pricing: { input: "", output: "0" } },
      { pricing: { input: 0, output: 0, transaction_fee: 0.001 } }, { categories: ["image"] },
    ]) expect(mapBlockRunFreeModel({ ...raw, ...patch })).toBeNull();
  });

  it("rejects paid, unavailable and missing models before inference", async () => {
    let calls = 0;
    const adapter = createBlockRunFreeAdapter({ fetchFn: (async () => { calls++; return catalog(); }) as typeof fetch });
    await expect(adapter.chat({ ...request, model: "openai/gpt-5" })).rejects.toMatchObject({ code: "MODEL_NOT_ALLOWED" });
    expect(calls).toBe(1);
  });

  it("expires catalog evidence and cannot keep serving a removed model", async () => {
    let now = 1;
    let removed = false;
    const adapter = createBlockRunFreeAdapter({ now: () => now, fetchFn: (async (target: string) => target.endsWith("/models")
      ? new Response(JSON.stringify({ data: removed ? [] : [raw] })) : completion()) as typeof fetch });
    await adapter.chat(request);
    expect(adapter.canRoute(MODEL)).toBe(true);
    now += 5 * 60_000;
    removed = true;
    expect(adapter.canRoute(MODEL)).toBe(true);
    await expect(adapter.chat(request)).rejects.toMatchObject({ code: "MODEL_NOT_ALLOWED" });
    expect(adapter.canRoute(MODEL)).toBe(false);
  });

  it("rejects silent Free model substitutions and missing served identities", async () => {
    for (const model of ["nvidia/nemotron-3.5-lightning", ""]) {
      const adapter = createBlockRunFreeAdapter({ fetchFn: (async (target: string) => target.endsWith("/models") ? catalog() : completion(model)) as typeof fetch });
      await expect(adapter.chat(request)).rejects.toMatchObject({ code: model ? "MODEL_SUBSTITUTED" : "SERVED_MODEL_UNVERIFIED" });
    }
  });

  it("rejects substituted or missing stream identity before releasing a tool call", async () => {
    for (const model of ["nvidia/nemotron-3.5-lightning", undefined]) {
      const chunk = { model, choices: [{ delta: { tool_calls: [{ index: 0, id: "write", function: { name: "edit_file", arguments: "{}" } }] } }] };
      const adapter = createBlockRunFreeAdapter({ fetchFn: (async (target: string) => target.endsWith("/models") ? catalog()
        : new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)) as typeof fetch });
      const events: StreamEvent[] = [];
      const collect = async () => { for await (const event of adapter.streamChat(request)) events.push(event); };
      await expect(collect()).rejects.toMatchObject({ code: model ? "MODEL_SUBSTITUTED" : "SERVED_MODEL_UNVERIFIED" });
      expect(events).toEqual([]);
    }
  });

  it("preserves actual matched stream identity and tool arguments", async () => {
    const chunks = [
      { model: MODEL, choices: [{ delta: { tool_calls: [{ index: 0, id: "read", function: { name: "read_file", arguments: '{"path":"src/retry.mjs"}' } }] } }] },
      { model: MODEL, choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
    const adapter = createBlockRunFreeAdapter({ fetchFn: (async (target: string) => target.endsWith("/models") ? catalog()
      : new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n")) as typeof fetch });
    const events: StreamEvent[] = [];
    for await (const event of adapter.streamChat(request)) events.push(event);
    expect(events.find((event) => event.type === "tool_call_completed")).toMatchObject({ toolName: "read_file", arguments: '{"path":"src/retry.mjs"}' });
    expect(events.at(-1)).toMatchObject({ type: "finish", model: MODEL });
  });

  it("withholds executable tool calls when a later stream frame changes the served model", async () => {
    const chunks = [
      { model: MODEL, choices: [{ delta: { tool_calls: [{ index: 0, id: "edit", function: { name: "edit_file", arguments: '{"path":"src/retry.mjs"}' } }] }, finish_reason: "tool_calls" }] },
      { model: "nvidia/unqualified-substitute", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ];
    const adapter = createBlockRunFreeAdapter({ fetchFn: (async (target: string) => target.endsWith("/models") ? catalog()
      : new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n")) as typeof fetch });
    const events: StreamEvent[] = [];
    const collect = async () => { for await (const event of adapter.streamChat(request)) events.push(event); };
    await expect(collect()).rejects.toMatchObject({ code: "MODEL_SUBSTITUTED" });
    expect(events.some(event => event.type === "tool_call_completed")).toBe(false);
    expect(events.some(event => event.type === "finish")).toBe(false);
  });

  it("does not follow redirects or satisfy payment challenges", async () => {
    for (const status of [302, 402]) {
      const adapter = createBlockRunFreeAdapter({ fetchFn: (async (target: string) => target.endsWith("/models") ? catalog() : new Response("payment required", { status })) as typeof fetch });
      await expect(adapter.chat(request)).rejects.toBeDefined();
    }
  });

  it("does not release a buffered tool call when its stream is cancelled", async () => {
    const abort = new AbortController();
    const chunk = { model: MODEL, choices: [{ delta: { tool_calls: [{ index: 0, id: "edit", function: { name: "edit_file", arguments: "{}" } }] }, finish_reason: "tool_calls" }] };
    const adapter = createBlockRunFreeAdapter({ fetchFn: (async (target: string, init: RequestInit) => {
      if (target.endsWith("/models")) return catalog();
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
        init.signal?.addEventListener("abort", () => controller.error(new DOMException("Cancelled", "AbortError")), { once: true });
        setTimeout(() => abort.abort(), 5);
      } }));
    }) as typeof fetch });
    const events: StreamEvent[] = [];
    for await (const event of adapter.streamChat(request, abort.signal)) events.push(event);
    expect(events.some((event) => event.type === "tool_call_completed" || event.type === "finish")).toBe(false);
  });

  it("binds the Free IP wall to the whole provider quota domain", () => {
    expect(gatewayRateLimitScope("blockrun-free-direct", { code: "FREE_TIER_RATE_LIMITED", message: "model limit" })).toBe("provider");
  });

  it("classifies a witnessed upstream tool parser failure separately from IP capacity", async () => {
    const body = { code: "FREE_MODEL_FAILED", error: { code: "FREE_MODEL_FAILED", message: "Free model capacity exhausted" }, debug: 'NVIDIA API error: 400 Invalid JSON: input_value=\'<|python_tag|>{"name":"read_file"}\'' };
    const adapter = createBlockRunFreeAdapter({ fetchFn: (async (target: string) => target.endsWith("/models") ? catalog()
      : new Response(JSON.stringify(body), { status: 429 })) as typeof fetch });
    await expect(adapter.chat({ ...request, tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }] }))
      .rejects.toMatchObject({ code: "INVALID_TOOL_OUTPUT", retryable: false, rateLimitScope: undefined });
    await expect(adapter.chat(request)).rejects.toMatchObject({ code: "RATE_LIMITED", rateLimitScope: "provider" });
  });
});
