import crypto from "node:crypto";
import type {
  ChatRequest,
  ChatResponse,
  ProviderAdapter,
  ProviderHealthResponse,
  ProviderModel,
  PromptCacheCapability,
  StreamEvent,
} from "@codeforge/providers";
import type { ModelCallRecord } from "./run-record.js";

/**
 * R23 per-model-call ledger, captured at the provider boundary.
 *
 * The recording adapter wraps a real `ProviderAdapter` and observes every `streamChat` the
 * runtime issues: timing, request size and composition, the provider's own usage event (or its
 * absence — never estimated), finish reason, tool calls, and failures (thrown or in-band). It
 * changes nothing about the call: events are yielded through untouched, aborts propagate, and
 * the wrapped adapter is the only thing that talks to the network.
 *
 * Content is retained in memory for the duration of a run only so the harness can compute exact
 * duplicate-context measurements (protocol §10); persisted records carry hashes and sizes.
 */

export interface RecordedMessage {
  role: string;
  bytes: number;
  contentHash: string;
  /** For tool results: the tool name when the message carries one (`name`). */
  toolName?: string;
  toolCallId?: string;
  /** Retained in-process for exact duplicate detection; never persisted by the harness. */
  content: string;
}

export interface RecordedRequest {
  callIndex: number;
  model: string;
  /** Agent role inferred from the system prompt's `You are CodeForge <Role>` opener (else "unknown"). */
  role: string;
  messages: RecordedMessage[];
  toolNames: string[];
  systemBytes: number;
  requestBytes: number;
  /** Tool calls the model emitted on this call. `arguments` is retained in-process only. */
  emittedToolCalls: Array<{ id: string; name: string; argumentsHash: string; argumentsBytes: number; arguments: string }>;
}

export interface RecordingAdapterOptions {
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Called after every completed/failed call with the finished record. */
  onCall?: (record: ModelCallRecord, request: RecordedRequest) => void | Promise<void>;
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export class RecordingProviderAdapter implements ProviderAdapter {
  readonly providerId: string;
  readonly isTestProvider?: boolean;
  readonly supportsDispatchIdentity?: boolean;
  readonly calls: ModelCallRecord[] = [];
  readonly requests: RecordedRequest[] = [];
  private readonly now: () => number;
  private readonly onCall?: RecordingAdapterOptions["onCall"];
  private index = 0;

  constructor(private readonly inner: ProviderAdapter, options: RecordingAdapterOptions = {}) {
    this.providerId = inner.providerId;
    this.isTestProvider = inner.isTestProvider;
    this.supportsDispatchIdentity = inner.supportsDispatchIdentity;
    this.now = options.now ?? (() => Date.now());
    this.onCall = options.onCall;
  }

  listModels(): Promise<ProviderModel[]> {
    return this.inner.listModels();
  }

  healthCheck(): Promise<ProviderHealthResponse> {
    return this.inner.healthCheck();
  }

  canRoute(modelId: string): boolean {
    return this.inner.canRoute ? this.inner.canRoute(modelId) : true;
  }

  getPromptCacheCapability(modelId: string): PromptCacheCapability {
    return this.inner.getPromptCacheCapability
      ? this.inner.getPromptCacheCapability(modelId)
      : { mode: "unsupported", telemetryAvailable: false };
  }

  /** Non-streaming path: recorded with the same ledger shape (the runtime uses streamChat). */
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const startedAtMs = this.now();
    const request = this.recordRequest(req);
    try {
      const response = await this.inner.chat(req);
      const endedAtMs = this.now();
      const usage = response.usage;
      const record: ModelCallRecord = {
        ...this.baseRecord(request, startedAtMs, endedAtMs),
        servedModelId: response.model,
        responseBytes: byteLength(JSON.stringify(response.choices ?? [])),
        usageSource: usage ? "PROVIDER_REPORTED" : "UNKNOWN",
        ...(usage ? usageFields(usage) : {}),
        finishReason: normalizeFinish(response.choices?.[0]?.finishReason),
        toolCallsEmitted: response.choices?.[0]?.message?.toolCalls?.length ?? 0,
        outcome: "ok",
        rateLimited: false,
      };
      await this.commit(record, request);
      return response;
    } catch (error) {
      const record = this.errorRecord(request, startedAtMs, this.now(), error);
      await this.commit(record, request);
      throw error;
    }
  }

  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const startedAtMs = this.now();
    const request = this.recordRequest(req);
    let firstEventAtMs: number | undefined;
    let responseBytes = 0;
    let usage: Parameters<typeof usageFields>[0] | undefined;
    let finishReason: ModelCallRecord["finishReason"];
    let inBandError: { code: string; message: string; retryable?: boolean; status?: number; retryAfter?: number } | undefined;
    let thrown: unknown;
    let sawThrow = false;
    const toolArgs = new Map<string, { name: string; args: string }>();
    try {
      for await (const event of this.inner.streamChat(req, signal)) {
        if (firstEventAtMs === undefined) firstEventAtMs = this.now();
        switch (event.type) {
          case "text_delta":
            responseBytes += byteLength(event.delta);
            break;
          case "tool_call_started":
            toolArgs.set(event.toolCallId, { name: event.toolName, args: "" });
            break;
          case "tool_call_delta": {
            const entry = toolArgs.get(event.toolCallId);
            if (entry) entry.args += event.delta;
            responseBytes += byteLength(event.delta);
            break;
          }
          case "tool_call_completed": {
            const entry = toolArgs.get(event.toolCallId) ?? { name: event.toolName, args: "" };
            entry.name = event.toolName;
            if (event.arguments) {
              responseBytes += Math.max(0, byteLength(event.arguments) - byteLength(entry.args));
              entry.args = event.arguments;
            }
            toolArgs.set(event.toolCallId, entry);
            break;
          }
          case "usage":
            usage = event.usage;
            break;
          case "finish":
            finishReason = event.finishReason;
            break;
          case "error":
            inBandError = { code: event.code, message: event.message, retryable: event.retryable, status: event.status, retryAfter: event.retryAfter };
            break;
        }
        // The consumer may throw on an in-band error event or abandon the stream after this
        // yield; either closes this generator through `finally` below, where the call is still
        // committed to the ledger — no call is ever lost.
        yield event;
        if (signal?.aborted) break;
      }
    } catch (error) {
      thrown = error;
      sawThrow = true;
      throw error;
    } finally {
      const endedAtMs = this.now();
      request.emittedToolCalls = [...toolArgs.entries()].map(([id, entry]) => ({ id, name: entry.name, argumentsHash: sha256(entry.args), argumentsBytes: byteLength(entry.args), arguments: entry.args }));
      let record: ModelCallRecord;
      if (sawThrow) {
        record = this.errorRecord(request, startedAtMs, endedAtMs, thrown, firstEventAtMs, responseBytes, signal?.aborted === true);
      } else {
        const rateLimited = inBandError ? isRateLimit(inBandError.code, inBandError.status, inBandError.message) : false;
        record = {
          ...this.baseRecord(request, startedAtMs, endedAtMs),
          ...(firstEventAtMs !== undefined ? { timeToFirstEventMs: Math.max(0, firstEventAtMs - startedAtMs) } : {}),
          responseBytes,
          usageSource: usage ? "PROVIDER_REPORTED" : "UNKNOWN",
          ...(usage ? usageFields(usage) : {}),
          ...(finishReason ? { finishReason } : {}),
          toolCallsEmitted: toolArgs.size,
          outcome: signal?.aborted ? "aborted" : inBandError ? "error" : "ok",
          ...(inBandError ? { errorCode: inBandError.code, ...(inBandError.retryable !== undefined ? { retryable: inBandError.retryable } : {}), ...(inBandError.status !== undefined ? { httpStatus: inBandError.status } : {}) } : {}),
          rateLimited,
          ...(rateLimited && inBandError?.retryAfter !== undefined ? { retryAfterMs: Math.max(0, inBandError.retryAfter - endedAtMs) } : {}),
        };
      }
      await this.commit(record, request);
    }
  }

  private recordRequest(req: ChatRequest): RecordedRequest {
    const messages: RecordedMessage[] = [];
    if (req.system) messages.push({ role: "system", bytes: byteLength(req.system), contentHash: sha256(req.system), content: req.system });
    // Tool-result messages carry only a toolCallId; the tool name lives on the assistant message
    // that issued the call. Resolve it so composition-by-tool is exact.
    const toolNameByCallId = new Map<string, string>();
    for (const message of req.messages) {
      for (const call of (message.toolCalls ?? []) as Array<{ id?: string; function?: { name?: string } }>) {
        if (call?.id && call.function?.name) toolNameByCallId.set(call.id, call.function.name);
      }
    }
    for (const message of req.messages) {
      const content = message.content ?? "";
      const toolName = message.name ?? (message.toolCallId ? toolNameByCallId.get(message.toolCallId) : undefined);
      messages.push({
        role: message.role,
        bytes: byteLength(content),
        contentHash: sha256(content),
        ...(toolName ? { toolName } : {}),
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        content,
      });
    }
    const toolNames = (req.tools ?? []).map((tool) => tool.function.name);
    const requestBytes = byteLength(JSON.stringify({ system: req.system ?? "", messages: req.messages, tools: req.tools ?? [] }));
    const request: RecordedRequest = {
      callIndex: this.index++,
      model: req.model,
      role: inferRole(req.system ?? messages.find((message) => message.role === "system")?.content ?? ""),
      messages,
      toolNames,
      systemBytes: req.system ? byteLength(req.system) : messages.find((m) => m.role === "system")?.bytes ?? 0,
      requestBytes,
      emittedToolCalls: [],
    };
    this.requests.push(request);
    return request;
  }

  private baseRecord(request: RecordedRequest, startedAtMs: number, endedAtMs: number): Omit<ModelCallRecord, "responseBytes" | "usageSource" | "toolCallsEmitted" | "outcome" | "rateLimited"> {
    const byRole: Record<string, number> = {};
    for (const message of request.messages) byRole[message.role] = (byRole[message.role] ?? 0) + 1;
    return {
      callIndex: request.callIndex,
      providerId: this.providerId,
      requestedModelId: request.model,
      startedAt: iso(startedAtMs),
      endedAt: iso(endedAtMs),
      latencyMs: Math.max(0, endedAtMs - startedAtMs),
      requestBytes: request.requestBytes,
      messageCount: request.messages.length,
      messageCountByRole: byRole,
      toolDefinitionCount: request.toolNames.length,
      conversationDigest: sha256(request.messages.map((m) => `${m.role}:${m.contentHash}`).join("\n")),
    };
  }

  private errorRecord(request: RecordedRequest, startedAtMs: number, endedAtMs: number, error: unknown, firstEventAtMs?: number, responseBytes = 0, aborted = false): ModelCallRecord {
    const err = error as { code?: unknown; message?: unknown; status?: unknown; retryable?: unknown; retryAfter?: unknown };
    const code = typeof err?.code === "string" ? err.code : "UNKNOWN_ERROR";
    const message = typeof err?.message === "string" ? err.message : String(error);
    const status = typeof err?.status === "number" ? err.status : undefined;
    const rateLimited = isRateLimit(code, status, message);
    const retryAfter = typeof err?.retryAfter === "number" ? err.retryAfter : undefined;
    return {
      ...this.baseRecord(request, startedAtMs, endedAtMs),
      ...(firstEventAtMs !== undefined ? { timeToFirstEventMs: Math.max(0, firstEventAtMs - startedAtMs) } : {}),
      responseBytes,
      usageSource: "UNKNOWN",
      toolCallsEmitted: request.emittedToolCalls.length,
      outcome: aborted ? "aborted" : "error",
      errorCode: code,
      ...(status !== undefined ? { httpStatus: status } : {}),
      ...(typeof err?.retryable === "boolean" ? { retryable: err.retryable } : {}),
      rateLimited,
      ...(rateLimited && retryAfter !== undefined ? { retryAfterMs: Math.max(0, retryAfter - endedAtMs) } : {}),
    };
  }

  private async commit(record: ModelCallRecord, request: RecordedRequest): Promise<void> {
    this.calls.push(record);
    if (this.onCall) await this.onCall(record, request);
  }
}

export function inferRole(systemPrompt: string): string {
  const match = systemPrompt.match(/You are CodeForge ([A-Za-z-]+(?: [A-Za-z-]+)?)/);
  if (!match) return "unknown";
  const name = match[1]!.toLowerCase();
  if (name.startsWith("mission planner")) return "mission-planner";
  return name.split(" ")[0]!;
}

function usageFields(usage: { inputTokens: number; outputTokens: number; totalTokens?: number; cachedInputTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; costUsd?: number }): Partial<ModelCallRecord> {
  return {
    promptTokens: usage.inputTokens,
    completionTokens: usage.outputTokens,
    totalTokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
    ...(usage.cachedInputTokens !== undefined ? { cachedPromptTokens: usage.cachedInputTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
    ...(usage.costUsd !== undefined ? { providerReportedCostUsd: usage.costUsd } : {}),
  };
}

function normalizeFinish(reason: string | undefined): ModelCallRecord["finishReason"] {
  switch (reason) {
    case "stop":
    case "tool_calls":
    case "length":
    case "content_filter":
    case "error":
      return reason;
    default:
      return undefined;
  }
}

export function isRateLimit(code: string | undefined, status: number | undefined, message: string | undefined): boolean {
  if (status === 429) return true;
  const c = (code ?? "").toUpperCase();
  if (c.includes("RATE_LIMIT") || c === "429") return true;
  const m = (message ?? "").toLowerCase();
  return m.includes("429") || m.includes("rate limit") || m.includes("too many requests") || m.includes("quota exceeded");
}

/**
 * Rate-limit wait attribution (protocol §6.3): for every call that ended rate-limited, the gap
 * until the next call started is time the agent spent waiting on supply, not working.
 */
export function rateLimitWaitMs(calls: readonly ModelCallRecord[]): number {
  let total = 0;
  for (let i = 0; i < calls.length - 1; i += 1) {
    const call = calls[i]!;
    if (!call.rateLimited) continue;
    const next = calls[i + 1]!;
    total += Math.max(0, Date.parse(next.startedAt) - Date.parse(call.endedAt));
  }
  return total;
}

/** Σ latency of every call — the time the agent spent waiting on the model (incl. failures). */
export function modelWaitMs(calls: readonly ModelCallRecord[]): number {
  return calls.reduce((sum, call) => sum + call.latencyMs, 0);
}
