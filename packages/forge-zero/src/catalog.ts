import type { FreeModelRecord } from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Muse Spark 1.2 — Meta's agentic coding model optimized for repository-scale tasks.
 *
 * Canonical provider/model identifier: opencode / muse-spark-1.2-contributor-free
 * This identifier is the OpenCode Zen-routed free variant exposed via the
 * opencode zero-cost cloud routing (https://opencode.ai/zen/v1). The underlying
 * provider is accessed through OpencodeAdapter (OpenAI-compatible).
 *
 * Provider evidence (2026-08-20 live catalog):
 * - OpenCode Zen lists `muse-spark-1.2-contributor-free` at $0 / $0 (Input/Output per 1M)
 * - OpenRouter lists `meta/muse-spark-1.2` at $1.25 / $4.25 (paid) and
 *   `meta/muse-spark-1.2-contributor` at $0.10 / $0.20 (paid contributor, not free)
 * - OpenRouter does NOT list `opencode/muse-spark-1.2-contributor-free` — 400 invalid model on OpenRouter
 *   => free route is via opencode, not openrouter
 * - OpenCode docs mark free models as "for a limited time" (promotional/feedback)
 *   => treated as verified_free with 7-day expiry (fail-closed), not permanent
 *
 * Free-first classification: VERIFIED_FREE (limited-time, re-verified weekly)
 * - Genuinely free cloud-hosted model via OpenCode Zen (`isFree true`, provider-backed $0 pricing)
 * - No paid fallback (paidFallbackPossible=false, paidFallbackDisabled=true) — ForgeZero fail-closed
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
  providerId: "opencode",
  modelId: "muse-spark-1.2-contributor-free",
  displayName: "Muse Spark 1.2",
  freeStatus: "verified_free",
  freeStatusVerifiedAt: nowIso(),
  tier: "free",
  accessClass: "FREE_ROUTED",
  authMode: "API_KEY",
  privacyClass: "standard",
  family: "muse-spark",
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
    source: "opencode:free",
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
  accessClass: "FREE_NATIVE",
  authMode: "NONE",
  privacyClass: "standard",
  family: "codeforge",
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

/**
 * Shipped free catalog. Muse Spark is intentionally EXCLUDED — it is a promotional
 * model and must not participate in normal/default routing (ForgeZero free-first policy).
 * Its record + factories are retained below only as legacy migration/test fixtures.
 * Real free models are discovered dynamically from connected providers (OpenRouter/Z.AI/…)
 * and verified by ForgeZero, never permanently hardcoded here.
 */
export const FREE_CATALOG: FreeModelRecord[] = [GENERIC_FREE_MODEL];

/**
 * Paid Muse Spark — verified via live OpenRouter /models 2026-08-27.
 * Distinct provider/model identity from opencode::muse-spark-1.2-contributor-free.
 * Must NEVER enter FREE_CATALOG or be selected by Full-Auto free-only routing.
 */
export const MUSE_SPARK_PAID: FreeModelRecord = {
  providerId: "openrouter",
  modelId: "meta/muse-spark-1.2",
  displayName: "Muse Spark 1.2 (Paid — OpenRouter)",
  freeStatus: "paid",
  tier: "paid",
  accessClass: "PAID",
  authMode: "OAUTH_PKCE",
  privacyClass: "standard",
  family: "muse-spark",
  contextWindow: 1048576,
  capabilities: {
    text: true,
    coding: true,
    toolCalling: true,
    vision: true,
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
    inputCostPerMillion: 1.25,
    outputCostPerMillion: 4.25,
    cacheReadCostPerMillion: 0.15,
    cacheWriteCostPerMillion: null,
    isFree: false,
    paidFallbackPossible: true,
    paidFallbackDisabled: false,
    source: "openrouter:paid",
  },
  isRemote: true,
  isCloudHosted: true,
  health: {
    status: "available",
    lastCheckedAt: nowIso(),
  },
};

export const MUSE_SPARK_CONTRIBUTOR_PAID: FreeModelRecord = {
  providerId: "openrouter",
  modelId: "meta/muse-spark-1.2-contributor",
  displayName: "Muse Spark 1.2 Contributor (Paid — OpenRouter)",
  freeStatus: "paid",
  tier: "paid",
  accessClass: "PAID",
  authMode: "OAUTH_PKCE",
  privacyClass: "standard",
  family: "muse-spark",
  contextWindow: 1048576,
  capabilities: {
    text: true,
    coding: true,
    toolCalling: true,
    vision: true,
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
    inputCostPerMillion: 0.1,
    outputCostPerMillion: 0.2,
    cacheReadCostPerMillion: 0.002,
    cacheWriteCostPerMillion: null,
    isFree: false,
    paidFallbackPossible: true,
    paidFallbackDisabled: false,
    source: "openrouter:paid",
  },
  isRemote: true,
  isCloudHosted: true,
  health: {
    status: "available",
    lastCheckedAt: nowIso(),
  },
};

export const PAID_CATALOG: FreeModelRecord[] = [MUSE_SPARK_PAID, MUSE_SPARK_CONTRIBUTOR_PAID];

export const ALL_CATALOG: FreeModelRecord[] = [...FREE_CATALOG, ...PAID_CATALOG];

export const PROVIDER_META = {
  opencode: {
    providerId: "opencode",
    displayName: "OpenCode Zen",
    endpoint: "https://opencode.ai/zen/v1",
    authEnv: "OPENCODE_API_KEY",
    setupHelp: "Get key at https://opencode.ai/auth then set OPENCODE_API_KEY. Test via npm run verify:opencode",
    modelsEndpoint: "https://opencode.ai/zen/v1/models",
  },
  openrouter: {
    providerId: "openrouter",
    displayName: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1",
    authEnv: "OPENROUTER_API_KEY",
    setupHelp: "Get key at https://openrouter.ai/keys then set OPENROUTER_API_KEY",
    modelsEndpoint: "https://openrouter.ai/api/v1/models",
  },
  codeforge: {
    providerId: "codeforge",
    displayName: "CodeForge Generic",
    endpoint: "internal",
    authEnv: null,
    setupHelp: "No credential — internal generic free model for fallback/testing",
    modelsEndpoint: null,
  },
} as const;

export function createMuseSparkPaidRecord(overrides: Partial<FreeModelRecord> = {}): FreeModelRecord {
  const ts = nowIso();
  return {
    ...MUSE_SPARK_PAID,
    ...overrides,
    costProfile: {
      ...MUSE_SPARK_PAID.costProfile,
      ...(overrides.costProfile ?? {}),
    },
    health: overrides.health ?? { status: "available", lastCheckedAt: ts },
  };
}

export function createMuseSparkContributorPaidRecord(overrides: Partial<FreeModelRecord> = {}): FreeModelRecord {
  const ts = nowIso();
  return {
    ...MUSE_SPARK_CONTRIBUTOR_PAID,
    ...overrides,
    costProfile: {
      ...MUSE_SPARK_CONTRIBUTOR_PAID.costProfile,
      ...(overrides.costProfile ?? {}),
    },
    health: overrides.health ?? { status: "available", lastCheckedAt: ts },
  };
}

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
