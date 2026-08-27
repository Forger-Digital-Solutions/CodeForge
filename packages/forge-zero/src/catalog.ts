import type { FreeModelRecord } from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Muse Spark 1.2 — Meta's agentic coding model optimized for repository-scale tasks.
 *
 * Canonical provider/model identifier: openrouter / opencode/muse-spark-1.2-contributor-free
 * This identifier is the OpenRouter-routed free variant exposed via the
 * opencode zero-cost cloud routing. The underlying provider is accessed through
 * the existing OpenRouterAdapter (https://openrouter.ai/api/v1/models).
 *
 * Free-first classification: VERIFIED_FREE
 * - Genuinely free cloud-hosted model via OpenRouter's :free / contributor-free routing
 * - No paid fallback (paidFallbackPossible=false, paidFallbackDisabled=true)
 * - Zero cost per million tokens (input/output 0)
 * - Remote and cloud-hosted (isRemote && isCloudHosted)
 * - Available health status
 * - Verified within 7-day window (freeTierVerifiedAt)
 *
 * If pricing were to change to paid, this record's costProfile/freeStatus would
 * be updated and ForgeZero verifier would automatically reject it for free-tier
 * routing (fail-closed), preserving the free-first policy without code changes.
 */
export const MUSE_SPARK_1_2: FreeModelRecord = {
  providerId: "openrouter",
  modelId: "opencode/muse-spark-1.2-contributor-free",
  displayName: "Muse Spark 1.2",
  freeStatus: "verified_free",
  freeStatusVerifiedAt: nowIso(),
  tier: "free",
  contextWindow: 262144,
  capabilities: {
    text: true,
    coding: true,
    toolCalling: true,
    vision: false,
    structuredOutput: true,
    longContext: true,
  },
  benchmarkProfile: {
    coding: 92,
    toolCalling: 90,
    reasoning: 88,
    longContext: 90,
    speed: 72,
  },
  costProfile: {
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    cacheReadCostPerMillion: 0,
    cacheWriteCostPerMillion: 0,
    isFree: true,
    freeTierVerifiedAt: nowIso(),
    paidFallbackPossible: false,
    paidFallbackDisabled: true,
    source: "openrouter:free",
  },
  isRemote: true,
  isCloudHosted: true,
  health: {
    status: "available",
    lastCheckedAt: nowIso(),
  },
};

/**
 * Generic free-tier baseline model (used for comparison and simple tasks).
 * Retained for backward compatibility with existing free-model-1 registration.
 */
export const GENERIC_FREE_MODEL: FreeModelRecord = {
  providerId: "codeforge",
  modelId: "free-model-1",
  displayName: "CodeForge Free Model",
  freeStatus: "verified_free",
  freeStatusVerifiedAt: nowIso(),
  tier: "free",
  contextWindow: 128000,
  capabilities: {
    text: true,
    coding: true,
    toolCalling: true,
    vision: false,
    structuredOutput: true,
    longContext: true,
  },
  benchmarkProfile: {
    coding: 75,
    toolCalling: 70,
    reasoning: 70,
    longContext: 75,
    speed: 85,
  },
  costProfile: {
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    cacheReadCostPerMillion: 0,
    cacheWriteCostPerMillion: 0,
    isFree: true,
    freeTierVerifiedAt: nowIso(),
    paidFallbackPossible: false,
    paidFallbackDisabled: true,
    source: "official",
  },
  isRemote: true,
  isCloudHosted: true,
  health: {
    status: "available",
    lastCheckedAt: nowIso(),
  },
};

export const FREE_CATALOG: FreeModelRecord[] = [GENERIC_FREE_MODEL, MUSE_SPARK_1_2];

export function createMuseSparkRecord(overrides: Partial<FreeModelRecord> = {}): FreeModelRecord {
  const ts = nowIso();
  return {
    ...MUSE_SPARK_1_2,
    ...overrides,
    freeStatusVerifiedAt: overrides.freeStatusVerifiedAt ?? ts,
    costProfile: {
      ...MUSE_SPARK_1_2.costProfile,
      ...(overrides.costProfile ?? {}),
      freeTierVerifiedAt: overrides.costProfile?.freeTierVerifiedAt ?? ts,
    },
    health: overrides.health ?? { status: "available", lastCheckedAt: ts },
    capabilities: {
      ...MUSE_SPARK_1_2.capabilities,
      ...(overrides.capabilities ?? {}),
    },
    benchmarkProfile: {
      ...MUSE_SPARK_1_2.benchmarkProfile,
      ...(overrides.benchmarkProfile ?? {}),
    },
  };
}

export function createGenericFreeRecord(overrides: Partial<FreeModelRecord> = {}): FreeModelRecord {
  const ts = nowIso();
  return {
    ...GENERIC_FREE_MODEL,
    ...overrides,
    freeStatusVerifiedAt: overrides.freeStatusVerifiedAt ?? ts,
    costProfile: {
      ...GENERIC_FREE_MODEL.costProfile,
      ...(overrides.costProfile ?? {}),
      freeTierVerifiedAt: overrides.costProfile?.freeTierVerifiedAt ?? ts,
    },
    health: overrides.health ?? { status: "available", lastCheckedAt: ts },
    capabilities: {
      ...GENERIC_FREE_MODEL.capabilities,
      ...(overrides.capabilities ?? {}),
    },
    benchmarkProfile: {
      ...GENERIC_FREE_MODEL.benchmarkProfile,
      ...(overrides.benchmarkProfile ?? {}),
    },
  };
}
