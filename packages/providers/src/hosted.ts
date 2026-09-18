import { randomUUID } from "node:crypto";
import type { ChatRequest, ChatResponse, StreamEvent, ToolCall } from "./chat-types.js";
import type { ProviderAdapter, ProviderModel, ProviderHealthResponse } from "./index.js";
import { normalizeMessagesForTextTools, parseTextToolCalls } from "./hosted-text-tools.js";

export interface HostedProviderOptions {
  cloudApiUrl?: string;
  getAccessToken?: () => Promise<string | null> | string | null;
  onAuthExpired?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
}

/**
 * Cloud capability negotiation: a gateway that understands the native tools
 * extension advertises "HOSTED_TOOLS" in /v1/meta `features`. Anything older
 * (the deployed v0.2.0 line) answers without it, and the adapter transparently
 * drives the same chat endpoint with the text-level tool contract instead — so
 * Managed Free executes the CodeForge tool loop on the gateway that exists
 * TODAY and upgrades itself the day a newer gateway ships.
 */
const HOSTED_TOOLS_FEATURE = "HOSTED_TOOLS";

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
  private metaProbe?: Promise<boolean>;

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

  /** True when the gateway advertises native hosted tools. Never throws; unknown → false. */
  private supportsNativeTools(): Promise<boolean> {
    this.metaProbe ??= (async () => {
      try {
        const res = await this.fetchFn(`${this.cloudApiUrl}/v1/meta`);
        if (!res.ok) return false;
        const meta = (await res.json()) as { features?: unknown };
        return Array.isArray(meta.features) && meta.features.includes(HOSTED_TOOLS_FEATURE);
      } catch {
        return false;
      }
    })();
    return this.metaProbe;
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
    const needsToolTransport =
      (req.tools?.length ?? 0) > 0 ||
      req.messages.some((m) => m.role === "tool" || (Array.isArray(m.toolCalls) && m.toolCalls.length > 0));
    const native = needsToolTransport && (await this.supportsNativeTools());
    const textToolMode = needsToolTransport && !native;

    const { exactProviderId, modelId } = this.splitModel(req.model);
    const messages = native
      ? req.messages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.name ? { name: m.name } : {}),
          ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
          ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
        }))
      : normalizeMessagesForTextTools(req.messages, req.tools);

    const body = JSON.stringify({
      requestId: randomUUID(),
      messages,
      modelId,
      ...(exactProviderId ? { providerId: exactProviderId } : {}),
      taskType: "coding",
      ...(native && req.tools?.length ? { tools: req.tools } : {}),
      ...(native && req.maxTokens ? { maxTokens: req.maxTokens } : {}),
    });

    const res = await this.postInference(body, signal);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // Text-tool mode buffers the whole response: a <tool_call> payload must never leak into the
    // text stream as if the model said it, so text is emitted only once the call spans are known.
    let fullText = "";

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
          if (textToolMode) {
            fullText += event.delta;
          } else {
            yield { type: "text_delta", delta: event.delta };
          }
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
          if (!textToolMode) {
            yield { type: "finish", finishReason: event.finishReason === "tool_calls" ? "tool_calls" : "stop" };
          }
        } else if (event.type === "turn.failed") {
          throw new Error(event.error || "Turn failed on CodeForge Cloud");
        }
      }
    }

    if (textToolMode) {
      const parsed = parseTextToolCalls(fullText);
      if (parsed.text.length > 0) {
        yield { type: "text_delta", delta: parsed.text };
      }
      for (const [index, call] of parsed.toolCalls.entries()) {
        const id = `text-call-${index + 1}`;
        yield { type: "tool_call_started", toolCallId: id, toolName: call.name };
        yield { type: "tool_call_completed", toolCallId: id, toolName: call.name, arguments: call.arguments };
      }
      if (parsed.toolCalls.length > 0) {
        yield { type: "finish", finishReason: "tool_calls" };
      } else if (parsed.truncated) {
        yield { type: "finish", finishReason: "length" };
      } else {
        yield { type: "finish", finishReason: "stop" };
      }
    }
  }
}
