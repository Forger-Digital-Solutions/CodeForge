import {
  type ProviderAdapter,
  type ProviderCatalog,
  type ChatRequest,
  type ChatMessage,
  type StreamEvent,
  type ToolDefinition as ProviderToolDefinition,
  type PromptCacheCapability,
  ProviderCapacityGovernor,
  ProviderError,
  defaultCapacityGovernor,
  rateLimitScopeFor,
  estimatePromptTokens,
  estimatePromptOnlyTokens,
} from "@codeforge/providers";
import type { ForgeZero } from "@codeforge/forge-zero";
import { ForgeRouter } from "@codeforge/router";
import { ERROR_CODES, type AgentModelSelection, type AgentUsage } from "@codeforge/agent";
import type { ToolDefinition } from "@codeforge/tools";
import type { PaidAutoService } from "@codeforge/paid-auto";
import { redactSecrets } from "@codeforge/secrets";
import { fingerprint, type ForgeGreenAdvisor } from "@codeforge/forge-green";
import type { ForgeGreenRunPolicy } from "./forgegreen-run-policy.js";
import { isUserApiAdapter } from "./user-intelligence.js";

export interface ModelExecutionRequest {
  modelSelection?: AgentModelSelection;
  messages: ChatMessage[];
  system?: string;
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none" | "required";
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  userId?: string;
  authorityState?: string;
  dedupeScope?: string;
}

export interface ModelExecutionResponse {
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  usage: AgentUsage;
  /** Exact provider usage was observed on a usage event; absent provider usage stays unknown. */
  usageSource: "PROVIDER_REPORTED" | "UNKNOWN";
  finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "error";
  modelId: string;
  providerId: string;
  /** R48: the upstream's own reported served-model identity when the provider protocol
   *  exposes one (stream-chunk `model`). Absent = identity is requested-route-known only —
   *  never fabricate it. */
  servedModel?: string;
  optimization?: {
    duplicateSuppressed: boolean;
    promptPrefixCacheHit: boolean;
    /** FG-1A provider prompt-cache telemetry. `measured` only when the provider itself
     * reported cached input tokens; otherwise `unavailable` and no savings are claimed. */
    providerPromptCache?: {
      capability: PromptCacheCapability;
      classification: "measured" | "unavailable";
      cachedInputTokens?: number;
      cacheWriteTokens?: number;
    };
  };
}

const SAFE_TRANSPORT_CAUSE_CODE = /^(?:EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR_[A-Z0-9_]+|CERT_[A-Z0-9_]+)$/;

/** Whitelisted transport cause *codes* are stable machine tokens — safe to persist. The cause's
 *  message is dropped entirely: it can carry hostnames, paths, or env details. */
function safeTransportCauseCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const code = (err.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && SAFE_TRANSPORT_CAUSE_CODE.test(code) ? code : undefined;
}

/**
 * Provider adapters emit a typed `code` on errors and stream-error events, and an upstream
 * re-wrap can carry an already-normalized runtime code. Text classification cannot re-derive
 * these — Groq's `output_parse_failed` reads as a generic stream error and was flattened into
 * PROVIDER_UNAVAILABLE, which mislabelled a model-quality fact as a provider outage in
 * telemetry and the run-failure record. A code in the known vocabulary therefore wins over
 * message patterns; generic (`PROVIDER_ERROR`/`PROVIDER_UNAVAILABLE`) or unknown codes still
 * fall through to text, which can only sharpen them.
 */
const PROVIDER_WIRE_CODES: Readonly<Record<string, string>> = {
  RATE_LIMITED: ERROR_CODES.PROVIDER_RATE_LIMITED,
  AUTH_ERROR: ERROR_CODES.PROVIDER_AUTH_FAILED,
  PAYMENT_REQUIRED: "PAYMENT_REQUIRED",
  MODEL_NOT_FOUND: ERROR_CODES.PROVIDER_MODEL_UNAVAILABLE,
  CONTEXT_LENGTH: ERROR_CODES.PROVIDER_CONTEXT_LIMIT,
  TIMEOUT: ERROR_CODES.PROVIDER_TIMEOUT,
  INVALID_TOOL_OUTPUT: "INVALID_TOOL_OUTPUT",
  STREAM_INTERRUPTED: ERROR_CODES.PROVIDER_STREAM_INTERRUPTED,
};

const NORMALIZED_PROVIDER_CODES: ReadonlySet<string> = new Set(Object.values(ERROR_CODES));

function normalizedCodeFor(token: string | undefined): string | undefined {
  if (token === undefined) return undefined;
  if (token === ERROR_CODES.PROVIDER_UNAVAILABLE) return undefined;
  return PROVIDER_WIRE_CODES[token] ?? (NORMALIZED_PROVIDER_CODES.has(token) ? token : undefined);
}

export function normalizeProviderError(err: unknown): { code: string; message: string } {
  const raw = err instanceof Error
    ? err.message
    : typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string"
      ? (err as { message: string }).message
      : String(err);
  const redacted = redactSecrets(raw);
  const lower = redacted.toLowerCase();
  // The cause marker rides on the message after classification, so 8-Bit's classifier can
  // derive TRANSIENT_NETWORK from it without the marker re-routing the error code here.
  const causeCode = safeTransportCauseCode(err);
  const msg = causeCode ? `${redacted} [cause=${causeCode}]` : redacted;

  const structured = normalizedCodeFor(typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : undefined)
    ?? normalizedCodeFor(/^\s*\[([A-Z][A-Z0-9_]*)\]\s*/.exec(redacted)?.[1]);
  if (structured !== undefined) {
    // Strip only envelopes that re-state the honored code — a foreign bracket is content.
    let out = msg;
    for (;;) {
      const envelope = /^\s*\[([A-Z][A-Z0-9_.:-]*)\]\s*/.exec(out);
      if (envelope === null || normalizedCodeFor(envelope[1]) !== structured) break;
      out = out.slice(envelope[0].length);
    }
    return { code: structured, message: out.length > 0 ? out : structured };
  }

  if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("invalid api key") || lower.includes("auth_failed") || lower.includes("missing_api_key")) {
    return { code: ERROR_CODES.PROVIDER_AUTH_FAILED, message: `Authentication failed with provider: ${msg}` };
  }
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("quota exceeded") || lower.includes("too many requests")) {
    return { code: ERROR_CODES.PROVIDER_RATE_LIMITED, message: `Provider rate limit exceeded: ${msg}` };
  }
  if (lower.includes("timeout") || lower.includes("etimedout") || lower.includes("timed out")) {
    return { code: ERROR_CODES.PROVIDER_TIMEOUT, message: `Provider request timed out: ${msg}` };
  }
  if (lower.includes("context length") || lower.includes("context window") || lower.includes("maximum context") || lower.includes("token limit")) {
    return { code: ERROR_CODES.PROVIDER_CONTEXT_LIMIT, message: `Model context limit exceeded: ${msg}` };
  }
  if (lower.includes("model not found") || lower.includes("unknown model") || lower.includes("model unavailable") || lower.includes("does not exist")) {
    return { code: ERROR_CODES.PROVIDER_MODEL_UNAVAILABLE, message: `Requested model is unavailable: ${msg}` };
  }
  if (lower.includes("stream interrupted") || lower.includes("stream disconnect") || lower.includes("connection closed") || lower.includes("econnreset")) {
    return { code: ERROR_CODES.PROVIDER_STREAM_INTERRUPTED, message: `Provider stream was interrupted: ${msg}` };
  }
  if (lower.includes("abort") || lower.includes("cancelled") || lower.includes("canceled")) {
    return { code: ERROR_CODES.AGENT_CANCELLED, message: `Model execution cancelled: ${msg}` };
  }

  return { code: ERROR_CODES.PROVIDER_UNAVAILABLE, message: msg };
}

export function convertToProviderTools(tools?: ToolDefinition[]): ProviderToolDefinition[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as ProviderToolDefinition["function"]["parameters"],
    },
  }));
}

export class ModelExecutionAdapter {
  private readonly providerCatalog: ProviderCatalog;
  private readonly firewall: ForgeZero;
  private readonly forgeGreen?: ForgeGreenAdvisor;
  private readonly governor?: ProviderCapacityGovernor;
  private readonly governorIsExplicit: boolean;

  constructor(
    providerCatalog: ProviderCatalog,
    firewall: ForgeZero,
    forgeGreen?: ForgeGreenAdvisor,
    governor?: ProviderCapacityGovernor,
    private readonly greenPolicy?: ForgeGreenRunPolicy,
    private readonly paidAuto?: PaidAutoService,
  ) {
    this.providerCatalog = providerCatalog;
    this.firewall = firewall;
    this.forgeGreen = forgeGreen;
    this.governor = governor ?? defaultCapacityGovernor;
    this.governorIsExplicit = governor !== undefined;
  }

  /**
   * Capacity authority for a request. Deterministic test providers (`isTestProvider`) have no real
   * provider capacity behind them, so the process-wide default governor must not pace or cool them
   * down — its sliding windows would otherwise leak across isolated runs in the same process and
   * stall unrelated runs for up to a minute. Callers that supply an explicit governor get exactly
   * what they asked for, test provider or not.
   */
  private governorFor(provider: unknown): ProviderCapacityGovernor | undefined {
    if (!this.governor) return undefined;
    // R55: USER_API sources are the user's own account — managed-free capacity pacing
    // never applies to them.
    if (isUserApiAdapter(provider as ProviderAdapter | undefined)) return undefined;
    if (!this.governorIsExplicit && (provider as { isTestProvider?: boolean } | undefined)?.isTestProvider === true) {
      return undefined;
    }
    return this.governor;
  }

  /**
   * Exact-model preservation & ForgeZero Adaptive resolution.
   * If exact model is specified, verifies it exists and is registered. Never silently replaces an exact model!
   */
  resolveModel(selection?: AgentModelSelection): { providerId: string; modelId: string } {
    if (selection && selection.providerId && selection.modelId) {
      // Paid Auto is a canonical-model surface, not a ForgeZero free route: eligibility,
      // pricing, and spend authorization live in the paid service and its budget ledger.
      if (selection.providerId === "paid-auto") {
        const paidModel = this.paidAuto?.runtimeModel(selection.modelId);
        if (!paidModel) {
          throw new Error(
            `[${ERROR_CODES.PROVIDER_MODEL_UNAVAILABLE}] Exact Paid Auto model "${selection.modelId}" is not registered. Exact model execution failed closed.`,
          );
        }
        return { providerId: "paid-auto", modelId: paidModel.modelId };
      }
      const provider = this.providerCatalog.get(selection.providerId);
      if (!provider) {
        throw new Error(
          `[${ERROR_CODES.PROVIDER_MODEL_UNAVAILABLE}] Requested provider "${selection.providerId}" is not registered in provider catalog. Exact model execution failed closed.`,
        );
      }

      // R55: USER_API adapters are owner-authorized through the roster allowance upstream —
      // ForgeZero's managed-free catalog holds no record for them and must not gate them.
      if (isUserApiAdapter(provider)) {
        return { providerId: selection.providerId, modelId: selection.modelId };
      }

      const modelRec = this.firewall.getModel(selection.providerId, selection.modelId);
      if (!modelRec) {
        throw new Error(
          `[${ERROR_CODES.PROVIDER_MODEL_UNAVAILABLE}] Requested exact model "${selection.providerId}/${selection.modelId}" is not registered in ForgeZero. Exact model execution failed closed.`,
        );
      }
      if (modelRec.tier !== "gems_paid") {
        const verifyResult = this.firewall.verify(selection.providerId, selection.modelId);
        if (!verifyResult.ok) {
          throw new Error(
            `[${ERROR_CODES.PROVIDER_MODEL_UNAVAILABLE}] Requested exact model "${selection.providerId}/${selection.modelId}" is not eligible: ${verifyResult.error.message}`,
          );
        }
      }

      return { providerId: selection.providerId, modelId: selection.modelId };
    }

    // ForgeZero Adaptive routing
    const router = new ForgeRouter({ firewall: this.firewall });
    const ranked = router.rank({
      taskType: "coding",
      estimatedContextTokens: 16000,
      requiredCapabilities: ["coding", "toolCalling"],
    });

    // Prefer highest-ranked available free provider not in 429 cooldown
    const best = ranked.find((r) => {
      const provider = this.providerCatalog.get(r.model.providerId);
      if (!provider || provider.canRoute?.(r.model.modelId) === false) return false;
      if (this.governorFor(provider)?.isCoolingDown(r.model.providerId)) return false;
      return true;
    }) ?? ranked.find((r) => {
      const provider = this.providerCatalog.get(r.model.providerId);
      return !!provider && provider.canRoute?.(r.model.modelId) !== false;
    });

    if (best) {
      return { providerId: best.model.providerId, modelId: best.model.modelId };
    }

    const eligible = this.firewall.eligibleModels();
    const fallback = eligible.find((m) => {
      const provider = this.providerCatalog.get(m.providerId);
      if (!provider || provider.canRoute?.(m.modelId) === false) return false;
      if (this.governorFor(provider)?.isCoolingDown(m.providerId)) return false;
      return true;
    }) ?? eligible.find((m) => {
      const provider = this.providerCatalog.get(m.providerId);
      return !!provider && provider.canRoute?.(m.modelId) !== false;
    });

    if (fallback) {
      return { providerId: fallback.providerId, modelId: fallback.modelId };
    }

    throw new Error(`[${ERROR_CODES.PROVIDER_MODEL_UNAVAILABLE}] No eligible or registered model provider found.`);
  }

  /**
   * Stream model execution with normalized event stream.
   */
  async *streamExecution(req: ModelExecutionRequest): AsyncIterable<StreamEvent> {
    const { providerId, modelId } = this.resolveModel(req.modelSelection);
    const provider = this.providerCatalog.get(providerId);
    if (!provider) {
      throw new Error(`[${ERROR_CODES.PROVIDER_UNAVAILABLE}] Provider "${providerId}" not found in catalog.`);
    }

    const tools = convertToProviderTools(req.tools);
    const chatRequest: ChatRequest = {
      model: modelId,
      messages: req.messages,
      system: req.system,
      tools,
      toolChoice: req.toolChoice ?? (tools && tools.length > 0 ? "auto" : undefined),
      temperature: req.temperature ?? 0.7,
      maxTokens: req.maxTokens ?? 4096,
    };

    let reservation: { release: (actualTokens?: number) => void } | undefined;
    let actualTokens: number | undefined;
    const pacingGovernor = this.governorFor(provider);

    if (pacingGovernor && !(provider as any).isGoverned) {
      const estimatedTokens = estimatePromptTokens(chatRequest);
      reservation = await pacingGovernor.acquire(providerId, estimatedTokens, req.signal, { promptTokens: estimatePromptOnlyTokens(chatRequest) });
    }

    try {
      for await (const event of provider.streamChat(chatRequest, req.signal)) {
        if (req.signal?.aborted) {
          return;
        }
        if (event.type === "usage" && event.usage) {
          actualTokens = (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0);
        } else if ((event as any).usage) {
          const u = (event as any).usage;
          actualTokens = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
        }
        if (event.type === "error") {
          const norm = normalizeProviderError(event);
          if (norm.code === ERROR_CODES.PROVIDER_RATE_LIMITED && pacingGovernor) {
            pacingGovernor.recordRateLimit(providerId, event.retryAfter, { modelId, scope: rateLimitScopeFor(event.message) });
          }
          yield {
            type: "error",
            code: norm.code,
            message: norm.message,
            retryable: event.retryable,
            status: event.status,
            retryAfter: event.retryAfter,
          };
          return;
        }
        yield event;
      }
    } catch (err: unknown) {
      if (req.signal?.aborted) {
        return;
      }
      // R55 wave 2: a proven pre-dispatch rejection (executionCertainty "not_started" —
      // e.g. the paid gate refused before any billable provider work began) keeps its
      // typed identity so allowance accounting can release rather than settle.
      if ((err as { executionCertainty?: unknown }).executionCertainty === "not_started") throw err;
      const norm = normalizeProviderError(err);
      if (norm.code === ERROR_CODES.PROVIDER_RATE_LIMITED && pacingGovernor) {
        pacingGovernor.recordRateLimit(providerId, (err as { retryAfter?: unknown }).retryAfter as number | undefined, { modelId, scope: rateLimitScopeFor(err instanceof Error ? err.message : String(err)) });
      }
      yield {
        type: "error",
        code: norm.code,
        message: norm.message,
        ...(typeof (err as { retryable?: unknown }).retryable === "boolean" ? { retryable: (err as { retryable: boolean }).retryable } : {}),
        ...(typeof (err as { status?: unknown }).status === "number" ? { status: (err as { status: number }).status } : {}),
        ...(typeof (err as { retryAfter?: unknown }).retryAfter === "number" ? { retryAfter: (err as { retryAfter: number }).retryAfter } : {}),
      };
    } finally {
      reservation?.release(actualTokens);
    }
  }

  /**
   * FG-1A provider-neutral capability resolution. Missing adapter support, malformed metadata,
   * or resolver failure all degrade to `unsupported`: the provider is invoked exactly as before
   * and no cache savings may be claimed. This must never be required for correctness.
   */
  resolvePromptCacheCapability(providerId: string, modelId: string): PromptCacheCapability {
    const provider = this.providerCatalog.get(providerId);
    if (!provider || typeof provider.getPromptCacheCapability !== "function") {
      return { mode: "unsupported", telemetryAvailable: false };
    }
    try {
      const capability = provider.getPromptCacheCapability(modelId);
      const validModes = ["unsupported", "automatic", "explicit"];
      if (!capability || typeof capability.mode !== "string" || !validModes.includes(capability.mode)) {
        return { mode: "unsupported", telemetryAvailable: false };
      }
      return capability;
    } catch {
      return { mode: "unsupported", telemetryAvailable: false };
    }
  }

  /**
   * Execute model request to full completion.
   */
  async execute(req: ModelExecutionRequest): Promise<ModelExecutionResponse> {
    const resolved = this.resolveModel(req.modelSelection);
    const tools = convertToProviderTools(req.tools);
    const prefixHit = this.forgeGreen?.observeStablePrefix(
      resolved.providerId,
      resolved.modelId,
      JSON.stringify({ system: req.system ?? "", tools: tools ?? [], toolChoice: req.toolChoice ?? "auto" }),
    ) ?? false;
    const requestKey = fingerprint({
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      messages: req.messages,
      system: req.system ?? "",
      tools: tools ?? [],
      toolChoice: req.toolChoice ?? "auto",
      temperature: req.temperature ?? 0.7,
      maxTokens: req.maxTokens ?? 4096,
      userId: req.userId ?? "",
      authorityState: req.authorityState ?? "canonical",
      dedupeScope: req.dedupeScope ?? "request",
      // R42: the run-policy epoch joins the key so a response cached before an escalation can
      // never be replayed to a retry issued after it (e.g. an identical re-dispatch following
      // an unusable answer would otherwise get that same unusable answer back).
      dedupeEpoch: this.greenPolicy?.dedupeEpoch() ?? 0,
    });
    const dedupeMode = this.greenPolicy?.modelDedupeMode() ?? "full";
    const run = this.forgeGreen && dedupeMode !== "off"
      ? await this.forgeGreen.runDeduplicated(
          requestKey,
          () => this.executeUncached({ ...req, modelSelection: resolved }),
          req.signal,
          { completedReplay: dedupeMode === "full" },
        )
      : { value: await this.executeUncached({ ...req, modelSelection: resolved }), suppressed: false };
    const cached = run.value.usage.cachedTokens;
    return {
      ...run.value,
      optimization: {
        duplicateSuppressed: run.suppressed,
        promptPrefixCacheHit: prefixHit,
        providerPromptCache: {
          capability: this.resolvePromptCacheCapability(resolved.providerId, resolved.modelId),
          ...(typeof cached === "number"
            ? { classification: "measured" as const, cachedInputTokens: cached, ...(typeof run.value.usage.cacheWriteTokens === "number" ? { cacheWriteTokens: run.value.usage.cacheWriteTokens } : {}) }
            : { classification: "unavailable" as const }),
        },
      },
    };
  }

  private async executeUncached(req: ModelExecutionRequest): Promise<ModelExecutionResponse> {
    const { providerId, modelId } = this.resolveModel(req.modelSelection);
    const provider = this.providerCatalog.get(providerId);
    if (!provider) {
      throw new Error(`[${ERROR_CODES.PROVIDER_UNAVAILABLE}] Provider "${providerId}" not found in catalog.`);
    }

    let text = "";
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    // Parallel tool calls share one event stream keyed by `toolCallId` — not arrival order.
    // A single slot drops earlier calls' names and concatenates their arguments into
    // malformed JSON (the explorer zero-read signature).
    const openToolCalls = new Map<string, { id: string; name: string; arguments: string }>();
    let finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "error" = "stop";
    let usage: AgentUsage = {
      inputTokens: 0,
      outputTokens: 0,
      provider: providerId,
      model: modelId,
      requestCount: 1,
      toolCount: 0,
    };
    let usageSource: ModelExecutionResponse["usageSource"] = "UNKNOWN";
    let servedModel: string | undefined;

    for await (const event of this.streamExecution(req)) {
      if (req.signal?.aborted) {
        throw new Error(`[${ERROR_CODES.AGENT_CANCELLED}] Model execution was cancelled`);
      }

      switch (event.type) {
        case "text_delta":
          text += event.delta;
          break;
        case "tool_call_started":
          openToolCalls.set(event.toolCallId, { id: event.toolCallId, name: event.toolName, arguments: "" });
          break;
        case "tool_call_delta": {
          const pending = openToolCalls.get(event.toolCallId) ?? { id: event.toolCallId, name: "", arguments: "" };
          openToolCalls.set(event.toolCallId, pending);
          pending.arguments += event.delta;
          break;
        }
        case "tool_call_completed": {
          const pending = openToolCalls.get(event.toolCallId) ?? { id: event.toolCallId, name: "", arguments: "" };
          openToolCalls.delete(event.toolCallId);
          // Providers are allowed to send the complete arguments only on the
          // terminal event. Preserve them verbatim; ToolBroker performs the
          // authoritative schema validation before any execution.
          toolCalls.push({
            ...pending,
            arguments: event.arguments ?? pending.arguments,
          });
          break;
        }
        case "usage":
          usageSource = "PROVIDER_REPORTED";
          usage = {
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            cachedTokens: event.usage.cachedInputTokens,
            cacheWriteTokens: event.usage.cacheWriteTokens,
            ...(typeof event.usage.reasoningTokens === "number" ? { reasoningTokens: event.usage.reasoningTokens } : {}),
            provider: providerId,
            model: modelId,
            requestCount: 1,
            toolCount: toolCalls.length,
          };
          break;
        case "finish":
          finishReason = event.finishReason;
          if (event.model) servedModel = event.model;
          break;
        case "error": {
          // Provider layers already prefix their message with "[CODE]"; re-prefixing produces
          // "[PROVIDER_UNAVAILABLE] [PROVIDER_UNAVAILABLE] …" in every surface that shows it.
          const detail = event.message.replace(/^(\s*\[[A-Z][A-Z0-9_.:-]*\]\s*)+/, "");
          throw new ProviderError(
            `[${event.code}] ${detail}`,
            event.code,
            event.retryable,
            { status: event.status, retryAfter: event.retryAfter },
          );
        }
      }
    }

    // A provider may notice cancellation and end its stream without emitting a
    // terminal error or any final event. Do not reinterpret that silent end as
    // a successful model completion.
    if (req.signal?.aborted) {
      throw new Error(`[${ERROR_CODES.AGENT_CANCELLED}] Model execution was cancelled`);
    }

    usage.toolCount = toolCalls.length;

    return {
      text,
      toolCalls,
      usage,
      usageSource,
      finishReason,
      modelId,
      providerId,
      ...(servedModel ? { servedModel } : {}),
    };
  }
}

export function createModelExecutionAdapter(
  providerCatalog: ProviderCatalog,
  firewall: ForgeZero,
  forgeGreen?: ForgeGreenAdvisor,
  governor?: ProviderCapacityGovernor,
  greenPolicy?: ForgeGreenRunPolicy,
  paidAuto?: PaidAutoService,
): ModelExecutionAdapter {
  return new ModelExecutionAdapter(providerCatalog, firewall, forgeGreen, governor, greenPolicy, paidAuto);
}
