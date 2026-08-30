import { randomUUID } from "node:crypto";
import type { ChatRequest, ChatResponse, StreamEvent } from "./chat-types.js";
import type { ProviderAdapter, ProviderModel, ProviderHealthResponse } from "./index.js";

export interface HostedProviderOptions {
  cloudApiUrl?: string;
  getAccessToken?: () => Promise<string | null> | string | null;
  onAuthExpired?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
}

export class HostedProviderAdapter implements ProviderAdapter {
  readonly providerId = "codeforge-cloud";
  readonly isTestProvider = false;
  private readonly cloudApiUrl: string;
  private readonly getAccessToken?: () => Promise<string | null> | string | null;
  private readonly onAuthExpired?: () => Promise<string | null>;
  private readonly fetchFn: typeof fetch;

  constructor(options: HostedProviderOptions = {}) {
    this.cloudApiUrl = (options.cloudApiUrl ?? "http://127.0.0.1:3220").replace(/\/$/, "");
    this.getAccessToken = options.getAccessToken;
    this.onAuthExpired = options.onAuthExpired;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async healthCheck(): Promise<ProviderHealthResponse> {
    try {
      const res = await this.fetchFn(`${this.cloudApiUrl}/health/ready`);
      if (!res.ok) {
        return { status: "offline", error: `HTTP ${res.status}` };
      }
      const data = (await res.json()) as { hostedInferenceReady?: boolean };
      return { status: data.hostedInferenceReady ? "available" : "offline" };
    } catch (err) {
      return { status: "offline", error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listModels(): Promise<ProviderModel[]> {
    try {
      const res = await this.fetchFn(`${this.cloudApiUrl}/v1/hosted/models`);
      if (res.ok) {
        const models = (await res.json()) as Array<{
          providerId: string;
          modelId: string;
          displayName: string;
          availability: "available" | "offline" | "degraded";
          capabilities: Record<string, boolean>;
          contextWindow: number;
          accessClass: "free" | "paid" | "gems_paid";
          isEligibleFree: boolean;
        }>;

        const eligible = models.filter((m) => m.isEligibleFree && m.accessClass === "free");
        if (eligible.length === 0) return [];
        return [
          {
            modelId: "codeforge-auto",
            displayName: "CodeForge Auto · Included Free (Cloud)",
            contextWindow: 128000,
            capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
            isFree: true,
            freeStatus: "verified_free",
          },
          ...eligible.map((m) => ({
            modelId: `${m.providerId}::${m.modelId}`,
            displayName: `${m.displayName} · Included Free (Cloud)`,
            contextWindow: m.contextWindow || 128000,
            capabilities: {
              text: m.capabilities?.text ?? true,
              coding: m.capabilities?.coding ?? true,
              toolCalling: m.capabilities?.toolCalling ?? true,
              vision: m.capabilities?.vision ?? false,
              structuredOutput: m.capabilities?.structuredOutput ?? true,
              longContext: m.capabilities?.longContext ?? true,
            },
            isFree: m.accessClass === "free",
            freeStatus: (m.isEligibleFree ? "verified_free" : "unknown") as ProviderModel["freeStatus"],
          })),
        ];
      }
    } catch {}

    return [];
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    let fullText = "";
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const chunk of this.streamChat(req)) {
      if (chunk.type === "text_delta") {
        fullText += chunk.delta;
      }
      if (chunk.type === "usage") {
        inputTokens = chunk.usage.inputTokens;
        outputTokens = chunk.usage.outputTokens;
      }
    }

    return {
      id: randomUUID(),
      model: req.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: fullText,
          },
          finishReason: "stop",
        },
      ],
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
    };
  }

  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    let token = this.getAccessToken ? await this.getAccessToken() : null;
    const messages = req.messages.map((m) => ({
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    }));

    const separator = req.model.indexOf("::");
    const exactProviderId = separator > 0 ? req.model.slice(0, separator) : undefined;
    const exactModelId = separator > 0 ? req.model.slice(separator + 2) : req.model;
    const body = JSON.stringify({
      requestId: randomUUID(),
      messages,
      modelId: req.model === "codeforge-auto" ? "auto" : exactModelId,
      ...(exactProviderId ? { providerId: exactProviderId } : {}),
      taskType: "coding",
    });

    const makeRequest = async (authToken: string | null) => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      };
      if (authToken) {
        headers["Authorization"] = `Bearer ${authToken}`;
      }

      return this.fetchFn(`${this.cloudApiUrl}/v1/hosted/inference`, {
        method: "POST",
        headers,
        body,
        signal,
      });
    };

    let res = await makeRequest(token);

    // Auth recovery: if 401 and onAuthExpired provided, refresh token and retry ONCE
    if (res.status === 401 && this.onAuthExpired) {
      const newToken = await this.onAuthExpired();
      if (newToken) {
        token = newToken;
        res = await makeRequest(token);
      }
    }

    if (!res.ok) {
      const errText = await res.text();
      let errorMsg = errText;
      try {
        const parsed = JSON.parse(errText);
        errorMsg = parsed.error || errText;
      } catch {}
      throw new Error(`CodeForge Cloud inference failed: ${errorMsg}`);
    }

    if (!res.body) {
      throw new Error("No response body received from CodeForge Cloud");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data: ")) {
          const raw = trimmed.slice(6);
          let event: any;
          try {
            event = JSON.parse(raw);
          } catch {
            continue;
          }

          if (event.type === "assistant.message.delta") {
            yield { type: "text_delta", delta: event.delta };
          } else if (event.type === "assistant.message.completed") {
            if (event.usage) {
              yield {
                type: "usage",
                usage: {
                  inputTokens: event.usage.inputTokens,
                  outputTokens: event.usage.outputTokens,
                },
              };
            }
            yield { type: "finish", finishReason: "stop" };
          } else if (event.type === "turn.failed") {
            throw new Error(event.error || "Turn failed on CodeForge Cloud");
          }
        }
      }
    }
  }
}
