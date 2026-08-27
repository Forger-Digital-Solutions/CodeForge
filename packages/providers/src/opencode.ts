import type { CredentialStore } from "./index.js";
import { ProviderError, EnvironmentCredentialStore } from "./index.js";
import type { ChatRequest, ChatResponse, StreamEvent } from "./chat-types.js";

export interface ProviderModel {
  modelId: string;
  displayName: string;
  contextWindow?: number;
  capabilities: {
    text: boolean;
    coding: boolean;
    toolCalling: boolean;
    vision: boolean;
    structuredOutput: boolean;
    longContext: boolean;
  };
  isFree: boolean;
  freeStatus: "verified_free" | "unknown" | "paid";
}

export interface ProviderAdapter {
  readonly providerId: string;
  readonly isTestProvider?: boolean;
  listModels(): Promise<ProviderModel[]>;
  chat(req: ChatRequest): Promise<ChatResponse>;
  streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
  healthCheck(): Promise<ProviderHealthResponse>;
}

export interface ProviderHealthResponse {
  status: "available" | "rate_limited" | "offline" | "unknown";
  latencyMs?: number;
  error?: string;
}

export interface OpencodeOptions {
  credentialStore?: CredentialStore;
  baseUrl?: string;
  timeoutMs?: number;
}

const OPENCODE_BASE_URL = "https://opencode.ai/zen/v1";

export class OpencodeAdapter implements ProviderAdapter {
  readonly providerId = "opencode";
  private readonly credentialStore: CredentialStore;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private modelCache: ProviderModel[] | null = null;
  private modelCacheTime = 0;
  private readonly cacheTtlMs = 60000;

  constructor(options: OpencodeOptions = {}) {
    this.credentialStore = options.credentialStore ?? new EnvironmentCredentialStore();
    this.baseUrl = options.baseUrl ?? OPENCODE_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? 60000;
  }

  async listModels(): Promise<ProviderModel[]> {
    const now = Date.now();
    if (this.modelCache && now - this.modelCacheTime < this.cacheTtlMs) {
      return this.modelCache;
    }
    const apiKey = this.getApiKey();
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) {
        throw new ProviderError(`Failed to list models: ${response.status}`, "LIST_MODELS_FAILED");
      }
      const data = (await response.json()) as { data: OpencodeModel[] };
      this.modelCache = data.data.map((m) => this.convertModel(m));
      this.modelCacheTime = now;
      return this.modelCache;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        `Failed to list models: ${error instanceof Error ? error.message : String(error)}`,
        "LIST_MODELS_FAILED",
      );
    }
  }

  private convertModel(m: OpencodeModel): ProviderModel {
    const pricing = m.pricing;
    const isFree = pricing?.prompt === "0" && pricing?.completion === "0";
    return {
      modelId: m.id,
      displayName: m.name ?? m.id,
      contextWindow: m.context_length,
      capabilities: {
        text: true,
        coding: true,
        toolCalling: m.supports_tools ?? true,
        vision: m.architecture?.modality?.includes("image") ?? false,
        structuredOutput: true,
        longContext: (m.context_length ?? 4096) > 32000,
      },
      isFree,
      freeStatus: isFree ? "verified_free" : "paid",
    };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const apiKey = this.getApiKey();
    const body = this.toOpenAIRequest(req);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) {
        const errorBody = await response.text();
        throw this.handleError(response.status, errorBody);
      }
      const data = (await response.json()) as OpencodeChatResponse;
      return this.fromResponse(data);
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof ProviderError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new ProviderError("Request timed out", "TIMEOUT", true);
      }
      throw new ProviderError(`Chat request failed: ${error instanceof Error ? error.message : String(error)}`, "CHAT_FAILED");
    }
  }

  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const apiKey = this.getApiKey();
    const body = { ...this.toOpenAIRequest(req), stream: true };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const combinedSignal = signal ? this.combineSignals(signal, controller.signal) : controller.signal;
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
      });
      clearTimeout(timeout);
      if (!response.ok) {
        const errorBody = await response.text();
        throw this.handleError(response.status, errorBody);
      }
      if (!response.body) throw new ProviderError("No response body", "NO_BODY");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentToolCall: { id: string; name: string; arguments: string } | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") {
            if (currentToolCall) {
              yield { type: "tool_call_completed", toolCallId: currentToolCall.id, toolName: currentToolCall.name, arguments: currentToolCall.arguments };
            }
            yield { type: "finish", finishReason: "stop" };
            return;
          }
          try {
            const parsed = JSON.parse(data) as OpencodeStreamChunk;
            const choice = parsed.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta;
            if (delta?.content) yield { type: "text_delta", delta: delta.content };
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.function?.name && !currentToolCall) {
                  currentToolCall = { id: tc.id, name: tc.function.name, arguments: "" };
                  yield { type: "tool_call_started", toolCallId: tc.id, toolName: tc.function.name };
                }
                if (tc.function?.arguments && currentToolCall) {
                  currentToolCall.arguments += tc.function.arguments;
                  yield { type: "tool_call_delta", toolCallId: currentToolCall.id, delta: tc.function.arguments };
                }
              }
            }
            if (choice.finish_reason === "tool_calls" && currentToolCall) {
              yield { type: "tool_call_completed", toolCallId: currentToolCall.id, toolName: currentToolCall.name, arguments: currentToolCall.arguments };
              currentToolCall = null;
            }
            if (parsed.usage) {
              yield { type: "usage", usage: { inputTokens: parsed.usage.prompt_tokens ?? 0, outputTokens: parsed.usage.completion_tokens ?? 0, totalTokens: parsed.usage.total_tokens } };
            }
          } catch {
            continue;
          }
        }
      }
      yield { type: "finish", finishReason: "stop" };
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof ProviderError) throw error;
      if (error instanceof Error && error.name === "AbortError") return;
      throw new ProviderError(`Stream failed: ${error instanceof Error ? error.message : String(error)}`, "STREAM_FAILED", true);
    }
  }

  async healthCheck(): Promise<ProviderHealthResponse> {
    try {
      const apiKey = this.getApiKey();
      const response = await fetch(`${this.baseUrl}/models`, {
        method: "HEAD",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      return { status: response.ok ? "available" : "offline", latencyMs: undefined };
    } catch {
      return { status: "offline" };
    }
  }

  private getApiKey(): string {
    const apiKey = this.credentialStore.get("opencode");
    if (!apiKey) {
      throw new ProviderError("Opencode API key not configured. Set OPENCODE_API_KEY environment variable.", "MISSING_API_KEY");
    }
    return apiKey;
  }

  private toOpenAIRequest(req: ChatRequest): Record<string, unknown> {
    const messages: Array<Record<string, unknown>> = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    for (const msg of req.messages) {
      messages.push({
        role: msg.role,
        content: msg.content,
        name: msg.name,
        tool_calls: msg.toolCalls?.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } })),
        tool_call_id: msg.toolCallId,
      });
    }
    return {
      model: req.model,
      messages,
      tools: req.tools?.map((t) => ({ type: "function", function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters } })),
      temperature: req.temperature,
      max_tokens: req.maxTokens,
    };
  }

  private fromResponse(res: OpencodeChatResponse): ChatResponse {
    return {
      id: res.id,
      model: res.model,
      choices: res.choices.map((c, i) => ({
        index: i,
        message: {
          role: c.message.role as ChatResponse["choices"][0]["message"]["role"],
          content: c.message.content ?? "",
          toolCalls: c.message.tool_calls?.map((tc) => ({ id: tc.id, type: "function" as const, function: { name: tc.function.name, arguments: tc.function.arguments } })),
        },
        finishReason: (c.finish_reason as ChatResponse["choices"][0]["finishReason"]) ?? "stop",
      })),
      usage: res.usage ? { inputTokens: res.usage.prompt_tokens, outputTokens: res.usage.completion_tokens, totalTokens: res.usage.total_tokens } : undefined,
    };
  }

  private handleError(status: number, body: string): ProviderError {
    let retryable = false;
    let code = "PROVIDER_ERROR";
    if (status === 401) code = "AUTH_ERROR";
    else if (status === 402) code = "PAYMENT_REQUIRED";
    else if (status === 429) { code = "RATE_LIMITED"; retryable = true; }
    else if (status === 503) { code = "MODEL_OVERLOADED"; retryable = true; }
    else if (status >= 500) { code = "PROVIDER_ERROR"; retryable = true; }
    return new ProviderError(`Opencode error (${status}): ${body.slice(0, 200)}`, code, retryable);
  }

  private combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
    const controller = new AbortController();
    const abort = () => controller.abort();
    a.addEventListener("abort", abort);
    b.addEventListener("abort", abort);
    return controller.signal;
  }
}

interface OpencodeModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { modality?: string[] };
  supports_tools?: boolean;
}

interface OpencodeChatResponse {
  id: string;
  model: string;
  choices: Array<{ index: number; message: { role: string; content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason?: string }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface OpencodeStreamChunk {
  choices?: Array<{ delta: { content?: string; tool_calls?: Array<{ id: string; function: { name?: string; arguments?: string } }> }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export function createOpencodeAdapter(options?: OpencodeOptions): OpencodeAdapter {
  return new OpencodeAdapter(options);
}
