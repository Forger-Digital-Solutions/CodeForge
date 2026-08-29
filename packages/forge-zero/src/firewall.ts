import {
  CodeForgeError,
  err,
  ok,
  type Result,
} from "@codeforge/core";
import type { FreeModelRecord, ModelHealthState, PrivacyMode } from "./types.js";
import {
  verifyModelEligibility,
  type ProviderAvailabilityOracle,
  type VerifyContext,
} from "./verifier.js";
import type { EntitlementProvider, EntitlementCheckStatus } from "./entitlement.js";

export interface FirewallOptions {
  context?: VerifyContext;
  entitlementProvider?: EntitlementProvider;
  /** Privacy routing mode applied to all eligibility checks. */
  privacyMode?: PrivacyMode;
  /** Oracle enforcing the orphan-model invariant (provider must be active to route). */
  providerOracle?: ProviderAvailabilityOracle;
  /** When true, TRIAL/PROMO are excluded from the free pool (ongoing-free policy). */
  requireOngoingFree?: boolean;
}

/** Per-call overrides for eligibility (e.g. previewing a stricter privacy mode). */
export interface EligibilityOptions {
  privacyMode?: PrivacyMode;
  requireOngoingFree?: boolean;
}

export class ForgeZero {
  private readonly models = new Map<string, FreeModelRecord>();
  private ctx: VerifyContext;
  private readonly entitlementProvider?: EntitlementProvider;

  constructor(options: FirewallOptions = {}) {
    const base = options.context ?? { now: () => new Date() };
    // Options take precedence over any values already on a supplied context.
    this.ctx = {
      now: base.now,
      privacyMode: options.privacyMode ?? base.privacyMode,
      providerOracle: options.providerOracle ?? base.providerOracle,
      requireOngoingFree: options.requireOngoingFree ?? base.requireOngoingFree,
    };
    this.entitlementProvider = options.entitlementProvider;
  }

  register(model: FreeModelRecord): void {
    const key = this.key(model.providerId, model.modelId);
    this.models.set(key, model);
  }

  /** Set the active privacy routing mode. Excludes endpoints whose privacyClass it disallows. */
  setPrivacyMode(mode: PrivacyMode): void {
    this.ctx = { ...this.ctx, privacyMode: mode };
  }

  getPrivacyMode(): PrivacyMode | undefined {
    return this.ctx.privacyMode;
  }

  /**
   * Mark every registered model of a provider with a health status. Used to exclude an
   * invalid-auth (401) or rate-limited provider from routing immediately, so Auto never
   * re-picks it and the same bad credential is not hammered on every task.
   */
  markProviderHealth(providerId: string, status: ModelHealthState["status"], extra?: { retryAfter?: number; lastError?: string }): void {
    const nowIso = this.ctx.now().toISOString();
    for (const [key, model] of this.models) {
      if (model.providerId !== providerId) continue;
      this.models.set(key, {
        ...model,
        health: {
          ...(model.health ?? {}),
          status,
          lastCheckedAt: nowIso,
          ...(extra?.retryAfter !== undefined ? { retryAfter: extra.retryAfter } : {}),
          ...(extra?.lastError !== undefined ? { lastError: extra.lastError } : {}),
        },
      });
    }
  }

  unregister(providerId: string, modelId: string): boolean {
    return this.models.delete(this.key(providerId, modelId));
  }

  getModel(providerId: string, modelId: string): FreeModelRecord | undefined {
    return this.models.get(this.key(providerId, modelId));
  }

  allModels(): FreeModelRecord[] {
    return [...this.models.values()];
  }

  private ctxWith(overrides?: EligibilityOptions): VerifyContext {
    if (!overrides) return this.ctx;
    return {
      ...this.ctx,
      privacyMode: overrides.privacyMode ?? this.ctx.privacyMode,
      requireOngoingFree: overrides.requireOngoingFree ?? this.ctx.requireOngoingFree,
    };
  }

  eligibleModels(overrides?: EligibilityOptions): FreeModelRecord[] {
    const ctx = this.ctxWith(overrides);
    const result: FreeModelRecord[] = [];
    for (const model of this.models.values()) {
      const v = verifyModelEligibility(model, ctx);
      if (v.eligible) result.push(model);
    }
    return result;
  }

  /**
   * Check entitlement for a GEMS paid model.
   * Must fail closed - if entitlement check fails, deny access.
   */
  async checkEntitlement(userId: string, providerId: string, modelId: string): Promise<Result<EntitlementCheckStatus, CodeForgeError>> {
    const model = this.models.get(this.key(providerId, modelId));
    if (!model) {
      return err(new CodeForgeError(
        "NOT_FOUND",
        `Model ${providerId}/${modelId} not registered`
      ));
    }

    // Free tier models never require an entitlement provider.
    if (model.tier !== "gems_paid") {
      return ok("included");
    }

    if (!this.entitlementProvider) {
      // FAIL CLOSED: GEMS access without an entitlement service is denied.
      return err(new CodeForgeError(
        "FORGE_ZERO_VIOLATION",
        "No entitlement provider configured for GEMS model access"
      ));
    }

    const health = await this.entitlementProvider.healthCheck();
    if (!health.healthy) {
      // FAIL CLOSED: If entitlement service is unavailable, deny paid model access
      return err(new CodeForgeError(
        "PROVIDER_UNAVAILABLE",
        "Entitlement service unavailable - access denied for GEMS model"
      ));
    }

    const result = await this.entitlementProvider.checkEntitlement(userId, modelId, providerId);
    
    if (!result.ok) {
      // FAIL CLOSED: Any error from entitlement provider denies access
      return err(new CodeForgeError(
        "FORGE_ZERO_VIOLATION",
        `Entitlement check failed: ${result.error.message}`
      ));
    }

    const status = result.value.status;
    if (status === "included" || status === "trial") {
      return ok(status);
    }

    return err(new CodeForgeError(
      "REQUIRES_SUBSCRIPTION",
      `User ${userId} not entitled to ${modelId}. Status: ${status}`,
      { entitlementStatus: status }
    ));
  }

  /**
   * Verify model eligibility for free tier models.
   * For GEMS models, use checkEntitlement instead.
   */
  verify(providerId: string, modelId: string): Result<FreeModelRecord, CodeForgeError> {
    const model = this.models.get(this.key(providerId, modelId));
    if (!model) {
      return err(
        new CodeForgeError(
          "NOT_FOUND",
          `Model ${providerId}/${modelId} not registered`,
        ),
      );
    }
    const result = verifyModelEligibility(model, this.ctx);
    if (result.eligible) return ok(model);
    const errorCode: CodeForgeError["code"] = result.failedStep === "verify_cost"
      ? "UNKNOWN_COST_REJECTED"
      : result.failedStep === "verify_paid_fallback_disabled"
        ? "PAID_FALLBACK_REJECTED"
        : result.failedStep === "verify_provider_account"
          ? "PROVIDER_UNAVAILABLE"
          : "FORGE_ZERO_VIOLATION";
    return err(
      new CodeForgeError(
        errorCode,
        `Model ${providerId}/${modelId} ineligible: ${result.reason}`,
        { failedStep: result.failedStep, reason: result.reason },
      ),
    );
  }

  canRouteTo(providerId: string, modelId: string): boolean {
    return this.verify(providerId, modelId).ok;
  }

  private key(providerId: string, modelId: string): string {
    return `${providerId}::${modelId}`;
  }
}
