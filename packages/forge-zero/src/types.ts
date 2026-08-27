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
    "rate_limited",
    "quota_exhausted",
    "offline",
    "unknown",
  ]),
  lastCheckedAt: z.string().datetime().optional(),
  lastError: z.string().optional(),
});
export type ModelHealthState = z.infer<typeof ModelHealthStateSchema>;

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
});
export type FreeModelRecord = z.infer<typeof FreeModelRecordSchema>;

export const VerificationStepSchema = z.enum([
  "verify_cost",
  "verify_free_status",
  "verify_paid_fallback_disabled",
  "verify_provider_account",
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
