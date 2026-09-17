import type { PrivacyClass, ProviderPolicyMetadata } from "@codeforge/forge-zero";

/**
 * CodeForge provider definition registry (R1 Free Cloud Platform).
 *
 * ONE place that describes how CodeForge talks to a provider: transport, connection schema
 * (which fields a user must supply), environment-variable aliases, discovery sources, the
 * provider's CURRENT free-access classification with evidence, privacy characteristics, and
 * terms status. Adapters, the desktop Settings UI, environment-credential discovery and the
 * 8-Bit admission pipeline all consume this — there is no provider-specific switch statement
 * scattered through React components.
 *
 * Classification is CodeForge knowledge derived from official provider documentation and live
 * catalogs (see docs/codeforge-provider-connections-r1.md). It is NOT upstream fact and it is
 * never a grant of free status by itself: a route still has to pass the admission pipeline.
 */

/** How a user connects a provider, in preferred-friction order. */
export type AuthClass =
  | "ZERO_TOUCH"
  | "OAUTH_PKCE"
  | "OAUTH_NATIVE"
  | "DEVICE_CODE"
  | "ENVIRONMENT_CREDENTIAL"
  | "ASSISTED_KEY"
  | "UNSUPPORTED";

/** Friction rank: lower is better. Used to order connection offers. */
export const AUTH_CLASS_FRICTION: Readonly<Record<AuthClass, number>> = {
  ZERO_TOUCH: 0,
  OAUTH_PKCE: 1,
  OAUTH_NATIVE: 2,
  DEVICE_CODE: 3,
  ENVIRONMENT_CREDENTIAL: 4,
  ASSISTED_KEY: 5,
  UNSUPPORTED: 99,
};

/**
 * Fine-grained free-access class of a provider's routes. Only the zero-cash classes may enter
 * ForgeAuto/Free, and only after independent verification. PROMOTIONAL_CREDIT and
 * FREE_DEV_ENDPOINT are deliberately NOT zero-cash-for-routing by default.
 */
export type FreeAccessClass =
  | "FREE_API"
  | "FREE_DAILY_ALLOCATION"
  | "FREE_MONTHLY_ALLOWANCE"
  | "FREE_ACCOUNT_ENTITLEMENT"
  | "FREE_PRODUCT_ONLY"
  | "FREE_DEV_ENDPOINT"
  | "PROMOTIONAL_CREDIT"
  | "PAID_API"
  | "UNAVAILABLE"
  | "LEGAL_REVIEW_REQUIRED";

/** Classes that are legitimately zero-cash and may be admitted to ForgeAuto/Free once verified. */
export const ZERO_CASH_FREE_ACCESS: readonly FreeAccessClass[] = [
  "FREE_API",
  "FREE_DAILY_ALLOCATION",
  "FREE_MONTHLY_ALLOWANCE",
  "FREE_ACCOUNT_ENTITLEMENT",
] as const;

export type TermsStatus = "CLEARED" | "RESTRICTED" | "DEVELOPMENT_ONLY" | "LEGAL_REVIEW_REQUIRED" | "NOT_ALLOWED";

/**
 * Can exhausting the free allowance silently create charges?
 * - NONE: provider hard-stops (or the route is listed at $0 unit price).
 * - ACCOUNT_DEPENDENT: depends on whether a payment method / paid plan is attached to the account.
 *   CodeForge must detect the plan or obtain an explicit user attestation before admitting.
 * - SILENT_CHARGES: allowance spills into pay-as-you-go automatically → never admitted.
 */
export type PaymentSpilloverRisk = "NONE" | "ACCOUNT_DEPENDENT" | "SILENT_CHARGES";

/** How CodeForge can establish which plan the connected account is on. */
export type PlanDetection = "not_required" | "api" | "attestation";

export interface ConnectionField {
  id: string;
  label: string;
  secret: boolean;
  optional?: boolean;
  /** Environment variables that may carry this field (first is the canonical name). */
  environmentAliases: string[];
  placeholder?: string;
  help?: string;
}

export interface ProviderConnectionSchema {
  fields: ConnectionField[];
}

export type ProviderApiStyle =
  | "openai-compatible"
  | "anthropic-messages"
  | "openrouter"
  | "opencode"
  | "hosted"
  | "internal";

export type ProviderDefinitionKind = "direct" | "gateway" | "fds-gateway" | "bundled";

export interface FreeAccessProfile {
  class: FreeAccessClass;
  /** Human-readable quota description ("10,000 neurons/day", "50 requests/day for :free"). */
  quota?: string;
  spillover: PaymentSpilloverRisk;
  planDetection: PlanDetection;
  /**
   * For allowance providers: the $0-unit-price rule cannot apply (unit prices are paid); free
   * status comes from the account's free plan. `allowanceScope` says which live-catalog models
   * the allowance covers: all chat models, or only an explicit allowlist (Cloudflare Free plan).
   */
  allowanceScope?: "all_chat_models" | "allowlist";
  /** Model ids (provider-native) covered by the free allowance when `allowanceScope === "allowlist"`. */
  allowanceModels?: string[];
  /** Model ids explicitly requiring a paid plan (never free on this provider). */
  paidPlanModels?: string[];
  evidence: { source: string; checkedAt: string; note?: string };
}

export interface ProviderDefinition {
  id: string;
  displayName: string;
  kind: ProviderDefinitionKind;
  apiStyle: ProviderApiStyle;
  baseUrl?: string;
  modelsPath?: string;
  /** Supported connection methods, preferred (lowest friction) first. */
  authClasses: AuthClass[];
  connection: ProviderConnectionSchema;
  discoverySources: Array<"models.dev" | "live-catalog" | "hosted-catalog">;
  freeAccess: FreeAccessProfile;
  privacy: { class: PrivacyClass; freeTierClass?: PrivacyClass; note?: string };
  terms: { status: TermsStatus; note?: string; source?: string };
  /** Reporting metadata for 8-Bit; this never grants route eligibility or consent. */
  policyMetadata?: ProviderPolicyMetadata;
  /** Whether CodeForge recommends this provider in the default free-connection offer. */
  recommendedForFreeDefault: boolean;
  /** True when a CodeForge adapter exists for this provider. */
  implemented: boolean;
  /** Where a user obtains a credential for the assisted-key flow. */
  keyUrl?: string;
  docsUrl?: string;
  /**
   * Live `/models` on this provider proves account availability but not price; a FRESH Models.dev
   * 0/0 record may supply the zero-unit evidence. Opt-in per provider (Z.AI only today).
   */
  allowLiveCatalogZeroUnitInference?: boolean;
  /** Providers with no free access of any kind. */
  paidOnly?: boolean;
  /** Provider offers only trial credits for otherwise-paid models. */
  hasTrial?: boolean;
  /** Providers discovered from Models.dev with no hand-written definition (generic OpenAI-compatible). */
  discovered?: boolean;
}

const CHECKED = "2026-09-15";

function apiKeyField(aliases: string[], help?: string): ConnectionField {
  return { id: "apiKey", label: "API key", secret: true, environmentAliases: aliases, help };
}

/** Hand-curated definitions for the providers CodeForge investigated for R1. */
export const PROVIDER_DEFINITIONS: Record<string, ProviderDefinition> = {
  "codeforge-cloud": {
    id: "codeforge-cloud",
    displayName: "CodeForge Free (hosted)",
    kind: "fds-gateway",
    apiStyle: "hosted",
    authClasses: ["ZERO_TOUCH", "OAUTH_NATIVE"],
    connection: { fields: [] },
    discoverySources: ["hosted-catalog"],
    freeAccess: {
      class: "FREE_ACCOUNT_ENTITLEMENT",
      quota: "CodeForge account entitlement (server-owned provider capacity)",
      spillover: "NONE",
      planDetection: "not_required",
      evidence: { source: "apps/cloud-api CloudProviderRegistry (server-owned keys, $0 routes only)", checkedAt: CHECKED },
    },
    privacy: { class: "standard", note: "Requests relay through CodeForge Cloud to upstream free routes." },
    terms: { status: "CLEARED", note: "First-party FDS gateway; upstream keys never leave the server." },
    recommendedForFreeDefault: true,
    implemented: true,
  },
  openrouter: {
    id: "openrouter",
    displayName: "OpenRouter",
    kind: "gateway",
    apiStyle: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    authClasses: ["OAUTH_PKCE", "ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    connection: { fields: [apiKeyField(["OPENROUTER_API_KEY"], "Prefer one-click connect; a key from openrouter.ai/keys also works.")] },
    discoverySources: ["models.dev", "live-catalog"],
    freeAccess: {
      class: "FREE_API",
      quota: "`:free` variants: 20 RPM; 50 requests/day (<10 credits purchased) or 1,000/day (>=10 credits)",
      spillover: "NONE",
      planDetection: "not_required",
      evidence: { source: "https://openrouter.ai/docs/api_reference/limits + live /api/v1/models pricing", checkedAt: CHECKED, note: "Free variants list prompt/completion price 0; a negative balance can 402 even free routes." },
    },
    privacy: { class: "standard", note: "Free variants may be served by providers that log/train; see OpenRouter model data policy." },
    terms: { status: "CLEARED", note: "OpenRouter documents PKCE for third-party desktop apps.", source: "https://openrouter.ai/docs/use-cases/oauth-pkce" },
    recommendedForFreeDefault: true,
    implemented: true,
    keyUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/docs",
  },
  zai: {
    id: "zai",
    displayName: "Z.AI",
    kind: "direct",
    apiStyle: "openai-compatible",
    baseUrl: "https://api.z.ai/api/paas/v4",
    authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    connection: { fields: [apiKeyField(["ZAI_API_KEY", "ZHIPU_API_KEY"])] },
    discoverySources: ["models.dev", "live-catalog"],
    freeAccess: {
      class: "FREE_API",
      quota: "GLM-4.5-Flash / GLM-4.7-Flash / GLM-4.6V-Flash listed at $0",
      spillover: "NONE",
      planDetection: "not_required",
      evidence: { source: "https://docs.z.ai/guides/overview/pricing", checkedAt: CHECKED },
    },
    privacy: { class: "standard" },
    terms: { status: "CLEARED" },
    recommendedForFreeDefault: true,
    implemented: true,
    hasTrial: true,
    allowLiveCatalogZeroUnitInference: true,
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
    docsUrl: "https://docs.z.ai",
  },
  alibaba: {
    id: "alibaba",
    displayName: "Alibaba Model Studio",
    kind: "direct",
    apiStyle: "openai-compatible",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    connection: { fields: [apiKeyField(["DASHSCOPE_API_KEY"], "Model Studio account authorization/KYC is required before use.")] },
    discoverySources: ["models.dev", "live-catalog"],
    freeAccess: {
      class: "PAID_API",
      quota: "Model Studio API is pay-as-you-go; no free Paid Auto route is assumed",
      spillover: "SILENT_CHARGES",
      planDetection: "not_required",
      evidence: { source: "https://www.alibabacloud.com/help/en/model-studio/models", checkedAt: CHECKED },
    },
    privacy: { class: "standard", note: "Paid Auto requires a separate privacy qualification before execution." },
    terms: { status: "CLEARED", note: "Account authorization is represented as a runtime gate; KYC is not bypassed." },
    recommendedForFreeDefault: false,
    implemented: true,
    paidOnly: true,
    keyUrl: "https://bailian.console.alibabacloud.com/?tab=globalset#/api-key",
    docsUrl: "https://www.alibabacloud.com/help/en/model-studio",
  },
  google: {
    id: "google",
    displayName: "Google Gemini",
    kind: "direct",
    apiStyle: "openai-compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    connection: { fields: [apiKeyField(["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"])] },
    discoverySources: ["models.dev", "live-catalog"],
    freeAccess: {
      class: "FREE_ACCOUNT_ENTITLEMENT",
      quota: "Gemini API Free Tier (per-project; limits shown in AI Studio)",
      spillover: "ACCOUNT_DEPENDENT",
      planDetection: "attestation",
      allowanceScope: "all_chat_models",
      evidence: { source: "https://ai.google.dev/gemini-api/docs/pricing", checkedAt: CHECKED, note: "Free tier exists for Flash/Flash-Lite/2.5 Pro; projects with billing enabled are charged." },
    },
    privacy: { class: "standard", freeTierClass: "permissive", note: "Free tier: 'Content used to improve our products'." },
    terms: { status: "CLEARED" },
    policyMetadata: {
      commercial_packaging_eligible: true,
      user_policy_acceptance_required: true,
      region_restrictions: ["EEA", "UK", "CH"],
      data_use_class: "TRAINING_POSSIBLE",
      confidential_data_eligible: false,
      free_or_paid_class: "UNPAID_ALLOWANCE",
      policy_revision: "gemini-api-unpaid-data-use/2026-03-23",
      official_terms_url: "https://ai.google.dev/gemini-api/terms",
    },
    recommendedForFreeDefault: false,
    implemented: true,
    keyUrl: "https://aistudio.google.com/apikey",
    docsUrl: "https://ai.google.dev/gemini-api/docs",
  },
  groq: {
    id: "groq",
    displayName: "Groq",
    kind: "direct",
    apiStyle: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    connection: { fields: [apiKeyField(["GROQ_API_KEY"])] },
    discoverySources: ["models.dev", "live-catalog"],
    freeAccess: {
      class: "FREE_DAILY_ALLOCATION",
      quota: "Free plan: 30 RPM / 1K RPD / 8K TPM / 200K TPD (gpt-oss, qwen)",
      spillover: "ACCOUNT_DEPENDENT",
      planDetection: "attestation",
      allowanceScope: "all_chat_models",
      evidence: { source: "https://console.groq.com/docs/rate-limits", checkedAt: CHECKED, note: "Developer plan (paid) shares the same key shape; plan is not exposed by the API." },
    },
    privacy: { class: "standard" },
    terms: { status: "CLEARED" },
    recommendedForFreeDefault: true,
    implemented: true,
    keyUrl: "https://console.groq.com/keys",
    docsUrl: "https://console.groq.com/docs",
  },
  cerebras: {
    id: "cerebras",
    displayName: "Cerebras",
    kind: "direct",
    apiStyle: "openai-compatible",
    baseUrl: "https://api.cerebras.ai/v1",
    authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    connection: { fields: [apiKeyField(["CEREBRAS_API_KEY"])] },
    discoverySources: ["models.dev", "live-catalog"],
    freeAccess: {
      class: "PROMOTIONAL_CREDIT",
      quota: "Free Trial: $5 credits expiring 30 days after grant; access stops when exhausted",
      spillover: "NONE",
      planDetection: "not_required",
      evidence: { source: "https://inference-docs.cerebras.ai/support/rate-limits", checkedAt: CHECKED, note: "Formerly a recurring free tier; now a time-boxed trial → not ForgeAuto/Free." },
    },
    privacy: { class: "standard" },
    terms: { status: "CLEARED" },
    policyMetadata: {
      commercial_packaging_eligible: true,
      user_policy_acceptance_required: false,
      region_restrictions: [],
      data_use_class: "STANDARD_PROVIDER_TERMS",
      confidential_data_eligible: false,
      free_or_paid_class: "TRIAL_CREDIT",
      policy_revision: "cerebras-commercial-terms/2024-08-27",
      official_terms_url: "https://www.cerebras.ai/terms-of-service",
    },
    recommendedForFreeDefault: false,
    implemented: true,
    keyUrl: "https://cloud.cerebras.ai",
    docsUrl: "https://inference-docs.cerebras.ai",
  },
  sambanova: {
    id: "sambanova",
    displayName: "SambaNova",
    kind: "direct",
    apiStyle: "openai-compatible",
    baseUrl: "https://api.sambanova.ai/v1",
    authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    connection: { fields: [apiKeyField(["SAMBANOVA_API_KEY"])] },
    discoverySources: ["live-catalog"],
    freeAccess: {
      class: "FREE_ACCOUNT_ENTITLEMENT",
      quota: "Free Tier applies while no payment method is linked; Developer Tier bills",
      spillover: "ACCOUNT_DEPENDENT",
      planDetection: "attestation",
      allowanceScope: "all_chat_models",
      evidence: { source: "https://docs.sambanova.ai/docs/en/models/rate-limits", checkedAt: CHECKED },
    },
    privacy: { class: "standard" },
    terms: { status: "CLEARED" },
    recommendedForFreeDefault: false,
    implemented: true,
    keyUrl: "https://cloud.sambanova.ai/apis",
    docsUrl: "https://docs.sambanova.ai",
  },
  mistral: {
    id: "mistral",
    displayName: "Mistral",
    kind: "direct",
    apiStyle: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
    authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    connection: { fields: [apiKeyField(["MISTRAL_API_KEY"])] },
    discoverySources: ["models.dev", "live-catalog"],
    freeAccess: {
      class: "FREE_MONTHLY_ALLOWANCE",
      quota: "Free mode includes monthly usage; current RPS, TPM, and monthly token limits are shown in the Admin Limits page; pay-as-you-go extends usage and bills",
      spillover: "ACCOUNT_DEPENDENT",
      planDetection: "attestation",
      allowanceScope: "all_chat_models",
      evidence: { source: "https://docs.mistral.ai/admin/billing-usage/usage-limits + https://docs.mistral.ai/admin/billing-usage/subscriptions", checkedAt: CHECKED, note: "Free mode is available, but account-level plan, monthly usage, and pay-as-you-go settings must be attested before managed routing; Preview/Beta/Labs routes are excluded from normal production discovery." },
    },
    privacy: { class: "standard", freeTierClass: "permissive", note: "Experiment plan requires opting in to data training." },
    terms: { status: "CLEARED" },
    policyMetadata: {
      commercial_packaging_eligible: true,
      user_policy_acceptance_required: false,
      region_restrictions: [],
      data_use_class: "TRAINING_POSSIBLE",
      confidential_data_eligible: false,
      free_or_paid_class: "UNPAID_ALLOWANCE",
      policy_revision: "mistral-commercial-terms/2026-08-05",
      official_terms_url: "https://legal.mistral.ai/terms/commercial-terms-of-service/",
    },
    recommendedForFreeDefault: false,
    implemented: true,
    keyUrl: "https://console.mistral.ai/api-keys",
    docsUrl: "https://docs.mistral.ai",
  },
  "cloudflare-workers-ai": {
    id: "cloudflare-workers-ai",
    displayName: "Cloudflare Workers AI",
    kind: "direct",
    apiStyle: "openai-compatible",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1",
    authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    connection: {
      fields: [
        { id: "apiKey", label: "API token", secret: true, environmentAliases: ["CLOUDFLARE_API_KEY", "CLOUDFLARE_API_TOKEN"], help: "An API token with Workers AI permissions." },
        { id: "accountId", label: "Account ID", secret: false, environmentAliases: ["CLOUDFLARE_ACCOUNT_ID"], help: "From the Cloudflare dashboard → Workers & Pages overview." },
      ],
    },
    discoverySources: ["models.dev", "live-catalog"],
    freeAccess: {
      class: "FREE_DAILY_ALLOCATION",
      quota: "Workers Free: 10,000 Neurons/day, hard stop; Workers Paid bills beyond allocation",
      spillover: "ACCOUNT_DEPENDENT",
      planDetection: "attestation",
      allowanceScope: "allowlist",
      allowanceModels: [
        "@cf/openai/gpt-oss-120b",
        "@cf/openai/gpt-oss-20b",
        "@cf/zai-org/glm-4.7-flash",
        "@cf/nvidia/nemotron-3-120b-a12b",
        "@cf/qwen/qwen3.8-27b",
        "@cf/qwen/qwen3-30b-a3b-fp8",
        "@cf/qwen/qwen2.5-coder-32b-instruct",
        "@cf/google/gemma-4-26b-a4b-it",
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        "@cf/meta/llama-4-scout-17b-16e-instruct",
        "@cf/mistralai/mistral-small-3.1-24b-instruct",
      ],
      paidPlanModels: [
        "@cf/moonshotai/kimi-k2.6",
        "@cf/moonshotai/kimi-k2.7-code",
        "@cf/zai-org/glm-5.2",
        "@cf/zai-org/glm-5.3",
        "@cf/zai-org/glm-5.3-flash",
        "@cf/deepseek-ai/deepseek-v4-flash-0731",
        "@cf/deepseek-ai/deepseek-v4-pro-0813",
      ],
      evidence: { source: "https://developers.cloudflare.com/workers-ai/platform/pricing/", checkedAt: CHECKED, note: "Kimi/GLM 5.x/DeepSeek v4 require Workers Paid or AI Gateway credits." },
    },
    privacy: { class: "standard" },
    terms: { status: "CLEARED" },
    recommendedForFreeDefault: false,
    implemented: true,
    keyUrl: "https://dash.cloudflare.com/profile/api-tokens",
    docsUrl: "https://developers.cloudflare.com/workers-ai/",
  },
  nvidia: {
    id: "nvidia",
    displayName: "NVIDIA API Catalog",
    kind: "direct",
    apiStyle: "openai-compatible",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    connection: { fields: [apiKeyField(["NVIDIA_API_KEY"])] },
    discoverySources: ["models.dev", "live-catalog"],
    freeAccess: {
      class: "FREE_DEV_ENDPOINT",
      quota: "Trial API credits for prototyping (build.nvidia.com); not a production entitlement",
      spillover: "NONE",
      planDetection: "not_required",
      evidence: { source: "https://docs.api.nvidia.com/nim/docs/faq", checkedAt: CHECKED, note: "Positioned for prototyping/evaluation; production expected on self-hosted NIM." },
    },
    privacy: { class: "standard" },
    terms: { status: "DEVELOPMENT_ONLY", note: "Evaluation endpoint; excluded from default production Free routing." },
    recommendedForFreeDefault: false,
    implemented: true,
    keyUrl: "https://build.nvidia.com",
    docsUrl: "https://docs.api.nvidia.com",
  },
  deepseek: {
    id: "deepseek",
    displayName: "DeepSeek",
    kind: "direct",
    apiStyle: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    connection: { fields: [apiKeyField(["DEEPSEEK_API_KEY"])] },
    discoverySources: ["models.dev", "live-catalog"],
    freeAccess: {
      class: "PAID_API",
      quota: "Direct API is pay-as-you-go (no recurring free tier)",
      spillover: "SILENT_CHARGES",
      planDetection: "not_required",
      evidence: { source: "https://api-docs.deepseek.com/quick_start/pricing", checkedAt: CHECKED },
    },
    privacy: { class: "standard" },
    terms: { status: "CLEARED" },
    recommendedForFreeDefault: false,
    implemented: true,
    paidOnly: true,
    keyUrl: "https://platform.deepseek.com/api_keys",
    docsUrl: "https://api-docs.deepseek.com",
  },
  poolside: {
    id: "poolside",
    displayName: "Poolside",
    kind: "direct",
    apiStyle: "openai-compatible",
    baseUrl: "https://inference.poolside.ai/v1",
    authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    connection: { fields: [apiKeyField(["POOLSIDE_API_KEY"])] },
    discoverySources: ["models.dev", "live-catalog"],
    freeAccess: {
      class: "FREE_DEV_ENDPOINT",
      quota: "Laguna models free-in-preview via platform.poolside.ai (no public rate card)",
      spillover: "NONE",
      planDetection: "not_required",
      evidence: { source: "https://platform.poolside.ai (preview) + Models.dev 0/0 listing", checkedAt: CHECKED, note: "Third-party/commercial terms unpublished → legal review before default routing." },
    },
    privacy: { class: "standard" },
    terms: { status: "LEGAL_REVIEW_REQUIRED" },
    recommendedForFreeDefault: false,
    implemented: true,
    keyUrl: "https://platform.poolside.ai",
  },
  huggingface: {
    id: "huggingface",
    displayName: "Hugging Face Inference Providers",
    kind: "gateway",
    apiStyle: "openai-compatible",
    baseUrl: "https://router.huggingface.co/v1",
    authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    connection: { fields: [apiKeyField(["HF_TOKEN", "HUGGINGFACE_API_KEY"])] },
    discoverySources: ["models.dev", "live-catalog"],
    freeAccess: {
      class: "PROMOTIONAL_CREDIT",
      quota: "Small monthly free credits; billed usage beyond credits on PAYG accounts",
      spillover: "ACCOUNT_DEPENDENT",
      planDetection: "attestation",
      evidence: { source: "https://huggingface.co/docs/inference-providers/pricing", checkedAt: CHECKED },
    },
    privacy: { class: "standard" },
    terms: { status: "CLEARED" },
    recommendedForFreeDefault: false,
    implemented: true,
    keyUrl: "https://huggingface.co/settings/tokens",
  },
  togetherai: {
    id: "togetherai",
    displayName: "Together AI",
    kind: "direct",
    apiStyle: "openai-compatible",
    baseUrl: "https://api.together.xyz/v1",
    authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    connection: { fields: [apiKeyField(["TOGETHER_API_KEY"])] },
    discoverySources: ["models.dev", "live-catalog"],
    freeAccess: { class: "PROMOTIONAL_CREDIT", quota: "Signup credit only", spillover: "SILENT_CHARGES", planDetection: "not_required", evidence: { source: "https://www.together.ai/pricing", checkedAt: CHECKED } },
    privacy: { class: "standard" },
    terms: { status: "CLEARED" },
    recommendedForFreeDefault: false,
    implemented: true,
    keyUrl: "https://api.together.xyz/settings/api-keys",
  },
  "fireworks-ai": {
    id: "fireworks-ai",
    displayName: "Fireworks AI",
    kind: "direct",
    apiStyle: "openai-compatible",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    connection: { fields: [apiKeyField(["FIREWORKS_API_KEY"])] },
    discoverySources: ["models.dev", "live-catalog"],
    freeAccess: { class: "PROMOTIONAL_CREDIT", quota: "Signup credit only", spillover: "SILENT_CHARGES", planDetection: "not_required", evidence: { source: "https://fireworks.ai/pricing", checkedAt: CHECKED } },
    privacy: { class: "standard" },
    terms: { status: "CLEARED" },
    recommendedForFreeDefault: false,
    implemented: true,
    keyUrl: "https://fireworks.ai/settings/users/api-keys",
  },
  siliconflow: {
    id: "siliconflow",
    displayName: "SiliconFlow",
    kind: "direct",
    apiStyle: "openai-compatible",
    baseUrl: "https://api.siliconflow.com/v1",
    authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    connection: { fields: [apiKeyField(["SILICONFLOW_API_KEY"])] },
    discoverySources: ["models.dev", "live-catalog"],
    freeAccess: { class: "LEGAL_REVIEW_REQUIRED", spillover: "ACCOUNT_DEPENDENT", planDetection: "attestation", evidence: { source: "Models.dev (no $0 listings); free-model program terms not reviewed", checkedAt: CHECKED } },
    privacy: { class: "standard" },
    terms: { status: "LEGAL_REVIEW_REQUIRED" },
    recommendedForFreeDefault: false,
    implemented: true,
  },
  nebius: {
    id: "nebius",
    displayName: "Nebius Token Factory",
    kind: "direct",
    apiStyle: "openai-compatible",
    baseUrl: "https://api.tokenfactory.nebius.com/v1",
    authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    connection: { fields: [apiKeyField(["NEBIUS_API_KEY"])] },
    discoverySources: ["models.dev", "live-catalog"],
    freeAccess: { class: "PROMOTIONAL_CREDIT", spillover: "SILENT_CHARGES", planDetection: "not_required", evidence: { source: "Models.dev (no $0 listings)", checkedAt: CHECKED } },
    privacy: { class: "standard" },
    terms: { status: "CLEARED" },
    recommendedForFreeDefault: false,
    implemented: true,
  },
  "novita-ai": {
    id: "novita-ai",
    displayName: "Novita AI",
    kind: "direct",
    apiStyle: "openai-compatible",
    baseUrl: "https://api.novita.ai/v3/openai",
    authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    connection: { fields: [apiKeyField(["NOVITA_API_KEY"])] },
    discoverySources: ["models.dev", "live-catalog"],
    freeAccess: { class: "PROMOTIONAL_CREDIT", spillover: "SILENT_CHARGES", planDetection: "not_required", evidence: { source: "Models.dev (no $0 listings)", checkedAt: CHECKED } },
    privacy: { class: "standard" },
    terms: { status: "CLEARED" },
    recommendedForFreeDefault: false,
    implemented: true,
  },
  hyperbolic: {
    id: "hyperbolic",
    displayName: "Hyperbolic",
    kind: "direct",
    apiStyle: "openai-compatible",
    baseUrl: "https://api.hyperbolic.xyz/v1",
    authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    connection: { fields: [apiKeyField(["HYPERBOLIC_API_KEY"])] },
    discoverySources: ["live-catalog"],
    freeAccess: { class: "PROMOTIONAL_CREDIT", spillover: "SILENT_CHARGES", planDetection: "not_required", evidence: { source: "Not listed on Models.dev; signup credit model", checkedAt: CHECKED } },
    privacy: { class: "standard" },
    terms: { status: "CLEARED" },
    recommendedForFreeDefault: false,
    implemented: true,
  },
  friendli: {
    id: "friendli",
    displayName: "Friendli",
    kind: "direct",
    apiStyle: "openai-compatible",
    baseUrl: "https://api.friendli.ai/serverless/v1",
    authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    connection: { fields: [apiKeyField(["FRIENDLI_TOKEN"])] },
    discoverySources: ["models.dev", "live-catalog"],
    freeAccess: { class: "PROMOTIONAL_CREDIT", spillover: "SILENT_CHARGES", planDetection: "not_required", evidence: { source: "Models.dev (no $0 listings)", checkedAt: CHECKED } },
    privacy: { class: "standard" },
    terms: { status: "CLEARED" },
    recommendedForFreeDefault: false,
    implemented: true,
  },
  baseten: {
    id: "baseten",
    displayName: "Baseten",
    kind: "direct",
    apiStyle: "openai-compatible",
    baseUrl: "https://inference.baseten.co/v1",
    authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    connection: { fields: [apiKeyField(["BASETEN_API_KEY"])] },
    discoverySources: ["models.dev", "live-catalog"],
    freeAccess: { class: "PROMOTIONAL_CREDIT", spillover: "SILENT_CHARGES", planDetection: "not_required", evidence: { source: "Models.dev (no $0 listings)", checkedAt: CHECKED } },
    privacy: { class: "standard" },
    terms: { status: "CLEARED" },
    recommendedForFreeDefault: false,
    implemented: true,
  },
  moonshotai: {
    id: "moonshotai",
    displayName: "Moonshot (Kimi)",
    kind: "direct",
    apiStyle: "openai-compatible",
    baseUrl: "https://api.moonshot.ai/v1",
    authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    connection: { fields: [apiKeyField(["MOONSHOT_API_KEY"])] },
    discoverySources: ["models.dev", "live-catalog"],
    freeAccess: { class: "PAID_API", spillover: "SILENT_CHARGES", planDetection: "not_required", evidence: { source: "Models.dev (no $0 listings)", checkedAt: CHECKED } },
    privacy: { class: "standard" },
    terms: { status: "CLEARED" },
    recommendedForFreeDefault: false,
    implemented: true,
    paidOnly: true,
  },
  opencode: {
    id: "opencode",
    displayName: "OpenCode Zen",
    kind: "gateway",
    apiStyle: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
    authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    connection: { fields: [apiKeyField(["OPENCODE_API_KEY"])] },
    discoverySources: ["models.dev", "live-catalog"],
    freeAccess: {
      class: "FREE_API",
      quota: "Zen `*-free` routes listed at $0 (many rotate/deprecate quickly)",
      spillover: "NONE",
      planDetection: "not_required",
      evidence: { source: "https://opencode.ai/docs/zen + live catalog", checkedAt: CHECKED },
    },
    privacy: { class: "standard" },
    terms: { status: "CLEARED", note: "Gateway documents API-key use by clients; free routes are promotional in nature and re-verified every 7 days." },
    recommendedForFreeDefault: false,
    implemented: true,
    keyUrl: "https://opencode.ai/auth",
  },
  kilo: {
    id: "kilo",
    displayName: "Kilo Gateway",
    kind: "gateway",
    apiStyle: "openai-compatible",
    baseUrl: "https://api.kilo.ai/api/gateway",
    authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    connection: { fields: [apiKeyField(["KILO_API_KEY"])] },
    discoverySources: ["models.dev"],
    freeAccess: { class: "LEGAL_REVIEW_REQUIRED", spillover: "NONE", planDetection: "not_required", evidence: { source: "Models.dev lists 24 $0 routes; third-party client terms not published", checkedAt: CHECKED } },
    privacy: { class: "standard" },
    terms: { status: "LEGAL_REVIEW_REQUIRED" },
    recommendedForFreeDefault: false,
    implemented: false,
  },
  zenmux: {
    id: "zenmux",
    displayName: "ZenMux",
    kind: "gateway",
    apiStyle: "openai-compatible",
    baseUrl: "https://zenmux.ai/api/v1",
    authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    connection: { fields: [apiKeyField(["ZENMUX_API_KEY"])] },
    discoverySources: ["models.dev"],
    freeAccess: { class: "LEGAL_REVIEW_REQUIRED", spillover: "NONE", planDetection: "not_required", evidence: { source: "Models.dev lists `*-free` routes incl. proprietary models; redistribution terms unverified", checkedAt: CHECKED } },
    privacy: { class: "standard" },
    terms: { status: "LEGAL_REVIEW_REQUIRED" },
    recommendedForFreeDefault: false,
    implemented: false,
  },
  "github-copilot": {
    id: "github-copilot",
    displayName: "GitHub Copilot",
    kind: "gateway",
    apiStyle: "openai-compatible",
    baseUrl: "https://api.githubcopilot.com",
    authClasses: ["UNSUPPORTED"],
    connection: { fields: [] },
    discoverySources: ["models.dev"],
    freeAccess: { class: "FREE_PRODUCT_ONLY", spillover: "NONE", planDetection: "not_required", evidence: { source: "No official third-party inference API for Copilot Free; endpoint is a private VS Code surface", checkedAt: CHECKED } },
    privacy: { class: "standard" },
    terms: { status: "NOT_ALLOWED", note: "No supported third-party client integration; CodeForge does not use Copilot tokens." },
    recommendedForFreeDefault: false,
    implemented: false,
  },
  anthropic: {
    id: "anthropic",
    displayName: "Anthropic",
    kind: "direct",
    apiStyle: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    connection: { fields: [apiKeyField(["ANTHROPIC_API_KEY"])] },
    discoverySources: ["models.dev", "live-catalog"],
    freeAccess: { class: "PAID_API", quota: "No zero-cost API route; consumer subscriptions do not grant API use", spillover: "SILENT_CHARGES", planDetection: "not_required", evidence: { source: "https://www.anthropic.com/pricing", checkedAt: CHECKED, note: "NO_SUPPORTED_ZERO_COST_ANTHROPIC_ROUTE" } },
    privacy: { class: "strict" },
    terms: { status: "CLEARED" },
    recommendedForFreeDefault: false,
    implemented: true,
    hasTrial: true,
    paidOnly: true,
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  openai: {
    id: "openai",
    displayName: "OpenAI",
    kind: "direct",
    apiStyle: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    connection: { fields: [apiKeyField(["OPENAI_API_KEY"])] },
    discoverySources: ["models.dev", "live-catalog"],
    freeAccess: { class: "PAID_API", quota: "No free API tier; ChatGPT/Codex subscriptions are not API entitlements", spillover: "SILENT_CHARGES", planDetection: "not_required", evidence: { source: "https://openai.com/api/pricing", checkedAt: CHECKED } },
    privacy: { class: "standard" },
    terms: { status: "CLEARED" },
    recommendedForFreeDefault: false,
    implemented: true,
    paidOnly: true,
    keyUrl: "https://platform.openai.com/api-keys",
  },
  codeforge: {
    id: "codeforge",
    displayName: "CodeForge (bundled)",
    kind: "bundled",
    apiStyle: "internal",
    authClasses: ["ZERO_TOUCH"],
    connection: { fields: [] },
    discoverySources: [],
    freeAccess: { class: "FREE_PRODUCT_ONLY", spillover: "NONE", planDetection: "not_required", evidence: { source: "bundled placeholder/smoke records", checkedAt: CHECKED } },
    privacy: { class: "strict" },
    terms: { status: "CLEARED" },
    recommendedForFreeDefault: false,
    implemented: true,
  },
};

export function getProviderDefinition(providerId: string): ProviderDefinition | undefined {
  return PROVIDER_DEFINITIONS[providerId];
}

export function allProviderDefinitions(): ProviderDefinition[] {
  return Object.values(PROVIDER_DEFINITIONS);
}

/** Every environment-variable name a definition may read (secret and non-secret fields). */
export function environmentVariablesFor(def: ProviderDefinition): string[] {
  return def.connection.fields.flatMap((f) => f.environmentAliases);
}

/** Providers whose free-access class is legitimately zero-cash (before any verification). */
export function isZeroCashFreeAccess(cls: FreeAccessClass): boolean {
  return ZERO_CASH_FREE_ACCESS.includes(cls);
}

/** True when the definition can be built into a real adapter by the provider factory. */
export function isImplementedProvider(providerId: string): boolean {
  return PROVIDER_DEFINITIONS[providerId]?.implemented === true;
}

export interface ModelsDevProviderHint {
  id: string;
  name?: string;
  env?: string[];
  api?: string;
  npm?: string;
  doc?: string;
}

/**
 * Merge Models.dev provider metadata into the definitions:
 *  - known providers gain any env aliases Models.dev documents that CodeForge did not list;
 *  - unknown OpenAI-compatible providers (npm `@ai-sdk/openai-compatible` + an `api` URL) become
 *    `discovered` definitions: connectable as BYOK through the generic adapter, NEVER admitted to
 *    ForgeAuto/Free (free class LEGAL_REVIEW_REQUIRED) until a curated definition exists.
 * Returns a NEW map; the curated table is never mutated.
 */
export function mergeModelsDevProviderHints(
  hints: ModelsDevProviderHint[],
  base: Record<string, ProviderDefinition> = PROVIDER_DEFINITIONS,
): Record<string, ProviderDefinition> {
  const out: Record<string, ProviderDefinition> = {};
  for (const [id, def] of Object.entries(base)) out[id] = def;
  for (const hint of hints) {
    if (!hint.id || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(hint.id)) continue;
    const existing = out[hint.id];
    if (existing) {
      const extraEnv = (hint.env ?? []).filter((v) => /^[A-Z][A-Z0-9_]{2,63}$/.test(v));
      if (extraEnv.length === 0) continue;
      const fields = existing.connection.fields.map((f, idx) => {
        if (idx !== 0 || !f.secret) return f;
        const aliases = [...f.environmentAliases];
        for (const v of extraEnv) if (!aliases.includes(v) && !isConfigVariable(v)) aliases.push(v);
        return { ...f, environmentAliases: aliases };
      });
      out[hint.id] = { ...existing, connection: { fields } };
      continue;
    }
    if (hint.npm !== "@ai-sdk/openai-compatible" || !hint.api || !hint.api.startsWith('https://')) continue;
    const env = (hint.env ?? []).filter((v) => /^[A-Z][A-Z0-9_]{2,63}$/.test(v));
    const secretEnv = env.filter((v) => !isConfigVariable(v));
    if (secretEnv.length === 0) continue;
    out[hint.id] = {
      id: hint.id,
      displayName: hint.name ?? hint.id,
      kind: "direct",
      apiStyle: "openai-compatible",
      baseUrl: hint.api.replace(/\/+$/, ""),
      authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
      connection: { fields: [apiKeyField(secretEnv)] },
      discoverySources: ["models.dev", "live-catalog"],
      freeAccess: {
        class: "LEGAL_REVIEW_REQUIRED",
        spillover: "ACCOUNT_DEPENDENT",
        planDetection: "attestation",
        evidence: { source: "Models.dev provider metadata (auto-discovered; no CodeForge review)", checkedAt: CHECKED },
      },
      privacy: { class: "standard" },
      terms: { status: "LEGAL_REVIEW_REQUIRED" },
      recommendedForFreeDefault: false,
      implemented: true,
      discovered: true,
      docsUrl: hint.doc,
    };
  }
  return out;
}

function isConfigVariable(name: string): boolean {
  return /ACCOUNT_ID|PROJECT|REGION|ORG|BASE_URL|ENDPOINT|RESOURCE|LOCATION/.test(name);
}
