import { describe, expect, it } from "vitest";
import {
  DEFAULT_FREE_CAPACITY_POLICY,
  isDataPolicyEligible,
  freeRouteExclusionReason,
  isFreeRouteEligible,
  type CapacityRoute,
  type DataPolicyProfile,
  type RouteDataContext,
} from "../src/index.js";

/**
 * R47 §15 — the data-policy contract as an explicit matrix. R46's corpus declared
 * SYNTHETIC+consent honestly; this proves that choice never leaked into production defaults
 * and that consent is never inferred.
 */

function managedRoute(profile: DataPolicyProfile): CapacityRoute {
  return {
    routeId: `r-${profile}`,
    providerId: "mistral",
    modelId: "codestral-latest",
    canonicalModelId: "codestral",
    family: "codestral",
    gateway: "direct",
    supplyClass: "PURE_MANAGED_FREE",
    capacityPoolId: "managed:mistral:acct-a:model:codestral-latest",
    capacityPoolScope: "SHARED_OWNER_POOL",
    capacityScope: "ORG",
    dataPolicyProfile: profile,
    lifecycle: "APPROVED",
    explicitZeroPrice: true,
    paidFallbackDisabled: true,
    managedMultiUserAllowed: true,
    privacyClass: "MANAGED",
    roles: ["CODER"],
    qualityScore: 0.9,
    healthy: true,
    enabled: true,
    windows: [],
  };
}

const PRIVATE: RouteDataContext = { dataClass: "PRIVATE_CODE" };
const SYNTHETIC_NO_CONSENT: RouteDataContext = { dataClass: "SYNTHETIC" };
const SYNTHETIC_CONSENTED: RouteDataContext = { dataClass: "SYNTHETIC", userConsented: true };
const PUBLIC_CONSENTED: RouteDataContext = { dataClass: "PUBLIC_CODE", userConsented: true };

describe("isDataPolicyEligible — consent and data-class matrix", () => {
  it("no dataContext supplied → the private-code default governs (fail-safe)", () => {
    // The default must exclude consent-gated routes: omitting context is never consent.
    expect(isDataPolicyEligible("USER_CONSENT_REQUIRED")).toBe(false);
    expect(isDataPolicyEligible("PRIVATE_CODE_ALLOWED")).toBe(true);
    expect(isDataPolicyEligible("PUBLIC_CODE_ONLY")).toBe(false);
    expect(isDataPolicyEligible("DISALLOWED")).toBe(false);
  });

  it("PRIVATE_CODE admits only PRIVATE_CODE_ALLOWED", () => {
    expect(isDataPolicyEligible("PRIVATE_CODE_ALLOWED", PRIVATE)).toBe(true);
    expect(isDataPolicyEligible("USER_CONSENT_REQUIRED", PRIVATE)).toBe(false);
    expect(isDataPolicyEligible("PUBLIC_CODE_ONLY", PRIVATE)).toBe(false);
  });

  it("private code requires explicit consent before using a consent-gated route", () => {
    const ctx: RouteDataContext = { dataClass: "PRIVATE_CODE", userConsented: true };
    expect(isDataPolicyEligible("USER_CONSENT_REQUIRED", ctx)).toBe(true);
    expect(isDataPolicyEligible("PUBLIC_CODE_ONLY", ctx)).toBe(false);
  });

  it("SYNTHETIC + explicit consent admits USER_CONSENT_REQUIRED (the R46 corpus case)", () => {
    expect(isDataPolicyEligible("USER_CONSENT_REQUIRED", SYNTHETIC_CONSENTED)).toBe(true);
    expect(isDataPolicyEligible("PUBLIC_CODE_ONLY", SYNTHETIC_CONSENTED)).toBe(true);
    expect(isDataPolicyEligible("PRIVATE_CODE_ALLOWED", SYNTHETIC_CONSENTED)).toBe(true);
    expect(isDataPolicyEligible("DISALLOWED", SYNTHETIC_CONSENTED)).toBe(false);
  });

  it("SYNTHETIC without consent still excludes USER_CONSENT_REQUIRED — the class alone is not consent", () => {
    expect(isDataPolicyEligible("USER_CONSENT_REQUIRED", SYNTHETIC_NO_CONSENT)).toBe(false);
    expect(isDataPolicyEligible("PUBLIC_CODE_ONLY", SYNTHETIC_NO_CONSENT)).toBe(true);
  });

  it("PUBLIC_CODE behaves like SYNTHETIC", () => {
    expect(isDataPolicyEligible("USER_CONSENT_REQUIRED", PUBLIC_CONSENTED)).toBe(true);
    expect(isDataPolicyEligible("USER_CONSENT_REQUIRED", { dataClass: "PUBLIC_CODE" })).toBe(false);
  });

  it("DISALLOWED is never eligible under any context", () => {
    for (const ctx of [PRIVATE, SYNTHETIC_NO_CONSENT, SYNTHETIC_CONSENTED, PUBLIC_CONSENTED]) {
      expect(isDataPolicyEligible("DISALLOWED", ctx)).toBe(false);
    }
  });
});

describe("freeRouteExclusionReason — data policy on otherwise-eligible managed routes", () => {
  const consentGated = managedRoute("USER_CONSENT_REQUIRED");

  it("a mistral-class route is excluded for private code when no consent context applies", () => {
    expect(freeRouteExclusionReason(consentGated)).toBe("DATA_POLICY_USER_CONSENT_REQUIRED");
    expect(isFreeRouteEligible(consentGated)).toBe(false);
  });

  it("the same route admits synthetic work with explicit consent", () => {
    expect(freeRouteExclusionReason(consentGated, DEFAULT_FREE_CAPACITY_POLICY, SYNTHETIC_CONSENTED)).toBeUndefined();
    expect(isFreeRouteEligible(consentGated, DEFAULT_FREE_CAPACITY_POLICY, SYNTHETIC_CONSENTED)).toBe(true);
  });

  it("a PRIVATE_CODE_ALLOWED route serves every data class", () => {
    const privateOk = managedRoute("PRIVATE_CODE_ALLOWED");
    for (const ctx of [PRIVATE, SYNTHETIC_NO_CONSENT, SYNTHETIC_CONSENTED, PUBLIC_CONSENTED]) {
      expect(freeRouteExclusionReason(privateOk, DEFAULT_FREE_CAPACITY_POLICY, ctx)).toBeUndefined();
    }
  });
});

describe("packaged direct admission", () => {
  const direct = (): CapacityRoute => ({
    ...managedRoute("USER_CONSENT_REQUIRED"),
    routeId: "kilo-direct", providerId: "kilo-free-direct", modelId: "kilo-auto/free",
    supplyClass: "PACKAGED_FREE_DIRECT", capacityPoolId: "kilo:ip:user-a",
    capacityPoolScope: "PER_USER_POOL", capacityScope: "SOURCE_IP", capacityIdentity: "user-a",
    quotaDomainType: "PUBLIC_IP", quotaDomainId: "kilo:ip:user-a", egressMode: "CLIENT_DIRECT",
    marginalCostToCodeForge: 0, freePrivacyClass: "DATA_COLLECTION_ALLOWED", trainingUse: "YES",
    admissionReceipt: {
      sourceDocumentation: "https://kilo.ai/docs/gateway/models-and-providers",
      termsEvidence: "https://kilo.ai/terms",
      priceEvidence: "https://kilo.ai/docs/gateway/usage-and-billing",
      privacyEvidence: "https://kilo.ai/docs/getting-started/using-kilo-for-free",
      verifiedAt: new Date().toISOString(), recheckAt: new Date(Date.now() + 86_400_000).toISOString(),
      qualificationAt: new Date().toISOString(),
    },
  });

  it("keeps private code off a data-collecting direct route by default", () => {
    expect(freeRouteExclusionReason(direct())).toBe("PRIVATE_CODE_CONSENT_REQUIRED");
    expect(isFreeRouteEligible(direct(), DEFAULT_FREE_CAPACITY_POLICY, { dataClass: "PUBLIC_CODE", userConsented: true })).toBe(true);
  });

  it("fails closed on cost, scope, and stale evidence", () => {
    expect(freeRouteExclusionReason({ ...direct(), marginalCostToCodeForge: 1 })).toBe("CODEFORGE_MARGINAL_COST_NOT_ZERO");
    expect(freeRouteExclusionReason({ ...direct(), egressMode: "CODEFORGE_GATEWAY" })).toBe("DIRECT_ROUTE_SCOPE_INVALID");
    const stale = direct();
    stale.admissionReceipt = { ...stale.admissionReceipt!, recheckAt: "2020-01-01T00:00:00Z" };
    expect(freeRouteExclusionReason(stale, DEFAULT_FREE_CAPACITY_POLICY, { dataClass: "PUBLIC_CODE", userConsented: true })).toBe("ADMISSION_EVIDENCE_STALE");
    expect(freeRouteExclusionReason({ ...direct(), supplyClass: "CODEFORGE_PAID" })).toBe("PAID_OR_PROMOTIONAL_NOT_PACKAGED_FREE");
  });
});
