import { describe, expect, it } from "vitest";
import { HostedProviderAdapter } from "../src/hosted.js";
import type { StreamEvent } from "../src/chat-types.js";

const compatibleMetadata = {
  apiVersion: "1.0.0",
  serverVersion: "0.4.0",
  features: ["HOSTED_FREE", "DYNAMIC_MODELS", "HOSTED_TOOLS"],
};

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("HostedProviderAdapter", () => {
  it("uses only the dynamic verified-free catalog and preserves exact provider identity", async () => {
    let inferenceBody: Record<string, unknown> | undefined;
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      if (url.toString().endsWith("/v1/meta")) return new Response(JSON.stringify(compatibleMetadata));
      if (url.toString().endsWith("/v1/hosted/models")) {
        return new Response(JSON.stringify([
          {
            providerId: "openrouter",
            modelId: "acme/coder:free",
            displayName: "Acme Coder",
            contextWindow: 64000,
            capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: false },
            accessClass: "free",
            isEligibleFree: true,
          },
          {
            providerId: "gems",
            modelId: "gems-topaz",
            displayName: "GEMS Topaz",
            contextWindow: 64000,
            capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: false },
            accessClass: "gems_paid",
            isEligibleFree: false,
          },
        ]));
      }
      inferenceBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('data: {"type":"assistant.message.completed","usage":{"inputTokens":2,"outputTokens":1}}\n\n');
    }) as typeof fetch;
    const adapter = new HostedProviderAdapter({ cloudApiUrl: "https://staging.example", getAccessToken: () => "token", fetchFn });

    const models = await adapter.listModels();
    expect(models.map((model) => model.modelId)).toEqual(["codeforge-auto", "openrouter::acme/coder:free"]);

    const events = await collect(adapter.streamChat({ model: "openrouter::acme/coder:free", messages: [{ role: "user", content: "hi" }] }));
    expect(inferenceBody?.providerId).toBe("openrouter");
    expect(inferenceBody?.modelId).toBe("acme/coder:free");
    expect(events.at(-1)?.type).toBe("finish");
  });

  it("does not advertise a fallback hosted model when the cloud catalog is unavailable", async () => {
    const adapter = new HostedProviderAdapter({
      cloudApiUrl: "https://staging.example",
      fetchFn: (async () => new Response("offline", { status: 503 })) as typeof fetch,
    });

    await expect(adapter.listModels()).resolves.toEqual([]);
  });

  it("refuses a v0.2 gateway rather than silently falling back to its text-level tool protocol", async () => {
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = url.toString();
      if (u.endsWith("/v1/meta")) {
        return new Response(JSON.stringify({ apiVersion: "1.0.0", serverVersion: "0.2.0", features: ["HOSTED_FREE", "DYNAMIC_MODELS"] }));
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const adapter = new HostedProviderAdapter({ cloudApiUrl: "https://staging.example", getAccessToken: () => "token", fetchFn });

    await expect(collect(adapter.streamChat({
      model: "openrouter::acme/coder:free",
      messages: [{ role: "user", content: "fix the bug" }],
      tools: [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object", properties: {} } } }],
    }))).rejects.toThrow(/needs an update/i);
  });

  it("preserves native tool-result history for a compatible gateway", async () => {
    let inferenceBody: { messages?: Array<{ role: string; content: string }> } | undefined;
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = url.toString();
      if (u.endsWith("/v1/meta")) return new Response(JSON.stringify(compatibleMetadata));
      inferenceBody = JSON.parse(String(init?.body)) as typeof inferenceBody;
      return new Response('data: {"type":"assistant.message.delta","delta":"The function returns a + b."}\n\ndata: {"type":"assistant.message.completed","usage":{"inputTokens":9,"outputTokens":4}}\n\n');
    }) as typeof fetch;
    const adapter = new HostedProviderAdapter({ cloudApiUrl: "https://staging.example", fetchFn });

    const events = await collect(adapter.streamChat({
      model: "codeforge-auto",
      messages: [
        { role: "user", content: "fix the bug" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"src/calc.ts\"}" } }] },
        { role: "tool", toolCallId: "c1", name: "read_file", content: "export function add(a,b){return a-b}" },
      ],
      tools: [{ type: "function", function: { name: "edit_file", description: "edit", parameters: { type: "object", properties: {} } } }],
    }));

    const roles = inferenceBody?.messages?.map((m) => m.role) ?? [];
    expect(roles).toContain("tool");
    const toolResult = inferenceBody?.messages?.find((m) => m.role === "tool");
    expect(toolResult).toBeDefined();
    expect(toolResult?.content).toContain("export function add");
    const priorCall = inferenceBody?.messages?.find((m) => m.role === "assistant");
    expect(priorCall).toBeDefined();
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "stop" });
    const text = events.filter((e) => e.type === "text_delta").map((e) => e.delta).join("");
    expect(text).toContain("returns a + b");
  });

  it("does not interpret text-shaped tool markup as a tool call on the native protocol", async () => {
    const fetchFn = (async (url: string | URL | Request) => {
      const u = url.toString();
      if (u.endsWith("/v1/meta")) return new Response(JSON.stringify(compatibleMetadata));
      return new Response('data: {"type":"assistant.message.delta","delta":"Let me read it. <tool_call>{\\"name\\":\\"read_file\\",\\"arg"}\n\ndata: {"type":"assistant.message.completed","usage":{"inputTokens":3,"outputTokens":9}}\n\n');
    }) as typeof fetch;
    const adapter = new HostedProviderAdapter({ cloudApiUrl: "https://staging.example", fetchFn });

    const events = await collect(adapter.streamChat({
      model: "codeforge-auto",
      messages: [{ role: "user", content: "go" }],
      tools: [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object", properties: {} } } }],
    }));

    expect(events.filter((e) => e.type === "tool_call_completed")).toHaveLength(0);
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.delta).join("")).toContain("<tool_call>");
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "stop" });
  });

  it("uses native hosted tools when the gateway advertises HOSTED_TOOLS", async () => {
    let inferenceBody: { tools?: unknown } | undefined;
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = url.toString();
      if (u.endsWith("/v1/meta")) return new Response(JSON.stringify(compatibleMetadata));
      inferenceBody = JSON.parse(String(init?.body)) as typeof inferenceBody;
      return new Response(
        'data: {"type":"assistant.tool_call.started","toolCallId":"t1","toolName":"read_file"}\n\n' +
        'data: {"type":"assistant.tool_call.completed","toolCallId":"t1","toolName":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}\n\n' +
        'data: {"type":"assistant.message.completed","usage":{"inputTokens":3,"outputTokens":2},"finishReason":"tool_calls"}\n\n',
      );
    }) as typeof fetch;
    const adapter = new HostedProviderAdapter({ cloudApiUrl: "https://staging.example", fetchFn });

    const events = await collect(adapter.streamChat({
      model: "codeforge-auto",
      messages: [{ role: "user", content: "go" }],
      tools: [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object", properties: {} } } }],
    }));

    expect(inferenceBody?.tools).toBeDefined();
    expect(events.filter((e) => e.type === "tool_call_completed")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "tool_calls" });
  });
});
