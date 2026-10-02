import { randomUUID } from "node:crypto";
import type { ChatRequest, ChatResponse, StreamEvent, ToolCall } from "./chat-types.js";
import type { ProviderAdapter, ProviderHealthResponse, ProviderModel, ProviderResponseObserver } from "./index.js";
import { ProviderError, quotaHeadersOf } from "./index.js";
import { normalizeMessagesForTextTools, parseTextToolCalls } from "./hosted-text-tools.js";

export const AI_HORDE_PROVIDER_ID = "ai-horde";
/**
 * AI Horde's documented anonymous API key — published by the provider for any client to use
 * (haidra-assets definitions.md: "Any user using the `0000000000` API key is identified as
 * anonymous"). It is a transport constant, never stored as a user credential.
 */
const AI_HORDE_ANONYMOUS_KEY = "0000000000";
const AI_HORDE_OAI_BASE = "https://oai.aihorde.net/v1";
const AI_HORDE_API_BASE = "https://aihorde.net/api/v2";
/** Community etiquette: Horde asks third-party clients to identify themselves. */
const CLIENT_AGENT = "CodeForge:1.0.0:https://devin.ai";
/** Live-validated: the Horde pipeline rejects max_length below 16 (HTTP 406). */
const MIN_MAX_TOKENS = 16;

export interface AiHordeAdapterOptions {
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  onResponse?: ProviderResponseObserver;
  /** Test seam: point at a stub transport. Defaults are the pinned community endpoints. */
  oaiBaseUrl?: string;
  apiBaseUrl?: string;
}

interface OaiChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    message?: { role?: string; content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface OaiStreamChunk {
  model?: string;
  choices?: Array<{
    delta?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

/**
 * AI Horde community transport.
 *
 * The Horde OpenAI-compatible facade (oai.aihorde.net) serves anonymous chat completions
 * against community worker capacity — one global pool whose only documented admission cost
 * is queue position (kudos, which can never be bought or sold). The facade silently drops the
 * OAI `tools` field, so this adapter drives CodeForge's tool contract through the shared
 * text-tool protocol (`hosted-text-tools`): tool schemas are described in the system prompt,
 * the model emits `<tool_call>` blocks, and they surface as ordinary tool_call stream events.
 * Whether a given model follows the contract is exactly what 8-Bit qualification measures —
 * this transport never claims capability it cannot observe.
 */
export class AiHordeCommunityAdapter implements ProviderAdapter {
  readonly providerId = AI_HORDE_PROVIDER_ID;
  readonly isTestProvider = false;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly onResponse?: ProviderResponseObserver;
  private readonly oaiBase: string;
  private readonly apiBase: string;

  constructor(options: AiHordeAdapterOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchFn = options.fetchFn ?? fetch;
    this.onResponse = options.onResponse;
    this.oaiBase = options.oaiBaseUrl ?? AI_HORDE_OAI_BASE;
    this.apiBase = options.apiBaseUrl ?? AI_HORDE_API_BASE;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AI_HORDE_ANONYMOUS_KEY}`,
      "Client-Agent": CLIENT_AGENT,
    };
  }

  private observe(res: Response, modelId?: string): void {
    this.onResponse?.({
      providerId: this.providerId,
      modelId,
      status: res.status,
      headers: quotaHeadersOf(res),
      observedAt: Date.now(),
    });
  }

  private toBody(req: ChatRequest, stream: boolean): string {
    return JSON.stringify({
      model: req.model,
      // The facade drops `tools`/`tool` roles; the text-tool contract carries the loop.
      messages: normalizeMessagesForTextTools(req.messages, req.tools),
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { max_tokens: Math.max(MIN_MAX_TOKENS, req.maxTokens) } : {}),
      ...(req.stop?.length ? { stop: req.stop } : {}),
    });
  }

  private async handleError(res: Response): Promise<never> {
    const text = await res.text().catch(() => "");
    let message = text;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown; error?: { message?: unknown } };
      const detail = typeof parsed.detail === "string" ? parsed.detail : typeof parsed.message === "string" ? parsed.message : parsed.error?.message;
      if (typeof detail === "string" && detail.length > 0) message = detail;
    } catch {}
    const retryable = res.status === 429 || res.status === 503 || res.status === 502 || res.status >= 500;
    throw new ProviderError(
      `ai-horde request failed: HTTP ${res.status} ${message}`.slice(0, 400),
      res.status === 429 ? "RATE_LIMITED" : res.status === 401 || res.status === 403 ? "AUTH_FAILED" : "PROVIDER_ERROR",
      retryable,
      { status: res.status, retryAfter: Number(res.headers.get("retry-after")) * 1000 || undefined },
    );
  }

  async listModels(): Promise<ProviderModel[]> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.oaiBase}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new ProviderError(`ai-horde model discovery failed: ${e instanceof Error ? e.message : String(e)}`, "LIST_MODELS_FAILED", true);
    }
    this.observe(res);
    if (!res.ok) await this.handleError(res);
    const data = (await res.json()) as { data?: unknown[] };
    const out: ProviderModel[] = [];
    for (const raw of Array.isArray(data.data) ? data.data : []) {
      if (typeof raw !== "object" || raw === null) continue;
      const m = raw as Record<string, unknown>;
      const id = typeof m.id === "string" ? m.id : "";
      if (!id || /embed|whisper|image|vision|moderation|tts|rerank/i.test(id)) continue;
      const contextWindow = typeof m.context_length === "number" ? m.context_length
        : typeof (m as { max_context_length?: unknown }).max_context_length === "number" ? (m as { max_context_length: number }).max_context_length
        : undefined;
      out.push({
        modelId: id,
        displayName: id,
        contextWindow,
        // The adapter itself supplies the tool-call contract; whether THIS model follows it is
        // what qualification verifies — identical contract surface to the hosted free route.
        capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: (contextWindow ?? 0) >= 64_000 },
        isFree: true,
        // Zero-cash by provider design: community workers donate capacity and Horde's kudos
        // economy cannot be purchased (haidra-assets docs/kudos.md). Verified per release.
        freeStatus: "verified_free",
      });
    }
    return out;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    let res: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      res = await this.fetchFn(`${this.oaiBase}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: this.toBody(req, false),
        signal: controller.signal,
      });
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") throw new ProviderError("ai-horde request timed out", "TIMEOUT", true);
      throw new ProviderError(`ai-horde chat failed: ${e instanceof Error ? e.message : String(e)}`, "CHAT_FAILED", true);
    } finally {
      clearTimeout(timeout);
    }
    this.observe(res, req.model);
    if (!res.ok) await this.handleError(res);
    const data = (await res.json()) as OaiChatResponse;
    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? "";
    const parsed = parseTextToolCalls(content);
    const toolCalls: ToolCall[] = parsed.toolCalls.map((call, i) => ({
      id: `hcall_${randomUUID().slice(0, 8)}_${i}`,
      type: "function" as const,
      function: { name: call.name, arguments: call.arguments },
    }));
    const hasTools = toolCalls.length > 0;
    return {
      id: data.id ?? randomUUID(),
      model: data.model ?? req.model,
      choices: [{
        index: choice?.index ?? 0,
        message: {
          role: "assistant",
          content: parsed.text,
          ...(hasTools ? { toolCalls } : {}),
        },
        finishReason: hasTools ? "tool_calls" : normalizeFinish(choice?.finish_reason),
      }],
      usage: data.usage
        ? {
            inputTokens: data.usage.prompt_tokens ?? 0,
            outputTokens: data.usage.completion_tokens ?? 0,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
    };
  }

  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    let res: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onExternalAbort);
    }
    try {
      res = await this.fetchFn(`${this.oaiBase}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: this.toBody(req, true),
        signal: controller.signal,
      });
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      throw new ProviderError(`ai-horde stream failed: ${e instanceof Error ? e.message : String(e)}`, "STREAM_FAILED", true);
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", onExternalAbort);
    }
    this.observe(res, req.model);
    if (!res.ok) await this.handleError(res);
    if (!res.body) throw new ProviderError("ai-horde returned no body", "NO_BODY", true);

    // The text-tool contract can only be split after the full body arrives (a `<tool_call>`
    // tag may open mid-stream), so deltas buffer internally; the caller still sees an ordinary
    // text + tool_call + finish event sequence.
    let text = "";
    let finishReason: string | undefined;
    let servedModel: string | undefined;
    let usage: { inputTokens: number; outputTokens: number; totalTokens?: number } | undefined;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        let parsed: OaiStreamChunk;
        try {
          parsed = JSON.parse(payload) as OaiStreamChunk;
        } catch {
          continue;
        }
        if (parsed.error) {
          yield { type: "error", code: "PROVIDER_ERROR", message: String(parsed.error.message ?? "stream error").slice(0, 300), retryable: true, status: res.status };
          return;
        }
        if (typeof parsed.model === "string" && parsed.model.length > 0) servedModel = parsed.model;
        const choice = parsed.choices?.[0];
        const delta = choice?.delta?.content;
        if (typeof delta === "string") text += delta;
        if (typeof choice?.finish_reason === "string" && choice.finish_reason.length > 0) finishReason = choice.finish_reason;
        if (parsed.usage) {
          usage = { inputTokens: parsed.usage.prompt_tokens ?? 0, outputTokens: parsed.usage.completion_tokens ?? 0, totalTokens: parsed.usage.total_tokens };
        }
      }
    }
    const parsedText = parseTextToolCalls(text);
    if (parsedText.text.length > 0) yield { type: "text_delta", delta: parsedText.text };
    if (usage) yield { type: "usage", usage };
    if (parsedText.toolCalls.length > 0) {
      for (let i = 0; i < parsedText.toolCalls.length; i++) {
        const call = parsedText.toolCalls[i]!;
        const toolCallId = `hcall_${randomUUID().slice(0, 8)}_${i}`;
        yield { type: "tool_call_started", toolCallId, toolName: call.name };
        yield { type: "tool_call_completed", toolCallId, toolName: call.name, arguments: call.arguments };
      }
      yield { type: "finish", finishReason: "tool_calls", ...(servedModel ? { model: servedModel } : {}) };
      return;
    }
    yield { type: "finish", finishReason: normalizeFinish(finishReason), ...(servedModel ? { model: servedModel } : {}) };
  }

  async healthCheck(): Promise<ProviderHealthResponse> {
    const start = Date.now();
    try {
      const res = await this.fetchFn(`${this.apiBase}/heartbeat`, {
        headers: { "Client-Agent": CLIENT_AGENT },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { status: res.status === 429 ? "rate_limited" : "offline", error: `HTTP ${res.status}`, latencyMs: Date.now() - start };
      return { status: "available", latencyMs: Date.now() - start };
    } catch (err) {
      return { status: "offline", error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Horde publishes the shared anonymous account's parallel-generation ceiling on
   * /find_user (`concurrency` less live `active_generations.text`). Translated into the
   * concurrency-observation vocabulary — the same metering that bounds this pool's holds.
   */
  async probeAccountQuota(): Promise<boolean> {
    if (!this.onResponse) return false;
    try {
      const res = await this.fetchFn(`${this.apiBase}/find_user`, {
        headers: { apikey: AI_HORDE_ANONYMOUS_KEY, "Client-Agent": CLIENT_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as {
        concurrency?: unknown;
        active_generations?: { text?: unknown[] };
      };
      if (typeof body.concurrency !== "number" || body.concurrency <= 0) return false;
      const active = Array.isArray(body.active_generations?.text) ? body.active_generations.text.length : 0;
      this.onResponse({
        providerId: this.providerId,
        modelId: undefined,
        status: 200,
        headers: [
          ["x-capacity-limit-concurrency", String(body.concurrency)],
          ["x-capacity-remaining-concurrency", String(Math.max(0, body.concurrency - active))],
        ],
        observedAt: Date.now(),
      });
      return true;
    } catch {
      return false;
    }
  }
}

function normalizeFinish(reason: string | null | undefined): NonNullable<ChatResponse["choices"][number]["finishReason"]> {
  if (reason === "tool_calls" || reason === "length" || reason === "content_filter" || reason === "error") return reason;
  return "stop";
}

export function createAiHordeCommunityAdapter(options: AiHordeAdapterOptions = {}): AiHordeCommunityAdapter {
  return new AiHordeCommunityAdapter(options);
}
