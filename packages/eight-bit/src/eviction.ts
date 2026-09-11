import type { FreeModelRecord, ModelHealthState } from "@codeforge/forge-zero";
import { ForgeZero } from "@codeforge/forge-zero";

/** Eviction policy configuration */
export interface EvictionPolicyConfig {
  /** Max age of free verification before considered stale (default: 7 days) */
  maxVerificationAgeMs?: number;
  /** Require ongoing free access (exclude TRIAL/PROMO) */
  requireOngoingFree?: boolean;
  /** Provider oracle for orphan model check */
  providerOracle?: { isActive(providerId: string): boolean };
}

/** Result of eviction check */
export interface EvictionResult {
  shouldEvict: boolean;
  reason: string;
  evictionType: "stale" | "paid_transition" | "deprecated" | "paid_fallback_enabled" | "provider_disagreement" | "quota_exhausted" | "orphan";
  modelId: string;
  providerId: string;
}

/** Provider disagreement detection result */
export interface ProviderDisagreementResult {
  hasDisagreement: boolean;
  sources: Array<{ source: string; accessClass?: string; freeStatus?: string; price?: number }>;
  resolution: "fail_closed" | "use_most_restrictive" | "require_manual_review";
}

/** Model catalog eviction manager */
export class ModelEvictionManager {
  private readonly firewall: ForgeZero;
  private readonly config: Required<EvictionPolicyConfig>;

  constructor(firewall: ForgeZero, config: EvictionPolicyConfig = {}) {
    this.firewall = firewall;
    this.config = {
      maxVerificationAgeMs: config.maxVerificationAgeMs ?? 7 * 24 * 60 * 60 * 1000,
      requireOngoingFree: config.requireOngoingFree ?? true,
      providerOracle: config.providerOracle ?? { isActive: () => true },
    };
  }

  /** Check if a model should be evicted from the free catalog */
  checkEviction(model: FreeModelRecord): EvictionResult {
    const now = Date.now();

    // 1. Check if model is deprecated
    if (model.deprecated === true) {
      return {
        shouldEvict: true,
        reason: "Model is deprecated upstream",
        evictionType: "deprecated",
        modelId: model.modelId,
        providerId: model.providerId,
      };
    }

    // 2. Check if paid fallback is enabled
    if (model.costProfile.paidFallbackPossible === true || model.costProfile.paidFallbackDisabled === false) {
      return {
        shouldEvict: true,
        reason: "Paid fallback is enabled for this model",
        evictionType: "paid_fallback_enabled",
        modelId: model.modelId,
        providerId: model.providerId,
      };
    }

    // 3. Check verification age (stale free evidence)
    if (model.freeStatusVerifiedAt) {
      const verifiedAt = new Date(model.freeStatusVerifiedAt).getTime();
      if (now - verifiedAt > this.config.maxVerificationAgeMs) {
        return {
          shouldEvict: true,
          reason: `Free verification expired (age: ${Math.round((now - verifiedAt) / (24 * 60 * 60 * 1000))} days)`,
          evictionType: "stale",
          modelId: model.modelId,
          providerId: model.providerId,
        };
      }
    }

    // 4. Check if model transitioned to paid (price change)
    if (model.accessClass === "PAID" || model.freeStatus === "paid") {
      return {
        shouldEvict: true,
        reason: "Model is now classified as paid",
        evictionType: "paid_transition",
        modelId: model.modelId,
        providerId: model.providerId,
      };
    }

    // 5. Check orphan model invariant (provider not active)
    if (!this.config.providerOracle.isActive(model.providerId)) {
      return {
        shouldEvict: true,
        reason: "Provider is not active (orphan model)",
        evictionType: "orphan",
        modelId: model.modelId,
        providerId: model.providerId,
      };
    }

    // 6. Check quota exhausted (temporary, not eviction)
    if (model.health?.status === "quota_exhausted") {
      return {
        shouldEvict: false, // Quota exhausted is temporary, not eviction
        reason: "Provider quota exhausted (temporary)",
        evictionType: "quota_exhausted",
        modelId: model.modelId,
        providerId: model.providerId,
      };
    }

    return {
      shouldEvict: false,
      reason: "Model is eligible for free routing",
      evictionType: "stale",
      modelId: model.modelId,
      providerId: model.providerId,
    };
  }

  /** Run eviction check on all models in firewall */
  runEvictionPass(): EvictionResult[] {
    const models = this.firewall.allModels();
    const results: EvictionResult[] = [];

    for (const model of models) {
      const result = this.checkEviction(model);
      if (result.shouldEvict) {
        results.push(result);
        // Actually evict from firewall
        this.firewall.unregister(model.providerId, model.modelId);
      }
    }

    return results;
  }

  /** Detect provider disagreement on model pricing/access */
  detectProviderDisagreement(
    modelId: string,
    providerId: string,
    sources: Array<{ source: string; accessClass?: string; freeStatus?: string; price?: number }>
  ): ProviderDisagreementResult {
    const accessClasses = new Set(sources.map(s => s.accessClass).filter(Boolean));
    const freeStatuses = new Set(sources.map(s => s.freeStatus).filter(Boolean));
    const prices = sources.map(s => s.price).filter((p): p is number => p !== undefined);

    const hasAccessClassDisagreement = accessClasses.size > 1;
    const hasFreeStatusDisagreement = freeStatuses.size > 1;
    const hasPriceDisagreement = prices.length > 1 && new Set(prices).size > 1;

    const hasDisagreement = hasAccessClassDisagreement || hasFreeStatusDisagreement || hasPriceDisagreement;

    let resolution: ProviderDisagreementResult["resolution"] = "fail_closed";
    if (hasDisagreement) {
      // Always fail closed for financial disagreements
      resolution = "fail_closed";
    }

    return {
      hasDisagreement,
      sources,
      resolution,
    };
  }

  /** Check if quota exhausted should be treated as temporary vs permanent */
  isQuotaExhaustedTemporary(model: FreeModelRecord): boolean {
    // Quota exhausted is temporary if model is still VERIFIED_FREE
    return model.freeStatus === "verified_free" && model.accessClass !== "PAID";
  }

  /** Get models that are temporarily unavailable but not evicted */
  getTemporarilyUnavailable(): FreeModelRecord[] {
    const models = this.firewall.allModels();
    return models.filter(m => 
      m.health?.status === "quota_exhausted" || 
      m.health?.status === "rate_limited" ||
      m.health?.status === "degraded"
    );
  }

  /** Get models that should be evicted */
  getEvictionCandidates(): FreeModelRecord[] {
    const models = this.firewall.allModels();
    return models.filter(m => this.checkEviction(m).shouldEvict);
  }
}

export function createModelEvictionManager(
  firewall: ForgeZero,
  config?: EvictionPolicyConfig
): ModelEvictionManager {
  return new ModelEvictionManager(firewall, config);
}