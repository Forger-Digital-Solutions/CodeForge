import { describe, expect, it } from "vitest";
import { HostedProviderAdapter } from "../src/hosted.js";
import type { StreamEvent } from "../src/chat-types.js";

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("HostedProviderAdapter", () => {
  it("uses only the dynamic verified-free catalog and preserves exact provider identity", async () => {
    let inferenceBody: Record<string, unknown> | undefined;
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
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

  it("forwards tool definitions and reconstructs hosted tool-call events", async () => {
    let inferenceBody: Record<string, unknown> | undefined;
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      inferenceBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response([
        'data: {"type":"assistant.tool_call.started","messageId":"m","toolCallId":"call-1","toolName":"read_file"}\n\n',
        'data: {"type":"assistant.tool_call.delta","messageId":"m","toolCallId":"call-1","delta":"{\\"path\\":\\"src/index.ts\\"}"}\n\n',
        'data: {"type":"assistant.tool_call.completed","messageId":"m","toolCallId":"call-1","toolName":"read_file","arguments":"{\\"path\\":\\"src/index.ts\\"}"}\n\n',
        'data: {"type":"assistant.message.completed","messageId":"m","fullText":"","finishReason":"tool_calls","usage":{"inputTokens":2,"outputTokens":1}}\n\n',
      ].join(''));
    }) as typeof fetch;
    const adapter = new HostedProviderAdapter({ cloudApiUrl: "https://staging.example", getAccessToken: () => "token", fetchFn });

    const events = await collect(adapter.streamChat({
      model: "openrouter::acme/coder:free",
      messages: [{ role: "user", content: "fix the bug" }],
      tools: [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object", properties: {} } } }],
      toolChoice: "auto",
    }));
    expect(inferenceBody?.tools).toBeDefined();
    expect(inferenceBody?.toolChoice).toBe("auto");
    expect(events.map((event) => event.type)).toEqual(["tool_call_started", "tool_call_delta", "tool_call_completed", "usage", "finish"]);
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "tool_calls" });
  });
});
