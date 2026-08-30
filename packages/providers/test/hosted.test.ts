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
});
