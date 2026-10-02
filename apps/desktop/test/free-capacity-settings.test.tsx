import { describe, expect, it } from "vitest";
import { FreeCapacitySection, freeCapacityStatus } from "../src/renderer/settings/sections/FreeCapacitySection.js";
import { renderSection, createSettingsContext } from "./settings-test-harness.js";
import type { ProviderConnectionView } from "../src/provider-connection-types.js";

const connection = (extra: Partial<ProviderConnectionView>): ProviderConnectionView => ({ providerId: "openrouter", displayName: "OpenRouter", kind: "gateway",
  implemented: true, recommendedForFreeDefault: true, authClasses: ["OAUTH_PKCE"], fields: [], freeAccess: { class: "FREE_API", spillover: "NONE", evidence: { source: "fixture", checkedAt: "2026-10-02" } },
  privacy: { class: "standard" }, terms: { status: "CLEARED" }, connected: true, credentialSource: "OAUTH", authState: "ok", planAttested: true,
  planAttestationRequired: false, environment: null, freeRouteCount: 20, healthyRouteCount: 20, catalogCount: 20, paidOnly: false, zeroCashFreeAccess: true, sortRank: 0, ...extra });

describe("Free Capacity admission display", () => {
  it("does not turn catalog counts, a saved key or a receipt alone into admitted capacity", () => {
    expect(freeCapacityStatus(connection({}))).toBe("UNKNOWN — NOT ADMITTED");
    expect(freeCapacityStatus(connection({ delegatedFree: { accountClass: "FREE_VERIFIED", reason: "fixture", verifiedAt: "2026-10-02", recheckAt: "2026-10-03", remainingRequests: 20 } }))).toBe("UNKNOWN — NOT ADMITTED");
    expect(freeCapacityStatus(connection({ freeCapacity: { admittedDomains: 1, independentGroups: 1, healthyGroups: 1 } }))).toBe("FREE VERIFIED · HEALTHY");
  });
  it("shows rejection and revocation even when stale catalog routes remain", () => {
    expect(freeCapacityStatus(connection({ freeConnectionAttempt: { accountClass: "PAID", reason: "PAID" } }))).toBe("PAID — NOT ELIGIBLE FOR FORGEAUTO/FREE");
    expect(freeCapacityStatus(connection({ freeConnectionAttempt: { accountClass: "REVOKED", reason: "REVOKED" } }))).toBe("REAUTH REQUIRED");
  });
  it("provides the exact OAuth handoff and states unavailable candidates honestly", () => {
    const html = renderSection(<FreeCapacitySection connections={[]} />, createSettingsContext());
    for (const text of ["Connect OpenRouter Free", "Puter", "Cerebras", "Cloudflare Workers AI", "Groq", "purchased credits", "one quota group"]) expect(html).toContain(text);
    expect(html).not.toContain("FREE VERIFIED");
  });
});
