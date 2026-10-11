import { describe, expect, it } from "vitest";
import { AiHordeCommunityAdapter } from "../src/ai-horde.js";
import { createProviderAdapterById } from "../src/provider-factory.js";
import type { ChatRequest, StreamEvent } from "../src/index.js";

const MODEL = "google/gemma-4-31b";
const TOOLS: ChatRequest["tools"] = [{
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
}];
const request: ChatRequest = { model: MODEL, messages: [{ role: "user", content: "read src/calc.ts" }] };

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...Object.fromEntries(new Headers(headers).entries()) } });
}

function generationFetch(text: string, servedModel: string | null = MODEL): typeof fetch {
  return (async (target: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(target);
    if (url.endsWith("/generate/text/async")) return jsonResponse({ id: "job-1" });
    if (url.endsWith("/generate/text/status/job-1") && init.method !== "DELETE") {
      return jsonResponse({ done: true, generations: [{ ...(servedModel !== null ? { model: servedModel } : {}), state: "ok", text }] });
    }
    return jsonResponse({});
  }) as typeof fetch;
}

describe("AI Horde documented native community transport", () => {
  it("requires installed-client authority in the factory path", () => {
    expect(createProviderAdapterById("ai-horde")).toBeUndefined();
    const adapter = createProviderAdapterById("ai-horde", { clientDirectAuthorized: true, fetchFn: generationFetch("ok") });
    expect(adapter?.providerId).toBe("ai-horde");
  });

  it("discovers only the active model with a verified prompt contract", async () => {
    const adapter = new AiHordeCommunityAdapter({ fetchFn: (async () => jsonResponse([
      { name: MODEL, count: 2 },
      { name: "another/model", count: 50 },
      { name: MODEL, count: 0 },
    ])) as typeof fetch });
    await expect(adapter.listModels()).resolves.toMatchObject([{ modelId: MODEL, freeStatus: "verified_free", capabilities: { toolCalling: true } }]);
  });

  it("uses documented anonymous headers and the native async generation contract", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const adapter = new AiHordeCommunityAdapter({ fetchFn: (async (target: RequestInfo | URL, init: RequestInit = {}) => {
      requests.push({ url: String(target), init });
      return generationFetch("ok")(target, init);
    }) as typeof fetch });
    await adapter.chat(request);
    const submit = requests.find((entry) => entry.init.method === "POST")!;
    expect(submit.url).toBe("https://aihorde.net/api/v2/generate/text/async");
    expect(submit.init.headers).toMatchObject({ apikey: "0000000000", "Client-Agent": expect.stringContaining("CodeForge") });
    const body = JSON.parse(String(submit.init.body)) as Record<string, unknown>;
    expect(body.models).toEqual([MODEL]);
    expect(body.trusted_workers).toBe(true);
    expect(body.validated_backends).toBe(true);
    expect(body).not.toHaveProperty("slow_workers");
    expect(body.context_fit).toBe("reject");
    expect(body.prompt).toContain("<|turn>user\nread src/calc.ts<turn|>");
  });

  it("fails closed when the native response omits or substitutes the served model", async () => {
    const missing = new AiHordeCommunityAdapter({ fetchFn: generationFetch("answer", null) });
    const substituted = new AiHordeCommunityAdapter({ fetchFn: generationFetch("answer", "another/model") });
    await expect(missing.chat(request)).rejects.toMatchObject({ code: "SERVED_MODEL_UNVERIFIED" });
    await expect(substituted.chat(request)).rejects.toMatchObject({ code: "MODEL_SUBSTITUTED" });
  });

  it("serializes Gemma tool declarations and parses native function calls", async () => {
    let prompt = "";
    const adapter = new AiHordeCommunityAdapter({ fetchFn: (async (target: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(target).endsWith("/generate/text/async")) prompt = (JSON.parse(String(init.body)) as { prompt: string }).prompt;
      return generationFetch('Let me inspect. <|tool_call>call:read_file{path:<|"|>src/calc.ts<|"|>}<|tool_call|><|tool_response>')(target, init);
    }) as typeof fetch });
    const response = await adapter.chat({ ...request, tools: TOOLS });
    expect(prompt).toContain("<|tool>declaration:read_file");
    expect(prompt).toContain("<tool|>");
    const message = response.choices[0]!.message;
    expect(message.content).toBe("Let me inspect.");
    expect(message.toolCalls).toHaveLength(1);
    expect(message.toolCalls?.[0]?.function.name).toBe("read_file");
    expect(JSON.parse(message.toolCalls?.[0]?.function.arguments ?? "")).toEqual({ path: "src/calc.ts" });
    expect(response.choices[0]?.finishReason).toBe("tool_calls");
  });

  it("clamps generation length to the provider's accepted minimum", async () => {
    let body: Record<string, unknown> | undefined;
    const adapter = new AiHordeCommunityAdapter({ fetchFn: (async (target: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(target).endsWith("/generate/text/async")) body = JSON.parse(String(init.body));
      return generationFetch("ok")(target, init);
    }) as typeof fetch });
    await adapter.chat({ ...request, maxTokens: 1 });
    expect((body?.params as { max_length: number } | undefined)?.max_length).toBe(16);
  });

  it("returns completed text and native tool events through streamChat", async () => {
    const adapter = new AiHordeCommunityAdapter({ fetchFn: generationFetch('Let me look. <|tool_call>call:read_file{path:<|"|>a.ts<|"|>}<|tool_call|><|tool_response>') });
    const events: StreamEvent[] = [];
    for await (const event of adapter.streamChat({ ...request, tools: TOOLS })) events.push(event);
    expect(events.map((event) => event.type)).toEqual(["text_delta", "tool_call_started", "tool_call_completed", "finish"]);
    expect((events[0] as { delta: string }).delta).toBe("Let me look.");
    expect(JSON.parse((events[2] as { arguments: string }).arguments)).toEqual({ path: "a.ts" });
    expect((events[3] as { finishReason: string }).finishReason).toBe("tool_calls");
  });

  it("passes earlier tool calls and results using Gemma's native markers", async () => {
    let prompt = "";
    const adapter = new AiHordeCommunityAdapter({ fetchFn: (async (target: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(target).endsWith("/generate/text/async")) prompt = (JSON.parse(String(init.body)) as { prompt: string }).prompt;
      return generationFetch("done")(target, init);
    }) as typeof fetch });
    await adapter.chat({ ...request, tools: TOOLS, messages: [
      { role: "user", content: "read src/calc.ts" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"src/calc.ts"}' } }] },
      { role: "tool", name: "read_file", toolCallId: "c1", content: "export const add = (a,b) => a+b;" },
    ] });
    expect(prompt).toContain("<|tool_call>call:read_file{path:<|\"|>src/calc.ts<|\"|>}<|tool_call|><|tool_response>");
    expect(prompt).toContain("response:read_file{result:<|\"|>export const add = (a,b) => a+b;<|\"|>}<|tool_response|>");
  });

  it("translates the shared anonymous account's observed concurrency", async () => {
    const observed: Array<{ providerId: string; headers: Array<[string, string]> }> = [];
    const adapter = new AiHordeCommunityAdapter({
      onResponse: (observation) => observed.push({ providerId: observation.providerId, headers: observation.headers }),
      fetchFn: (async (target: RequestInfo | URL) => {
        expect(String(target)).toBe("https://aihorde.net/api/v2/find_user");
        return jsonResponse({ concurrency: 500, active_generations: { text: [{}, {}] } });
      }) as typeof fetch,
    });
    expect(await adapter.probeAccountQuota()).toBe(true);
    const headers = new Map(observed[observed.length - 1]!.headers);
    expect(headers.get("x-capacity-limit-concurrency")).toBe("500");
    expect(headers.get("x-capacity-remaining-concurrency")).toBe("498");
  });

  it("reports unavailable quota shape and native heartbeat health accurately", async () => {
    const adapter = new AiHordeCommunityAdapter({
      onResponse: () => {},
      fetchFn: (async (target: RequestInfo | URL) => String(target).endsWith("/heartbeat")
        ? jsonResponse({ uptime: 1 }) : jsonResponse({ id: 0 })) as typeof fetch,
    });
    expect(await adapter.probeAccountQuota()).toBe(false);
    expect((await adapter.healthCheck()).status).toBe("available");
  });

  it("surfaces provider errors and rate limit cooldowns", async () => {
    const adapter = new AiHordeCommunityAdapter({ fetchFn: (async () => new Response("rate limited", { status: 429, headers: { "retry-after": "30" } })) as typeof fetch });
    await expect(adapter.chat(request)).rejects.toMatchObject({ code: "RATE_LIMITED", retryable: true, status: 429, retryAfter: 30_000 });
  });

  it("keeps validation failures non-retryable", async () => {
    const adapter = new AiHordeCommunityAdapter({ fetchFn: (async () => jsonResponse({ detail: "Error: Input payload validation failed" }, 406)) as typeof fetch });
    await expect(adapter.chat(request)).rejects.toMatchObject({ status: 406, retryable: false });
  });
});
