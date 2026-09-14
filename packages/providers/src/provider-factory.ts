import type { CredentialStore, ProviderModel, ProviderResponseObserver } from "./index.js";
import { OpenAICompatibleAdapter, type OpenAICompatibleConfig } from "./openai-compatible.js";
import { AnthropicAdapter } from "./anthropic.js";
import { createOpenRouterAdapter } from "./openrouter.js";
import { createOpencodeAdapter } from "./opencode.js";
import type { ProviderAdapter } from "./index.js";

export interface ProviderFactoryOptions {
  credentialStore?: CredentialStore;
  apiKey?: string;
  timeoutMs?: number;
  /** Receives status + rate-limit headers for every upstream response (quota tracking). */
  onResponse?: ProviderResponseObserver;
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
    resolveModelsUrl: cloudflareModelsUrl,
    parseModels: parseCloudflareModels,
    resolveBaseUrl: (url) => {
      const acct = opts.accountId
        ?? opts.credentialStore?.get(configFieldKey("cloudflare-workers-ai", "accountId"))
        ?? opts.credentialStore?.get("cloudflare-account-id")
        ?? process.env.CLOUDFLARE_ACCOUNT_ID
        ?? "";
      return url.replace("${CLOUDFLARE_ACCOUNT_ID}", acct);
    },
    mapModel: mapCloudflareModel,
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

function common(opts: ProviderFactoryOptions): Pick<OpenAICompatibleConfig, "credentialStore" | "apiKey" | "timeoutMs" | "onResponse"> {
  return { credentialStore: opts.credentialStore, apiKey: opts.apiKey, timeoutMs: opts.timeoutMs, onResponse: opts.onResponse };
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

function cloudflareModelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/ai\/v1$/, "/ai/models/search")}?task=Text%20Generation`;
}

function parseCloudflareModels(data: unknown): unknown[] {
  if (typeof data !== "object" || data === null) return [];
  const result = (data as { result?: unknown }).result;
  return Array.isArray(result) ? result : [];
}

/**
 * Build a generic OpenAI-compatible adapter from a transport definition. Non-secret connection
 * fields (account ids, project ids) resolve `${ENV_NAME}` templates in the base URL from the
 * credential store (`providerId:fieldId`) and then from the environment.
 */
export function createProviderAdapterFromDefinition(def: ProviderTransportDefinition, opts: ProviderFactoryOptions = {}): ProviderAdapter | undefined {
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
      if (def.id === "cloudflare-workers-ai") {
        cfg.mapModel = mapCloudflareModel;
        cfg.resolveModelsUrl = cloudflareModelsUrl;
        cfg.parseModels = parseCloudflareModels;
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
    case "google":
      return createGeminiAdapter(opts);
    case "cloudflare-workers-ai":
      return createCloudflareAdapter(opts);
    case "openai":
      return createOpenAIAdapter(opts);
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
