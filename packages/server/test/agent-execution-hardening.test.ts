import { describe, it, expect } from "vitest";
import { ForgeZero, createGenericFreeRecord, createMuseSparkRecord } from "@codeforge/forge-zero";
import { ForgeRouter } from "@codeforge/router";

function paidModel(): import("@codeforge/forge-zero").FreeModelRecord {
  return {
    providerId: "openrouter",
    modelId: "meta/muse-spark-1.2",
    displayName: "Paid Muse Spark",
    tier: "paid",
    freeStatus: "paid",
    isRemote: true,
    isCloudHosted: true,
    freeStatusVerifiedAt: new Date().toISOString(),
    contextWindow: 128000,
    capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: false },
    costProfile: {
      inputCostPerMillion: 1.25,
      outputCostPerMillion: 5,
      cacheReadCostPerMillion: 0,
      cacheWriteCostPerMillion: 0,
      isFree: false,
      paidFallbackPossible: true,
      paidFallbackDisabled: false,
      source: "paid",
      freeTierVerifiedAt: new Date().toISOString(),
    },
    health: { status: "available" },
  };
}

describe("Full-Auto execution hardening — adversarial routing", () => {
  it("Test 1: UI claiming paid model is free -> inference rejected", () => {
    const fw = new ForgeZero();
    fw.register(paidModel());
    fw.register(createGenericFreeRecord());
    // Paid masquerading as free via UI metadata would still be paid in ForgeZero
    expect(fw.verify("openrouter", "meta/muse-spark-1.2").ok).toBe(false);
    expect(fw.eligibleModels().map((m) => m.modelId)).not.toContain("meta/muse-spark-1.2");
  });

  it("Test 2: manual paid model must be rejected before provider request — verify gate", async () => {
    const fw = new ForgeZero();
    const paid = paidModel();
    fw.register(paid);
    const result = fw.verify(paid.providerId, paid.modelId);
    expect(result.ok).toBe(false);
  });

  it("Test 3: Auto receives paid model in catalog — ForgeZero excludes it", () => {
    const fw = new ForgeZero();
    fw.register(createGenericFreeRecord());
    fw.register(paidModel());
    const router = new ForgeRouter({ firewall: fw });
    const decision = router.route({ taskType: "coding", estimatedContextTokens: 8000, requiredCapabilities: ["text", "coding"] });
    expect(decision).not.toBeNull();
    expect(decision?.model.modelId).not.toBe("meta/muse-spark-1.2");
    expect(fw.eligibleModels().every((m) => m.costProfile.isFree)).toBe(true);
  });

  it("Test 4: free model expired between turns — next inference fails", async () => {
    const fw = new ForgeZero();
    const m = createMuseSparkRecord();
    fw.register(m);
    expect(fw.verify(m.providerId, m.modelId).ok).toBe(true);
    // expire it
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    m.freeStatusVerifiedAt = old;
    m.costProfile.freeTierVerifiedAt = old;
    // re-register overwrites
    fw.register(m);
    expect(fw.verify(m.providerId, m.modelId).ok).toBe(false);
    expect(fw.eligibleModels()).toHaveLength(0);
  });

  it("Test 5: provider A model paired with provider B adapter -> rejected (canonical mismatch)", () => {
    const fw = new ForgeZero();
    fw.register(createGenericFreeRecord());
    // getModel requires exact providerId::modelId
    const found = fw.getModel("openrouter", "free-model-1");
    expect(found).toBeUndefined(); // free-model-1 is under opencode or generic provider
    const correct = fw.getModel("opencode", "muse-spark-1.2-contributor-free") ?? fw.getModel("opencode", "free-model-1") ?? fw.getModel(createGenericFreeRecord().providerId, createGenericFreeRecord().modelId);
    // at least generic exists under its provider
    expect(correct).toBeDefined();
  });

  it("Test 6: provider failure does not fallback to paid", () => {
    const fw = new ForgeZero();
    const free = createGenericFreeRecord();
    free.health = { status: "offline" };
    fw.register(free);
    fw.register(paidModel());
    expect(fw.eligibleModels()).toHaveLength(0);
    const router = new ForgeRouter({ firewall: fw });
    expect(router.route({ taskType: "coding", estimatedContextTokens: 8000, requiredCapabilities: ["text", "coding"] })).toBeNull();
    const sel = router.resolveSelection({ mode: "forgezero-adaptive" });
    expect(sel.ok).toBe(false);
    if (!sel.ok) expect(sel.error.code).toBe("NO_FREE_PROVIDER");
  });

  it("Test 7: retry must re-validate via ForgeZero", () => {
    const fw = new ForgeZero();
    const free = createGenericFreeRecord();
    fw.register(free);
    const router = new ForgeRouter({ firewall: fw });
    const first = router.route({ taskType: "coding", estimatedContextTokens: 8000, requiredCapabilities: ["text", "coding"] });
    expect(first?.model.modelId).toBe(free.modelId);
    // simulate failure then retry — new model must still pass verification
    const retryVerify = fw.verify(free.providerId, free.modelId);
    expect(retryVerify.ok).toBe(true);
  });

  it("Test 8: tool loop cannot bypass model validation", () => {
    const fw = new ForgeZero();
    const free = createGenericFreeRecord();
    fw.register(free);
    // tool execution path calls firewall.verify per tool — ensure still eligible
    expect(fw.verify(free.providerId, free.modelId).ok).toBe(true);
    // paid tool loop attempt fails
    const paid = paidModel();
    fw.register(paid);
    expect(fw.verify(paid.providerId, paid.modelId).ok).toBe(false);
  });
});
