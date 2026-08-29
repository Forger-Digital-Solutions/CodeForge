import { describe, it, expect } from "vitest";
import { AnthropicAdapter } from "../src/anthropic.js";
import type { StreamEvent } from "../src/chat-types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}
function sseResponse(lines: string[]): Response {
  return new Response(lines.join("\n") + "\n", { status: 200, headers: { "content-type": "text/event-stream" } });
}
async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("AnthropicAdapter (Messages API)", () => {
  it("maps system + messages to the Messages shape and parses text + tool_use", async () => {
    let body: any;
    const fetchFn = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return jsonResponse({
        id: "msg_1",
        model: "claude-sonnet-5",
        content: [
          { type: "text", text: "Reading the file." },
          { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a.ts" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 12, output_tokens: 8 },
      });
    }) as unknown as typeof fetch;

    const a = new AnthropicAdapter({ apiKey: "k", fetchFn });
    const res = await a.chat({
      model: "claude-sonnet-5",
      system: "You are helpful",
      messages: [{ role: "user", content: "read a.ts" }],
      tools: [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object", properties: {} } } }],
      maxTokens: 100,
    });

    // system is a top-level field, not a message
    expect(body.system).toBe("You are helpful");
    expect(body.max_tokens).toBe(100);
    expect(body.tools[0].name).toBe("read_file");
    expect(body.tools[0].input_schema).toBeDefined();
    // response parsing
    expect(res.choices[0]!.message.content).toBe("Reading the file.");
    expect(res.choices[0]!.message.toolCalls?.[0]!.function.name).toBe("read_file");
    expect(res.choices[0]!.finishReason).toBe("tool_calls");
    expect(res.usage?.inputTokens).toBe(12);
  });

  it("sends x-api-key + anthropic-version headers", async () => {
    let headers: any;
    const fetchFn = (async (_u: string, init: RequestInit) => { headers = init.headers; return jsonResponse({ id: "1", content: [{ type: "text", text: "hi" }], usage: {} }); }) as unknown as typeof fetch;
    await new AnthropicAdapter({ apiKey: "secret", fetchFn }).chat({ model: "m", messages: [{ role: "user", content: "x" }] });
    expect(headers["x-api-key"]).toBe("secret");
    expect(headers["anthropic-version"]).toBeTruthy();
    expect(headers.Authorization).toBeUndefined();
  });

  it("streams text + usage + finish from Anthropic SSE events", async () => {
    const fetchFn = (async () => sseResponse([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"message_delta","usage":{"output_tokens":2}}',
      'data: {"type":"message_stop"}',
    ])) as unknown as typeof fetch;
    const events = await collect(new AnthropicAdapter({ apiKey: "k", fetchFn }).streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] }));
    const text = events.filter((e) => e.type === "text_delta").map((e) => (e as any).delta).join("");
    expect(text).toBe("Hello");
    expect(events.some((e) => e.type === "usage")).toBe(true);
    expect(events.at(-1)!.type).toBe("finish");
  });

  it("streams a tool_use block as started → delta → completed", async () => {
    const fetchFn = (async () => sseResponse([
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_9","name":"edit_file"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"p\\":1}"}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"message_stop"}',
    ])) as unknown as typeof fetch;
    const events = await collect(new AnthropicAdapter({ apiKey: "k", fetchFn }).streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] }));
    const completed = events.find((e) => e.type === "tool_call_completed") as any;
    expect(completed.toolName).toBe("edit_file");
    expect(completed.arguments).toBe('{"p":1}');
  });

  it("maps 401 to an auth error and healthCheck auth_required", async () => {
    const fetchFn = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    await expect(new AnthropicAdapter({ apiKey: "bad", fetchFn }).chat({ model: "m", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "AUTH_ERROR" });
    expect((await new AnthropicAdapter({ apiKey: "bad", fetchFn }).healthCheck()).status).toBe("auth_required");
  });

  it("requires a credential", async () => {
    await expect(new AnthropicAdapter({}).chat({ model: "m", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "MISSING_API_KEY" });
  });
});
