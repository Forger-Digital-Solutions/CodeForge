import type { CredentialStore, ProviderAdapter, ProviderHealthResponse, ProviderModel, PromptCacheCapability, ProviderResponseObserver } from "./index.js";
import { EnvironmentCredentialStore, ProviderError, quotaHeadersOf } from "./index.js";
import { redactSecrets } from "./redact.js";
import type { ChatRequest, ChatResponse, StreamEvent } from "./chat-types.js";
import {
  CloudflareNeuronBudgetGuard,
  createFailClosedCloudflareNeuronBudgetGuard,
  type CloudflareNeuronReservation,
} from "./cloudflare-neuron-budget.js";
import { createFailClosedGeminiFreePolicyGate, type GeminiFreePolicyGate } from "@codeforge/legal-policy";

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
  /** Provider-specific request fields that are safe for every model behind this adapter. */
  requestBodyExtras?: Record<string, unknown>;
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
  /** Receives status + rate-limit headers of every upstream response (never bodies/credentials). */
  onResponse?: ProviderResponseObserver;
  /**
   * Route-specific request shaping. Some OpenAI-compatible hosts reject fields they do not
   * implement (e.g. `tool_choice`, `stream_options`); a definition can strip them per provider.
   */
  omitRequestFields?: string[];
  /** Required safety gate for Cloudflare Workers AI inference; omitted means fail closed. */
  cloudflareNeuronGuard?: CloudflareNeuronBudgetGuard;
  /** Unpaid Gemini routes require a current policy acceptance and trusted region. */
  geminiFreePolicyGate?: GeminiFreePolicyGate;
  /** Paid Gemini is never selected by Free routing and must be explicitly requested. */
  geminiServiceTier?: "UNPAID" | "PAID";
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
  private readonly cloudflareNeuronGuard?: CloudflareNeuronBudgetGuard;
  private readonly geminiFreePolicyGate?: GeminiFreePolicyGate;
  private readonly geminiServiceTier: "UNPAID" | "PAID";

  constructor(cfg: OpenAICompatibleConfig) {
    // Match OpenRouterAdapter: absent an explicit store, resolve `<PROVIDER>_API_KEY` from the
    // environment — otherwise factory-built adapters fail with MISSING_API_KEY even when the
    // documented env var is set. `credentialStore` may arrive explicitly undefined via the
    // factory's common() spread, so normalize it after merging rather than in the spread.
    this.cfg = { credentialStore: new EnvironmentCredentialStore(), ...cfg };
    this.cfg.credentialStore = cfg.credentialStore ?? new EnvironmentCredentialStore();
    this.providerId = cfg.providerId;
    this.timeoutMs = cfg.timeoutMs ?? 60000;
    this.fetchFn = cfg.fetchFn ?? fetch;
    this.cloudflareNeuronGuard = cfg.providerId === "cloudflare-workers-ai"
      ? cfg.cloudflareNeuronGuard ?? createFailClosedCloudflareNeuronBudgetGuard()
      : undefined;
    this.geminiServiceTier = cfg.geminiServiceTier ?? "UNPAID";
    this.geminiFreePolicyGate = cfg.providerId === "google"
      ? cfg.geminiFreePolicyGate ?? createFailClosedGeminiFreePolicyGate()
      : undefined;
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
    return { "Content-Type": "application/json", ...this.cfg.defaultHeaders, ...auth };
  }

  async listModels(): Promise<ProviderModel[]> {
    const key = this.getApiKey();
    const url = `${this.baseUrl()}${this.cfg.modelsPath ?? "/models"}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(url, { headers: this.headers(key), signal: controller.signal });
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw new ProviderError(`${this.providerId} model discovery timed out`, "TIMEOUT", true);
      }
      throw new ProviderError(
        `${this.providerId} listModels failed: ${e instanceof Error ? e.message : String(e)}`,
        "LIST_MODELS_FAILED",
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
    this.observe(res);
    if (!res.ok) throw this.handleError(res.status, await safeText(res), res);
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
    this.assertGeminiRouteAllowed();
    const key = this.getApiKey();
    const reservation = await this.reserveCloudflare(req);
    let usage: ChatResponse["usage"];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.baseUrl()}/chat/completions`, {
        method: "POST",
        headers: this.headers(key),
        body: JSON.stringify(this.toRequest(req, false)),
        signal: controller.signal,
      });
      this.observe(res, req.model);
      if (!res.ok) throw this.handleError(res.status, await safeText(res), res);
      const data = (await res.json()) as OaiChatResponse;
      const response = this.fromResponse(data);
      usage = response.usage;
      return response;
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
      await this.settleCloudflare(reservation, usage);
    }
  }

  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.assertGeminiRouteAllowed();
    const key = this.getApiKey();
    const reservation = await this.reserveCloudflare(req);
    let usage: ChatResponse["usage"];
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
      this.observe(res, req.model);
      if (!res.ok) throw this.handleError(res.status, await safeText(res), res);
      if (!res.body) throw new ProviderError(`${this.providerId} returned no body`, "NO_BODY", true);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let receivedDone = false;
      let current: { id: string; name: string; arguments: string } | null = null;
      // Wire-level diagnostics (R23): a stream that ends without `[DONE]` must never be a blind
      // spot. OpenAI-compatible hosts (Groq among them) report a failure that happens after the
      // 200 response as an in-band `data: {"error":{...}}` frame; the old parser matched neither
      // `choices` nor `usage` on that frame, dropped it, and the provider's own message vanished
      // into a generic STREAM_INTERRUPTED. The terminal `finish_reason` — not the `[DONE]` trailer —
      // is the protocol's completion marker, so a finished answer is not discarded either.
      let rawBytes = 0;
      let frames = 0;
      let terminalFinish: string | undefined;
      let bodyHead = "";
      const finishEvent = (): StreamEvent => ({ type: "finish", finishReason: normalizeStreamFinish(terminalFinish) });
      const finishTerminal = function* (): Generator<StreamEvent> {
        if (current) {
          yield { type: "tool_call_completed", toolCallId: current.id, toolName: current.name, arguments: current.arguments };
          current = null;
        }
        yield finishEvent();
      };
      const handleLine = function* (this: OpenAICompatibleAdapter, line: string): Generator<StreamEvent, "continue" | "done" | "error"> {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) return "continue";
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") {
          receivedDone = true;
          yield* finishTerminal();
          return "done";
        }
        let parsed: OaiStreamChunk;
        try {
          parsed = JSON.parse(payload) as OaiStreamChunk;
        } catch {
          return "continue";
        }
        frames += 1;
        const inBand = parsed.error ?? parsed.x_groq?.error;
        if (inBand) {
          yield this.inBandStreamError(inBand, res.status);
          return "error";
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
          if (choice.finish_reason === "error") {
            yield {
              type: "error",
              code: "PROVIDER_ERROR",
              message: `${this.providerId} stream finished with finish_reason=error`,
              retryable: true,
              status: res.status,
            };
            return "error";
          }
          if (choice.finish_reason === "tool_calls" && current) {
            yield { type: "tool_call_completed", toolCallId: current.id, toolName: current.name, arguments: current.arguments };
            current = null;
          }
          if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) terminalFinish = choice.finish_reason;
        }
        if (parsed.usage) {
          usage = {
            inputTokens: parsed.usage.prompt_tokens ?? 0,
            outputTokens: parsed.usage.completion_tokens ?? 0,
            totalTokens: parsed.usage.total_tokens,
            ...cachedFieldsFromOaiUsage(parsed.usage),
          };
          yield {
            type: "usage",
            usage,
          };
        }
        return "continue";
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        rawBytes += value.byteLength;
        const text = decoder.decode(value, { stream: true });
        if (bodyHead.length < 400) bodyHead += text.slice(0, 400 - bodyHead.length);
        buffer += text;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const outcome = yield* handleLine.call(this, line);
          if (outcome !== "continue") return;
        }
      }
      // A final frame without a trailing newline is still a frame.
      if (buffer.trim().length > 0) {
        const outcome = yield* handleLine.call(this, buffer);
        if (outcome !== "continue") return;
      }
      if (!receivedDone) {
        if (terminalFinish !== undefined) {
          // The provider sent its terminal chunk but no `[DONE]` trailer — the answer is complete.
          yield* finishTerminal();
          return;
        }
        const safeHead = frames === 0 && rawBytes > 0
          ? `, body: ${redactSecrets(bodyHead, this.cfg.apiKey ?? this.cfg.credentialStore?.get(this.providerId)).replace(/\s+/g, " ").slice(0, 200)}`
          : "";
        throw new ProviderError(
          `${this.providerId} stream ended before the provider sent [DONE] (HTTP ${res.status}, ${rawBytes} byte(s), ${frames} frame(s), no terminal finish_reason${safeHead})`,
          "STREAM_INTERRUPTED",
          true,
          { status: res.status },
        );
      }
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
      await this.settleCloudflare(reservation, usage);
    }
  }

  canRoute(modelId: string): boolean {
    if (this.providerId === "cloudflare-workers-ai") return this.cloudflareNeuronGuard?.canRoute(modelId) === true;
    if (this.providerId === "google" && this.geminiServiceTier === "UNPAID") return this.geminiFreePolicyGate?.evaluate().decision === "ALLOW";
    return true;
  }

  private assertGeminiRouteAllowed(): void {
    if (this.providerId !== "google" || this.geminiServiceTier !== "UNPAID") return;
    const decision = this.geminiFreePolicyGate?.evaluate();
    if (!decision || decision.decision === "ALLOW") return;
    throw new ProviderError(`google route blocked by ${decision.reasonCode}`, decision.reasonCode);
  }

  private async reserveCloudflare(req: ChatRequest): Promise<CloudflareNeuronReservation | undefined> {
    return this.cloudflareNeuronGuard ? this.cloudflareNeuronGuard.reserve(req) : undefined;
  }

  private async settleCloudflare(reservation: CloudflareNeuronReservation | undefined, usage: ChatResponse["usage"]): Promise<void> {
    if (reservation) await reservation.settleUsage(usage);
  }

  async healthCheck(): Promise<ProviderHealthResponse> {
    let key: string;
    try {
      key = this.getApiKey();
    } catch {
      return { status: "auth_required", error: "No credential configured" };
    }
    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.baseUrl()}${this.cfg.modelsPath ?? "/models"}`, { headers: this.headers(key), signal: controller.signal });
      const latencyMs = Date.now() - start;
      if (res.ok) return { status: "available", latencyMs };
      if (res.status === 401 || res.status === 403) return { status: "auth_required", latencyMs };
      if (res.status === 429) return { status: "rate_limited", latencyMs, retryAfter: parseRetryAfter(res) };
      return { status: "degraded", latencyMs, error: `HTTP ${res.status}` };
    } catch (e) {
      return { status: "offline", error: e instanceof Error && e.name === "AbortError" ? "Provider health check timed out" : e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timeout);
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
    const body: Record<string, unknown> = {
      ...this.cfg.requestBodyExtras,
      model: req.model,
      messages,
      tools: req.tools?.map((t) => ({ type: "function" as const, function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters } })),
      tool_choice: req.toolChoice,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      stop: req.stop,
      stream,
    };
    for (const field of this.cfg.omitRequestFields ?? []) delete body[field];
    return body;
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
        ? {
            inputTokens: res.usage.prompt_tokens ?? 0,
            outputTokens: res.usage.completion_tokens ?? 0,
            totalTokens: res.usage.total_tokens,
            ...cachedFieldsFromOaiUsage(res.usage),
          }
        : undefined,
    };
  }

  /**
   * FG-1A. OpenAI-compatible endpoints may cache stable prefixes opaquely; no request shaping
   * is ever applied. cached_tokens telemetry is parsed only when the provider reports it, so
   * providers that do not cache (or do not report) produce no measured savings.
   */
  getPromptCacheCapability(_modelId: string): PromptCacheCapability {
    return {
      mode: "automatic",
      telemetryAvailable: true,
      constraints: ["cached_tokens is counted only when the provider reports prompt_tokens_details"],
    };
  }

  private observe(res: Response, modelId?: string): void {
    if (!this.cfg.onResponse) return;
    try {
      this.cfg.onResponse({ providerId: this.providerId, modelId, status: res.status, headers: quotaHeadersOf(res), observedAt: Date.now() });
    } catch {
      // Observation is advisory; never let a listener break a request.
    }
  }

  /**
   * Maps a provider's in-band stream error frame to a typed error event. Classification prefers
   * the structured fields (numeric `code`, `type`) over message text; the message is redacted and
   * truncated before it can reach a log or an evidence ledger.
   */
  private inBandStreamError(error: OaiStreamError, httpStatus: number): StreamEvent {
    const message = typeof error.message === "string" && error.message.length > 0 ? error.message : "upstream stream error";
    const rawCode = error.code !== undefined && error.code !== null ? String(error.code) : undefined;
    const numericCode = rawCode !== undefined && /^\d{3}$/.test(rawCode) ? Number(rawCode) : undefined;
    const type = typeof error.type === "string" ? error.type.toLowerCase() : "";
    const lowered = message.toLowerCase();
    let code = "PROVIDER_ERROR";
    let retryable = true;
    let status: number | undefined = numericCode;
    if (type === "tool_use_failed" || type === "output_parse_failed" || /tool call validation failed|not in request\.tools|did not match schema|output that could not be parsed|failed to parse tool call/.test(lowered)) {
      // Groq validates tool calls server-side and rejects the whole response (R23 round 3:
      // "attempted to call tool 'json' which was not in request.tools"). The model's output is
      // invalid, not the route — a resample is the right recovery, and the ledger must say so.
      code = "INVALID_TOOL_OUTPUT";
      status ??= 400;
    } else if (numericCode === 429 || /rate.?limit/.test(type) || /rate limit/.test(lowered)) {
      code = "RATE_LIMITED";
      status ??= 429;
    } else if (numericCode === 401 || numericCode === 403 || /auth|permission/.test(type)) {
      code = "AUTH_ERROR";
      retryable = false;
    } else if (numericCode === 402 || /billing|payment/.test(type)) {
      code = "PAYMENT_REQUIRED";
      retryable = false;
    } else if (numericCode === 404 || /model_not_found|not_found/.test(type)) {
      code = "MODEL_NOT_FOUND";
      retryable = false;
    } else if (numericCode !== undefined && numericCode >= 400 && numericCode < 500 && numericCode !== 408) {
      retryable = false;
    } else if (/invalid_request|bad_request/.test(type)) {
      retryable = false;
      status ??= 400;
    } else if (/context.?length|maximum context|too many tokens/.test(lowered)) {
      code = "CONTEXT_LENGTH";
      retryable = false;
    }
    if (numericCode === undefined && status === undefined && (type === "internal_server_error" || type === "server_error" || type === "service_unavailable")) status = type === "service_unavailable" ? 503 : 500;
    const safe = redactSecrets(message, this.cfg.apiKey ?? this.cfg.credentialStore?.get(this.providerId)).slice(0, 300);
    return {
      type: "error",
      code,
      message: `${this.providerId} stream error${rawCode ? ` (${rawCode})` : type ? ` (${type})` : ""} after HTTP ${httpStatus}: ${safe}`,
      retryable,
      ...(status !== undefined && status >= 100 && status <= 599 ? { status } : {}),
    };
  }

  private handleError(status: number, body: string, res?: Response): ProviderError {
    let code = "PROVIDER_ERROR";
    let retryable = false;
    if (status === 401 || status === 403) code = "AUTH_ERROR";
    else if (status === 402) code = "PAYMENT_REQUIRED";
    else if (status === 404) code = "MODEL_NOT_FOUND";
    else if (status === 429) { code = "RATE_LIMITED"; retryable = true; }
    else if (status >= 500) { code = "PROVIDER_ERROR"; retryable = true; }
    // Providers (e.g. Google) can echo the API key back in error bodies — redact before surfacing.
    const safe = redactSecrets(body, this.cfg.apiKey ?? this.cfg.credentialStore?.get(this.providerId)).slice(0, 200);
    return new ProviderError(`${this.providerId} error (${status}): ${safe}`, code, retryable, {
      status,
      retryAfter: res && status === 429 ? parseRetryAfter(res) : undefined,
    });
  }
}

interface OaiChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason?: string }>;
  usage?: OaiUsage;
}

interface OaiStreamError {
  message?: string;
  type?: string;
  code?: string | number | null;
}

interface OaiStreamChunk {
  choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>;
  usage?: OaiUsage;
  /** In-band failure after the 200 response (OpenAI-compatible hosts, Groq, Cloudflare). */
  error?: OaiStreamError;
  /** Groq attaches request metadata (and, on failure, the error) under `x_groq`. */
  x_groq?: { error?: OaiStreamError; usage?: OaiUsage };
}

function normalizeStreamFinish(reason: string | undefined): "stop" | "tool_calls" | "length" | "content_filter" {
  switch (reason) {
    case "tool_calls":
    case "length":
    case "content_filter":
      return reason;
    default:
      return "stop";
  }
}

interface OaiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  /** R23: reasoning-token detail reported by reasoning models on OpenAI-compatible routes. */
  completion_tokens_details?: { reasoning_tokens?: number };
}

function cachedFieldsFromOaiUsage(usage: OaiUsage): { cachedInputTokens?: number; reasoningTokens?: number } {
  const cached = usage.prompt_tokens_details?.cached_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  return {
    ...(typeof cached === "number" && cached >= 0 ? { cachedInputTokens: cached } : {}),
    ...(typeof reasoning === "number" && Number.isFinite(reasoning) && reasoning >= 0 ? { reasoningTokens: Math.floor(reasoning) } : {}),
  };
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
