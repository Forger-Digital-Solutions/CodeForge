import { describe, expect, it } from "vitest";
import { capacityIndependenceKey, capacityIndependenceSnapshot, hashQuotaScope, haveIndependentQuotaScopes, quotaScopeEvidenceExclusionReason } from "../src/capacity-independence.js";
import { freeRouteExclusionReason } from "../src/capacity-policy.js";
import type { CapacityRoute, CapacityScope, QuotaDomainType } from "../src/capacity-types.js";

const now = Date.now();
const route = (providerId = "kilo-free-direct", domain: QuotaDomainType = "PUBLIC_IP"): CapacityRoute => ({
  routeId: `${providerId}:model-a`, providerId, modelId: "model-a", canonicalModelId: "model-a", family: "test", gateway: providerId,
  supplyClass: domain === "PUBLIC_IP" ? "PACKAGED_FREE_DIRECT" : "USER_ENTITLED_FREE",
  quotaDomainType: domain, quotaDomainId: `${providerId}:owner-a`, egressMode: domain === "PUBLIC_IP" ? "CLIENT_DIRECT" : "USER_DELEGATED",
  marginalCostToCodeForge: 0, freePrivacyClass: "PRIVATE_SAFE", trainingUse: "NO",
  capacityPoolId: `${providerId}:owner-a`, capacityPoolScope: "PER_USER_POOL", capacityScope: domain === "PUBLIC_IP" ? "SOURCE_IP" : "USER_ACCOUNT",
  dataPolicyProfile: "PRIVATE_CODE_ALLOWED", lifecycle: "APPROVED", explicitZeroPrice: true, freeOnlyAdmissionProven: true,
  paidFallbackDisabled: true, managedMultiUserAllowed: true, privacyClass: "standard", roles: ["coder"], qualityScore: 80,
  healthy: true, enabled: true, windows: [], capacityIdentity: "user-a",
  admissionReceipt: { sourceDocumentation: "official-docs", termsEvidence: "terms", priceEvidence: "free-account", privacyEvidence: "privacy",
    verifiedAt: new Date(now - 1_000).toISOString(), recheckAt: new Date(now + 60_000).toISOString(), qualificationAt: new Date(now - 1_000).toISOString() },
});
const scoped = (input: CapacityRoute, scope: CapacityScope, owner: string): CapacityRoute => ({
  ...input, quotaScopeEvidence: { scope, identityHash: hashQuotaScope(input.providerId, scope, owner), source: "provider-authoritative-quota-owner",
    verifiedAt: new Date(now - 1_000).toISOString(), recheckAt: new Date(now + 60_000).toISOString() },
});

describe("physical quota independence", () => {
  it("counts unknown Kilo NAT scopes once regardless of user, session, key or model aliases", () => {
    const a = route();
    const b = { ...route(), routeId: "bob:model-b", modelId: "model-b", quotaDomainId: "kilo:bob", capacityPoolId: "kilo:bob", capacityIdentity: "bob", independenceKey: "fabricated-bob" };
    expect(capacityIndependenceKey(a, now)).toBe(capacityIndependenceKey(b, now));
    expect(haveIndependentQuotaScopes(a, b, now)).toBe(false);
    expect(capacityIndependenceSnapshot([a, b], undefined, undefined, now)).toMatchObject({ admittedDomains: 2, independentCapacityGroups: 1, verifiedIndependentCapacityGroups: 0 });
  });

  it("same verified egress is one group and distinct verified egress is independent", () => {
    const a = scoped(route(), "SOURCE_IP", "egress-a");
    const b = scoped({ ...route(), capacityIdentity: "bob", modelId: "model-b" }, "SOURCE_IP", "egress-a");
    const c = scoped(route(), "SOURCE_IP", "egress-c");
    expect(haveIndependentQuotaScopes(a, b, now)).toBe(false);
    expect(haveIndependentQuotaScopes(a, c, now)).toBe(true);
    expect(capacityIndependenceSnapshot([a, b, c], undefined, undefined, now).independentCapacityGroups).toBe(2);
    expect(JSON.stringify(a.quotaScopeEvidence)).not.toContain("egress-a");
  });

  it("same account with multiple credentials/models is one group independent from Kilo", () => {
    const kilo = scoped(route(), "SOURCE_IP", "egress-a");
    const a = scoped(route("openrouter", "USER_ACCOUNT"), "ACCOUNT", "account-a");
    const b = scoped({ ...route("openrouter", "USER_ACCOUNT"), modelId: "model-b", capacityIdentity: "different-key" }, "ACCOUNT", "account-a");
    expect(haveIndependentQuotaScopes(a, b, now)).toBe(false);
    expect(haveIndependentQuotaScopes(kilo, a, now)).toBe(true);
    expect(capacityIndependenceSnapshot([kilo, a, b], undefined, undefined, now).verifiedIndependentCapacityGroups).toBe(2);
  });

  it("same sponsor wallet and organization remain shared across model routes", () => {
    for (const domain of ["SPONSOR_POOL", "PROVIDER_ACCOUNT"] as const) {
      const a = scoped(route("provider", domain), domain === "SPONSOR_POOL" ? "SPONSORED" : "ORG", "shared-owner");
      const b = { ...a, modelId: "different-model", capacityPoolId: "alias-pool" };
      expect(haveIndependentQuotaScopes(a, b, now)).toBe(false);
    }
  });

  it("rejects stale, future, wrong-scope, raw and forged owner evidence at Free admission", () => {
    const a = scoped(route(), "SOURCE_IP", "egress-a");
    const invalids: CapacityRoute[] = [
      { ...a, independenceKey: "forged" },
      { ...a, quotaScopeEvidence: { ...a.quotaScopeEvidence!, scope: "USER_ACCOUNT" } },
      { ...a, quotaScopeEvidence: { ...a.quotaScopeEvidence!, identityHash: "203.0.113.1" } },
      { ...a, quotaScopeEvidence: { ...a.quotaScopeEvidence!, source: " " } },
      { ...a, quotaScopeEvidence: { ...a.quotaScopeEvidence!, recheckAt: new Date(now - 1).toISOString() } },
      { ...a, quotaScopeEvidence: { ...a.quotaScopeEvidence!, verifiedAt: new Date(now + 60_000).toISOString() } },
    ];
    for (const invalid of invalids) {
      expect(quotaScopeEvidenceExclusionReason(invalid, now)).toBeDefined();
      expect(freeRouteExclusionReason(invalid)).toBeDefined();
      expect(haveIndependentQuotaScopes(a, invalid, now)).toBe(false);
    }
  });

  it("expired identity receipts lose independent status without becoming a new group", () => {
    const a = scoped(route(), "SOURCE_IP", "egress-a");
    expect(haveIndependentQuotaScopes(a, scoped(route(), "SOURCE_IP", "egress-b"), now + 60_001)).toBe(false);
    expect(capacityIndependenceSnapshot([a], undefined, undefined, now + 60_001).independentCapacityGroups).toBe(0);
    expect(capacityIndependenceSnapshot([{ ...a, supplyClass: "PAID" }], undefined, undefined, now).independentCapacityGroups).toBe(0);
  });
});
