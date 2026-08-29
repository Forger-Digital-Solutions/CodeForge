import type { CredentialStore, ProviderAdapter, ProviderHealthResponse, ProviderModel } from "./index.js";
import { ProviderError } from "./index.js";
import type { ChatRequest, ChatResponse, StreamEvent } from "./chat-types.js";

/**
 * Canonical OpenAI-compatible transport. One maintainable adapter for every provider that
 * speaks the OpenAI Chat Completions protocol — OpenRouter, Z.AI, Groq, Cloudflare Workers AI,
 * Google Gemini (OpenAI-compat endpoint) and OpenAI itself. Providers differ only by base URL,
 * auth header, and default headers, expressed via {@link OpenAICompatibleConfig}. No hand-written
 * HTTP scattered per provider; no Python daemon; no hosted gateway hop.
 */
export interface OpenAICompatibleConfig {
  providerId: string;
  baseUrl: string;
  credentialStore?: CredentialStore;
  /** Direct API key (overrides the credential store when set). */
  apiKey?: string;
  timeoutMs?: number;
  /** Extra headers sent on every request (e.g. OpenRouter attribution). */
  defaultHeaders?: Record<string, string>;
  /** Builds the auth header(s) from the resolved key. Defaults to `Authorization: Bearer <key>`. */
  authHeader?: (key: string) => Record<string, string>;
  /** Path for model listing relative to baseUrl. Default "/models". */
  modelsPath?: string;
  /** Resolve `${VAR}` templates in baseUrl (e.g. CLOUDFLARE_ACCOUNT_ID). */
  resolveBaseUrl?: (baseUrl: string) => string;
  /** Map an upstream model listing entry into a ProviderModel (provider-specific shapes). */
  mapModel?: (raw: unknown) => ProviderModel | null;
  /** Injectable fetch (defaults to global fetch). Used for tests and custom transports. */
  fetchFn?: typeof fetch;
}

interface OaiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly providerId: string;
  private readonly cfg: OpenAICompatibleConfig;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(cfg: OpenAICompatibleConfig) {
    this.cfg = cfg;
    this.providerId = cfg.providerId;
    this.timeoutMs = cfg.timeoutMs ?? 60000;
    this.fetchFn = cfg.fetchFn ?? fetch;
  }

  private baseUrl(): string {
    return this.cfg.resolveBaseUrl ? this.cfg.resolveBaseUrl(this.cfg.baseUrl) : this.cfg.baseUrl;
  }

  private getApiKey(): string {
    const key = this.cfg.apiKey ?? this.cfg.credentialStore?.get(this.providerId);
    if (!key) {
      throw new ProviderError(
        `${this.providerId} credential not configured.`,
        "MISSING_API_KEY",
      );
    }
    return key;
  }

  private headers(key: string): Record<string, string> {
    const auth = this.cfg.authHeader ? this.cfg.authHeader(key) : { Authorization: `Bearer ${key}` };
    return { "Content-Type": "application/json", ...(this.cfg.defaultHeaders ?? {}), ...auth };
  }

  async listModels(): Promise<ProviderModel[]> {
    const key = this.getApiKey();
    const url = `${this.baseUrl()}${this.cfg.modelsPath ?? "/models"}`;
    let res: Response;
    try {
      res = await this.fetchFn(url, { headers: this.headers(key) });
    } catch (e) {
      throw new ProviderError(
        `${this.providerId} listModels failed: ${e instanceof Error ? e.message : String(e)}`,
        "LIST_MODELS_FAILED",
        true,
      );
    }
    if (!res.ok) throw this.handleError(res.status, await safeText(res));
    const data = (await res.json()) as { data?: unknown[] };
    const list = Array.isArray(data.data) ? data.data : [];
    const mapper = this.cfg.mapModel ?? defaultMapModel;
    const out: ProviderModel[] = [];
    for (const raw of list) {
      const m = mapper(raw);
      if (m) out.push(m);
    }
    return out;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const key = this.getApiKey();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.baseUrl()}/chat/completions`, {
        method: "POST",
        headers: this.headers(key),
        body: JSON.stringify(this.toRequest(req, false)),
        signal: controller.signal,
      });
      if (!res.ok) throw this.handleError(res.status, await safeText(res));
      const data = (await res.json()) as OaiChatResponse;
      return this.fromResponse(data);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if (e instanceof Error && e.name === "AbortError") {
        throw new ProviderError(`${this.providerId} request timed out`, "TIMEOUT", true);
      }
      throw new ProviderError(
        `${this.providerId} chat failed: ${e instanceof Error ? e.message : String(e)}`,
        "CHAT_FAILED",
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const key = this.getApiKey();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onExternalAbort);
    }
    try {
      const res = await this.fetchFn(`${this.baseUrl()}/chat/completions`, {
        method: "POST",
        headers: this.headers(key),
        body: JSON.stringify(this.toRequest(req, true)),
        signal: controller.signal,
      });
      if (!res.ok) throw this.handleError(res.status, await safeText(res));
      if (!res.body) throw new ProviderError(`${this.providerId} returned no body`, "NO_BODY", true);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let current: { id: string; name: string; arguments: string } | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") {
            if (current) {
              yield { type: "tool_call_completed", toolCallId: current.id, toolName: current.name, arguments: current.arguments };
              current = null;
            }
            yield { type: "finish", finishReason: "stop" };
            return;
          }
          let parsed: OaiStreamChunk;
          try {
            parsed = JSON.parse(payload) as OaiStreamChunk;
          } catch {
            continue;
          }
          const choice = parsed.choices?.[0];
          if (choice) {
            const delta = choice.delta;
            if (delta?.content) yield { type: "text_delta", delta: delta.content };
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.function?.name && !current) {
                  current = { id: tc.id ?? `call_${Date.now()}`, name: tc.function.name, arguments: "" };
                  yield { type: "tool_call_started", toolCallId: current.id, toolName: current.name };
                }
                if (tc.function?.arguments && current) {
                  current.arguments += tc.function.arguments;
                  yield { type: "tool_call_delta", toolCallId: current.id, delta: tc.function.arguments };
                }
              }
            }
            if (choice.finish_reason === "tool_calls" && current) {
              yield { type: "tool_call_completed", toolCallId: current.id, toolName: current.name, arguments: current.arguments };
              current = null;
            }
          }
          if (parsed.usage) {
            yield {
              type: "usage",
              usage: {
                inputTokens: parsed.usage.prompt_tokens ?? 0,
                outputTokens: parsed.usage.completion_tokens ?? 0,
                totalTokens: parsed.usage.total_tokens,
              },
            };
          }
        }
      }
      yield { type: "finish", finishReason: "stop" };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if (e instanceof Error && e.name === "AbortError") return;
      throw new ProviderError(
        `${this.providerId} stream failed: ${e instanceof Error ? e.message : String(e)}`,
        "STREAM_FAILED",
        true,
      );
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", onExternalAbort);
    }
  }

  async healthCheck(): Promise<ProviderHealthResponse> {
    let key: string;
    try {
      key = this.getApiKey();
    } catch {
      return { status: "auth_required", error: "No credential configured" };
    }
    const start = Date.now();
    try {
      const res = await this.fetchFn(`${this.baseUrl()}${this.cfg.modelsPath ?? "/models"}`, { headers: this.headers(key) });
      const latencyMs = Date.now() - start;
      if (res.ok) return { status: "available", latencyMs };
      if (res.status === 401 || res.status === 403) return { status: "auth_required", latencyMs };
      if (res.status === 429) return { status: "rate_limited", latencyMs, retryAfter: parseRetryAfter(res) };
      return { status: "degraded", latencyMs, error: `HTTP ${res.status}` };
    } catch (e) {
      return { status: "offline", error: e instanceof Error ? e.message : String(e) };
    }
  }

  private toRequest(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const messages: OaiMessage[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    for (const m of req.messages) {
      messages.push({
        role: m.role,
        content: m.content,
        name: m.name,
        tool_calls: m.toolCalls?.map((tc) => ({ id: tc.id, type: "function" as const, function: { name: tc.function.name, arguments: tc.function.arguments } })),
        tool_call_id: m.toolCallId,
      });
    }
    return {
      model: req.model,
      messages,
      tools: req.tools?.map((t) => ({ type: "function" as const, function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters } })),
      tool_choice: req.toolChoice,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      stop: req.stop,
      stream,
    };
  }

  private fromResponse(res: OaiChatResponse): ChatResponse {
    return {
      id: res.id ?? crypto.randomUUID(),
      model: res.model ?? "unknown",
      choices: (res.choices ?? []).map((c, i) => ({
        index: i,
        message: {
          role: "assistant",
          content: c.message?.content ?? "",
          toolCalls: c.message?.tool_calls?.map((tc) => ({ id: tc.id, type: "function" as const, function: { name: tc.function.name, arguments: tc.function.arguments } })),
        },
        finishReason: (c.finish_reason as ChatResponse["choices"][number]["finishReason"]) ?? "stop",
      })),
      usage: res.usage
        ? { inputTokens: res.usage.prompt_tokens ?? 0, outputTokens: res.usage.completion_tokens ?? 0, totalTokens: res.usage.total_tokens }
        : undefined,
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
    return new ProviderError(`${this.providerId} error (${status}): ${body.slice(0, 200)}`, code, retryable);
  }
}

interface OaiChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface OaiStreamChunk {
  choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function parseRetryAfter(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const secs = Number(h);
  if (!Number.isNaN(secs)) return Date.now() + secs * 1000;
  const date = Date.parse(h);
  return Number.isNaN(date) ? undefined : date;
}

/** Default mapper for the standard OpenAI `/models` listing shape. */
function defaultMapModel(raw: unknown): ProviderModel | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const id = typeof m.id === "string" ? m.id : undefined;
  if (!id) return null;
  return {
    modelId: id,
    displayName: typeof m.name === "string" ? m.name : id,
    contextWindow: typeof m.context_length === "number" ? m.context_length : undefined,
    capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: false },
    isFree: false,
    freeStatus: "unknown",
  };
}

export function createOpenAICompatibleAdapter(cfg: OpenAICompatibleConfig): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter(cfg);
}
