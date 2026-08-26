import { CodeForgeError, err, ok, type Result } from "@codeforge/core";
import type { FreeModelRecord, VerificationResult, VerificationStep } from "./types.js";

export interface VerifyContext {
  readonly now: () => Date;
}

const defaultContext: VerifyContext = {
  now: () => new Date(),
};

const step = (name: VerificationStep) => name;

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

  if (!verifyCost(cost)) {
    return fail(
      "verify_cost",
      `Cannot verify model is free: inputCost=${cost.inputCostPerMillion}, outputCost=${cost.outputCostPerMillion}, isFree=${cost.isFree}`,
    );
  }
  passed.push(step("verify_cost"));

  if (!verifyFreeStatus(model, ctx)) {
    return fail(
      "verify_free_status",
      `Free status not verified: freeStatus=${model.freeStatus}`,
    );
  }
  passed.push(step("verify_free_status"));

  if (!verifyPaidFallbackDisabled(cost)) {
    return fail(
      "verify_paid_fallback_disabled",
      "Model supports paid fallback and it is not disabled",
    );
  }
  passed.push(step("verify_paid_fallback_disabled"));

  if (!verifyProviderAccount(model)) {
    return fail(
      "verify_provider_account",
      `Provider account not configured or model unavailable: health=${model.health?.status ?? "unknown"}`,
    );
  }
  passed.push(step("verify_provider_account"));

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
  ctx: VerifyContext,
): boolean => {
  if (model.freeStatus !== "verified_free") return false;
  if (!model.costProfile.isFree) return false;
  if (!model.isRemote || !model.isCloudHosted) return false;

  if (model.costProfile.freeTierVerifiedAt) {
    const verifiedAt = new Date(model.costProfile.freeTierVerifiedAt);
    const ageMs = ctx.now().getTime() - verifiedAt.getTime();
    const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
    if (ageMs > maxAgeMs) return false;
  }

  return true;
};

const verifyPaidFallbackDisabled = (cost: FreeModelRecord["costProfile"]): boolean => {
  if (cost.paidFallbackPossible && !cost.paidFallbackDisabled) return false;
  return true;
};

const verifyProviderAccount = (model: FreeModelRecord): boolean => {
  const status = model.health?.status;
  if (!model.health) return false;
  if (status === "offline" || status === "unknown") return false;
  if (status === "quota_exhausted" || status === "rate_limited") return false;
  if (status === "configured" || status === "authenticated") return false;
  return status === "available" || status === "verified";
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
    case "verify_cost":
      return "UNKNOWN_COST_REJECTED";
    case "verify_free_status":
      return "FORGE_ZERO_VIOLATION";
    case "verify_paid_fallback_disabled":
      return "PAID_FALLBACK_REJECTED";
    case "verify_provider_account":
      return "PROVIDER_UNAVAILABLE";
    case "allow":
      return "INTERNAL_ERROR";
    default:
      return "FORGE_ZERO_VIOLATION";
  }
};
