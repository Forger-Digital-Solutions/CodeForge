import type { ForgeZero, FreeModelRecord } from "@codeforge/forge-zero";
import type { EightBitHealthTracker } from "./health.js";
import { EightBitEligibilityPolicy, type EightBitPolicyMode } from "./eligibility.js";
import type { EightBitReliabilityTracker } from "./reliability.js";
import type { EightBitRole } from "./types.js";

/**
 * Builds an ordered provider-native fallback candidate list for a single provider (e.g.
 * OpenRouter's request-level `models` array). This solves the request-level "this exact call
 * failed" problem the provider itself can retry against, distinct from 8-Bit's own
 * cross-provider rotation which operates above any single provider. Every candidate is
 * re-checked against the same free/paid/policy + role eligibility gate as adaptive routing —
 * a native fallback list must never smuggle a paid or unknown-cost route past ForgeZero.
 */
export function buildNativeFallbackModelIds(options: {
  providerId: string;
  primaryModelId: string;
  role: EightBitRole;
  policyMode: EightBitPolicyMode;
  firewall: ForgeZero;
  health: EightBitHealthTracker;
  reliability: EightBitReliabilityTracker;
  estimatedContextTokens?: number;
  maxCandidates?: number;
}): string[] {
  if (options.policyMode !== "adaptive") {
    // Exact pins (including exact-premium/BYOK) never silently expand into an adaptive
    // fallback list — that would be a silent policy-boundary crossing.
    return [options.primaryModelId];
  }

  const eligibility = new EightBitEligibilityPolicy();
  const sameProviderEligible = options.firewall
    .eligibleModels()
    .filter((m: FreeModelRecord) => m.providerId === options.providerId && m.modelId !== options.primaryModelId)
    .filter((m) => !options.health.isInCooldown(m.providerId, m.modelId))
    .filter((m) =>
      eligibility.evaluate(m, {
        role: options.role,
        policyMode: "adaptive",
        estimatedContextTokens: options.estimatedContextTokens,
        reliability: options.reliability.score(m.providerId, m.modelId),
      }).eligible,
    )
    // Deterministic ordering: highest empirical coding score first, then modelId for stability.
    .sort((a, b) => (b.codingScore ?? 0) - (a.codingScore ?? 0) || a.modelId.localeCompare(b.modelId));

  const max = Math.max(0, options.maxCandidates ?? 3);
  return [options.primaryModelId, ...sameProviderEligible.slice(0, max).map((m) => m.modelId)];
}
