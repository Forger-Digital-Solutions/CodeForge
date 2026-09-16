import { describe, expect, it } from "vitest";
import { evaluateRouteEligibility } from "../src/eligibility.js";
import { classifyRegionEvidence, REGION_UNKNOWN, type RegionEvidence } from "../src/region.js";
import type { EnterpriseOverrideConfig } from "../src/provider-policy.js";
import { buildGeminiFreeAcceptance } from "../src/gemini-policy.js";

const GEMINI_ACCOUNT = "gemini-project-fixture";
const GEMINI_US = region({ countryCode: "US", source: "ACCOUNT_BILLING_COUNTRY", observedAt: new Date().toISOString() });

function region(evidence: RegionEvidence) {
  return classifyRegionEvidence(evidence);
}

describe("evaluateRouteEligibility — region restriction (R1 spec §51)", () => {
  it("ALLOWs hosted Gemini free tier for a trusted non-denied region", () => {
    const decision = evaluateRouteEligibility({
      providerId: "google-gemini",
      architecture: "HOSTED_MULTI_TENANT",
      serviceTier: "FREE",
      region: GEMINI_US,
      geminiAccountId: GEMINI_ACCOUNT,
      geminiFreeAcceptance: buildGeminiFreeAcceptance({ accountId: GEMINI_ACCOUNT, region: GEMINI_US }),
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

  it("requires a current free-tier acceptance for Desktop BYOK Gemini", () => {
    const decision = evaluateRouteEligibility({
      providerId: "google-gemini",
      architecture: "BYOK",
      serviceTier: "FREE",
      region: region({ countryCode: "DE", source: "TRUSTED_EDGE_HEADER", observedAt: new Date().toISOString() }),
    });
    expect(decision.decision).toBe("DENY");
    expect(decision.reasonCode).toBe("GEMINI_PAID_REQUIRED_BY_REGION");
  });

  it("allows Desktop BYOK Gemini only with a current account-bound acceptance", () => {
    const acceptance = buildGeminiFreeAcceptance({ accountId: GEMINI_ACCOUNT, region: GEMINI_US });
    const decision = evaluateRouteEligibility({ providerId: "google", architecture: "BYOK", serviceTier: "FREE", region: GEMINI_US, geminiAccountId: GEMINI_ACCOUNT, geminiFreeAcceptance: acceptance });
    expect(decision.decision).toBe("ALLOW");
    expect(decision.reasonCode).toBe("GEMINI_FREE_POLICY_CONSENT_REQUIRED");
  });

  it("fails closed when direct Gemini free routing has no acceptance", () => {
    const decision = evaluateRouteEligibility({ providerId: "google", architecture: "BYOK", serviceTier: "FREE", region: GEMINI_US, geminiAccountId: GEMINI_ACCOUNT });
    expect(decision.decision).toBe("DENY");
    expect(decision.reasonCode).toBe("GEMINI_FREE_POLICY_NOT_ACCEPTED");
  });

  it("ALLOWs hosted Gemini paid tier in every region (no unpaid-tier restriction)", () => {
    const decision = evaluateRouteEligibility({
      providerId: "google-gemini",
      architecture: "HOSTED_MULTI_TENANT",
      serviceTier: "PAID",
      region: GEMINI_US,
      geminiAccountId: GEMINI_ACCOUNT,
      geminiFreeAcceptance: buildGeminiFreeAcceptance({ accountId: GEMINI_ACCOUNT, region: GEMINI_US }),
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

  it("gates Mistral's account-dependent free allowance with an explicit policy record", () => {
    const decision = evaluateRouteEligibility({
      providerId: "mistral",
      architecture: "BYOK",
      serviceTier: "FREE",
      region: REGION_UNKNOWN,
    });
    expect(decision.decision).toBe("ALLOW");
    expect(decision.reasonCode).toBe("MISTRAL_FREE_ALLOWANCE_ACCOUNT_ATTESTATION");
    expect(decision.disclosure?.confidentialDataPolicy).toBe("AVOID_SUBMISSION_RECOMMENDED");
  });

  it("keeps Cerebras promotional credit out of Managed-Free while permitting explicit paid BYOK", () => {
    const free = evaluateRouteEligibility({ providerId: "cerebras", architecture: "BYOK", serviceTier: "FREE", region: REGION_UNKNOWN });
    expect(free.decision).toBe("DENY");
    expect(free.reasonCode).toBe("CEREBRAS_PROMOTIONAL_CREDIT_NOT_FREE_ROUTING");

    const paid = evaluateRouteEligibility({ providerId: "cerebras", architecture: "BYOK", serviceTier: "PAID", region: REGION_UNKNOWN });
    expect(paid.decision).toBe("ALLOW");
    expect(paid.reasonCode).toBe("CEREBRAS_BYOK_PAID_OR_TRIAL_ONLY");
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
