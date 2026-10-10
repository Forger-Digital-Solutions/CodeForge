import { randomUUID } from "node:crypto";
import type { ChatRequest, ChatResponse, StreamEvent, ToolCall, ToolDefinition } from "./chat-types.js";
import type { ProviderAdapter, ProviderHealthResponse, ProviderModel, ProviderResponseObserver } from "./index.js";
import { ProviderError, quotaHeadersOf } from "./index.js";

export const AI_HORDE_PROVIDER_ID = "ai-horde";
const AI_HORDE_ANONYMOUS_KEY = "0000000000";
const AI_HORDE_API_BASE = "https://aihorde.net/api/v2";
const AI_HORDE_GEMMA4_MODEL = "google/gemma-4-31b";
const CLIENT_AGENT = "CodeForge:0.4.0:https://github.com/Forger-Digital-Solutions/CodeForge";
const GEMMA_STRING_MARKER = "<|\"|>";
const GEMMA_TOOL_OPEN = "<|tool_call>";
const GEMMA_TOOL_CLOSE = "<|tool_call|>";
const STATUS_POLL_INTERVAL_MS = 1_200;
const MAX_CONTEXT_LENGTH = 8_192;

export interface AiHordeAdapterOptions {
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  onResponse?: ProviderResponseObserver;
  apiBaseUrl?: string;
}

interface TextGenerationStatus {
  done?: boolean;
  faulted?: boolean;
  is_possible?: boolean;
  generations?: Array<{
    model?: string;
    text?: string;
    state?: string;
  }>;
}

interface TextGenerationAccepted {
  id?: string;
  message?: string;
  kudos?: number;
}

interface GemmaParseResult {
  value: unknown;
  next: number;
}

function gemmaString(value: string): string {
  return `${GEMMA_STRING_MARKER}${value}${GEMMA_STRING_MARKER}`;
}

function encodeGemmaValue(value: unknown): string {
  if (typeof value === "string") return gemmaString(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(encodeGemmaValue).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return `{${entries.map(([key, child]) => `${key}:${encodeGemmaValue(child)}`).join(",")}}`;
  }
  return "null";
}

function normalizedSchemaValue(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalizedSchemaValue(entry));
  if (typeof value !== "object" || value === null) {
    return key === "type" && typeof value === "string" ? value.toUpperCase() : value;
  }
  const input = value as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const field of ["description", "enum", "items", "properties", "required", "type"]) {
    if (field in input) fields[field] = normalizedSchemaValue(input[field], field);
  }
  return fields;
}

function toolDeclaration(tool: ToolDefinition): string {
  const schema = normalizedSchemaValue(tool.function.parameters ?? { type: "object", properties: {} });
  return `<|tool>declaration:${tool.function.name}{description:${gemmaString(tool.function.description)},parameters:${encodeGemmaValue(schema)}}<tool|>`;
}

function callNameAndArgs(raw: unknown): { id?: string; name?: string; arguments: unknown } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const call = raw as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
  const name = typeof call.function?.name === "string" ? call.function.name : undefined;
  if (!name) return undefined;
  let args: unknown = call.function?.arguments ?? {};
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { args = { value: args }; }
  }
  return { ...(typeof call.id === "string" ? { id: call.id } : {}), name, arguments: args };
}

function gemmaPrompt(request: ChatRequest): string {
  const toolByCallId = new Map<string, string>();
  const turns: string[] = [];
  const declarations = (request.tools ?? []).map(toolDeclaration).join("");
  let hasSystem = false;
  for (const message of request.messages) {
    if (message.role === "system") {
      hasSystem = true;
      turns.push(`<|turn>system\n${message.content}${declarations}<turn|>`);
      continue;
    }
    if (message.role === "user") {
      turns.push(`<|turn>user\n${message.content}<turn|>`);
      continue;
    }
    if (message.role === "assistant") {
      const calls = Array.isArray(message.toolCalls)
        ? message.toolCalls.map(callNameAndArgs).filter((call): call is NonNullable<typeof call> => call !== undefined)
        : [];
      if (calls.length > 0) {
        const blocks = calls.map((call) => {
          if (call.id) toolByCallId.set(call.id, call.name!);
          return `${GEMMA_TOOL_OPEN}call:${call.name}{${Object.entries((call.arguments && typeof call.arguments === "object" ? call.arguments : {}) as Record<string, unknown>).map(([key, value]) => `${key}:${encodeGemmaValue(value)}`).join(",")}}${GEMMA_TOOL_CLOSE}<|tool_response>`;
        }).join("");
        turns.push(`<|turn>model\n${message.content}${blocks}`);
      } else {
        turns.push(`<|turn>model\n${message.content}<turn|>`);
      }
      continue;
    }
    const name = message.name || (message.toolCallId ? toolByCallId.get(message.toolCallId) : undefined) || "tool";
    turns.push(`response:${name}{result:${gemmaString(message.content)}}<|tool_response|>`);
  }
  if (!hasSystem && declarations) turns.unshift(`<|turn>system\n${declarations}<turn|>`);
  turns.push("<|turn>model\n");
  return turns.join("\n");
}

function skipWhitespace(input: string, index: number): number {
  while (index < input.length && /\s/.test(input[index]!)) index++;
  return index;
}

function parseGemmaValue(input: string, start: number): GemmaParseResult | undefined {
  let index = skipWhitespace(input, start);
  if (input.startsWith(GEMMA_STRING_MARKER, index)) {
    const valueStart = index + GEMMA_STRING_MARKER.length;
    const valueEnd = input.indexOf(GEMMA_STRING_MARKER, valueStart);
    if (valueEnd < 0) return undefined;
    return { value: input.slice(valueStart, valueEnd), next: valueEnd + GEMMA_STRING_MARKER.length };
  }
  const opening = input[index];
  if (opening === "{" || opening === "[") {
    const closing = opening === "{" ? "}" : "]";
    const entries: Array<[string, unknown]> = [];
    const values: unknown[] = [];
    index++;
    for (;;) {
      index = skipWhitespace(input, index);
      while (input[index] === ",") index = skipWhitespace(input, index + 1);
      if (input[index] === closing) return { value: opening === "{" ? Object.fromEntries(entries) : values, next: index + 1 };
      if (index >= input.length) return undefined;
      if (opening === "{") {
        const keyMatch = /^[A-Za-z0-9_.-]+/.exec(input.slice(index));
        if (!keyMatch) return undefined;
        const key = keyMatch[0];
        index += key.length;
        index = skipWhitespace(input, index);
        if (input[index] !== ":") return undefined;
        const parsed = parseGemmaValue(input, index + 1);
        if (!parsed) return undefined;
        entries.push([key, parsed.value]);
        index = parsed.next;
      } else {
        const parsed = parseGemmaValue(input, index);
        if (!parsed) return undefined;
        values.push(parsed.value);
        index = parsed.next;
      }
      index = skipWhitespace(input, index);
      if (input[index] !== "," && input[index] !== closing) return undefined;
    }
  }
  const end = (() => {
    let cursor = index;
    while (cursor < input.length && input[cursor] !== "," && input[cursor] !== "}" && input[cursor] !== "]" && !/\s/.test(input[cursor]!)) cursor++;
    return cursor;
  })();
  if (end === index) return undefined;
  const token = input.slice(index, end);
  if (token === "true") return { value: true, next: end };
  if (token === "false") return { value: false, next: end };
  if (token === "null") return { value: null, next: end };
  const numeric = Number(token);
  return { value: Number.isFinite(numeric) ? numeric : token, next: end };
}

function parseGemmaToolCalls(text: string): { text: string; toolCalls: Array<{ name: string; arguments: string }> } {
  const toolCalls: Array<{ name: string; arguments: string }> = [];
  const remaining: string[] = [];
  let cursor = 0;
  for (;;) {
    const open = text.indexOf(GEMMA_TOOL_OPEN, cursor);
    if (open < 0) {
      remaining.push(text.slice(cursor));
      break;
    }
    remaining.push(text.slice(cursor, open));
    const callStart = open + GEMMA_TOOL_OPEN.length;
    if (!text.startsWith("call:", callStart)) {
      remaining.push(text.slice(open, callStart));
      cursor = callStart;
      continue;
    }
    const nameStart = callStart + 5;
    const brace = text.indexOf("{", nameStart);
    if (brace < 0) { remaining.push(text.slice(open)); break; }
    const name = text.slice(nameStart, brace).trim();
    const args = parseGemmaValue(text, brace);
    if (!name || !args || typeof args.value !== "object" || args.value === null || Array.isArray(args.value)
      || !text.startsWith(GEMMA_TOOL_CLOSE, args.next)) {
      remaining.push(text.slice(open, args?.next ?? callStart));
      cursor = args?.next ?? callStart;
      continue;
    }
    toolCalls.push({ name, arguments: JSON.stringify(args.value) });
    cursor = args.next + GEMMA_TOOL_CLOSE.length;
    if (text.startsWith("<|tool_response>", cursor)) cursor += "<|tool_response>".length;
  }
  return { text: remaining.join("").trim(), toolCalls };
}

export class AiHordeCommunityAdapter implements ProviderAdapter {
  readonly providerId = AI_HORDE_PROVIDER_ID;
  readonly isTestProvider = false;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly onResponse?: ProviderResponseObserver;
  private readonly apiBase: string;

  constructor(options: AiHordeAdapterOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchFn = options.fetchFn ?? fetch;
    this.onResponse = options.onResponse;
    this.apiBase = options.apiBaseUrl ?? AI_HORDE_API_BASE;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      apikey: AI_HORDE_ANONYMOUS_KEY,
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

  private async handleError(res: Response): Promise<never> {
    const text = await res.text().catch(() => "");
    let message = text;
    try {
      const parsed = JSON.parse(text) as { message?: unknown; detail?: unknown; error?: { message?: unknown } };
      const candidate = typeof parsed.message === "string" ? parsed.message
        : typeof parsed.detail === "string" ? parsed.detail
        : parsed.error?.message;
      if (typeof candidate === "string" && candidate.length > 0) message = candidate;
    } catch {}
    const retryable = res.status === 429 || res.status === 502 || res.status === 503 || res.status >= 500;
    throw new ProviderError(
      `ai-horde request failed: HTTP ${res.status} ${message}`.slice(0, 400),
      res.status === 429 ? "RATE_LIMITED" : res.status === 401 || res.status === 403 ? "AUTH_FAILED" : "PROVIDER_ERROR",
      retryable,
      { status: res.status, retryAfter: Number(res.headers.get("retry-after")) * 1000 || undefined },
    );
  }

  private async request<T>(path: string, method: "GET" | "POST" | "DELETE", modelId: string | undefined, signal: AbortSignal, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.apiBase}${path}`, {
        method,
        headers: this.headers(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        throw new ProviderError("ai-horde request timed out or was cancelled", "TIMEOUT", true);
      }
      throw new ProviderError(`ai-horde request failed: ${error instanceof Error ? error.message : String(error)}`, "CHAT_FAILED", true);
    }
    this.observe(res, modelId);
    if (!res.ok) await this.handleError(res);
    return await res.json() as T;
  }

  async listModels(): Promise<ProviderModel[]> {
    let models: unknown;
    try {
      models = await this.request<unknown>("/status/models?type=text", "GET", undefined, AbortSignal.timeout(this.timeoutMs));
    } catch (error) {
      if (error instanceof ProviderError) throw new ProviderError(`ai-horde model discovery failed: ${error.message}`, "LIST_MODELS_FAILED", error.retryable, { status: error.status, retryAfter: error.retryAfter });
      throw error;
    }
    if (!Array.isArray(models)) return [];
    return models.flatMap((entry): ProviderModel[] => {
      if (typeof entry !== "object" || entry === null) return [];
      const row = entry as { name?: unknown; count?: unknown };
      if (row.name !== AI_HORDE_GEMMA4_MODEL || typeof row.count !== "number" || row.count <= 0) return [];
      return [{
        modelId: AI_HORDE_GEMMA4_MODEL,
        displayName: AI_HORDE_GEMMA4_MODEL,
        contextWindow: MAX_CONTEXT_LENGTH,
        capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: false },
        isFree: true,
        freeStatus: "verified_free",
      }];
    });
  }

  private async generate(req: ChatRequest, signal?: AbortSignal): Promise<{ id: string; text: string }> {
    if (req.model !== AI_HORDE_GEMMA4_MODEL) throw new ProviderError("ai-horde has no verified prompt contract for this model", "MODEL_NOT_SUPPORTED", false);
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let requestId: string | undefined;
    let completed = false;
    try {
      const accepted = await this.request<TextGenerationAccepted>("/generate/text/async", "POST", req.model, requestSignal, {
        prompt: gemmaPrompt(req),
        params: {
          n: 1,
          max_length: Math.max(16, Math.min(req.maxTokens ?? 512, 4096)),
          max_context_length: MAX_CONTEXT_LENGTH,
          temperature: req.temperature ?? 0.2,
          ...(req.stop?.length ? { stop_sequence: req.stop } : {}),
        },
        models: [req.model],
        trusted_workers: true,
        validated_backends: true,
        context_fit: "reject",
      });
      if (typeof accepted.id !== "string" || accepted.id.length === 0) throw new ProviderError("ai-horde accepted no request identifier", "INVALID_RESPONSE", true);
      requestId = accepted.id;
      const deadline = Date.now() + this.timeoutMs;
      while (Date.now() < deadline) {
        requestSignal.throwIfAborted();
        const status = await this.request<TextGenerationStatus>(`/generate/text/status/${encodeURIComponent(requestId)}`, "GET", req.model, requestSignal);
        if (status.faulted) throw new ProviderError("ai-horde generation faulted", "GENERATION_FAULTED", true);
        if (status.is_possible === false) throw new ProviderError("ai-horde has no eligible trusted worker for this request", "NO_AVAILABLE_WORKER", true);
        if (status.done) {
          completed = true;
          const generation = status.generations?.[0];
          if (!generation) throw new ProviderError("ai-horde completed without a text generation", "EMPTY_RESPONSE", true);
          if (generation.model !== req.model) {
            throw new ProviderError(
              "ai-horde did not verify the requested served model",
              generation.model ? "MODEL_SUBSTITUTED" : "SERVED_MODEL_UNVERIFIED",
              true,
            );
          }
          if (generation.state !== "ok" || typeof generation.text !== "string") throw new ProviderError("ai-horde returned a non-successful text generation", "GENERATION_FAILED", true);
          return { id: requestId, text: generation.text };
        }
        await new Promise<void>((resolve) => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));
      }
      throw new ProviderError("ai-horde generation timed out", "TIMEOUT", true);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw new ProviderError("ai-horde generation timed out or was cancelled", "TIMEOUT", true);
      throw new ProviderError(`ai-horde generation failed: ${error instanceof Error ? error.message : String(error)}`, "CHAT_FAILED", true);
    } finally {
      if (requestId && !completed) {
        await this.request(`/generate/text/status/${encodeURIComponent(requestId)}`, "DELETE", req.model, AbortSignal.timeout(5_000)).catch(() => undefined);
      }
    }
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const generated = await this.generate(req);
    const parsed = parseGemmaToolCalls(generated.text);
    const toolCalls: ToolCall[] = parsed.toolCalls.map((call, index) => ({
      id: `hcall_${randomUUID().slice(0, 8)}_${index}`,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
    return {
      id: generated.id,
      model: req.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: parsed.text, ...(toolCalls.length ? { toolCalls } : {}) },
        finishReason: toolCalls.length ? "tool_calls" : "stop",
      }],
    };
  }

  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const generated = await this.generate(req, signal);
    const parsed = parseGemmaToolCalls(generated.text);
    if (parsed.text.length > 0) yield { type: "text_delta", delta: parsed.text };
    for (const [index, call] of parsed.toolCalls.entries()) {
      const toolCallId = `hcall_${randomUUID().slice(0, 8)}_${index}`;
      yield { type: "tool_call_started", toolCallId, toolName: call.name };
      yield { type: "tool_call_completed", toolCallId, toolName: call.name, arguments: call.arguments };
    }
    yield { type: "finish", finishReason: parsed.toolCalls.length ? "tool_calls" : "stop", model: req.model };
  }

  async healthCheck(): Promise<ProviderHealthResponse> {
    const start = Date.now();
    try {
      const res = await this.fetchFn(`${this.apiBase}/heartbeat`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      });
      this.observe(res);
      if (!res.ok) return { status: res.status === 429 ? "rate_limited" : "offline", error: `HTTP ${res.status}`, latencyMs: Date.now() - start };
      return { status: "available", latencyMs: Date.now() - start };
    } catch (error) {
      return { status: "offline", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async probeAccountQuota(): Promise<boolean> {
    if (!this.onResponse) return false;
    try {
      const res = await this.fetchFn(`${this.apiBase}/find_user`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(15_000),
      });
      this.observe(res);
      if (!res.ok) return false;
      const body = await res.json() as { concurrency?: unknown; active_generations?: { text?: unknown[] } };
      if (typeof body.concurrency !== "number" || body.concurrency <= 0) return false;
      const active = Array.isArray(body.active_generations?.text) ? body.active_generations.text.length : 0;
      this.onResponse({
        providerId: this.providerId,
        headers: [
          ["x-capacity-limit-concurrency", String(body.concurrency)],
          ["x-capacity-remaining-concurrency", String(Math.max(0, body.concurrency - active))],
        ],
        status: 200,
        observedAt: Date.now(),
      });
      return true;
    } catch {
      return false;
    }
  }
}

export function createAiHordeCommunityAdapter(options: AiHordeAdapterOptions = {}): AiHordeCommunityAdapter {
  return new AiHordeCommunityAdapter(options);
}
