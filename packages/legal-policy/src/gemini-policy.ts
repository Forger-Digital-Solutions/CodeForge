import {
  classifyRegionEvidence,
  isTrustedRegionSource,
  type RegionEvidenceSource,
  type RegionResolution,
} from "./region.js";

export const GEMINI_FREE_POLICY_REVISION = "gemini-api-unpaid-data-use/2026-03-23";
export const GEMINI_FREE_DISCLOSURE_VERSION = "1.0";
export const GEMINI_FREE_TERMS_EFFECTIVE_AT = "2026-03-23T00:00:00.000Z";
export const GEMINI_ADDITIONAL_TERMS_URL = "https://ai.google.dev/gemini-api/terms";

export type GeminiFreeRegionStatus = "GEMINI_FREE_REGION_ELIGIBLE" | "GEMINI_PAID_REQUIRED_BY_REGION" | "GEMINI_REGION_UNKNOWN";

export interface GeminiFreePolicyMetadata {
  policyRevision: string;
  disclosureVersion: string;
  termsEffectiveAt: string;
  officialTermsUrl: string;
  dataUseClass: "TRAINING_POSSIBLE" | "HUMAN_REVIEW_POSSIBLE";
  confidentialDataEligible: false;
  professionalBusinessUseOnly: true;
  minimumAge: 18;
  paidOnlyRegions: readonly ["EEA", "UK", "CH"];
}

export const GEMINI_FREE_POLICY: GeminiFreePolicyMetadata = {
  policyRevision: GEMINI_FREE_POLICY_REVISION,
  disclosureVersion: GEMINI_FREE_DISCLOSURE_VERSION,
  termsEffectiveAt: GEMINI_FREE_TERMS_EFFECTIVE_AT,
  officialTermsUrl: GEMINI_ADDITIONAL_TERMS_URL,
  dataUseClass: "TRAINING_POSSIBLE",
  confidentialDataEligible: false,
  professionalBusinessUseOnly: true,
  minimumAge: 18,
  paidOnlyRegions: ["EEA", "UK", "CH"],
};

export interface GeminiFreeAcceptanceRecord {
  providerId: "google" | "google-gemini";
  serviceTier: "FREE";
  accountId: string;
  policyRevision: string;
  disclosureVersion: string;
  termsEffectiveAt: string;
  acceptedAt: string;
  regionStatus: GeminiFreeRegionStatus;
  regionSource: RegionEvidenceSource;
  regionCountryCode: string | null;
}

export interface GeminiFreeDisclosure {
  version: string;
  headline: string;
  body: string;
  warning: string;
  termsUrl: string;
  checkboxLabel: string;
  checkedByDefault: false;
}

export const GEMINI_FREE_DISCLOSURE: GeminiFreeDisclosure = {
  version: GEMINI_FREE_DISCLOSURE_VERSION,
  headline: "Gemini API Free Tier data-use notice",
  body: "Google may use content from unpaid Gemini API services to improve its products and may use human review. Do not send confidential, proprietary, personal, or employer-owned data through this tier.",
  warning: "This is the unpaid Gemini API tier. It is restricted to professional/business use, users 18+, and regions where Google's Additional Terms permit unpaid API access.",
  termsUrl: GEMINI_ADDITIONAL_TERMS_URL,
  checkboxLabel: "I understand and accept the Gemini API Free Tier data-use notice.",
  checkedByDefault: false,
};

export function classifyGeminiFreeRegion(region: RegionResolution): GeminiFreeRegionStatus {
  if (!region.trusted || !isTrustedRegionSource(region.source)) return "GEMINI_REGION_UNKNOWN";
  return region.groups.some((group) => GEMINI_FREE_POLICY.paidOnlyRegions.includes(group as "EEA" | "UK" | "CH"))
    ? "GEMINI_PAID_REQUIRED_BY_REGION"
    : "GEMINI_FREE_REGION_ELIGIBLE";
}

export function buildGeminiFreeAcceptance(input: {
  accountId: string;
  region: RegionResolution;
  providerId?: "google" | "google-gemini";
  now?: Date;
}): GeminiFreeAcceptanceRecord {
  if (!input.accountId.trim()) throw new Error("Gemini free policy acceptance requires an account identity");
  const regionStatus = classifyGeminiFreeRegion(input.region);
  return {
    providerId: input.providerId ?? "google",
    serviceTier: "FREE",
    accountId: input.accountId.trim(),
    policyRevision: GEMINI_FREE_POLICY.policyRevision,
    disclosureVersion: GEMINI_FREE_POLICY.disclosureVersion,
    termsEffectiveAt: GEMINI_FREE_POLICY.termsEffectiveAt,
    acceptedAt: (input.now ?? new Date()).toISOString(),
    regionStatus,
    regionSource: input.region.source,
    regionCountryCode: input.region.countryCode,
  };
}

export interface GeminiFreePolicyDecision {
  decision: "ALLOW" | "DENY";
  reasonCode: "GEMINI_FREE_POLICY_ACCEPTED" | "GEMINI_FREE_POLICY_NOT_ACCEPTED" | "GEMINI_PAID_REQUIRED_BY_REGION" | "GEMINI_REGION_UNKNOWN";
  regionStatus: GeminiFreeRegionStatus;
  disclosure: GeminiFreeDisclosure;
  policy: GeminiFreePolicyMetadata;
}

export interface GeminiFreePolicyGate {
  evaluate(): GeminiFreePolicyDecision;
}

export class StaticGeminiFreePolicyGate implements GeminiFreePolicyGate {
  private readonly input: { accountId?: string; acceptance?: GeminiFreeAcceptanceRecord | null; region: RegionResolution; now?: Date };

  constructor(input: { accountId?: string; acceptance?: GeminiFreeAcceptanceRecord | null; region: RegionResolution; now?: Date }) {
    this.input = input;
  }

  evaluate(): GeminiFreePolicyDecision {
    return evaluateGeminiFreePolicy(this.input);
  }
}

export function createFailClosedGeminiFreePolicyGate(): GeminiFreePolicyGate {
  return new StaticGeminiFreePolicyGate({ region: { countryCode: null, groups: [], trusted: false, source: "UNKNOWN" } });
}

export function createGeminiFreePolicyGate(input: {
  accountId?: string;
  acceptance?: GeminiFreeAcceptanceRecord | null;
  region: RegionResolution;
  now?: Date;
}): GeminiFreePolicyGate {
  return new StaticGeminiFreePolicyGate(input);
}

export function evaluateGeminiFreePolicy(input: {
  accountId?: string;
  acceptance?: GeminiFreeAcceptanceRecord | null;
  region: RegionResolution;
  now?: Date;
}): GeminiFreePolicyDecision {
  const regionStatus = classifyGeminiFreeRegion(input.region);
  if (regionStatus === "GEMINI_REGION_UNKNOWN") return denied("GEMINI_REGION_UNKNOWN", regionStatus);
  if (regionStatus === "GEMINI_PAID_REQUIRED_BY_REGION") return denied("GEMINI_PAID_REQUIRED_BY_REGION", regionStatus);

  const accepted = input.acceptance;
  const acceptedAt = accepted ? Date.parse(accepted.acceptedAt) : Number.NaN;
  const current = accepted !== null && accepted !== undefined
    && (accepted.providerId === "google" || accepted.providerId === "google-gemini")
    && accepted.serviceTier === "FREE"
    && typeof input.accountId === "string"
    && accepted.accountId === input.accountId.trim()
    && accepted.policyRevision === GEMINI_FREE_POLICY.policyRevision
    && accepted.disclosureVersion === GEMINI_FREE_POLICY.disclosureVersion
    && accepted.termsEffectiveAt === GEMINI_FREE_POLICY.termsEffectiveAt
    && accepted.regionStatus === regionStatus
    && accepted.regionSource === input.region.source
    && accepted.regionCountryCode === input.region.countryCode
    && Number.isFinite(acceptedAt)
    && acceptedAt <= (input.now ?? new Date()).getTime();
  return current
    ? { decision: "ALLOW", reasonCode: "GEMINI_FREE_POLICY_ACCEPTED", regionStatus, disclosure: GEMINI_FREE_DISCLOSURE, policy: GEMINI_FREE_POLICY }
    : denied("GEMINI_FREE_POLICY_NOT_ACCEPTED", regionStatus);
}

function denied(reasonCode: GeminiFreePolicyDecision["reasonCode"], regionStatus: GeminiFreeRegionStatus): GeminiFreePolicyDecision {
  return { decision: "DENY", reasonCode, regionStatus, disclosure: GEMINI_FREE_DISCLOSURE, policy: GEMINI_FREE_POLICY };
}

/** Trusted-region adapter for callers that receive a country code from an approved source. */
export function classifyGeminiFreeCountry(countryCode: string | null, source: RegionEvidenceSource): GeminiFreeRegionStatus {
  return classifyGeminiFreeRegion(classifyRegionEvidence({ countryCode, source, observedAt: new Date().toISOString() }));
}
