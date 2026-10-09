import { randomUUID } from "node:crypto";
import type { ChatRequest, ChatResponse, FinishReason, ProviderAdapter, ProviderExecutionContext, ProviderHealthResponse, ProviderModel, StreamEvent, ToolCall, Usage } from "./index.js";
import { ToolCallSchema, UsageSchema } from "./chat-types.js";

export interface PuterSdkClient {
  ai: {
    listModels(): Promise<unknown>;
    chat(messages: Array<Record<string, unknown>>, options: Record<string, unknown>): Promise<unknown>;
  };
  auth: { getUser(): Promise<unknown>; getMonthlyUsage(): Promise<unknown> };
}

export interface PuterSdkAdapterOptions {
  sdk: PuterSdkClient;
  ownerUserId: string;
  currentUserId: () => string;
  timeoutMs?: number;
  isTestProvider?: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function usage(value: unknown): Usage | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const parsed = UsageSchema.safeParse({ inputTokens: raw.input_tokens ?? raw.prompt_tokens,
    outputTokens: raw.output_tokens ?? raw.completion_tokens, totalTokens: raw.total_tokens });
  return parsed.success ? parsed.data : undefined;
}

function finishReason(value: unknown): FinishReason {
  if (value === "stop" || value === "tool_calls" || value === "length" || value === "content_filter") return value;
  throw new Error("PUTER_FINISH_REASON_UNSUPPORTED");
}

function sdkRequest(request: ChatRequest, stream: boolean): { messages: Array<Record<string, unknown>>; options: Record<string, unknown> } {
  const messages: Array<Record<string, unknown>> = request.messages.map(message => ({ role: message.role, content: message.content,
    ...(message.name ? { name: message.name } : {}), ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.toolCalls ? { tool_calls: message.toolCalls } : {}) }));
  if (request.system) messages.unshift({ role: "system", content: request.system });
  return { messages, options: { model: request.model, stream, normalize: true, ...(request.tools ? { tools: request.tools } : {}),
    ...(request.toolChoice ? { toolChoice: request.toolChoice } : {}), ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}), ...(request.stop ? { stopSequences: request.stop } : {}) } };
}

function sanitizedError(error: unknown): StreamEvent & { type: "error" } {
  const raw = record(error);
  const code = typeof raw?.code === "string" ? raw.code : "PUTER_TRANSPORT_ERROR";
  const known = ["insufficient_funds", "subscription_required", "too_many_requests", "unauthorized", "invalid_token", "network_error", "PUTER_TIMEOUT", "PUTER_OWNER_CHANGED", "PUTER_EMPTY_RESPONSE", "PUTER_INCOMPLETE_STREAM", "PUTER_OUTPUT_INVALID", "PUTER_CANCELLED"];
  return { type: "error", code: known.includes(code) ? code : "PUTER_TRANSPORT_ERROR", message: "Puter request did not complete",
    retryable: code === "too_many_requests" || code === "network_error" || code === "PUTER_TIMEOUT",
    ...(code === "too_many_requests" ? { status: 429, rateLimitScope: "provider" as const } : {}),
    ...(code === "unauthorized" || code === "invalid_token" ? { status: 401 } : {}),
    ...(code === "insufficient_funds" || code === "subscription_required" ? { status: 402 } : {}) };
}

export class PuterSdkAdapter implements ProviderAdapter {
  readonly providerId = "puter";
  readonly isTestProvider: boolean;
  private readonly options: PuterSdkAdapterOptions;

  constructor(options: PuterSdkAdapterOptions) {
    if (!options.ownerUserId.trim()) throw new Error("PUTER_OWNER_MISSING");
    this.options = options;
    this.isTestProvider = options.isTestProvider === true;
  }

  // The SDK can spend purchased credits after the monthly allowance; transport is not admission.
  canRoute(): boolean { return false; }

  private assertOwner(): void {
    if (this.options.currentUserId() !== this.options.ownerUserId) throw { code: "PUTER_OWNER_CHANGED" };
  }

  private async bounded<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    this.assertOwner();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject({ code: "PUTER_TIMEOUT" }), this.options.timeoutMs ?? 60_000);
        abort = () => reject({ code: "PUTER_CANCELLED" });
        if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      })]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
      this.assertOwner();
    }
  }

  async listModels(): Promise<ProviderModel[]> {
    this.assertOwner();
    const models = await this.bounded(this.options.sdk.ai.listModels());
    if (!Array.isArray(models)) throw new Error("PUTER_CATALOG_INVALID");
    return models.flatMap(value => {
      const raw = record(value);
      if (!raw || typeof raw.id !== "string" || !raw.id || raw.modality === "image" || raw.modality === "audio") return [];
      const context = typeof raw.context === "number" && Number.isSafeInteger(raw.context) && raw.context > 0 ? raw.context : undefined;
      const parameters = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : [];
      return [{ modelId: raw.id, displayName: typeof raw.name === "string" ? raw.name : raw.id, contextWindow: context,
        capabilities: { text: true, coding: false, toolCalling: raw.supports_tools === true || parameters.includes("tools"),
          vision: false, structuredOutput: parameters.includes("response_format"), longContext: (context ?? 0) > 32_000 },
        isFree: false, freeStatus: "unknown" as const }];
    });
  }

  async accountObservation(): Promise<{ user: unknown; monthlyUsage: unknown }> {
    this.assertOwner();
    const [user, monthlyUsage] = await Promise.all([this.bounded(this.options.sdk.auth.getUser()), this.bounded(this.options.sdk.auth.getMonthlyUsage())]);
    return { user, monthlyUsage };
  }

  async healthCheck(): Promise<ProviderHealthResponse> {
    try { await this.accountObservation(); return { status: "available" }; }
    catch (error) {
      const failure = sanitizedError(error);
      return { status: failure.status === 401 ? "auth_required" : failure.status === 429 ? "rate_limited" : "unknown", error: failure.code };
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.assertOwner();
    const mapped = sdkRequest(request, false);
    const raw = record(await this.bounded(this.options.sdk.ai.chat(mapped.messages, mapped.options)));
    const message = record(raw?.message);
    if (!message || (message.content !== null && typeof message.content !== "string")) throw new Error("PUTER_OUTPUT_INVALID");
    const calls: ToolCall[] = Array.isArray(message.tool_calls) ? message.tool_calls.map(value => ToolCallSchema.parse(value)) : [];
    if (!message.content && calls.length === 0) throw new Error("PUTER_EMPTY_RESPONSE");
    const reason = finishReason(raw?.finish_reason);
    if (reason === "tool_calls" && calls.length === 0) throw new Error("PUTER_OUTPUT_INVALID");
    const measuredUsage = usage(raw?.usage);
    return { id: typeof raw?.id === "string" ? raw.id : randomUUID(), model: typeof raw?.model === "string" ? raw.model : request.model,
      choices: [{ index: 0, message: { role: "assistant", content: message.content as string ?? "", ...(calls.length ? { toolCalls: calls } : {}) }, finishReason: reason }],
      ...(measuredUsage ? { usage: measuredUsage } : {}) };
  }

  async *streamChatWithContext(request: ChatRequest, context: ProviderExecutionContext, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    if (context.userId !== this.options.ownerUserId) { yield sanitizedError({ code: "PUTER_OWNER_CHANGED" }); return; }
    yield* this.streamChat(request, signal);
  }

  async *streamChat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    let iterator: AsyncIterator<unknown> | undefined;
    try {
      this.assertOwner();
      if (signal?.aborted) throw { code: "PUTER_CANCELLED" };
      const mapped = sdkRequest(request, true);
      const source = await this.bounded(this.options.sdk.ai.chat(mapped.messages, mapped.options), signal);
      if (!source || typeof (source as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") throw { code: "PUTER_OUTPUT_INVALID" };
      iterator = (source as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      let output = false;
      let completed = false;
      let toolCalls = false;
      const ids = new Set<string>();
      while (true) {
        const next = await this.bounded(iterator.next(), signal);
        if (next.done) break;
        const chunk = record(next.value);
        if (!chunk) throw { code: "PUTER_OUTPUT_INVALID" };
        if (chunk.type === "error") throw chunk;
        if (completed) throw { code: "PUTER_OUTPUT_INVALID" };
        if (chunk.type === "text" && typeof chunk.text === "string") {
          output ||= chunk.text.length > 0;
          yield { type: "text_delta", delta: chunk.text };
        } else if (chunk.type === "tool_use") {
          if (typeof chunk.id !== "string" || !chunk.id || typeof chunk.name !== "string" || !chunk.name || !record(chunk.input) || ids.has(chunk.id)) throw { code: "PUTER_OUTPUT_INVALID" };
          ids.add(chunk.id); toolCalls = true; output = true;
          yield { type: "tool_call_started", toolCallId: chunk.id, toolName: chunk.name };
          yield { type: "tool_call_completed", toolCallId: chunk.id, toolName: chunk.name, arguments: JSON.stringify(chunk.input) };
        } else if (chunk.type === "usage") {
          const measuredUsage = usage(chunk.usage);
          if (!measuredUsage) throw { code: "PUTER_OUTPUT_INVALID" };
          completed = true;
          yield { type: "usage", usage: measuredUsage };
        } else if (chunk.type !== "reasoning" && chunk.type !== "extra_content") throw { code: "PUTER_OUTPUT_INVALID" };
      }
      if (!output) throw { code: "PUTER_EMPTY_RESPONSE" };
      if (!completed) throw { code: "PUTER_INCOMPLETE_STREAM" };
      yield { type: "finish", finishReason: toolCalls ? "tool_calls" : "stop" };
    } catch (error) { yield sanitizedError(error); }
    finally { void iterator?.return?.().catch(() => {}); }
  }
}
