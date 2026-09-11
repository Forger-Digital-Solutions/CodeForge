import {
  defaultEnterpriseOverride,
  findProviderPolicy,
  isPolicyExpired,
  type EnterpriseOverrideConfig,
  type ProviderArchitecture,
  type ProviderPolicyRecord,
  type ServiceTier,
} from "./provider-policy.js";
import type { RegionResolution } from "./region.js";

export type EligibilityDecisionKind = "ALLOW" | "WARN" | "DENY";

export interface DataUseDisclosure {
  headline: string;
  body: string;
  confidentialDataPolicy: ProviderPolicyRecord["confidentialDataPolicy"];
}

export interface RouteEligibilityInput {
  providerId: string;
  architecture: ProviderArchitecture;
  serviceTier: ServiceTier;
  region: RegionResolution;
  enterpriseOverride?: EnterpriseOverrideConfig;
  now?: Date;
}

export interface RouteEligibilityDecision {
  decision: EligibilityDecisionKind;
  reasonCode: string;
  disclosure: DataUseDisclosure | null;
  policyRecord: ProviderPolicyRecord | null;
  evaluatedAt: string;
}

function buildDisclosure(record: ProviderPolicyRecord): DataUseDisclosure | null {
  const trains = record.providerDataUse.includes("TRAINING_POSSIBLE");
  const humanReview = record.providerDataUse.includes("HUMAN_REVIEW_POSSIBLE");
  if (!trains && !humanReview) return null;
  const bits: string[] = [];
  if (trains) bits.push("may use submitted prompts and responses to improve its products");
  if (humanReview) bits.push("may involve human review of your prompts and responses");
  return {
    headline: "This provider's unpaid service may retain your data",
    body: `This provider's unpaid service ${bits.join(" and ")}. Avoid sending confidential, proprietary, personal, or employer-owned code unless permitted by your organization's policies.`,
    confidentialDataPolicy: record.confidentialDataPolicy,
  };
}

function decide(
  base: EligibilityDecisionKind,
  reasonCode: string,
  record: ProviderPolicyRecord | null,
): RouteEligibilityDecision {
  return {
    decision: base,
    reasonCode,
    disclosure: record ? buildDisclosure(record) : null,
    policyRecord: record,
    evaluatedAt: new Date().toISOString(),
  };
}

/**
 * The single legal/provider-policy eligibility gate. This is ELIGIBILITY only — it has no
 * concept of $0 cost verification (ForgeZero) or health/capability qualification (8-Bit) and
 * must run strictly before both, per R1 remediation spec §8:
 *   candidate -> [this gate] -> ForgeZero financial eligibility -> 8-Bit qualification -> ForgeAuto ranking
 *
 * This function is pure and synchronous: it never makes a network call, never mutates state,
 * and never accepts a client-supplied override for `enterpriseOverride` — callers must source
 * that from trusted server configuration only.
 */
export function evaluateRouteEligibility(input: RouteEligibilityInput): RouteEligibilityDecision {
  const now = input.now ?? new Date();
  const record = findProviderPolicy(input.providerId, input.architecture, input.serviceTier);

  // No evidenced policy for this provider/architecture pair: default ALLOW so unrelated,
  // unevidenced routes are never broken by this gate (R1 remediation spec mission #13).
  if (!record) {
    return decide("ALLOW", "NO_POLICY_RECORD_DEFAULT_ALLOW", null);
  }

  const expired = isPolicyExpired(record, now);
  const isHostedArchitecture =
    record.architecture === "HOSTED_MULTI_TENANT" || record.architecture === "CODEFORGE_SHARED_KEY";

  if (expired) {
    if (isHostedArchitecture) {
      return decide("DENY", "PROVIDER_POLICY_EXPIRED_HOSTED_FAIL_CLOSED", record);
    }
    // BYOK/USER_OAUTH: stale metadata shouldn't break a user's own credentials.
    return decide("WARN", "PROVIDER_POLICY_EXPIRED_BYOK_UNAFFECTED", record);
  }

  const override = input.enterpriseOverride ?? defaultEnterpriseOverride(input.providerId);
  const enterpriseAuthorizes =
    override.status === "ENTERPRISE_AUTHORIZED" && override.allowedArchitectures.includes(input.architecture);

  if (
    (record.hostedResaleStatus === "RESTRICTED" || record.hostedResaleStatus === "AGREEMENT_REQUIRED") &&
    isHostedArchitecture &&
    !enterpriseAuthorizes
  ) {
    return decide("DENY", record.reasonCode, record);
  }

  if (record.regionsDenied.length > 0) {
    const inDeniedRegion = record.regionsDenied.some((g) => input.region.groups.includes(g));
    if (inDeniedRegion) {
      return decide("DENY", "PROVIDER_POLICY_REGION_RESTRICTED", record);
    }
    if (!input.region.trusted) {
      const behavior = record.regionUnknownBehavior;
      if (behavior === "DENY") {
        return decide("DENY", "PROVIDER_POLICY_REGION_UNKNOWN_FAIL_CLOSED", record);
      }
      if (behavior === "WARN") {
        return decide("WARN", "PROVIDER_POLICY_REGION_UNKNOWN", record);
      }
    }
  }

  if (record.enforcement === "DENY" && !enterpriseAuthorizes) {
    return decide("DENY", record.reasonCode, record);
  }

  if (record.attorneyReviewStatus === "PENDING") {
    return decide("WARN", "ATTORNEY_REVIEW_PENDING", record);
  }

  if (record.enforcement === "WARN") {
    return decide("WARN", record.reasonCode, record);
  }

  return decide("ALLOW", record.reasonCode, record);
}
