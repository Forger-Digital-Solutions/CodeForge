import { z } from "zod";

export const ModelCostProfileSchema = z.object({
  inputCostPerMillion: z.number().nullable(),
  outputCostPerMillion: z.number().nullable(),
  cacheReadCostPerMillion: z.number().nullable().optional(),
  cacheWriteCostPerMillion: z.number().nullable().optional(),

  isFree: z.boolean(),
  freeTierVerifiedAt: z.string().datetime().optional(),

  freeQuotaDescription: z.string().optional(),
  freeQuotaRemaining: z.number().nullable().optional(),

  paidFallbackPossible: z.boolean(),
  paidFallbackDisabled: z.boolean(),

  source: z.string(),
});
export type ModelCostProfile = z.infer<typeof ModelCostProfileSchema>;

export const ModelCapabilitiesSchema = z.object({
  text: z.boolean(),
  coding: z.boolean(),
  toolCalling: z.boolean(),
  vision: z.boolean(),
  structuredOutput: z.boolean(),
  longContext: z.boolean(),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

export const ModelLimitsSchema = z.object({
  requestsPerMinute: z.number().int().positive().optional(),
  requestsPerDay: z.number().int().positive().optional(),
  tokensPerMinute: z.number().int().positive().optional(),
  tokensPerDay: z.number().int().positive().optional(),
});
export type ModelLimits = z.infer<typeof ModelLimitsSchema>;

export const ModelBenchmarkProfileSchema = z.object({
  coding: z.number().min(0).max(100).optional(),
  toolCalling: z.number().min(0).max(100).optional(),
  reasoning: z.number().min(0).max(100).optional(),
  vision: z.number().min(0).max(100).optional(),
  speed: z.number().min(0).max(100).optional(),
  longContext: z.number().min(0).max(100).optional(),
});
export type ModelBenchmarkProfile = z.infer<typeof ModelBenchmarkProfileSchema>;

export const ModelHealthStateSchema = z.object({
  status: z.enum([
    "configured",
    "authenticated",
    "verified",
    "available",
    "degraded",
    "auth_required",
    "rate_limited",
    "quota_exhausted",
    "offline",
    "unknown",
  ]),
  lastCheckedAt: z.string().datetime().optional(),
  lastError: z.string().optional(),
  /** Epoch millis after which a rate-limited/cooling provider may be retried. */
  retryAfter: z.number().int().nonnegative().optional(),
  /** Rolling count of recent consecutive failures (health penalty input). */
  recentFailureCount: z.number().int().nonnegative().optional(),
  latencyMs: z.number().nonnegative().optional(),
});
export type ModelHealthState = z.infer<typeof ModelHealthStateSchema>;

/**
 * CodeForge free-access classification. Preserves meaningful distinctions instead of
 * collapsing everything into a single misleading `free` boolean.
 * - FREE_NATIVE:    provider charges $0 for the model itself (e.g. Z.AI glm-4.5-flash)
 * - FREE_ROUTED:    a gateway exposes a verified $0 route (e.g. OpenRouter `*:free`)
 * - FREE_ALLOWANCE: provider grants a recurring free quota/allowance (Gemini/Groq/Cloudflare)
 * - FREE_PROMO:     temporary promotional free access
 * - TRIAL:          time/token-limited trial credits (Anthropic, Z.AI coding-plan trial)
 * - PAID:           may incur a monetary charge
 * - UNAVAILABLE:    not currently usable (deprecated/offline/no route)
 */
export const AccessClassSchema = z.enum([
  "FREE_NATIVE",
  "FREE_ROUTED",
  "FREE_ALLOWANCE",
  "FREE_PROMO",
  "TRIAL",
  "PAID",
  "UNAVAILABLE",
]);
export type AccessClass = z.infer<typeof AccessClassSchema>;

/** $0-unit access classes: provider/gateway lists the model's unit price as zero. */
export const ZERO_UNIT_ACCESS: readonly AccessClass[] = ["FREE_NATIVE", "FREE_ROUTED"] as const;
/** Access classes that count as "free" for Auto routing when independently verified. */
export const FREE_ACCESS_CLASSES: readonly AccessClass[] = [
  "FREE_NATIVE",
  "FREE_ROUTED",
  "FREE_ALLOWANCE",
  "FREE_PROMO",
] as const;

/** How a provider is authenticated. */
export const AuthModeSchema = z.enum([
  "NONE",
  "OAUTH_PKCE",
  "ACCOUNT_CONNECT",
  "API_KEY",
  "HOSTED_RELAY",
]);
export type AuthMode = z.infer<typeof AuthModeSchema>;

/**
 * Privacy characteristic of a model's serving endpoint, used as a routing constraint.
 * - strict:     no provider training/retention beyond serving the request
 * - standard:   standard provider retention behavior
 * - permissive: weaker retention/data-use (e.g. free tiers that may train on prompts)
 */
export const PrivacyClassSchema = z.enum(["strict", "standard", "permissive"]);
export type PrivacyClass = z.infer<typeof PrivacyClassSchema>;

/**
 * Privacy routing mode selected by the user. Determines which privacy classes are eligible.
 * - STRICT:       only `strict` endpoints
 * - STANDARD:     `strict` + `standard`
 * - MAXIMUM_FREE: all classes, including `permissive` free endpoints (with disclosure)
 */
export const PrivacyModeSchema = z.enum(["STRICT", "STANDARD", "MAXIMUM_FREE"]);
export type PrivacyMode = z.infer<typeof PrivacyModeSchema>;

/** Which privacy classes each privacy mode permits. */
export const PRIVACY_MODE_ALLOWS: Record<PrivacyMode, readonly PrivacyClass[]> = {
  STRICT: ["strict"],
  STANDARD: ["strict", "standard"],
  MAXIMUM_FREE: ["strict", "standard", "permissive"],
};

/**
 * Product tier for a model in CodeForge's offering.
 * - "free": Models available at no cost through Free Tier
 * - "paid": Third-party provider paid models (e.g., OpenRouter Muse Spark)
 * - "gems_paid": CodeForge first-party paid models (Topaz, Sapphire, Peridot, Garnet)
 */
export const ModelTierSchema = z.enum(["free", "paid", "gems_paid"]);
export type ModelTier = z.infer<typeof ModelTierSchema>;

/**
 * User's entitlement status for a model.
 * - "included": User has full access to this model
 * - "requires_subscription": User needs to upgrade to access
 * - "trial": User has temporary/trial access
 * - "not_entitled": User does not have access
 */
export const EntitlementStatusSchema = z.enum(["included", "requires_subscription", "trial", "not_entitled"]);
export type EntitlementStatus = z.infer<typeof EntitlementStatusSchema>;

export const FreeModelRecordSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
  displayName: z.string(),

  freeStatus: z.enum(["verified_free", "unknown", "expired", "paid", "temporarily_unavailable"]),
  freeStatusVerifiedAt: z.string().datetime().optional(),

  /** CodeForge product tier - distinguishes Free Tier from GEMS models */
  tier: ModelTierSchema.optional(),
  /** User's entitlement for this model - whether they can use it */
  entitlementStatus: EntitlementStatusSchema.optional(),

  contextWindow: z.number().int().positive().optional(),
  capabilities: ModelCapabilitiesSchema,
  limits: ModelLimitsSchema.optional(),
  benchmarkProfile: ModelBenchmarkProfileSchema.optional(),
  health: ModelHealthStateSchema.optional(),
  costProfile: ModelCostProfileSchema,

  isRemote: z.boolean(),
  isCloudHosted: z.boolean(),

  // --- Normalized-registry overlay (optional; upstream facts + CodeForge trust) ---
  /** CodeForge free-access classification. Absent = treat as a legacy $0-unit free model. */
  accessClass: AccessClassSchema.optional(),
  /** Provider authentication mode. */
  authMode: AuthModeSchema.optional(),
  /** Privacy characteristic of the serving endpoint (routing constraint). */
  privacyClass: PrivacyClassSchema.optional(),
  /** Model family (e.g. "glm", "gemini", "gpt"). */
  family: z.string().optional(),
  /** Where the raw facts came from (e.g. "models.dev", "openrouter-live", "snapshot"). */
  upstreamSource: z.string().optional(),
  /** True when upstream marks the model deprecated/retired. */
  deprecated: z.boolean().optional(),
  maxOutput: z.number().int().positive().optional(),
  /** CodeForge empirical coding suitability (0-100). */
  codingScore: z.number().min(0).max(100).optional(),
  /** CodeForge empirical agent suitability (0-100). */
  agentScore: z.number().min(0).max(100).optional(),
  /** CodeForge empirical tool-call reliability (0-1). */
  toolReliability: z.number().min(0).max(1).optional(),
  /** ISO time of the last CodeForge verification of this record. */
  lastVerified: z.string().datetime().optional(),
  /** How the record was verified (e.g. "pricing", "live-probe", "snapshot"). */
  verificationSource: z.string().optional(),
  /** Empirical CodeForge certification-workload status. */
  empiricalStatus: z.enum(["untested", "passing", "degraded", "failing"]).optional(),
});
export type FreeModelRecord = z.infer<typeof FreeModelRecordSchema>;

export const VerificationStepSchema = z.enum([
  "verify_access_class",
  "verify_not_deprecated",
  "verify_provider_registered",
  "verify_cost",
  "verify_free_status",
  "verify_paid_fallback_disabled",
  "verify_provider_account",
  "verify_privacy",
  "allow",
]);
export type VerificationStep = z.infer<typeof VerificationStepSchema>;

export const VerificationResultSchema = z.discriminatedUnion("eligible", [
  z.object({
    eligible: z.literal(true),
    modelId: z.string(),
    providerId: z.string(),
    passedSteps: z.array(VerificationStepSchema),
  }),
  z.object({
    eligible: z.literal(false),
    modelId: z.string(),
    providerId: z.string(),
    failedStep: VerificationStepSchema,
    reason: z.string(),
    passedSteps: z.array(VerificationStepSchema),
  }),
]);
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
