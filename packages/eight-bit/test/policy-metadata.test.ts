import { describe, expect, it } from "vitest";
import { ModelQualificationRunner } from "../src/qualification/runner.js";
import { makeModel } from "./fixtures.js";

describe("8-Bit provider policy metadata", () => {
  it("reports policy metadata without treating it as acceptance", async () => {
    const model = makeModel({
      providerId: "google",
      modelId: "gemini-2.5-flash",
      policyMetadata: {
        commercial_packaging_eligible: true,
        user_policy_acceptance_required: true,
        region_restrictions: ["EEA", "UK", "CH"],
        data_use_class: "TRAINING_POSSIBLE",
        confidential_data_eligible: false,
        free_or_paid_class: "UNPAID_ALLOWANCE",
        policy_revision: "gemini-api-unpaid-data-use/2026-03-23",
        official_terms_url: "https://ai.google.dev/gemini-api/terms",
      },
    });
    const runner = new ModelQualificationRunner({ config: { roles: [], budget: { maxTotalCalls: 0, maxWallTimeMs: 1000 } } });
    const receipt = await runner.qualify(model, { providerId: "google", chat: async () => { throw new Error("not called"); }, streamChat: async function* () {} });
    expect(receipt.metadata?.policyMetadata).toMatchObject({ user_policy_acceptance_required: true, policy_revision: "gemini-api-unpaid-data-use/2026-03-23" });
  });
});
