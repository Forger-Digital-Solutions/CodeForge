import { describe, expect, it } from "vitest";
import { getProviderDefinition } from "../src/provider-definitions.js";
import { createProviderAdapterFromDefinition } from "@codeforge/providers";

describe("commercial provider packaging metadata", () => {
  it.each([
    ["mistral", "Mistral API commercial terms"],
    ["cerebras", "Cerebras API commercial terms"],
  ])("registers %s as packageable without promoting its access class", (providerId, __) => {
    const definition = getProviderDefinition(providerId);
    expect(definition?.implemented).toBe(true);
    expect(definition?.policyMetadata?.commercial_packaging_eligible).toBe(true);
    expect(definition?.freeAccess.class).not.toBe("FREE_API");
    const adapter = createProviderAdapterFromDefinition(definition!, { apiKey: "test-key" });
    expect(adapter?.providerId).toBe(providerId);
  });

  it("keeps Gemini packaging policy-gated and distinct from paid services", () => {
    const definition = getProviderDefinition("google");
    expect(definition?.policyMetadata).toMatchObject({ commercial_packaging_eligible: true, user_policy_acceptance_required: true, free_or_paid_class: "UNPAID_ALLOWANCE" });
    expect(definition?.policyMetadata?.official_terms_url).toBe("https://ai.google.dev/gemini-api/terms");
  });
});
