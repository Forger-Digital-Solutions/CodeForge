import { randomUUID } from "node:crypto";
import type { ChatRequest, ChatResponse, StreamEvent, ToolCall } from "./chat-types.js";
import type { ProviderAdapter, ProviderModel, ProviderHealthResponse } from "./index.js";
import { checkCloudCompatibility, CloudCompatibilityError, type CloudCompatibilityResult } from "./cloud-compatibility.js";

export interface HostedProviderOptions {
  cloudApiUrl?: string;
  getAccessToken?: () => Promise<string | null> | string | null;
  onAuthExpired?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
}

/**
 * Cloud capability negotiation is a release boundary. The desktop refuses a Cloud generation
 * that cannot execute the native hosted tool loop, instead of silently degrading to an older
 * text protocol and failing later in an agent run.
 */

/** SSE frames emitted by /v1/hosted/inference (unknown fields are ignored). */
interface HostedSseEvent {
  type?: string;
  delta?: string;
  toolCallId?: string;
  toolName?: string;
  arguments?: string;
  finishReason?: string;
  error?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export class HostedProviderAdapter implements ProviderAdapter {
  readonly providerId = "codeforge-cloud";
  readonly isTestProvider = false;
  private readonly cloudApiUrl: string;
  private readonly getAccessToken?: () => Promise<string | null> | string | null;
  private readonly onAuthExpired?: () => Promise<string | null>;
  private readonly fetchFn: typeof fetch;
  private compatibilityProbe?: Promise<CloudCompatibilityResult>;

  constructor(options: HostedProviderOptions = {}) {
    this.cloudApiUrl = (options.cloudApiUrl ?? "http://127.0.0.1:3220").replace(/\/$/, "");
    this.getAccessToken = options.getAccessToken;
    this.onAuthExpired = options.onAuthExpired;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async healthCheck(): Promise<ProviderHealthResponse> {
    try {
      const compatibility = await this.getCloudCompatibility();
      if (!compatibility.compatible) {
        return { status: "offline", error: new CloudCompatibilityError(compatibility).message };
      }
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

  async getCloudCompatibility(): Promise<CloudCompatibilityResult> {
    this.compatibilityProbe ??= checkCloudCompatibility(this.cloudApiUrl, this.fetchFn);
    return this.compatibilityProbe;
  }

  private async requireCompatibleCloud(): Promise<CloudCompatibilityResult> {
    const compatibility = await this.getCloudCompatibility();
    if (!compatibility.compatible) throw new CloudCompatibilityError(compatibility);
    return compatibility;
  }

  async listModels(): Promise<ProviderModel[]> {
    try {
      await this.requireCompatibleCloud();
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
    const toolCalls: ToolCall[] = [];
    let finishReason: ChatResponse["choices"][number]["finishReason"] = "stop";

    for await (const chunk of this.streamChat(req)) {
      if (chunk.type === "text_delta") {
        fullText += chunk.delta;
      } else if (chunk.type === "tool_call_completed") {
        toolCalls.push({
          id: chunk.toolCallId,
          type: "function",
          function: { name: chunk.toolName, arguments: chunk.arguments },
        });
      } else if (chunk.type === "finish") {
        finishReason = chunk.finishReason;
      } else if (chunk.type === "usage") {
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
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
          },
          finishReason,
        },
      ],
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
    };
  }

  private splitModel(model: string): { exactProviderId?: string; modelId: string } {
    const separator = model.indexOf("::");
    return {
      exactProviderId: separator > 0 ? model.slice(0, separator) : undefined,
      modelId: separator > 0 ? model.slice(separator + 2) : model === "codeforge-auto" ? "auto" : model,
    };
  }

  private async postInference(body: string, signal: AbortSignal | undefined): Promise<Response> {
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

    let res = await makeRequest(this.getAccessToken ? await this.getAccessToken() : null);

    // Auth recovery: if 401 and onAuthExpired provided, refresh token and retry ONCE
    if (res.status === 401 && this.onAuthExpired) {
      const newToken = await this.onAuthExpired();
      if (newToken) {
        res = await makeRequest(newToken);
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
    return res;
  }

  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    await this.requireCompatibleCloud();
    const needsToolTransport =
      (req.tools?.length ?? 0) > 0 ||
      req.messages.some((m) => m.role === "tool" || (Array.isArray(m.toolCalls) && m.toolCalls.length > 0));

    const { exactProviderId, modelId } = this.splitModel(req.model);
    const messages = req.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.name ? { name: m.name } : {}),
      ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
      ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
    }));

    const body = JSON.stringify({
      requestId: randomUUID(),
      messages,
      modelId,
      ...(exactProviderId ? { providerId: exactProviderId } : {}),
      taskType: "coding",
      ...(needsToolTransport && req.tools?.length ? { tools: req.tools } : {}),
      ...(needsToolTransport && req.maxTokens ? { maxTokens: req.maxTokens } : {}),
    });

    const res = await this.postInference(body, signal);
    const reader = res.body!.getReader();
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
        if (!trimmed.startsWith("data: ")) continue;
        let event: HostedSseEvent;
        try {
          event = JSON.parse(trimmed.slice(6)) as HostedSseEvent;
        } catch {
          continue;
        }

        if (event.type === "assistant.message.delta" && typeof event.delta === "string") {
          yield { type: "text_delta", delta: event.delta };
        } else if (event.type === "assistant.tool_call.started" && event.toolCallId && event.toolName) {
          yield { type: "tool_call_started", toolCallId: event.toolCallId, toolName: event.toolName };
        } else if (event.type === "assistant.tool_call.delta" && event.toolCallId && typeof event.delta === "string") {
          yield { type: "tool_call_delta", toolCallId: event.toolCallId, delta: event.delta };
        } else if (event.type === "assistant.tool_call.completed" && event.toolCallId && event.toolName) {
          yield {
            type: "tool_call_completed",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            arguments: event.arguments ?? "",
          };
        } else if (event.type === "assistant.message.completed") {
          if (event.usage) {
            yield {
              type: "usage",
              usage: {
                inputTokens: event.usage.inputTokens ?? 0,
                outputTokens: event.usage.outputTokens ?? 0,
              },
            };
          }
          yield { type: "finish", finishReason: event.finishReason === "tool_calls" ? "tool_calls" : "stop" };
        } else if (event.type === "turn.failed") {
          throw new Error(event.error || "Turn failed on CodeForge Cloud");
        }
      }
    }
  }
}
