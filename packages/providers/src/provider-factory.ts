import type { CredentialStore } from "./index.js";
import { OpenAICompatibleAdapter, type OpenAICompatibleConfig } from "./openai-compatible.js";
import { AnthropicAdapter } from "./anthropic.js";
import { createOpenRouterAdapter } from "./openrouter.js";
import { createOpencodeAdapter } from "./opencode.js";
import type { ProviderAdapter } from "./index.js";

export interface ProviderFactoryOptions {
  credentialStore?: CredentialStore;
  apiKey?: string;
  timeoutMs?: number;
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
        ?? opts.credentialStore?.get("cloudflare-account-id")
        ?? process.env.CLOUDFLARE_ACCOUNT_ID
        ?? "";
      return url.replace("${CLOUDFLARE_ACCOUNT_ID}", acct);
    },
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

function common(opts: ProviderFactoryOptions): Pick<OpenAICompatibleConfig, "credentialStore" | "apiKey" | "timeoutMs"> {
  return { credentialStore: opts.credentialStore, apiKey: opts.apiKey, timeoutMs: opts.timeoutMs };
}

/**
 * Build a provider adapter by id. Central place mapping providerId → transport, so the desktop
 * and server never hand-write provider HTTP. Returns undefined for unknown providers.
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
