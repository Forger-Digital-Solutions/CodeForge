import type { RegionGroupId } from "./region.js";

export type ProviderArchitecture =
  | "BYOK"
  | "USER_OAUTH"
  | "CODEFORGE_SHARED_KEY"
  | "HOSTED_MULTI_TENANT";

export type ServiceTier = "FREE" | "PAID" | "UNKNOWN";

export type ProviderDataUseFlag =
  | "TRAINING_POSSIBLE"
  | "HUMAN_REVIEW_POSSIBLE"
  | "NO_TRAINING_CONTRACT"
  | "UNKNOWN";

export type HostedResaleStatus = "ALLOWED" | "RESTRICTED" | "AGREEMENT_REQUIRED" | "UNKNOWN";

export type QualificationTrafficStatus = "PERMITTED" | "RATE_LIMITED" | "PROHIBITED";

export type ConfidentialDataPolicy =
  | "AVOID_SUBMISSION_RECOMMENDED"
  | "PROHIBITED"
  | "NO_RESTRICTION";

export type EnforcementAction = "ALLOW" | "WARN" | "DENY";

export type AttorneyReviewStatus = "NONE" | "PENDING" | "RESOLVED";

/**
 * A provider policy record represents PRODUCT POLICY, not law. It must never be the sole
 * output of dynamic legal interpretation — every restrictive field must trace back to a
 * specific piece of Pass-3 evidence via authoritySource (R1 remediation spec §9-10).
 */
export interface ProviderPolicyRecord {
  providerId: string;
  architecture: ProviderArchitecture;
  serviceTier: ServiceTier;
  regionsDenied: RegionGroupId[];
  /** What to do when a route in `regionsDenied`'s scope can't have its region resolved. */
  regionUnknownBehavior: EnforcementAction;
  confidentialDataPolicy: ConfidentialDataPolicy;
  providerDataUse: ProviderDataUseFlag[];
  hostedResaleStatus: HostedResaleStatus;
  qualificationTrafficStatus: QualificationTrafficStatus;
  attorneyReviewStatus: AttorneyReviewStatus;
  authoritySource: string;
  reviewedAt: string;
  expiresAt: string | null;
  enforcement: EnforcementAction;
  reasonCode: string;
  notes?: string;
}

function recordKey(providerId: string, architecture: ProviderArchitecture, serviceTier: ServiceTier): string {
  return `${providerId}::${architecture}::${serviceTier}`;
}

// Populated directly from docs/legal/pass3/final-issue-register.md and
// docs/legal/pass3/final-provider-remediation-plan.md. Do not add entries without a citable
// Pass-3 (or later attorney-reviewed) source in authoritySource.
const REVIEWED_AT = "2026-09-11T00:00:00.000Z";
// Provider ToS and regional law change; a policy record that is never re-confirmed is exactly the
// "opaque magic boolean" R1 spec §10 warns against. Every record gets a finite review horizon —
// evaluateRouteEligibility() fails closed on HOSTED architectures (and only warns for BYOK) once
// a record passes this point without being re-reviewed. ~180 days from REVIEWED_AT.
const EXPIRES_AT = "2027-03-10T00:00:00.000Z";

export const PROVIDER_POLICY_REGISTRY: ProviderPolicyRecord[] = [
  // --- Google Gemini ---------------------------------------------------------------------
  {
    providerId: "google-gemini",
    architecture: "BYOK",
    serviceTier: "FREE",
    regionsDenied: [],
    regionUnknownBehavior: "ALLOW",
    confidentialDataPolicy: "AVOID_SUBMISSION_RECOMMENDED",
    providerDataUse: ["TRAINING_POSSIBLE", "HUMAN_REVIEW_POSSIBLE"],
    hostedResaleStatus: "ALLOWED",
    qualificationTrafficStatus: "PERMITTED",
    // Q1 of final-attorney-review-packet.md is explicitly unresolved for EEA/UK/CH BYOK.
    // Do NOT auto-block; represent as attorney-review-pending per R1 remediation spec §13.
    attorneyReviewStatus: "PENDING",
    authoritySource:
      "docs/legal/pass3/final-attorney-review-packet.md Q1; docs/legal/pass3/final-issue-register.md LEG-P1-03",
    reviewedAt: REVIEWED_AT,
    expiresAt: EXPIRES_AT,
    enforcement: "ALLOW",
    reasonCode: "BYOK_ALLOWED_ATTORNEY_REVIEW_PENDING_FOR_EEA_UK_CH",
    notes:
      "Desktop BYOK Gemini free tier is not blocked by region. EEA/UK/CH legal status is ATTORNEY_REVIEW_PENDING per Q1, not a confirmed restriction.",
  },
  {
    providerId: "google-gemini",
    architecture: "BYOK",
    serviceTier: "PAID",
    regionsDenied: [],
    regionUnknownBehavior: "ALLOW",
    confidentialDataPolicy: "NO_RESTRICTION",
    providerDataUse: ["NO_TRAINING_CONTRACT"],
    hostedResaleStatus: "ALLOWED",
    qualificationTrafficStatus: "PERMITTED",
    attorneyReviewStatus: "NONE",
    authoritySource: "docs/legal/pass3/final-provider-remediation-plan.md §2.2",
    reviewedAt: REVIEWED_AT,
    expiresAt: EXPIRES_AT,
    enforcement: "ALLOW",
    reasonCode: "BYOK_PAID_TIER_ALLOWED",
  },
  {
    // Architecture is HOSTED_MULTI_TENANT, not CODEFORGE_SHARED_KEY: CodeForge has exactly one
    // server-side hosted routing path (packages/cloud-gateway's GatewayService, confirmed by the
    // R1 routing-architecture research — every request it handles is, by construction, pooled
    // multi-tenant traffic through a server-owned credential). CODEFORGE_SHARED_KEY is reserved
    // in the type system (§9) for a hypothetical desktop-direct-shared-key mode that does not
    // exist in the codebase today; no registry row should claim to gate a path that isn't real.
    providerId: "google-gemini",
    architecture: "HOSTED_MULTI_TENANT",
    serviceTier: "FREE",
    regionsDenied: ["EEA", "UK", "CH"],
    // This is the confirmed LEG-P0-03 contract restriction: fail closed when region can't be
    // proven, rather than silently allowing an EEA user through.
    regionUnknownBehavior: "DENY",
    confidentialDataPolicy: "AVOID_SUBMISSION_RECOMMENDED",
    providerDataUse: ["TRAINING_POSSIBLE", "HUMAN_REVIEW_POSSIBLE"],
    hostedResaleStatus: "ALLOWED",
    qualificationTrafficStatus: "PERMITTED",
    attorneyReviewStatus: "NONE",
    authoritySource:
      "Google Gemini API Additional Terms, \"Use Restrictions / Geographical Availability\" as cited in docs/legal/pass3/final-issue-register.md LEG-P0-03",
    reviewedAt: REVIEWED_AT,
    expiresAt: EXPIRES_AT,
    enforcement: "ALLOW",
    reasonCode: "HOSTED_GEMINI_UNPAID_REGION_GATED",
  },
  {
    providerId: "google-gemini",
    architecture: "HOSTED_MULTI_TENANT",
    serviceTier: "PAID",
    regionsDenied: [],
    regionUnknownBehavior: "ALLOW",
    confidentialDataPolicy: "NO_RESTRICTION",
    providerDataUse: ["NO_TRAINING_CONTRACT"],
    hostedResaleStatus: "AGREEMENT_REQUIRED",
    qualificationTrafficStatus: "PERMITTED",
    attorneyReviewStatus: "NONE",
    authoritySource: "docs/legal/pass3/final-provider-remediation-plan.md §2.2 (Google Cloud Customer Agreement + DPA required)",
    reviewedAt: REVIEWED_AT,
    expiresAt: EXPIRES_AT,
    // No Google Cloud Customer Agreement/DPA is on file for CodeForge today (R1 §61: engineering
    // may not execute provider agreements). Fail closed until server config asserts otherwise.
    enforcement: "DENY",
    reasonCode: "GOOGLE_CLOUD_DPA_NOT_ON_FILE",
  },

  // --- OpenRouter --------------------------------------------------------------------------
  {
    providerId: "openrouter",
    architecture: "BYOK",
    serviceTier: "UNKNOWN",
    regionsDenied: [],
    regionUnknownBehavior: "ALLOW",
    confidentialDataPolicy: "NO_RESTRICTION",
    providerDataUse: ["UNKNOWN"],
    hostedResaleStatus: "ALLOWED",
    qualificationTrafficStatus: "PERMITTED",
    attorneyReviewStatus: "NONE",
    authoritySource:
      "docs/legal/pass3/final-provider-remediation-plan.md §2.1 (\"Desktop BYOK: PERMITTED under standard Terms of Service (§3.1, §3.2)\")",
    reviewedAt: REVIEWED_AT,
    expiresAt: EXPIRES_AT,
    enforcement: "ALLOW",
    reasonCode: "BYOK_ALLOWED",
    notes:
      "Per-model training disclosure (e.g. \":free\" suffixed models) is not independently evidenced by Pass-3; providerDataUse intentionally left UNKNOWN rather than assumed.",
  },
  {
    providerId: "openrouter",
    architecture: "HOSTED_MULTI_TENANT",
    serviceTier: "FREE",
    regionsDenied: [],
    regionUnknownBehavior: "ALLOW",
    confidentialDataPolicy: "NO_RESTRICTION",
    providerDataUse: ["UNKNOWN"],
    hostedResaleStatus: "AGREEMENT_REQUIRED",
    qualificationTrafficStatus: "RATE_LIMITED",
    // Not an open legal QUESTION (attorneyReviewStatus is reserved for genuine interpretive
    // ambiguity, e.g. the Gemini BYOK EEA case) — this is a settled business/contract gate: no
    // agreement on file means denied, full stop. hostedResaleStatus + enforcement already say so.
    attorneyReviewStatus: "NONE",
    authoritySource:
      "docs/legal/pass3/final-issue-register.md LEG-P1-01; docs/legal/pass3/launch-readiness-matrix.md Mode C; OpenRouter ToS §7.3/§7.4 as cited in docs/legal/pass3/final-attorney-review-packet.md Q2",
    reviewedAt: REVIEWED_AT,
    expiresAt: EXPIRES_AT,
    // No OpenRouter Enterprise/Commercial Agreement is on file (R1 §61 forbids engineering from
    // negotiating one). Deny until an EnterpriseOverrideConfig authorizes this architecture.
    enforcement: "DENY",
    reasonCode: "OPENROUTER_ENTERPRISE_AGREEMENT_REQUIRED",
  },

  // --- Groq ----------------------------------------------------------------------------------
  {
    providerId: "groq",
    architecture: "BYOK",
    serviceTier: "FREE",
    regionsDenied: [],
    regionUnknownBehavior: "ALLOW",
    confidentialDataPolicy: "NO_RESTRICTION",
    providerDataUse: ["UNKNOWN"],
    hostedResaleStatus: "ALLOWED",
    qualificationTrafficStatus: "PERMITTED",
    attorneyReviewStatus: "NONE",
    authoritySource: "docs/legal/pass3/final-provider-remediation-plan.md §2.3",
    reviewedAt: REVIEWED_AT,
    expiresAt: EXPIRES_AT,
    enforcement: "ALLOW",
    reasonCode: "BYOK_ALLOWED",
  },
  {
    providerId: "groq",
    architecture: "HOSTED_MULTI_TENANT",
    serviceTier: "FREE",
    regionsDenied: [],
    regionUnknownBehavior: "ALLOW",
    confidentialDataPolicy: "NO_RESTRICTION",
    providerDataUse: ["UNKNOWN"],
    hostedResaleStatus: "ALLOWED",
    qualificationTrafficStatus: "RATE_LIMITED",
    attorneyReviewStatus: "NONE",
    authoritySource: "docs/legal/pass3/final-provider-remediation-plan.md §2.3",
    reviewedAt: REVIEWED_AT,
    expiresAt: EXPIRES_AT,
    enforcement: "ALLOW",
    reasonCode: "HOSTED_ALLOWED_WITHIN_FREE_ALLOWANCE",
  },

  // --- Cloudflare Workers AI -------------------------------------------------------------
  {
    providerId: "cloudflare-workers-ai",
    architecture: "BYOK",
    serviceTier: "FREE",
    regionsDenied: [],
    regionUnknownBehavior: "ALLOW",
    confidentialDataPolicy: "NO_RESTRICTION",
    providerDataUse: ["UNKNOWN"],
    hostedResaleStatus: "ALLOWED",
    qualificationTrafficStatus: "PERMITTED",
    attorneyReviewStatus: "NONE",
    authoritySource: "docs/legal/pass3/final-provider-remediation-plan.md §2.4",
    reviewedAt: REVIEWED_AT,
    expiresAt: EXPIRES_AT,
    enforcement: "ALLOW",
    reasonCode: "BYOK_ALLOWED",
  },
  {
    providerId: "cloudflare-workers-ai",
    architecture: "HOSTED_MULTI_TENANT",
    serviceTier: "FREE",
    regionsDenied: [],
    regionUnknownBehavior: "ALLOW",
    confidentialDataPolicy: "NO_RESTRICTION",
    providerDataUse: ["UNKNOWN"],
    hostedResaleStatus: "ALLOWED",
    qualificationTrafficStatus: "RATE_LIMITED",
    attorneyReviewStatus: "NONE",
    authoritySource: "docs/legal/pass3/final-provider-remediation-plan.md §2.4",
    reviewedAt: REVIEWED_AT,
    expiresAt: EXPIRES_AT,
    enforcement: "ALLOW",
    reasonCode: "HOSTED_ALLOWED",
  },
];

function buildRegistryIndex(records: ProviderPolicyRecord[]): Map<string, ProviderPolicyRecord> {
  const index = new Map<string, ProviderPolicyRecord>();
  for (const record of records) {
    const key = recordKey(record.providerId, record.architecture, record.serviceTier);
    if (index.has(key)) {
      throw new Error(`Duplicate provider policy record for ${key} — each (providerId, architecture, serviceTier) triple must be unique`);
    }
    index.set(key, record);
  }
  return index;
}

const REGISTRY_INDEX = buildRegistryIndex(PROVIDER_POLICY_REGISTRY);

export function findProviderPolicy(
  providerId: string,
  architecture: ProviderArchitecture,
  serviceTier: ServiceTier,
): ProviderPolicyRecord | null {
  return REGISTRY_INDEX.get(recordKey(providerId, architecture, serviceTier)) ?? null;
}

export function isPolicyExpired(record: ProviderPolicyRecord, now: Date): boolean {
  if (!record.expiresAt) return false;
  return now.getTime() > new Date(record.expiresAt).getTime();
}

/**
 * Server-controlled override state for a provider's enterprise/commercial agreement.
 * MUST be sourced from trusted server configuration (env var / config file loaded at process
 * start) — never from a client request field. See R1 remediation spec §19-20.
 */
export interface EnterpriseOverrideConfig {
  providerId: string;
  status: "STANDARD_TERMS" | "ENTERPRISE_AUTHORIZED";
  agreementReference?: string;
  effectiveDate?: string;
  allowedArchitectures: ProviderArchitecture[];
}

export function defaultEnterpriseOverride(providerId: string): EnterpriseOverrideConfig {
  return { providerId, status: "STANDARD_TERMS", allowedArchitectures: [] };
}
