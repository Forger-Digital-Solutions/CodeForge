import type { CredentialStore, ProviderModel, ProviderResponseObserver } from "./index.js";
import { OpenAICompatibleAdapter, type OpenAICompatibleConfig } from "./openai-compatible.js";
import { AnthropicAdapter } from "./anthropic.js";
import { createOpenRouterAdapter } from "./openrouter.js";
import { createOpencodeAdapter } from "./opencode.js";
import type { ProviderAdapter } from "./index.js";
import type { CloudflareNeuronBudgetGuard } from "./cloudflare-neuron-budget.js";
import type { GeminiFreePolicyGate } from "@codeforge/legal-policy";

export interface ProviderFactoryOptions {
  credentialStore?: CredentialStore;
  apiKey?: string;
  timeoutMs?: number;
  /** Injectable fetch for deterministic provider contract tests and custom runtimes. */
  fetchFn?: typeof fetch;
  /** Receives status + rate-limit headers for every upstream response (quota tracking). */
  onResponse?: ProviderResponseObserver;
  /** Cloudflare Workers AI daily-neuron guard. The Cloudflare factory fails closed when omitted. */
  cloudflareNeuronGuard?: CloudflareNeuronBudgetGuard;
  geminiFreePolicyGate?: GeminiFreePolicyGate;
  geminiServiceTier?: "UNPAID" | "PAID";
}

/**
 * The transport facts the factory needs from a provider definition. `@codeforge/model-registry`'s
 * `ProviderDefinition` satisfies this structurally; the providers package deliberately does not
 * depend on the registry so the dependency graph stays acyclic.
 */
export interface ProviderTransportDefinition {
  id: string;
  apiStyle: "openai-compatible" | "anthropic-messages" | "openrouter" | "opencode" | "hosted" | "internal";
  baseUrl?: string;
  modelsPath?: string;
  connection: { fields: Array<{ id: string; secret: boolean; environmentAliases: string[] }> };
}

/** Key under which a non-secret connection field (account id, project id…) is stored. */
export function configFieldKey(providerId: string, fieldId: string): string {
  return `${providerId}:${fieldId}`;
}

/** Z.AI direct (OpenAI-compatible /paas/v4). FREE_NATIVE glm-*-flash + paid glm coding models. */
export function createZaiAdapter(opts: ProviderFactoryOptions = {}): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    providerId: "zai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    ...common(opts),
  });
}

/** Groq (OpenAI-compatible). Free developer allowance + paid unit prices. */
export function createGroqAdapter(opts: ProviderFactoryOptions = {}): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    providerId: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    ...common(opts),
    // GPT-OSS returns reasoning separately by default. Excluding it keeps the model's final
    // answer available to the shared agent loop and avoids treating private reasoning as UI text.
    requestBodyExtras: { include_reasoning: false },
  });
}

/** Mistral API (OpenAI-compatible). Preview, beta, and labs entries are not normal production routes. */
export function createMistralAdapter(opts: ProviderFactoryOptions = {}): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    providerId: "mistral",
    baseUrl: "https://api.mistral.ai/v1",
    ...common(opts),
    mapModel: mapNormalProductionModel,
  });
}

/** Cerebras API (OpenAI-compatible). Only live normal-production catalog entries are surfaced. */
export function createCerebrasAdapter(opts: ProviderFactoryOptions = {}): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    providerId: "cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    ...common(opts),
    mapModel: mapNormalProductionModel,
  });
}

/**
 * Google Gemini via its OpenAI-compatible endpoint. Same API key, different base URL + model name.
 * Free tier is a quota allowance (verified independently, never from pricing).
 */
export function createGeminiAdapter(opts: ProviderFactoryOptions = {}): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    providerId: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    ...common(opts),
    mapModel: mapGeminiModel,
    geminiFreePolicyGate: opts.geminiFreePolicyGate,
    geminiServiceTier: opts.geminiServiceTier,
  });
}

/**
 * Cloudflare Workers AI (OpenAI-compatible). Base URL contains ${CLOUDFLARE_ACCOUNT_ID}, resolved
 * from the credential store or env at request time. Auth via API token bearer.
 */
export function createCloudflareAdapter(opts: ProviderFactoryOptions & { accountId?: string } = {}): OpenAICompatibleAdapter {
  const cfg: OpenAICompatibleConfig = {
    providerId: "cloudflare-workers-ai",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1",
    ...common(opts),
    resolveBaseUrl: (url) => {
      const acct = opts.accountId
        ?? opts.credentialStore?.get(configFieldKey("cloudflare-workers-ai", "accountId"))
        ?? opts.credentialStore?.get("cloudflare-account-id")
        ?? process.env.CLOUDFLARE_ACCOUNT_ID
        ?? "";
      return url.replace("${CLOUDFLARE_ACCOUNT_ID}", acct);
    },
    mapModel: mapCloudflareModel,
    cloudflareNeuronGuard: opts.cloudflareNeuronGuard,
  };
  return new OpenAICompatibleAdapter(cfg);
}

/** OpenAI (native Chat Completions). PAID only — never in free routing. */
export function createOpenAIAdapter(opts: ProviderFactoryOptions = {}): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    providerId: "openai",
    baseUrl: "https://api.openai.com/v1",
    ...common(opts),
  });
}

/** Alibaba Model Studio's global OpenAI-compatible endpoint. KYC/authorization stays outside this transport. */
export function createAlibabaAdapter(opts: ProviderFactoryOptions = {}): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    providerId: "alibaba",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    ...common(opts),
    credentialStore: aliasedCredentialStore(opts.credentialStore, "alibaba", "DASHSCOPE_API_KEY"),
  });
}

/** DeepSeek's OpenAI-compatible API. The Paid Auto registry maps its canonical V4.1 id to `deepseek-flash`. */
export function createDeepSeekAdapter(opts: ProviderFactoryOptions = {}): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    providerId: "deepseek",
    baseUrl: "https://api.deepseek.com",
    ...common(opts),
  });
}

function common(opts: ProviderFactoryOptions): Pick<OpenAICompatibleConfig, "credentialStore" | "apiKey" | "timeoutMs" | "fetchFn" | "onResponse" | "cloudflareNeuronGuard" | "geminiFreePolicyGate" | "geminiServiceTier"> {
  return {
    credentialStore: opts.credentialStore,
    apiKey: opts.apiKey,
    timeoutMs: opts.timeoutMs,
    fetchFn: opts.fetchFn,
    onResponse: opts.onResponse,
    cloudflareNeuronGuard: opts.cloudflareNeuronGuard,
    geminiFreePolicyGate: opts.geminiFreePolicyGate,
    geminiServiceTier: opts.geminiServiceTier,
  };
}

function aliasedCredentialStore(base: CredentialStore | undefined, providerId: string, environmentName: string): CredentialStore {
  return {
    get: (requestedId) => requestedId === providerId
      ? base?.get(environmentName) ?? process.env[environmentName]
      : base?.get(requestedId),
    set: (requestedId, value) => base?.set(requestedId, value),
    delete: (requestedId) => base?.delete(requestedId) ?? false,
    has: (requestedId) => requestedId === providerId
      ? Boolean(base?.get(environmentName) ?? process.env[environmentName])
      : base?.has(requestedId) ?? false,
  };
}

/** Gemini's OpenAI-compatible listing prefixes ids with "models/" and includes non-chat models. */
function mapGeminiModel(raw: unknown): ProviderModel | null {
  const m = raw as { id?: string };
  if (!m?.id) return null;
  const id = m.id.replace(/^models\//, "");
  if (!/^gemini/.test(id) || /embedding|tts|image|veo|imagen|native-audio|live|computer-use|robotics/i.test(id)) return null;
  return {
    modelId: id,
    displayName: id,
    capabilities: { text: true, coding: true, toolCalling: true, vision: true, structuredOutput: true, longContext: true },
    isFree: false,
    freeStatus: "unknown",
  };
}

/** Cloudflare's OpenAI-compatible listing; only text-generation models are chat candidates. */
function mapCloudflareModel(raw: unknown): ProviderModel | null {
  const m = raw as { id?: string; task?: { name?: string } };
  if (!m?.id) return null;
  if (m.task?.name && !/text generation/i.test(m.task.name)) return null;
  if (/embed|whisper|guard|rerank|lora|bge|melotts|flux|stable-diffusion|resnet|detr|uform|m2m100|opus-mt|dreamshaper|distilbert/i.test(m.id)) return null;
  return {
    modelId: m.id,
    displayName: m.id.replace(/^@cf\//, ""),
    capabilities: { text: true, coding: true, toolCalling: true, vision: /vision|llava/i.test(m.id), structuredOutput: true, longContext: false },
    isFree: false,
    freeStatus: "unknown",
  };
}

/**
 * Normal-production filter shared by providers whose catalogs include preview/beta/labs routes.
 * Availability and pricing still come from the live catalog and ForgeZero; this only prevents
 * clearly non-production labels from entering the common chat-model contract.
 */
function mapNormalProductionModel(raw: unknown): ProviderModel | null {
  if (typeof raw !== "object" || raw === null) return null;
  const model = raw as Record<string, unknown>;
  const id = typeof model.id === "string" ? model.id : "";
  const name = typeof model.name === "string" ? model.name : "";
  if (!id || /(?:preview|beta|labs|experimental|deprecated)/i.test(`${id} ${name}`)) return null;
  return {
    modelId: id,
    displayName: name || id,
    contextWindow: typeof model.context_length === "number" ? model.context_length : undefined,
    capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: false },
    isFree: false,
    freeStatus: "unknown",
  };
}

/**
 * Build a generic OpenAI-compatible adapter from a transport definition. Non-secret connection
 * fields (account ids, project ids) resolve `${ENV_NAME}` templates in the base URL from the
 * credential store (`providerId:fieldId`) and then from the environment.
 */
export function createProviderAdapterFromDefinition(def: ProviderTransportDefinition, opts: ProviderFactoryOptions = {}): ProviderAdapter | undefined {
  if (def.id === "alibaba") return createAlibabaAdapter(opts);
  if (def.id === "deepseek") return createDeepSeekAdapter(opts);
  switch (def.apiStyle) {
    case "openrouter":
      return createOpenRouterAdapter({ credentialStore: opts.credentialStore, timeoutMs: opts.timeoutMs });
    case "opencode":
      return createOpencodeAdapter({ credentialStore: opts.credentialStore, timeoutMs: opts.timeoutMs });
    case "anthropic-messages":
      return new AnthropicAdapter({ credentialStore: opts.credentialStore, apiKey: opts.apiKey, timeoutMs: opts.timeoutMs });
    case "openai-compatible": {
      if (!def.baseUrl) return undefined;
      const configFields = def.connection.fields.filter((f) => !f.secret);
      const cfg: OpenAICompatibleConfig = {
        providerId: def.id,
        baseUrl: def.baseUrl,
        modelsPath: def.modelsPath,
        ...common(opts),
        resolveBaseUrl: (url) => {
          let resolved = url;
          for (const field of configFields) {
            for (const alias of field.environmentAliases) {
              const token = "${" + alias + "}";
              if (!resolved.includes(token)) continue;
              const value = opts.credentialStore?.get(configFieldKey(def.id, field.id)) ?? process.env[alias] ?? "";
              resolved = resolved.split(token).join(value);
            }
          }
          return resolved;
        },
      };
      if (def.id === "google") cfg.mapModel = mapGeminiModel;
      if (def.id === "mistral" || def.id === "cerebras") cfg.mapModel = mapNormalProductionModel;
      if (def.id === "cloudflare-workers-ai") {
        cfg.mapModel = mapCloudflareModel;
        cfg.cloudflareNeuronGuard = opts.cloudflareNeuronGuard;
        cfg.resolveBaseUrl = (url) => {
          const acct = opts.credentialStore?.get(configFieldKey("cloudflare-workers-ai", "accountId"))
            ?? opts.credentialStore?.get("cloudflare-account-id")
            ?? process.env.CLOUDFLARE_ACCOUNT_ID
            ?? "";
          return url.replace("${CLOUDFLARE_ACCOUNT_ID}", acct);
        };
      }
      return new OpenAICompatibleAdapter(cfg);
    }
    default:
      return undefined;
  }
}

/**
 * Build a provider adapter by id. Central place mapping providerId → transport, so the desktop
 * and server never hand-write provider HTTP. Returns undefined for unknown providers; callers
 * with a provider definition should prefer {@link createProviderAdapterFromDefinition}.
 */
export function createProviderAdapterById(providerId: string, opts: ProviderFactoryOptions = {}): ProviderAdapter | undefined {
  switch (providerId) {
    case "zai":
      return createZaiAdapter(opts);
    case "groq":
      return createGroqAdapter(opts);
    case "mistral":
      return createMistralAdapter(opts);
    case "cerebras":
      return createCerebrasAdapter(opts);
    case "google":
      return createGeminiAdapter(opts);
    case "cloudflare-workers-ai":
      return createCloudflareAdapter(opts);
    case "openai":
      return createOpenAIAdapter(opts);
    case "alibaba":
      return createAlibabaAdapter(opts);
    case "deepseek":
      return createDeepSeekAdapter(opts);
    case "anthropic":
      return new AnthropicAdapter({ credentialStore: opts.credentialStore, apiKey: opts.apiKey, timeoutMs: opts.timeoutMs });
    case "openrouter":
      // OpenRouter gateway (dedicated adapter: OAuth-aware, attribution headers, models cache).
      return createOpenRouterAdapter({ credentialStore: opts.credentialStore, timeoutMs: opts.timeoutMs });
    case "opencode":
      // OpenCode Zen gateway (dedicated adapter).
      return createOpencodeAdapter({ credentialStore: opts.credentialStore, timeoutMs: opts.timeoutMs });
    default:
      return undefined;
  }
}
