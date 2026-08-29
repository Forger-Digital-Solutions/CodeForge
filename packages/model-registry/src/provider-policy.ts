import type { AccessClass, AuthMode, PrivacyClass } from "@codeforge/forge-zero";
import type { NormalizedCapabilities, NormalizedPricing } from "./normalized-types.js";

export type ProviderTransport = "openai-compatible" | "anthropic-messages" | "internal";
export type ProviderKind = "direct" | "gateway";

/**
 * CodeForge-owned provider policy. Derived from official-docs research
 * (see docs/research/provider-model-access-2026.md, checked 2026-08-29).
 * This is CodeForge knowledge/trust — NOT raw upstream facts.
 */
export interface ProviderPolicy {
  providerId: string;
  displayName: string;
  kind: ProviderKind;
  transport: ProviderTransport;
  authMode: AuthMode;
  /** Default privacy class of the provider's serving endpoints. */
  privacyClass: PrivacyClass;
  /** Privacy class of the provider's FREE tier specifically, if materially different. */
  freePrivacyClass?: PrivacyClass;
  /** Provider grants a recurring free quota/allowance (Gemini/Groq/Cloudflare). */
  hasAllowanceFree?: boolean;
  /** Provider offers only trial credits for otherwise-paid models (Anthropic). */
  hasTrial?: boolean;
  /** Provider has no free access of any kind (OpenAI). */
  paidOnly?: boolean;
  /** Base URL (may contain ${VAR} templates resolved at connect time). */
  baseUrl?: string;
  /** Env var(s) that carry the credential. */
  env?: string[];
}

export const PROVIDER_POLICIES: Record<string, ProviderPolicy> = {
  openrouter: {
    providerId: "openrouter",
    displayName: "OpenRouter",
    kind: "gateway",
    transport: "openai-compatible",
    authMode: "OAUTH_PKCE",
    privacyClass: "standard",
    baseUrl: "https://openrouter.ai/api/v1",
    env: ["OPENROUTER_API_KEY"],
  },
  zai: {
    providerId: "zai",
    displayName: "Z.AI",
    kind: "direct",
    transport: "openai-compatible",
    authMode: "API_KEY",
    privacyClass: "standard",
    hasTrial: true,
    baseUrl: "https://api.z.ai/api/paas/v4",
    env: ["ZHIPU_API_KEY", "ZAI_API_KEY"],
  },
  google: {
    providerId: "google",
    displayName: "Google Gemini",
    kind: "direct",
    transport: "openai-compatible",
    authMode: "API_KEY",
    privacyClass: "standard",
    // Free tier prompts may be used to improve Google products → weaker retention.
    freePrivacyClass: "permissive",
    hasAllowanceFree: true,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    env: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  },
  groq: {
    providerId: "groq",
    displayName: "Groq",
    kind: "direct",
    transport: "openai-compatible",
    authMode: "API_KEY",
    privacyClass: "standard",
    hasAllowanceFree: true,
    baseUrl: "https://api.groq.com/openai/v1",
    env: ["GROQ_API_KEY"],
  },
  "cloudflare-workers-ai": {
    providerId: "cloudflare-workers-ai",
    displayName: "Cloudflare Workers AI",
    kind: "direct",
    transport: "openai-compatible",
    authMode: "ACCOUNT_CONNECT",
    privacyClass: "standard",
    hasAllowanceFree: true,
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1",
    env: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY"],
  },
  openai: {
    providerId: "openai",
    displayName: "OpenAI",
    kind: "direct",
    transport: "openai-compatible",
    authMode: "API_KEY",
    privacyClass: "standard",
    paidOnly: true,
    baseUrl: "https://api.openai.com/v1",
    env: ["OPENAI_API_KEY"],
  },
  anthropic: {
    providerId: "anthropic",
    displayName: "Anthropic",
    kind: "direct",
    transport: "anthropic-messages",
    authMode: "API_KEY",
    privacyClass: "strict",
    hasTrial: true,
    baseUrl: "https://api.anthropic.com/v1",
    env: ["ANTHROPIC_API_KEY"],
  },
  opencode: {
    providerId: "opencode",
    displayName: "OpenCode Zen",
    kind: "gateway",
    transport: "openai-compatible",
    authMode: "API_KEY",
    privacyClass: "standard",
    baseUrl: "https://opencode.ai/zen/v1",
    env: ["OPENCODE_API_KEY"],
  },
};

export function getProviderPolicy(providerId: string): ProviderPolicy | undefined {
  return PROVIDER_POLICIES[providerId];
}

const isZeroUnit = (p: NormalizedPricing): boolean =>
  p.inputPerMillion === 0 && p.outputPerMillion === 0;

/**
 * Derive a CANDIDATE access classification from upstream facts + provider policy.
 * This is not trust: a candidate free class still requires independent CodeForge
 * verification (the overlay) before it can enter Auto free routing.
 */
export function deriveAccessClass(
  providerId: string,
  pricing: NormalizedPricing,
  capabilities: NormalizedCapabilities,
  policy: ProviderPolicy | undefined,
): AccessClass {
  if (pricing.inputPerMillion === null || pricing.outputPerMillion === null) {
    // Unknown pricing → never assume free.
    return "PAID";
  }
  if (isZeroUnit(pricing)) {
    return policy?.kind === "gateway" ? "FREE_ROUTED" : "FREE_NATIVE";
  }
  // Non-zero unit price. Allowance providers expose a recurring free quota despite the
  // listed paid unit price; mark text chat models as allowance candidates (verified later).
  if (policy?.hasAllowanceFree && capabilities.text && !policy.paidOnly) {
    return "FREE_ALLOWANCE";
  }
  return "PAID";
}

/** Derive the effective privacy class for a model given its access class. */
export function derivePrivacyClass(policy: ProviderPolicy | undefined, accessClass: AccessClass): PrivacyClass {
  if (!policy) return "standard";
  const isAllowanceOrPromo = accessClass === "FREE_ALLOWANCE" || accessClass === "FREE_PROMO";
  if (isAllowanceOrPromo && policy.freePrivacyClass) return policy.freePrivacyClass;
  return policy.privacyClass;
}
