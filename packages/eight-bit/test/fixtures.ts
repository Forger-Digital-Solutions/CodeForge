import type { FreeModelRecord } from "@codeforge/forge-zero";

const now = new Date("2026-09-06T12:00:00Z");

export const NOW = now;

const base: FreeModelRecord = {
  providerId: "openrouter",
  modelId: "coder-alpha:free",
  displayName: "Coder Alpha (Free)",
  freeStatus: "verified_free",
  freeStatusVerifiedAt: now.toISOString(),
  isRemote: true,
  isCloudHosted: true,
  contextWindow: 128_000,
  capabilities: {
    text: true,
    coding: true,
    toolCalling: true,
    vision: false,
    structuredOutput: true,
    longContext: true,
  },
  costProfile: {
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    isFree: true,
    freeTierVerifiedAt: now.toISOString(),
    paidFallbackPossible: false,
    paidFallbackDisabled: true,
    source: "test-fixture",
  },
  accessClass: "FREE_ROUTED",
  health: { status: "available", lastCheckedAt: now.toISOString() },
};

export function makeModel(overrides: Partial<FreeModelRecord> = {}): FreeModelRecord {
  return {
    ...base,
    ...overrides,
    costProfile: { ...base.costProfile, ...(overrides.costProfile ?? {}) },
    capabilities: { ...base.capabilities, ...(overrides.capabilities ?? {}) },
    health: overrides.health === undefined ? base.health : overrides.health,
  };
}

export function makePaidModel(overrides: Partial<FreeModelRecord> = {}): FreeModelRecord {
  return makeModel({
    providerId: "openrouter",
    modelId: "premium-beta",
    accessClass: "PAID",
    costProfile: { ...base.costProfile, isFree: false, paidFallbackDisabled: false },
    ...overrides,
  });
}

export function makeUnknownCostModel(overrides: Partial<FreeModelRecord> = {}): FreeModelRecord {
  return makeModel({
    providerId: "unknownco",
    modelId: "mystery-model",
    accessClass: undefined,
    freeStatus: "unknown",
    costProfile: {
      inputCostPerMillion: null,
      outputCostPerMillion: null,
      isFree: false,
      paidFallbackPossible: false,
      paidFallbackDisabled: true,
      source: "test-fixture",
    },
    ...overrides,
  });
}
