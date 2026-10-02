import { describe, expect, it } from "vitest";
import { migrateLegacyFreeRoute, type CapacityRoute } from "../src/index.js";

const now = new Date();
const future = new Date(now.getTime() + 86_400_000).toISOString();
const route: CapacityRoute = {
  routeId: "managed:groq:account-a", providerId: "groq", modelId: "coder", canonicalModelId: "coder",
  family: "coder", gateway: "groq", supplyClass: "PURE_MANAGED_FREE",
  quotaDomainType: "PROVIDER_ACCOUNT", quotaDomainId: "groq:account-a", egressMode: "CODEFORGE_GATEWAY",
  marginalCostToCodeForge: 0, freePrivacyClass: "PUBLIC_CODE_ONLY", trainingUse: "YES",
  admissionReceipt: {
    sourceDocumentation: "https://provider.example/docs", termsEvidence: "https://provider.example/terms",
    priceEvidence: "https://provider.example/pricing", privacyEvidence: "https://provider.example/privacy",
    verifiedAt: now.toISOString(), recheckAt: future, qualificationAt: now.toISOString(),
  },
  capacityPoolId: "groq:account-a", capacityPoolScope: "SHARED_OWNER_POOL", capacityScope: "ORG",
  dataPolicyProfile: "PUBLIC_CODE_ONLY", lifecycle: "APPROVED", explicitZeroPrice: true,
  paidFallbackDisabled: true, managedMultiUserAllowed: true, privacyClass: "permissive", roles: ["CODER"],
  qualityScore: 70, healthy: true, enabled: true, windows: [],
};

describe("legacy Free route migration", () => {
  it("activates only when the new admission gate passes", () => {
    const decision = migrateLegacyFreeRoute(route, undefined, { dataClass: "PUBLIC_CODE" });
    expect(decision).toMatchObject({ state: "MIGRATED_ACTIVE", migrated: { supplyClass: "PACKAGED_FREE_PROVIDER_FUNDED" } });
  });

  it("keeps missing cost or policy evidence unknown and fail closed", () => {
    expect(migrateLegacyFreeRoute({ ...route, marginalCostToCodeForge: undefined }).state).toBe("REQUIRES_REVERIFY");
    expect(migrateLegacyFreeRoute({ ...route, admissionReceipt: undefined }).state).toBe("REQUIRES_REVERIFY");
    expect(migrateLegacyFreeRoute({ ...route, marginalCostToCodeForge: 0.001 }).state).toBe("MIGRATED_QUARANTINED");
    expect(migrateLegacyFreeRoute({ ...route, supplyClass: "SPONSORED_FREE" }).state).toBe("RETIRED");
  });
});
