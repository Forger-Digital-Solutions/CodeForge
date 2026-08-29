import { CodeForgeError, err, ok, type Result } from "@codeforge/core";
import {
  ZERO_UNIT_ACCESS,
  FREE_ACCESS_CLASSES,
  PRIVACY_MODE_ALLOWS,
  type AccessClass,
  type FreeModelRecord,
  type PrivacyMode,
  type VerificationResult,
  type VerificationStep,
} from "./types.js";

/**
 * Oracle telling the verifier whether a provider is registered and currently able to
 * execute. Enforces the orphan-model invariant: a model is routable only if a live,
 * authenticated provider adapter backs it. When absent, the invariant is not enforced
 * (pure model-policy check) so unit tests that register only model records still work.
 */
export interface ProviderAvailabilityOracle {
  /** True when a provider adapter is registered AND its auth/health permits execution. */
  isActive(providerId: string): boolean;
}

export interface VerifyContext {
  readonly now: () => Date;
  /** Privacy routing mode; when set, models with a disallowed privacyClass are excluded. */
  readonly privacyMode?: PrivacyMode;
  /** When set, models whose provider is not active are excluded (orphan invariant). */
  readonly providerOracle?: ProviderAvailabilityOracle;
  /**
   * Whether the current free policy requires *ongoing* free access. When true, TRIAL and
   * FREE_PROMO models are excluded from the free pool even if otherwise valid. Defaults false.
   */
  readonly requireOngoingFree?: boolean;
}

const defaultContext: VerifyContext = {
  now: () => new Date(),
};

const step = (name: VerificationStep) => name;

const FREE_VERIFICATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const verifyModelEligibility = (
  model: FreeModelRecord,
  ctx: VerifyContext = defaultContext,
): VerificationResult => {
  const passed: VerificationStep[] = [];

  const fail = (
    failedStep: VerificationStep,
    reason: string,
  ): VerificationResult => ({
    eligible: false,
    modelId: model.modelId,
    providerId: model.providerId,
    failedStep,
    reason,
    passedSteps: [...passed],
  });

  const pass = (): VerificationResult => ({
    eligible: true,
    modelId: model.modelId,
    providerId: model.providerId,
    passedSteps: [...passed, step("allow")],
  });

  const cost = model.costProfile;
  const accessClass = model.accessClass;

  // 0. Access class gate. Absent accessClass => legacy $0-unit free model (backward compatible).
  if (accessClass !== undefined) {
    if (!FREE_ACCESS_CLASSES.includes(accessClass)) {
      return fail(
        "verify_access_class",
        `Access class ${accessClass} is not free-eligible (never auto-routed)`,
      );
    }
    if (ctx.requireOngoingFree && (accessClass === "TRIAL" || accessClass === "FREE_PROMO")) {
      // FREE_PROMO cannot be TRIAL here (filtered above) but keep the guard explicit.
      return fail(
        "verify_access_class",
        `Access class ${accessClass} is not ongoing-free (excluded by free-only policy)`,
      );
    }
  }
  passed.push(step("verify_access_class"));

  // 1. Deprecation gate.
  if (model.deprecated === true) {
    return fail("verify_not_deprecated", "Model is deprecated upstream");
  }
  passed.push(step("verify_not_deprecated"));

  // 2. Orphan-model invariant: provider must be registered & able to execute.
  if (ctx.providerOracle && !ctx.providerOracle.isActive(model.providerId)) {
    return fail(
      "verify_provider_registered",
      `Provider ${model.providerId} has no active registered adapter (orphan model)`,
    );
  }
  passed.push(step("verify_provider_registered"));

  // 3. Cost gate. Only $0-unit classes (and legacy undefined) must prove zero unit price.
  //    Allowance/promo free is a quota, not a $0 unit price, so it is verified differently (step 4).
  const isZeroUnitClass = accessClass === undefined || ZERO_UNIT_ACCESS.includes(accessClass);
  if (isZeroUnitClass) {
    if (!verifyCost(cost)) {
      return fail(
        "verify_cost",
        `Cannot verify model is free: inputCost=${cost.inputCostPerMillion}, outputCost=${cost.outputCostPerMillion}, isFree=${cost.isFree}`,
      );
    }
  }
  passed.push(step("verify_cost"));

  // 4. Free-status gate. Must be independently verified free (not stale, remote, cloud-hosted).
  if (!verifyFreeStatus(model, accessClass, ctx)) {
    return fail(
      "verify_free_status",
      `Free status not verified: freeStatus=${model.freeStatus}, accessClass=${accessClass ?? "legacy"}`,
    );
  }
  passed.push(step("verify_free_status"));

  // 5. No enabled paid fallback.
  if (!verifyPaidFallbackDisabled(cost)) {
    return fail(
      "verify_paid_fallback_disabled",
      "Model supports paid fallback and it is not disabled",
    );
  }
  passed.push(step("verify_paid_fallback_disabled"));

  // 6. Provider account/health gate (auth_required, rate_limited, offline, etc. excluded).
  if (!verifyProviderAccount(model, ctx)) {
    return fail(
      "verify_provider_account",
      `Provider account not configured or model unavailable: health=${model.health?.status ?? "unknown"}`,
    );
  }
  passed.push(step("verify_provider_account"));

  // 7. Privacy gate: model's privacy class must be permitted by the active privacy mode.
  if (ctx.privacyMode && model.privacyClass) {
    const allowed = PRIVACY_MODE_ALLOWS[ctx.privacyMode];
    if (!allowed.includes(model.privacyClass)) {
      return fail(
        "verify_privacy",
        `Privacy class ${model.privacyClass} not permitted under ${ctx.privacyMode} privacy mode`,
      );
    }
  }
  passed.push(step("verify_privacy"));

  return pass();
};

const verifyCost = (cost: FreeModelRecord["costProfile"]): boolean => {
  if (cost.inputCostPerMillion === null || cost.inputCostPerMillion !== 0) return false;
  if (cost.outputCostPerMillion === null || cost.outputCostPerMillion !== 0) return false;
  if (cost.cacheReadCostPerMillion !== null && cost.cacheReadCostPerMillion !== undefined && cost.cacheReadCostPerMillion !== 0) return false;
  if (cost.cacheWriteCostPerMillion !== null && cost.cacheWriteCostPerMillion !== undefined && cost.cacheWriteCostPerMillion !== 0) return false;
  return true;
};

const verifyFreeStatus = (
  model: FreeModelRecord,
  accessClass: AccessClass | undefined,
  ctx: VerifyContext,
): boolean => {
  if (model.freeStatus !== "verified_free") return false;
  if (!model.isRemote || !model.isCloudHosted) return false;

  // Zero-unit classes additionally require the isFree flag to be set (unit price is $0).
  const isZeroUnitClass = accessClass === undefined || ZERO_UNIT_ACCESS.includes(accessClass);
  if (isZeroUnitClass && !model.costProfile.isFree) return false;

  // Verification freshness: verified-free status expires after 7 days without re-check.
  const verifiedAt = model.costProfile.freeTierVerifiedAt ?? model.freeStatusVerifiedAt ?? model.lastVerified;
  if (verifiedAt) {
    const ageMs = ctx.now().getTime() - new Date(verifiedAt).getTime();
    if (ageMs > FREE_VERIFICATION_MAX_AGE_MS) return false;
  }

  return true;
};

const verifyPaidFallbackDisabled = (cost: FreeModelRecord["costProfile"]): boolean => {
  if (cost.paidFallbackPossible && !cost.paidFallbackDisabled) return false;
  return true;
};

const verifyProviderAccount = (model: FreeModelRecord, ctx: VerifyContext): boolean => {
  const status = model.health?.status;
  if (!model.health) return false;
  if (status === "offline" || status === "unknown") return false;
  if (status === "auth_required") return false;
  if (status === "quota_exhausted") return false;
  if (status === "rate_limited") {
    // Excluded while cooling down; eligible again after retryAfter elapses.
    const retryAfter = model.health.retryAfter;
    if (retryAfter === undefined || ctx.now().getTime() < retryAfter) return false;
  }
  if (status === "configured" || status === "authenticated") return false;
  return status === "available" || status === "verified" || status === "rate_limited";
};

export const assertEligible = (
  model: FreeModelRecord,
  ctx: VerifyContext = defaultContext,
): Result<FreeModelRecord, CodeForgeError> => {
  const result = verifyModelEligibility(model, ctx);
  if (result.eligible) return ok(model);
  return err(
    new CodeForgeError(
      forgeZeroErrorCode(result.failedStep),
      `Model ${result.providerId}/${result.modelId} ineligible: ${result.reason}`,
      { failedStep: result.failedStep, passedSteps: result.passedSteps },
    ),
  );
};

const forgeZeroErrorCode = (step: VerificationStep): CodeForgeError["code"] => {
  switch (step) {
    case "verify_access_class":
      return "PAID_MODEL_REJECTED";
    case "verify_not_deprecated":
      return "PROVIDER_UNAVAILABLE";
    case "verify_provider_registered":
      return "PROVIDER_UNAVAILABLE";
    case "verify_cost":
      return "UNKNOWN_COST_REJECTED";
    case "verify_free_status":
      return "FORGE_ZERO_VIOLATION";
    case "verify_paid_fallback_disabled":
      return "PAID_FALLBACK_REJECTED";
    case "verify_provider_account":
      return "PROVIDER_UNAVAILABLE";
    case "verify_privacy":
      return "FORGE_ZERO_VIOLATION";
    case "allow":
      return "INTERNAL_ERROR";
    default:
      return "FORGE_ZERO_VIOLATION";
  }
};
