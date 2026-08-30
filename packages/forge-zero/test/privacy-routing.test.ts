import { describe, expect, it } from "vitest";
import { ForgeZero } from "../src/firewall.js";
import { verifyModelEligibility } from "../src/verifier.js";
import type { FreeModelRecord } from "../src/types.js";

const now = new Date("2026-08-23T12:00:00Z");

const makePrivacyModel = (
  providerId: string,
  modelId: string,
  privacyClass: "strict" | "standard" | "permissive",
): FreeModelRecord => ({
  providerId,
  modelId,
  displayName: `${providerId} ${modelId}`,
  freeStatus: "verified_free",
  freeStatusVerifiedAt: now.toISOString(),
  isRemote: true,
  isCloudHosted: true,
  contextWindow: 128000,
  privacyClass,
  capabilities: {
    text: true,
    coding: true,
    toolCalling: true,
    vision: false,
    structuredOutput: true,
    longContext: true,
  },
  costProfile: {
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    cacheReadCostPerMillion: 0,
    cacheWriteCostPerMillion: 0,
    isFree: true,
    freeTierVerifiedAt: now.toISOString(),
    paidFallbackPossible: false,
    paidFallbackDisabled: true,
    source: "test:free",
  },
  health: {
    status: "available",
    lastCheckedAt: now.toISOString(),
  },
});

describe("Privacy Routing — STRICT, STANDARD, and MAXIMUM_FREE Modes", () => {
  it("filters eligibility strictly based on active privacy mode", () => {
    const fw = new ForgeZero({ context: { now: () => now } });
    const strictModel = makePrivacyModel("groq", "strict-model", "strict");
    const standardModel = makePrivacyModel("openrouter", "standard-model", "standard");
    const permissiveModel = makePrivacyModel("cloudflare", "permissive-model", "permissive");

    fw.register(strictModel);
    fw.register(standardModel);
    fw.register(permissiveModel);

    // 1. STRICT Mode: only strict models are eligible
    fw.setPrivacyMode("STRICT");
    expect(fw.getPrivacyMode()).toBe("STRICT");

    const strictResult = verifyModelEligibility(strictModel, { privacyMode: "STRICT", now: () => now });
    expect(strictResult.eligible).toBe(true);

    const standardResult = verifyModelEligibility(standardModel, { privacyMode: "STRICT", now: () => now });
    expect(standardResult.eligible).toBe(false);
    if (!standardResult.eligible) {
      expect(standardResult.failedStep).toBe("verify_privacy");
      expect(standardResult.reason).toContain("Privacy class standard not permitted under STRICT privacy mode");
    }

    const permissiveResult = verifyModelEligibility(permissiveModel, { privacyMode: "STRICT", now: () => now });
    expect(permissiveResult.eligible).toBe(false);
    if (!permissiveResult.eligible) {
      expect(permissiveResult.failedStep).toBe("verify_privacy");
      expect(permissiveResult.reason).toContain("Privacy class permissive not permitted under STRICT privacy mode");
    }

    const eligibleStrict = fw.eligibleModels();
    expect(eligibleStrict.map((m) => m.modelId)).toEqual(["strict-model"]);

    // 2. STANDARD Mode: strict + standard models are eligible
    fw.setPrivacyMode("STANDARD");
    expect(fw.getPrivacyMode()).toBe("STANDARD");

    expect(verifyModelEligibility(strictModel, { privacyMode: "STANDARD", now: () => now }).eligible).toBe(true);
    expect(verifyModelEligibility(standardModel, { privacyMode: "STANDARD", now: () => now }).eligible).toBe(true);
    expect(verifyModelEligibility(permissiveModel, { privacyMode: "STANDARD", now: () => now }).eligible).toBe(false);

    const eligibleStandard = fw.eligibleModels();
    expect(eligibleStandard.map((m) => m.modelId).sort()).toEqual(["standard-model", "strict-model"]);

    // 3. MAXIMUM_FREE Mode: strict + standard + permissive models are eligible
    fw.setPrivacyMode("MAXIMUM_FREE");
    expect(fw.getPrivacyMode()).toBe("MAXIMUM_FREE");

    expect(verifyModelEligibility(strictModel, { privacyMode: "MAXIMUM_FREE", now: () => now }).eligible).toBe(true);
    expect(verifyModelEligibility(standardModel, { privacyMode: "MAXIMUM_FREE", now: () => now }).eligible).toBe(true);
    expect(verifyModelEligibility(permissiveModel, { privacyMode: "MAXIMUM_FREE", now: () => now }).eligible).toBe(true);

    const eligibleMaxFree = fw.eligibleModels();
    expect(eligibleMaxFree.map((m) => m.modelId).sort()).toEqual(["permissive-model", "standard-model", "strict-model"]);
  });
});
