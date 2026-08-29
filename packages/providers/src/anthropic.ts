import type { CredentialStore, ProviderAdapter, ProviderHealthResponse, ProviderModel } from "./index.js";
import { ProviderError } from "./index.js";
import type { ChatRequest, ChatResponse, StreamEvent } from "./chat-types.js";

/**
 * Anthropic Messages API adapter. NOT OpenAI-compatible: `system` is a top-level field,
 * content is block-based, auth is `x-api-key` + `anthropic-version`, and streaming uses
 * Anthropic's own SSE event shape (message_start / content_block_delta / message_stop).
 */
export interface AnthropicOptions {
  credentialStore?: CredentialStore;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  version?: string;
  fetchFn?: typeof fetch;
}

const BASE = "https://api.anthropic.com/v1";
const VERSION = "2023-06-01";

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  tool_use_id?: string;
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly providerId = "anthropic";
  private readonly credentialStore?: CredentialStore;
  private readonly directKey?: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly version: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: AnthropicOptions = {}) {
    this.credentialStore = opts.credentialStore;
    this.directKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? BASE;
    this.timeoutMs = opts.timeoutMs ?? 60000;
    this.version = opts.version ?? VERSION;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private getApiKey(): string {
    const key = this.directKey ?? this.credentialStore?.get("anthropic");
    if (!key) throw new ProviderError("Anthropic credential not configured.", "MISSING_API_KEY");
    return key;
  }

  private headers(key: string): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": this.version,
    };
  }

  /**
   * Anthropic has no public dynamic /models listing usable without extra setup; the catalog
   * comes from Models.dev. listModels returns [] so discovery flows through the registry.
   */
  async listModels(): Promise<ProviderModel[]> {
    return [];
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const key = this.getApiKey();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: this.headers(key),
        body: JSON.stringify(this.toRequest(req, false)),
        signal: controller.signal,
      });
      if (!res.ok) throw this.handleError(res.status, await safeText(res));
      const data = (await res.json()) as AnthropicResponse;
      return this.fromResponse(data, req.model);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if (e instanceof Error && e.name === "AbortError") {
        throw new ProviderError("Anthropic request timed out", "TIMEOUT", true);
      }
      throw new ProviderError(`Anthropic chat failed: ${e instanceof Error ? e.message : String(e)}`, "CHAT_FAILED", true);
    } finally {
      clearTimeout(timeout);
    }
  }

  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const key = this.getApiKey();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort);
    }
    try {
      const res = await this.fetchFn(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: this.headers(key),
        body: JSON.stringify(this.toRequest(req, true)),
        signal: controller.signal,
      });
      if (!res.ok) throw this.handleError(res.status, await safeText(res));
      if (!res.body) throw new ProviderError("Anthropic returned no body", "NO_BODY", true);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const toolBlocks = new Map<number, { id: string; name: string; args: string }>();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const payload = t.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let evt: AnthropicStreamEvent;
          try {
            evt = JSON.parse(payload) as AnthropicStreamEvent;
          } catch {
            continue;
          }
          if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use") {
            const idx = evt.index ?? 0;
            const id = evt.content_block.id ?? `call_${idx}`;
            const name = evt.content_block.name ?? "";
            toolBlocks.set(idx, { id, name, args: "" });
            yield { type: "tool_call_started", toolCallId: id, toolName: name };
          } else if (evt.type === "content_block_delta") {
            const idx = evt.index ?? 0;
            if (evt.delta?.type === "text_delta" && evt.delta.text) {
              yield { type: "text_delta", delta: evt.delta.text };
            } else if (evt.delta?.type === "input_json_delta" && evt.delta.partial_json !== undefined) {
              const tb = toolBlocks.get(idx);
              if (tb) {
                tb.args += evt.delta.partial_json;
                yield { type: "tool_call_delta", toolCallId: tb.id, delta: evt.delta.partial_json };
              }
            }
          } else if (evt.type === "content_block_stop") {
            const idx = evt.index ?? 0;
            const tb = toolBlocks.get(idx);
            if (tb) {
              yield { type: "tool_call_completed", toolCallId: tb.id, toolName: tb.name, arguments: tb.args };
              toolBlocks.delete(idx);
            }
          } else if (evt.type === "message_delta" && evt.usage) {
            yield { type: "usage", usage: { inputTokens: evt.usage.input_tokens ?? 0, outputTokens: evt.usage.output_tokens ?? 0 } };
          } else if (evt.type === "message_stop") {
            yield { type: "finish", finishReason: "stop" };
            return;
          }
        }
      }
      yield { type: "finish", finishReason: "stop" };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if (e instanceof Error && e.name === "AbortError") return;
      throw new ProviderError(`Anthropic stream failed: ${e instanceof Error ? e.message : String(e)}`, "STREAM_FAILED", true);
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  async healthCheck(): Promise<ProviderHealthResponse> {
    let key: string;
    try {
      key = this.getApiKey();
    } catch {
      return { status: "auth_required", error: "No credential configured" };
    }
    // Minimal 1-token ping validates auth without meaningful spend.
    const start = Date.now();
    try {
      const res = await this.fetchFn(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: this.headers(key),
        body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      });
      const latencyMs = Date.now() - start;
      if (res.ok) return { status: "available", latencyMs };
      if (res.status === 401 || res.status === 403) return { status: "auth_required", latencyMs };
      if (res.status === 429) return { status: "rate_limited", latencyMs };
      return { status: "degraded", latencyMs, error: `HTTP ${res.status}` };
    } catch (e) {
      return { status: "offline", error: e instanceof Error ? e.message : String(e) };
    }
  }

  private toRequest(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const systemParts: string[] = [];
    if (req.system) systemParts.push(req.system);
    const messages: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] | string }> = [];

    for (const m of req.messages) {
      if (m.role === "system") {
        systemParts.push(m.content);
        continue;
      }
      if (m.role === "tool") {
        messages.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content } as AnthropicBlock],
        });
        continue;
      }
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        const blocks: AnthropicBlock[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const tc of m.toolCalls) {
          blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: safeJson(tc.function.arguments) });
        }
        messages.push({ role: "assistant", content: blocks });
        continue;
      }
      messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
    }

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      messages,
      stream,
    };
    if (systemParts.length > 0) body.system = systemParts.join("\n\n");
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters ?? { type: "object", properties: {} },
      }));
    }
    return body;
  }

  private fromResponse(res: AnthropicResponse, model: string): ChatResponse {
    let text = "";
    const toolCalls: NonNullable<ChatResponse["choices"][number]["message"]["toolCalls"]> = [];
    for (const block of res.content ?? []) {
      if (block.type === "text" && block.text) text += block.text;
      else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id ?? crypto.randomUUID(), type: "function", function: { name: block.name ?? "", arguments: JSON.stringify(block.input ?? {}) } });
      }
    }
    return {
      id: res.id ?? crypto.randomUUID(),
      model: res.model ?? model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text, toolCalls: toolCalls.length > 0 ? toolCalls : undefined },
          finishReason: res.stop_reason === "tool_use" ? "tool_calls" : "stop",
        },
      ],
      usage: res.usage ? { inputTokens: res.usage.input_tokens ?? 0, outputTokens: res.usage.output_tokens ?? 0 } : undefined,
    };
  }

  private handleError(status: number, body: string): ProviderError {
    let code = "PROVIDER_ERROR";
    let retryable = false;
    if (status === 401 || status === 403) code = "AUTH_ERROR";
    else if (status === 402) code = "PAYMENT_REQUIRED";
    else if (status === 404) code = "MODEL_NOT_FOUND";
    else if (status === 429) { code = "RATE_LIMITED"; retryable = true; }
    else if (status >= 500) { code = "PROVIDER_ERROR"; retryable = true; }
    return new ProviderError(`Anthropic error (${status}): ${body.slice(0, 200)}`, code, retryable);
  }
}

interface AnthropicResponse {
  id?: string;
  model?: string;
  content?: AnthropicBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface AnthropicStreamEvent {
  type: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

export function createAnthropicAdapter(opts?: AnthropicOptions): AnthropicAdapter {
  return new AnthropicAdapter(opts);
}
