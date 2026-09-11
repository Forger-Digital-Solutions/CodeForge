export type AgePolicyStatus = "BUSINESS_DECISION_REQUIRED" | "APPROVED";

export interface AgePolicyConfig {
  /** The value ENFORCED server-side today. Null until a project owner approves BIZ-04. */
  minimumAge: number | null;
  status: AgePolicyStatus;
  acknowledgementRequired: boolean;
  /** Data minimization (R1 spec §40): CodeForge never collects date of birth. */
  collectsBirthdate: false;
  approvedBy: string | null;
  approvedAt: string | null;
  /** The number shown in onboarding acknowledgement copy — reflects the only value consistent
   *  with the provider contract facts already in evidence (Google Gemini / OpenRouter ToS both
   *  require 18+), without treating it as a ratified Terms-of-Service policy. See BIZ-04. */
  recommendedMinimumAge: number;
  rationale: string;
}

export const DEFAULT_AGE_POLICY: AgePolicyConfig = {
  minimumAge: null,
  status: "BUSINESS_DECISION_REQUIRED",
  acknowledgementRequired: true,
  collectsBirthdate: false,
  approvedBy: null,
  approvedAt: null,
  recommendedMinimumAge: 18,
  rationale:
    "Google Gemini API Additional Terms and OpenRouter ToS §2 flow down a minimum age of 18 " +
    "(Pass-3 LEG-P1-02, BIZ-04). The onboarding acknowledgement uses 18+ because it is the only " +
    "value consistent with facts already in evidence; formal Terms-of-Service policy-of-record " +
    "status remains BUSINESS_DECISION_REQUIRED pending explicit project-owner approval.",
};

export interface AgeAcknowledgementRecord {
  acknowledged: boolean;
  acknowledgedAt: string | null;
}

export function isAgeAcknowledgementSatisfied(
  record: AgeAcknowledgementRecord | null,
  config: AgePolicyConfig = DEFAULT_AGE_POLICY,
): boolean {
  if (!config.acknowledgementRequired) return true;
  return record?.acknowledged === true;
}

export function approveAgePolicy(
  config: AgePolicyConfig,
  input: { minimumAge: number; approvedBy: string; now?: Date },
): AgePolicyConfig {
  if (!input.approvedBy) throw new Error("approveAgePolicy requires an explicit approvedBy identity");
  return {
    ...config,
    minimumAge: input.minimumAge,
    status: "APPROVED",
    approvedBy: input.approvedBy,
    approvedAt: (input.now ?? new Date()).toISOString(),
  };
}
