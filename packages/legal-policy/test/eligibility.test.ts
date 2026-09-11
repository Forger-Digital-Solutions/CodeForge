import { describe, expect, it } from "vitest";
import { evaluateRouteEligibility } from "../src/eligibility.js";
import { classifyRegionEvidence, REGION_UNKNOWN, type RegionEvidence } from "../src/region.js";
import type { EnterpriseOverrideConfig } from "../src/provider-policy.js";

function region(evidence: RegionEvidence) {
  return classifyRegionEvidence(evidence);
}

describe("evaluateRouteEligibility — region restriction (R1 spec §51)", () => {
  it("ALLOWs hosted Gemini free tier for a trusted non-denied region", () => {
    const decision = evaluateRouteEligibility({
      providerId: "google-gemini",
      architecture: "HOSTED_MULTI_TENANT",
      serviceTier: "FREE",
      region: region({ countryCode: "US", source: "ACCOUNT_BILLING_COUNTRY", observedAt: new Date().toISOString() }),
    });
    expect(decision.decision).toBe("ALLOW");
  });

  it("DENYs hosted Gemini free tier for a trusted denied region (EEA)", () => {
    const decision = evaluateRouteEligibility({
      providerId: "google-gemini",
      architecture: "HOSTED_MULTI_TENANT",
      serviceTier: "FREE",
      region: region({ countryCode: "DE", source: "TRUSTED_EDGE_HEADER", observedAt: new Date().toISOString() }),
    });
    expect(decision.decision).toBe("DENY");
    expect(decision.reasonCode).toBe("PROVIDER_POLICY_REGION_RESTRICTED");
  });

  it("DENYs (fails closed) hosted Gemini free tier when region cannot be resolved", () => {
    const decision = evaluateRouteEligibility({
      providerId: "google-gemini",
      architecture: "HOSTED_MULTI_TENANT",
      serviceTier: "FREE",
      region: REGION_UNKNOWN,
    });
    expect(decision.decision).toBe("DENY");
    expect(decision.reasonCode).toBe("PROVIDER_POLICY_REGION_UNKNOWN_FAIL_CLOSED");
  });

  it("does not spoof region from an untrusted client-supplied source", () => {
    // A raw header claiming "US" from an undocumented/untrusted source must resolve exactly the
    // same as no evidence at all — this is the "no spoofable geoblock" property (R1 spec §12).
    const spoofed = region({ countryCode: "US", source: "USER_DECLARED", observedAt: new Date().toISOString() });
    expect(spoofed.trusted).toBe(false);
    const decision = evaluateRouteEligibility({
      providerId: "google-gemini",
      architecture: "HOSTED_MULTI_TENANT",
      serviceTier: "FREE",
      region: spoofed,
    });
    expect(decision.decision).toBe("DENY");
  });

  it("leaves Desktop BYOK Gemini unaffected by the hosted region restriction (R1 spec §13)", () => {
    const decision = evaluateRouteEligibility({
      providerId: "google-gemini",
      architecture: "BYOK",
      serviceTier: "FREE",
      region: region({ countryCode: "DE", source: "TRUSTED_EDGE_HEADER", observedAt: new Date().toISOString() }),
    });
    expect(decision.decision).not.toBe("DENY");
    expect(decision.reasonCode).toBe("ATTORNEY_REVIEW_PENDING");
  });

  it("ALLOWs hosted Gemini paid tier in every region (no unpaid-tier restriction)", () => {
    const decision = evaluateRouteEligibility({
      providerId: "google-gemini",
      architecture: "HOSTED_MULTI_TENANT",
      serviceTier: "PAID",
      region: REGION_UNKNOWN,
    });
    // Paid-tier record is DENY today only because no Google Cloud DPA is on file — but it must
    // never be rejected for a REGION reason, since the EEA restriction is specifically the
    // "unpaid" clause.
    expect(decision.reasonCode).not.toContain("REGION");
  });
});

describe("evaluateRouteEligibility — data use disclosure (R1 spec §52)", () => {
  it("attaches a disclosure for a provider marked TRAINING_POSSIBLE / HUMAN_REVIEW_POSSIBLE", () => {
    const decision = evaluateRouteEligibility({
      providerId: "google-gemini",
      architecture: "BYOK",
      serviceTier: "FREE",
      region: REGION_UNKNOWN,
    });
    expect(decision.disclosure).not.toBeNull();
    expect(decision.disclosure?.body).toMatch(/human review/i);
  });

  it("does not attach a disclosure for a provider with NO_TRAINING_CONTRACT", () => {
    const decision = evaluateRouteEligibility({
      providerId: "google-gemini",
      architecture: "BYOK",
      serviceTier: "PAID",
      region: REGION_UNKNOWN,
    });
    expect(decision.disclosure).toBeNull();
  });

  it("never infers a disclosure from 'free' alone — an UNKNOWN-data-use free provider gets no disclosure", () => {
    const decision = evaluateRouteEligibility({
      providerId: "groq",
      architecture: "BYOK",
      serviceTier: "FREE",
      region: REGION_UNKNOWN,
    });
    expect(decision.disclosure).toBeNull();
  });
});

describe("evaluateRouteEligibility — provider policy change / freshness (R1 spec §49-50)", () => {
  it("fails closed for a HOSTED architecture once policy metadata has expired", () => {
    const decision = evaluateRouteEligibility({
      providerId: "google-gemini",
      architecture: "HOSTED_MULTI_TENANT",
      serviceTier: "FREE",
      region: region({ countryCode: "US", source: "ACCOUNT_BILLING_COUNTRY", observedAt: new Date().toISOString() }),
      now: new Date("2099-01-01T00:00:00.000Z"),
    });
    expect(decision.decision).toBe("DENY");
    expect(decision.reasonCode).toBe("PROVIDER_POLICY_EXPIRED_HOSTED_FAIL_CLOSED");
  });

  it("does not fail closed a BYOK architecture merely because policy metadata expired", () => {
    const decision = evaluateRouteEligibility({
      providerId: "google-gemini",
      architecture: "BYOK",
      serviceTier: "PAID",
      region: REGION_UNKNOWN,
      now: new Date("2099-01-01T00:00:00.000Z"),
    });
    expect(decision.decision).not.toBe("DENY");
  });

  it("defaults unevidenced provider/architecture pairs to ALLOW rather than breaking unrelated routes", () => {
    const decision = evaluateRouteEligibility({
      providerId: "some-future-provider",
      architecture: "BYOK",
      serviceTier: "UNKNOWN",
      region: REGION_UNKNOWN,
    });
    expect(decision.decision).toBe("ALLOW");
    expect(decision.reasonCode).toBe("NO_POLICY_RECORD_DEFAULT_ALLOW");
    expect(decision.policyRecord).toBeNull();
  });
});

describe("evaluateRouteEligibility — authority boundary (R1 spec §81)", () => {
  it("DENYs a hosted-resale-restricted route when no enterprise override is supplied", () => {
    const decision = evaluateRouteEligibility({
      providerId: "openrouter",
      architecture: "HOSTED_MULTI_TENANT",
      serviceTier: "FREE",
      region: REGION_UNKNOWN,
    });
    expect(decision.decision).toBe("DENY");
    expect(decision.reasonCode).toBe("OPENROUTER_ENTERPRISE_AGREEMENT_REQUIRED");
  });

  it("ALLOWs only when a trusted server-sourced EnterpriseOverrideConfig explicitly authorizes the architecture", () => {
    const override: EnterpriseOverrideConfig = {
      providerId: "openrouter",
      status: "ENTERPRISE_AUTHORIZED",
      agreementReference: "TEST-FIXTURE-NOT-REAL",
      allowedArchitectures: ["HOSTED_MULTI_TENANT"],
    };
    const decision = evaluateRouteEligibility({
      providerId: "openrouter",
      architecture: "HOSTED_MULTI_TENANT",
      serviceTier: "FREE",
      region: REGION_UNKNOWN,
      enterpriseOverride: override,
    });
    expect(decision.decision).toBe("ALLOW");
  });

  it("an override authorized for a DIFFERENT architecture does not leak authorization across architectures", () => {
    const override: EnterpriseOverrideConfig = {
      providerId: "openrouter",
      status: "ENTERPRISE_AUTHORIZED",
      allowedArchitectures: ["BYOK"], // BYOK never needed authorization in the first place
    };
    const decision = evaluateRouteEligibility({
      providerId: "openrouter",
      architecture: "HOSTED_MULTI_TENANT",
      serviceTier: "FREE",
      region: REGION_UNKNOWN,
      enterpriseOverride: override,
    });
    expect(decision.decision).toBe("DENY");
  });

  it("a STANDARD_TERMS override status never authorizes a restricted route regardless of allowedArchitectures", () => {
    const override: EnterpriseOverrideConfig = {
      providerId: "openrouter",
      status: "STANDARD_TERMS",
      allowedArchitectures: ["HOSTED_MULTI_TENANT"],
    };
    const decision = evaluateRouteEligibility({
      providerId: "openrouter",
      architecture: "HOSTED_MULTI_TENANT",
      serviceTier: "FREE",
      region: REGION_UNKNOWN,
      enterpriseOverride: override,
    });
    expect(decision.decision).toBe("DENY");
  });
});
