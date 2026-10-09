import type { ProviderAdapter, ProviderHealthResponse, ProviderModel, ProviderResponseObserver } from "./index.js";
import { ProviderError } from "./index.js";
import type { ChatRequest, ChatResponse, StreamEvent } from "./chat-types.js";
import { OpenAICompatibleAdapter } from "./openai-compatible.js";

export const BLOCKRUN_FREE_PROVIDER_ID = "blockrun-free-direct";
const BASE_URL = "https://blockrun.ai/api/v1";
const CATALOG_TTL_MS = 5 * 60_000;

export interface BlockRunFreeOptions {
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  onResponse?: ProviderResponseObserver;
  now?: () => number;
}

function zero(value: unknown): boolean {
  return value === 0 || (typeof value === "string" && /^0(?:\.0+)?(?:[eE][+-]?\d+)?$/.test(value.trim()));
}

export function mapBlockRunFreeModel(raw: unknown): ProviderModel | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const model = raw as Record<string, unknown>;
  const price = model.pricing && typeof model.pricing === "object" ? model.pricing as Record<string, unknown> : undefined;
  const categories = Array.isArray(model.categories) ? model.categories : [];
  if (typeof model.id !== "string" || !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(model.id)
    || model.billing_mode !== "free" || model.available !== true || !categories.includes("chat")
    || !price || !zero(price.input) || !zero(price.output) || (price.transaction_fee !== undefined && !zero(price.transaction_fee))) return null;
  const contextWindow = typeof model.context_window === "number" ? model.context_window : undefined;
  return {
    modelId: model.id,
    displayName: typeof model.name === "string" ? model.name : model.id,
    contextWindow,
    capabilities: { text: true, coding: categories.includes("coding"), toolCalling: true, vision: categories.includes("vision"), structuredOutput: false, longContext: (contextWindow ?? 0) > 32_000 },
    isFree: true,
    freeStatus: "verified_free",
  };
}

export class BlockRunFreeAdapter implements ProviderAdapter {
  readonly providerId = BLOCKRUN_FREE_PROVIDER_ID;
  private readonly transport: OpenAICompatibleAdapter;
  private readonly now: () => number;
  private models = new Map<string, ProviderModel>();
  private catalogExpiresAt = 0;
  private refresh?: Promise<ProviderModel[]>;

  constructor(options: BlockRunFreeOptions = {}) {
    this.now = options.now ?? Date.now;
    const fetchFn = options.fetchFn ?? fetch;
    this.transport = new OpenAICompatibleAdapter({
      providerId: BLOCKRUN_FREE_PROVIDER_ID, baseUrl: BASE_URL, anonymousFree: true,
      requireExactServedModel: true, mapModel: mapBlockRunFreeModel,
      timeoutMs: options.timeoutMs, onResponse: options.onResponse,
      fetchFn: async (target, init) => {
        const response = await fetchFn(target, init);
        if (response.status === 429 && typeof init?.body === "string") {
          let requestedTools = false;
          try { requestedTools = Array.isArray((JSON.parse(init.body) as { tools?: unknown }).tools); } catch {}
          if (requestedTools) {
            let failure: { code?: unknown; debug?: unknown; error?: { code?: unknown } } = {};
            try { failure = await response.clone().json() as typeof failure; } catch {}
            // The gateway masks this witnessed upstream model-output defect as quota exhaustion.
            if ((failure.code === "FREE_MODEL_FAILED" || failure.error?.code === "FREE_MODEL_FAILED")
              && typeof failure.debug === "string" && /NVIDIA API error: 400\b/.test(failure.debug)
              && /Invalid JSON/.test(failure.debug) && /python_tag|tool.call|function/i.test(failure.debug)) {
              throw new ProviderError("BlockRun upstream rejected invalid model tool output", "INVALID_TOOL_OUTPUT", false);
            }
          }
        }
        return response;
      },
    });
  }

  async listModels(): Promise<ProviderModel[]> {
    if (this.refresh) return this.refresh;
    this.refresh = this.transport.listModels().then((models) => {
      this.models = new Map(models.map((model) => [model.modelId, model]));
      this.catalogExpiresAt = this.now() + CATALOG_TTL_MS;
      return models;
    }).finally(() => { this.refresh = undefined; });
    return this.refresh;
  }

  private async assertCurrentFreeModel(model: string): Promise<void> {
    if (this.catalogExpiresAt <= this.now()) {
      this.models.clear();
      await this.listModels();
    }
    if (!this.models.has(model)) throw new ProviderError("BlockRun model is not currently available with explicit free billing", "MODEL_NOT_ALLOWED");
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    await this.assertCurrentFreeModel(request.model);
    return this.transport.chat(request);
  }

  async *streamChat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    await this.assertCurrentFreeModel(request.model);
    const executable: StreamEvent[] = [];
    let failed = false;
    for await (const event of this.transport.streamChat(request, signal)) {
      if (event.type === "error") { failed = true; executable.length = 0; }
      // A later usage frame can expose a substituted identity after the tool finish marker.
      if (event.type === "tool_call_completed" || event.type === "finish") executable.push(event);
      else yield event;
    }
    if (!failed && !signal?.aborted && executable.some((event) => event.type === "finish")) {
      for (const event of executable) yield event;
    }
  }

  canRoute(model: string): boolean {
    // Dispatch refreshes expired evidence before POST; a synchronous selection check cannot.
    return this.models.has(model);
  }

  async healthCheck(): Promise<ProviderHealthResponse> {
    return this.transport.healthCheck();
  }
}

export function createBlockRunFreeAdapter(options: BlockRunFreeOptions = {}): BlockRunFreeAdapter {
  return new BlockRunFreeAdapter(options);
}
