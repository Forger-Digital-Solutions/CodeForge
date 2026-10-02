import { describe, expect, it } from "vitest";
import { AiHordeCommunityAdapter, createAiHordeCommunityAdapter } from "../src/ai-horde.js";
import { createProviderAdapterById } from "../src/provider-factory.js";
import type { ChatRequest, StreamEvent } from "../src/index.js";

const TOOLS: ChatRequest["tools"] = [{
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
}];

const request: ChatRequest = { model: "aphrodite/DeepSeek-V4.1-Flash", messages: [{ role: "user", content: "read src/calc.ts" }] };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function sseResponse(lines: string[], status = 200): Response {
  const body = lines.map((l) => `data: ${l}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

describe("AI Horde community transport", () => {
  it("requires an installed-client authority in the factory path", () => {
    expect(createProviderAdapterById("ai-horde")).toBeUndefined();
    const adapter = createProviderAdapterById("ai-horde", { clientDirectAuthorized: true, fetchFn: async () => jsonResponse({ data: [] }) });
    expect(adapter?.providerId).toBe("ai-horde");
  });

  it("sends the documented anonymous key + Client-Agent, and never a stored credential", async () => {
    let url = "";
    let headers: HeadersInit | undefined;
    const adapter = new AiHordeCommunityAdapter({
      fetchFn: (async (target: RequestInfo | URL, init: RequestInit) => {
        url = String(target); headers = init.headers;
        return jsonResponse({ id: "1", model: "m", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
      }) as typeof fetch,
    });
    await adapter.chat(request);
    expect(url).toBe("https://oai.aihorde.net/v1/chat/completions");
    expect(headers).toMatchObject({ Authorization: "Bearer 0000000000" });
    expect((headers as Record<string, string>)["Client-Agent"]).toContain("CodeForge");
  });

  it("translates tools into the text contract instead of the dropped OAI tools field", async () => {
    let body: Record<string, unknown> | undefined;
    const adapter = new AiHordeCommunityAdapter({
      fetchFn: (async (_t: RequestInfo | URL, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return jsonResponse({ id: "1", choices: [{ message: { content: '<tool_call>{"name":"read_file","arguments":{"path":"src/calc.ts"}}</tool_call>' }, finish_reason: "stop" }] });
      }) as typeof fetch,
    });
    const res = await adapter.chat({ ...request, tools: TOOLS });
    expect(body?.tools).toBeUndefined();
    const messages = body?.messages as Array<{ role: string; content: string }>;
    expect(messages.some((m) => m.role === "system" && m.content.includes("<tool_call>"))).toBe(true);
    const toolCalls = res.choices[0]?.message.toolCalls;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls?.[0]?.function.name).toBe("read_file");
    expect(JSON.parse(toolCalls?.[0]?.function.arguments ?? "")).toEqual({ path: "src/calc.ts" });
    expect(res.choices[0]?.finishReason).toBe("tool_calls");
  });

  it("clamps max_tokens to the provider's validated minimum", async () => {
    let body: Record<string, unknown> | undefined;
    const adapter = new AiHordeCommunityAdapter({
      fetchFn: (async (_t: RequestInfo | URL, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return jsonResponse({ id: "1", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
      }) as typeof fetch,
    });
    await adapter.chat({ ...request, maxTokens: 1 });
    expect(body?.max_tokens).toBe(16);
  });

  it("streams buffered text then surfaces parsed tool_call events", async () => {
    const adapter = new AiHordeCommunityAdapter({
      fetchFn: (async () => sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'Let me look. <tool' }, finish_reason: null }] }),
        JSON.stringify({ choices: [{ delta: { content: '_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>' }, finish_reason: null }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4 } }),
      ])) as typeof fetch,
    });
    const events: StreamEvent[] = [];
    for await (const ev of adapter.streamChat({ ...request, tools: TOOLS })) events.push(ev);
    const kinds = events.map((e) => e.type);
    expect(kinds).toEqual(["text_delta", "usage", "tool_call_started", "tool_call_completed", "finish"]);
    expect((events[0] as { delta: string }).delta).toBe("Let me look.");
    const completed = events[3] as { toolName: string; arguments: string };
    expect(completed.toolName).toBe("read_file");
    expect(JSON.parse(completed.arguments)).toEqual({ path: "a.ts" });
    expect((events[4] as { finishReason: string }).finishReason).toBe("tool_calls");
  });

  it("passes tool results back as <tool_result> user messages", async () => {
    let body: Record<string, unknown> | undefined;
    const adapter = new AiHordeCommunityAdapter({
      fetchFn: (async (_t: RequestInfo | URL, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return jsonResponse({ id: "1", choices: [{ message: { content: "file contents seen" }, finish_reason: "stop" }] });
      }) as typeof fetch,
    });
    await adapter.chat({
      ...request,
      tools: TOOLS,
      messages: [
        { role: "user", content: "read src/calc.ts" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"src/calc.ts"}' } }] },
        { role: "tool", name: "read_file", toolCallId: "c1", content: "export const add = (a,b) => a+b;" },
      ],
    });
    const messages = body?.messages as Array<{ role: string; content: string }>;
    expect(messages.some((m) => m.role === "tool")).toBe(false);
    expect(messages.some((m) => m.role === "user" && m.content.includes('<tool_result name="read_file">'))).toBe(true);
    expect(messages.some((m) => m.role === "assistant" && m.content.includes("<tool_call>"))).toBe(true);
  });

  it("translates the shared account's real concurrency figures into the quota vocabulary", async () => {
    const observed: Array<{ providerId: string; headers: Array<[string, string]> }> = [];
    const adapter = new AiHordeCommunityAdapter({
      onResponse: (obs) => observed.push({ providerId: obs.providerId, headers: obs.headers }),
      fetchFn: (async (target: RequestInfo | URL) => {
        expect(String(target)).toBe("https://aihorde.net/api/v2/find_user");
        return jsonResponse({ concurrency: 500, active_generations: { text: [{}, {}] } });
      }) as typeof fetch,
    });
    expect(await adapter.probeAccountQuota()).toBe(true);
    expect(observed).toHaveLength(1);
    const headers = new Map(observed[0]!.headers);
    expect(headers.get("x-capacity-limit-concurrency")).toBe("500");
    expect(headers.get("x-capacity-remaining-concurrency")).toBe("498");
  });

  it("probeAccountQuota resolves false when the account shape is unverifiable", async () => {
    const adapter = new AiHordeCommunityAdapter({
      onResponse: () => {},
      fetchFn: (async () => jsonResponse({ id: 0 })) as typeof fetch,
    });
    expect(await adapter.probeAccountQuota()).toBe(false);
  });

  it("reports health from the native heartbeat endpoint", async () => {
    const adapter = new AiHordeCommunityAdapter({
      fetchFn: (async (target: RequestInfo | URL) => {
        return String(target).includes("/heartbeat") ? jsonResponse({ uptime: 1 }) : jsonResponse({}, 404);
      }) as typeof fetch,
    });
    expect((await adapter.healthCheck()).status).toBe("available");
  });

  it("surfaces provider errors truthfully, including 429 cooldowns", async () => {
    const adapter = new AiHordeCommunityAdapter({
      fetchFn: (async () => new Response("rate limited", { status: 429, headers: { "retry-after": "30" } })) as typeof fetch,
    });
    await expect(adapter.chat(request)).rejects.toMatchObject({ code: "RATE_LIMITED", retryable: true, status: 429 });
    await expect(adapter.chat(request)).rejects.toMatchObject({ retryAfter: 30_000 });
  });

  it("validation failures stay non-retryable provider errors", async () => {
    const adapter = new AiHordeCommunityAdapter({
      fetchFn: (async () => jsonResponse({ detail: "Error: Input payload validation failed" }, 406)) as typeof fetch,
    });
    await expect(adapter.chat(request)).rejects.toMatchObject({ status: 406, retryable: false });
  });
});
