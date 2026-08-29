import { z } from "zod";
import {
  AccessClassSchema,
  AuthModeSchema,
  PrivacyClassSchema,
  type AccessClass,
} from "@codeforge/forge-zero";

/**
 * Normalized capability set. Superset of the ForgeZero capability flags plus `reasoning`.
 */
export const NormalizedCapabilitiesSchema = z.object({
  text: z.boolean(),
  coding: z.boolean(),
  toolCalling: z.boolean(),
  vision: z.boolean(),
  structuredOutput: z.boolean(),
  longContext: z.boolean(),
  reasoning: z.boolean(),
});
export type NormalizedCapabilities = z.infer<typeof NormalizedCapabilitiesSchema>;

/** Pricing in USD per 1M tokens (null = unknown). */
export const NormalizedPricingSchema = z.object({
  inputPerMillion: z.number().nullable(),
  outputPerMillion: z.number().nullable(),
  cacheReadPerMillion: z.number().nullable().optional(),
  cacheWritePerMillion: z.number().nullable().optional(),
  currency: z.literal("USD"),
});
export type NormalizedPricing = z.infer<typeof NormalizedPricingSchema>;

/**
 * ONE normalized CodeForge model representation consumed by UI and router.
 * Carries UPSTREAM FACTS only (from Models.dev / live provider catalogs). CodeForge trust
 * (verifiedFree, empirical scores, health) lives in a separate {@link CodeForgeOverlay}.
 */
export const ModelRecordSchema = z.object({
  /** Canonical identity `${providerId}::${modelId}`. */
  id: z.string(),
  providerId: z.string(),
  modelId: z.string(),
  displayName: z.string(),
  family: z.string().optional(),
  /** Where the raw facts came from: "models.dev" | "openrouter-live" | "snapshot" | … */
  upstreamSource: z.string(),

  capabilities: NormalizedCapabilitiesSchema,
  contextWindow: z.number().int().positive().optional(),
  maxOutput: z.number().int().positive().optional(),
  pricing: NormalizedPricingSchema,

  /** Candidate access classification derived from facts + provider policy (not trust). */
  accessClass: AccessClassSchema,
  authMode: AuthModeSchema,
  privacyClass: PrivacyClassSchema,

  status: z.enum(["active", "deprecated", "unavailable"]),
  deprecated: z.boolean(),
  lastUpdated: z.string().optional(),
});
export type ModelRecord = z.infer<typeof ModelRecordSchema>;

/**
 * CodeForge verification overlay — INDEPENDENT of upstream facts. This is where CodeForge/ForgeZero
 * records its own evidence and trust. Models.dev metadata alone must NEVER set `verifiedFree`.
 */
export const CodeForgeOverlaySchema = z.object({
  providerId: z.string(),
  modelId: z.string(),

  /** True only when CodeForge independently verified the model is free for the current account. */
  verifiedFree: z.boolean().optional(),
  freeVerification: z
    .object({
      verifiedAt: z.string(),
      /** "pricing+live-catalog" | "live-probe" | "quota" | "manual" | … */
      method: z.string(),
      source: z.string(),
    })
    .optional(),

  /** Empirical CodeForge scores (from synthetic certification workloads, never user code). */
  toolReliability: z.number().min(0).max(1).optional(),
  agentScore: z.number().min(0).max(100).optional(),
  codingScore: z.number().min(0).max(100).optional(),
  agentCertified: z.boolean().optional(),
  empiricalStatus: z.enum(["untested", "passing", "degraded", "failing"]).optional(),

  privacyReviewed: z.boolean().optional(),
  latencyMs: z.number().nonnegative().optional(),

  providerHealth: z
    .object({
      status: z.enum([
        "healthy",
        "degraded",
        "auth_required",
        "rate_limited",
        "quota_exhausted",
        "unavailable",
        "unknown",
      ]),
      lastFailure: z.string().optional(),
      lastSuccess: z.string().optional(),
      retryAfter: z.number().int().nonnegative().optional(),
      recentFailureCount: z.number().int().nonnegative().optional(),
    })
    .optional(),

  lastVerified: z.string().optional(),
  verificationSource: z.string().optional(),
});
export type CodeForgeOverlay = z.infer<typeof CodeForgeOverlaySchema>;

/** True when the access class denotes some form of free access. */
export const FREE_ACCESS: readonly AccessClass[] = [
  "FREE_NATIVE",
  "FREE_ROUTED",
  "FREE_ALLOWANCE",
  "FREE_PROMO",
];

export function canonicalId(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}
