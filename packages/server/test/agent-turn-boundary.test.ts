import { describe, it, expect, afterAll } from "vitest";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import {
  type ProviderAdapter,
  type ProviderModel,
  type ChatRequest,
  type ChatResponse,
  type StreamEvent,
  InMemoryProviderCatalog,
} from "@codeforge/providers";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { createAgentRuntime } from "../src/agent-runtime.js";

class RecordingProvider implements ProviderAdapter {
  readonly providerId = "boundary-provider";
  readonly isTestProvider = true;
  readonly requests: ChatRequest[] = [];

  async listModels(): Promise<ProviderModel[]> {
    return [{
      modelId: "boundary-model",
      displayName: "Boundary Model",
      isFree: true,
      freeStatus: "verified_free",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    }];
  }

  async chat(_request: ChatRequest): Promise<ChatResponse> {
    throw new Error("Use streamChat");
  }

  async *streamChat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.requests.push(structuredClone(request));
    if (signal?.aborted) return;
    yield { type: "text_delta", delta: request.messages.at(-1)?.content.includes("second") ? "second answer" : "first answer" };
    yield { type: "finish", finishReason: "stop" };
  }

  async healthCheck() { return { status: "available" as const }; }
}

describe("AgentRuntime durable turn boundaries", () => {
  const persistence = createSessionPersistence();
  const eventStore = new EventStore();

  afterAll(async () => {
    await persistence.close();
  });

  it("isolates model history per turn and persists the final response", async () => {
    const provider = new RecordingProvider();
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: provider.providerId, modelId: "boundary-model" }));
    const runtime = createAgentRuntime({
      sessionId: "turn-boundary",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
    });
    runtime.setModelSelection({ providerId: provider.providerId, modelId: "boundary-model" });

    const waitForCompletion = async (turnId: string): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const turn = await persistence.getTurn(turnId);
        if (turn?.status === "completed") return;
        if (turn?.status === "failed") throw new Error(turn.error ?? "turn failed");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Turn ${turnId} did not complete`);
    };

    const firstTurn = await runtime.startTurn("first request");
    await waitForCompletion(firstTurn);
    const secondTurn = await runtime.startTurn("second request");
    await waitForCompletion(secondTurn);

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]!.messages.some((message) => message.content.includes("first request"))).toBe(true);
    expect(provider.requests[1]!.messages.some((message) => message.content.includes("first request"))).toBe(false);
    expect(provider.requests[1]!.messages.some((message) => message.content.includes("second request"))).toBe(true);

    const finalResponse = await persistence.getWorkItem(`agent-final-response-${secondTurn}`);
    expect(finalResponse).toMatchObject({
      kind: "agent_final_response",
      turnId: secondTurn,
      status: "completed",
      response: "second answer",
    });
  });
});
