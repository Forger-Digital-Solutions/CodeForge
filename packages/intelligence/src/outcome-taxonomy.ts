import type { IntelligenceOutcome, VerificationOutcome } from "./schema.js";

export type ModelCapabilityLabel = "OBSERVED" | "UNKNOWN";

export interface OutcomeClassificationInput {
  providerRateLimited?: boolean;
  providerFailed?: boolean;
  quotaBlocked?: boolean;
  budgetBlocked?: boolean;
  executionExceededTimeBudget?: boolean;
  verificationStarted?: boolean;
  verificationCaught?: boolean;
  completionBlocked?: boolean;
  falseCompletion?: boolean;
  modelReasoningFailed?: boolean;
  modelReliabilityFailed?: boolean;
  planningFailed?: boolean;
  contextFailed?: boolean;
  toolFailed?: boolean;
  userCancelled?: boolean;
  infrastructureFailed?: boolean;
}

export interface OutcomeClassification {
  outcome: IntelligenceOutcome;
  verification: VerificationOutcome;
  modelCapabilityLabel: ModelCapabilityLabel;
}

/**
 * Maps a terminal observation with availability first. Provider limits and outages never imply a
 * model-intelligence label. This is intentionally a taxonomy, not a policy or completion rule.
 */
export function classifyOutcome(input: OutcomeClassificationInput): OutcomeClassification {
  const verification: VerificationOutcome = {
    verificationStarted: input.verificationStarted ?? false,
    verificationCaught: input.verificationCaught ?? false,
    completionBlocked: input.completionBlocked ?? false,
    falseCompletion: input.falseCompletion ?? false,
  };
  if (input.executionExceededTimeBudget) return { outcome: "TIME_BUDGET_EXHAUSTED", verification, modelCapabilityLabel: "UNKNOWN" };
  if (input.providerRateLimited) return { outcome: "PROVIDER_RATE_LIMIT", verification, modelCapabilityLabel: "UNKNOWN" };
  if (input.quotaBlocked) return { outcome: "QUOTA_BLOCK", verification, modelCapabilityLabel: "UNKNOWN" };
  if (input.providerFailed) return { outcome: "PROVIDER_FAILURE", verification, modelCapabilityLabel: "UNKNOWN" };
  if (input.budgetBlocked) return { outcome: "BUDGET_BLOCK", verification, modelCapabilityLabel: "UNKNOWN" };
  if (input.userCancelled) return { outcome: "USER_CANCELLED", verification, modelCapabilityLabel: "UNKNOWN" };
  if (input.infrastructureFailed) return { outcome: "INFRASTRUCTURE_FAILURE", verification, modelCapabilityLabel: "UNKNOWN" };
  if (input.falseCompletion) return { outcome: "COMPLETION_CONTROL_FAILURE", verification, modelCapabilityLabel: "OBSERVED" };
  if (input.verificationCaught || input.completionBlocked) return { outcome: "VERIFICATION_FAILURE", verification, modelCapabilityLabel: "OBSERVED" };
  if (input.modelReasoningFailed) return { outcome: "MODEL_REASONING_FAILURE", verification, modelCapabilityLabel: "OBSERVED" };
  if (input.modelReliabilityFailed) return { outcome: "MODEL_RELIABILITY_FAILURE", verification, modelCapabilityLabel: "OBSERVED" };
  if (input.planningFailed) return { outcome: "PLANNING_FAILURE", verification, modelCapabilityLabel: "OBSERVED" };
  if (input.contextFailed) return { outcome: "CONTEXT_FAILURE", verification, modelCapabilityLabel: "OBSERVED" };
  if (input.toolFailed) return { outcome: "TOOL_FAILURE", verification, modelCapabilityLabel: "OBSERVED" };
  return { outcome: "VERIFIED_SUCCESS", verification, modelCapabilityLabel: "OBSERVED" };
}
