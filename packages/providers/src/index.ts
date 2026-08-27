import type { ChatRequest, ChatResponse, StreamEvent, ToolDefinition, Usage } from "./chat-types.js";

export * from "./chat-types.js";

export interface ProviderAdapter {
  readonly providerId: string;
  readonly isTestProvider?: boolean;
  listModels(): Promise<ProviderModel[]>;
  chat(req: ChatRequest): Promise<ChatResponse>;
  streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
  healthCheck(): Promise<ProviderHealthResponse>;
}

/**
 * Product tier for a model in CodeForge's offering.
 * - "free": Models available at no cost through Free Tier
 * - "gems_paid": CodeForge first-party paid models (Topaz, Sapphire, Peridot, Garnet)
 */
export type ModelTier = "free" | "gems_paid";

/**
 * User's entitlement status for a model.
 * - "included": User has full access to this model
 * - "requires_subscription": User needs to upgrade to access
 * - "trial": User has temporary/trial access
 * - "not_entitled": User does not have access
 */
export type EntitlementStatus = "included" | "requires_subscription" | "trial" | "not_entitled";

export interface ProviderModel {
  modelId: string;
  displayName: string;
  contextWindow?: number;
  capabilities: {
    text: boolean;
    coding: boolean;
    toolCalling: boolean;
    vision: boolean;
    structuredOutput: boolean;
    longContext: boolean;
  };
  /** Provider-side cost status - what the provider says this model costs */
  isFree: boolean;
  freeStatus: "verified_free" | "unknown" | "paid";
  /** CodeForge product tier - distinguishes Free Tier from GEMS models */
  tier?: ModelTier;
  /** User's entitlement for this model - whether they can use it */
  entitlementStatus?: EntitlementStatus;
}

export type ProviderRegistry = Map<string, ProviderAdapter>;

export interface ProviderConfig {
  readonly providerId: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

export interface ProviderCatalog {
  readonly adapters: Map<string, ProviderAdapter>;
  register(adapter: ProviderAdapter): void;
  get(providerId: string): ProviderAdapter | undefined;
  all(): ProviderAdapter[];
}

export interface ProviderHealthResponse {
  status: "available" | "rate_limited" | "offline" | "unknown";
  latencyMs?: number;
  error?: string;
}

export interface CatalogOptions {
  credentialStore?: CredentialStore;
}

export interface CredentialStore {
  get(providerId: string): string | undefined;
  set(providerId: string, credential: string): void;
  delete(providerId: string): boolean;
  has(providerId: string): boolean;
}

export type ProviderStatus =
  | "ready"
  | "missing_credential"
  | "invalid_configuration"
  | "unsupported"
  | "coming_soon";

export const testProvidersAllowed = (): boolean =>
  process.env.NODE_ENV === "test" || process.env.CODEFORGE_ALLOW_TEST_PROVIDERS === "1";

export class TestProviderIsolationError extends Error {
  constructor(providerId: string) {
    super(
      `Refusing to register test provider '${providerId}' outside test mode. ` +
        `Production must never route inference through a scripted provider (ForgeZero isolation).`,
    );
    this.name = "TestProviderIsolationError";
  }
}

export const assertRegistrable = (adapter: ProviderAdapter): void => {
  if (adapter.isTestProvider && !testProvidersAllowed()) {
    throw new TestProviderIsolationError(adapter.providerId);
  }
};

export class InMemoryProviderCatalog implements ProviderCatalog {
  readonly adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    assertRegistrable(adapter);
    this.adapters.set(adapter.providerId, adapter);
  }

  get(providerId: string): ProviderAdapter | undefined {
    return this.adapters.get(providerId);
  }

  all(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }
}

export interface MockProviderOptions {
  providerId: string;
  models?: ProviderModel[];
  responses?: ChatResponse[];
  streamEvents?: StreamEvent[][];
}

export function createMockProvider(
  optionsOrId: MockProviderOptions | string,
): ProviderAdapter {
  const options: MockProviderOptions =
    typeof optionsOrId === "string" ? { providerId: optionsOrId } : optionsOrId;

  const models: ProviderModel[] = options.models ?? [
    { modelId: "mock-model", displayName: "Mock Model", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: false, longContext: false }, isFree: true, freeStatus: "verified_free" },
  ];

  let responseIndex = 0;
  let streamIndex = 0;

  return {
    providerId: options.providerId,
    isTestProvider: true,

    async listModels(): Promise<ProviderModel[]> {
      return models;
    },

    async chat(req: ChatRequest): Promise<ChatResponse> {
      if (options.responses && options.responses.length > 0) {
        const response = options.responses[responseIndex % options.responses.length]!;
        responseIndex++;
        return response;
      }
      return {
        id: crypto.randomUUID(),
        model: req.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Mock response" },
            finishReason: "stop",
          },
        ],
      };
    },

    async *streamChat(_req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
      if (options.streamEvents && options.streamEvents.length > 0) {
        const events = options.streamEvents[streamIndex % options.streamEvents.length];
        if (events) {
          streamIndex++;
          for (const event of events) {
            if (signal?.aborted) return;
            yield event;
          }
        }
        return;
      }

      if (signal?.aborted) return;

      yield { type: "text_delta", delta: "Mock " };
      yield { type: "text_delta", delta: "streaming " };
      yield { type: "text_delta", delta: "response." };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
      yield { type: "finish", finishReason: "stop" };
    },

    async healthCheck(): Promise<ProviderHealthResponse> {
      return { status: "available", latencyMs: 1 };
    },
  };
}

export class ProviderCatalogService {
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly credentialStore: CredentialStore;

  constructor(options: CatalogOptions = {}) {
    this.credentialStore = options.credentialStore ?? new EnvironmentCredentialStore();
  }

  register(adapter: ProviderAdapter): void {
    assertRegistrable(adapter);
    this.adapters.set(adapter.providerId, adapter);
  }

  get(providerId: string): ProviderAdapter | undefined {
    return this.adapters.get(providerId);
  }

  all(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }

  getStatus(providerId: string): ProviderStatus {
    const adapter = this.adapters.get(providerId);
    if (!adapter) return "unsupported";
    const credential = this.credentialStore.get(providerId);
    if (!credential) return "missing_credential";
    return "ready";
  }
}

export class EnvironmentCredentialStore implements CredentialStore {
  private readonly store = new Map<string, string>();

  get(providerId: string): string | undefined {
    return this.store.get(providerId) ?? process.env[`${providerId.toUpperCase()}_API_KEY`];
  }

  set(providerId: string, credential: string): void {
    this.store.set(providerId, credential);
  }

  delete(providerId: string): boolean {
    return this.store.delete(providerId);
  }

  has(providerId: string): boolean {
    return this.store.has(providerId) || !!process.env[`${providerId.toUpperCase()}_API_KEY`];
  }
}

export function createProviderCatalog(options?: CatalogOptions): ProviderCatalogService {
  return new ProviderCatalogService(options);
}

export interface ScriptedStep {
  type: "response" | "error" | "delay";
  payload?: unknown;
  delayMs?: number;
}

export interface ScriptedProviderOptions {
  providerId: string;
  steps: ScriptedStep[];
}

export class ScriptedTestProvider implements ProviderAdapter {
  readonly providerId: string;
  readonly isTestProvider = true;
  private steps: ScriptedStep[];
  private stepIndex = 0;

  constructor(options: ScriptedProviderOptions) {
    this.providerId = options.providerId;
    this.steps = options.steps;
  }

  listModels(): Promise<ProviderModel[]> {
    return Promise.resolve([]);
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    if (!testProvidersAllowed()) {
      throw new TestProviderIsolationError(this.providerId);
    }
    if (this.steps.length === 0) {
      return { id: crypto.randomUUID(), model: "test", choices: [{ index: 0, message: { role: "assistant", content: "" } }] };
    }
    const step = this.steps[this.stepIndex % this.steps.length];
    this.stepIndex++;
    if (step?.delayMs) {
      await new Promise((r) => setTimeout(r, step.delayMs));
    }
    if (step?.type === "error") {
      throw new ProviderError(String(step?.payload ?? "Scripted error"));
    }
    return (step?.payload as ChatResponse) ?? { id: crypto.randomUUID(), model: "test", choices: [{ index: 0, message: { role: "assistant", content: "" } }] };
  }

  async *streamChat(_req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    if (!testProvidersAllowed()) {
      throw new TestProviderIsolationError(this.providerId);
    }
    if (signal?.aborted) return;

    yield { type: "text_delta", delta: "Scripted response" };
    yield { type: "finish", finishReason: "stop" };
  }

  async healthCheck(): Promise<ProviderHealthResponse> {
    return { status: "available" };
  }
}

export function createScriptedTestProvider(options: ScriptedProviderOptions): ScriptedTestProvider {
  return new ScriptedTestProvider(options);
}

export class ProviderError extends Error {
  readonly code?: string;
  readonly retryable?: boolean;

  constructor(message: string, code?: string, retryable?: boolean) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

export { OpenRouterAdapter, type OpenRouterOptions, createOpenRouterAdapter } from "./openrouter.js";
export { OpencodeAdapter, type OpencodeOptions, createOpencodeAdapter } from "./opencode.js";
