import type { ProviderCatalog, ChatRequest, ChatMessage, StreamEvent, ToolDefinition as ProviderToolDefinition } from "@codeforge/providers";
import type { ForgeZero, FreeModelRecord } from "@codeforge/forge-zero";
import { ForgeRouter } from "@codeforge/router";
import { ERROR_CODES, type AgentModelSelection, type AgentUsage } from "@codeforge/agent";
import type { ToolDefinition } from "@codeforge/tools";
import { redactSecrets } from "@codeforge/secrets";
import { fingerprint, type ForgeGreenAdvisor } from "@codeforge/forge-green";

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
  finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "error";
  modelId: string;
  providerId: string;
  optimization?: {
    duplicateSuppressed: boolean;
    promptPrefixCacheHit: boolean;
  };
}

export function normalizeProviderError(err: unknown): { code: string; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const msg = redactSecrets(raw);
  const lower = msg.toLowerCase();

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

  constructor(providerCatalog: ProviderCatalog, firewall: ForgeZero, forgeGreen?: ForgeGreenAdvisor) {
    this.providerCatalog = providerCatalog;
    this.firewall = firewall;
    this.forgeGreen = forgeGreen;
  }

  /**
   * Exact-model preservation & ForgeZero Adaptive resolution.
   * If exact model is specified, verifies it exists and is registered. Never silently replaces an exact model!
   */
  resolveModel(selection?: AgentModelSelection): { providerId: string; modelId: string } {
    if (selection && selection.providerId && selection.modelId) {
      const provider = this.providerCatalog.get(selection.providerId);
      if (!provider) {
        throw new Error(
          `[${ERROR_CODES.PROVIDER_MODEL_UNAVAILABLE}] Requested provider "${selection.providerId}" is not registered in provider catalog. Exact model execution failed closed.`,
        );
      }

      // Check model in firewall if present
      const modelRec = this.firewall.getModel(selection.providerId, selection.modelId);
      if (modelRec && modelRec.tier !== "gems_paid") {
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

    const best = ranked.find((r) => this.providerCatalog.get(r.model.providerId));
    if (best) {
      return { providerId: best.model.providerId, modelId: best.model.modelId };
    }

    const eligible = this.firewall.eligibleModels();
    const fallback = eligible.find((m) => this.providerCatalog.get(m.providerId));
    if (fallback) {
      return { providerId: fallback.providerId, modelId: fallback.modelId };
    }

    // Direct provider catalog fallback
    for (const p of this.providerCatalog.all()) {
      if (p.providerId) {
        return { providerId: p.providerId, modelId: "default" };
      }
    }

    throw new Error(`[${ERROR_CODES.PROVIDER_UNAVAILABLE}] No eligible or registered model provider found.`);
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

    try {
      for await (const event of provider.streamChat(chatRequest, req.signal)) {
        if (req.signal?.aborted) {
          return;
        }
        if (event.type === "error") {
          const norm = normalizeProviderError(event.message);
          yield {
            type: "error",
            code: norm.code,
            message: norm.message,
            retryable: event.retryable,
          };
          return;
        }
        yield event;
      }
    } catch (err: unknown) {
      if (req.signal?.aborted) {
        return;
      }
      const norm = normalizeProviderError(err);
      yield {
        type: "error",
        code: norm.code,
        message: norm.message,
      };
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
    });
    const run = this.forgeGreen
      ? await this.forgeGreen.runDeduplicated(requestKey, () => this.executeUncached({ ...req, modelSelection: resolved }), req.signal)
      : { value: await this.executeUncached({ ...req, modelSelection: resolved }), suppressed: false };
    return {
      ...run.value,
      optimization: { duplicateSuppressed: run.suppressed, promptPrefixCacheHit: prefixHit },
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
    let currentToolCall: { id: string; name: string; arguments: string } | null = null;
    let finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "error" = "stop";
    let usage: AgentUsage = {
      inputTokens: 0,
      outputTokens: 0,
      provider: providerId,
      model: modelId,
      requestCount: 1,
      toolCount: 0,
    };

    for await (const event of this.streamExecution(req)) {
      if (req.signal?.aborted) {
        throw new Error(`[${ERROR_CODES.AGENT_CANCELLED}] Model execution was cancelled`);
      }

      switch (event.type) {
        case "text_delta":
          text += event.delta;
          break;
        case "tool_call_started":
          currentToolCall = { id: event.toolCallId, name: event.toolName, arguments: "" };
          break;
        case "tool_call_delta":
          if (currentToolCall) {
            currentToolCall.arguments += event.delta;
          }
          break;
        case "tool_call_completed":
          if (currentToolCall) {
            // Providers are allowed to send the complete arguments only on the
            // terminal event. Preserve them verbatim; ToolBroker performs the
            // authoritative schema validation before any execution.
            toolCalls.push({
              ...currentToolCall,
              arguments: event.arguments ?? currentToolCall.arguments,
            });
          }
          currentToolCall = null;
          break;
        case "usage":
          usage = {
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            cachedTokens: undefined,
            provider: providerId,
            model: modelId,
            requestCount: 1,
            toolCount: toolCalls.length,
          };
          break;
        case "finish":
          finishReason = event.finishReason;
          break;
        case "error":
          throw new Error(`[${event.code}] ${event.message}`);
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
      finishReason,
      modelId,
      providerId,
    };
  }
}

export function createModelExecutionAdapter(
  providerCatalog: ProviderCatalog,
  firewall: ForgeZero,
  forgeGreen?: ForgeGreenAdvisor,
): ModelExecutionAdapter {
  return new ModelExecutionAdapter(providerCatalog, firewall, forgeGreen);
}
