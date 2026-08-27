import { describe, it, expect } from "vitest";
import { ForgeZero } from "../src/firewall.js";
import { createMuseSparkRecord, createGenericFreeRecord } from "../src/catalog.js";
import type { FreeModelRecord } from "../src/types.js";

function paidMasqueradingAsFree(): FreeModelRecord {
  // Attempt to claim freeStatus verified_free while cost is paid
  return {
    providerId: "opencode",
    modelId: "evil-free-claim",
    displayName: "Evil Free Claim",
    tier: "free",
    freeStatus: "verified_free",
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
      paidFallbackPossible: false,
      paidFallbackDisabled: true,
      source: "paid",
      freeTierVerifiedAt: new Date().toISOString(),
    },
    health: { status: "available" },
  };
}

function expiredPromotional(): FreeModelRecord {
  const r = createMuseSparkRecord();
  r.modelId = "expired-promo";
  r.isPromotional = true;
  // force expired verification (8 days ago)
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  r.freeStatusVerifiedAt = eightDaysAgo;
  r.costProfile.freeTierVerifiedAt = eightDaysAgo;
  return r;
}

describe("ForgeZero adversarial boundary — UI metadata cannot override authority", () => {
  it("paid model masquerading as free remains ineligible", () => {
    const fw = new ForgeZero();
    fw.register(paidMasqueradingAsFree());
    expect(fw.eligibleModels()).toHaveLength(0);
    expect(fw.verify("opencode", "evil-free-claim").ok).toBe(false);
  });

  it("expired promotional model excluded from eligibleModels", () => {
    const fw = new ForgeZero();
    fw.register(expiredPromotional());
    expect(fw.eligibleModels()).toHaveLength(0);
  });

  it("missing verification (isFree false) not eligible", () => {
    const fw = new ForgeZero();
    const m = createGenericFreeRecord();
    m.costProfile.isFree = false as unknown as boolean;
    fw.register(m);
    expect(fw.eligibleModels()).toHaveLength(0);
  });

  it("provider health failure excludes model", () => {
    const fw = new ForgeZero();
    const m = createGenericFreeRecord();
    m.health = { status: "offline" };
    fw.register(m);
    expect(fw.eligibleModels()).toHaveLength(0);
    expect(fw.verify(m.providerId, m.modelId).ok).toBe(false);
  });

  it("renderer metadata claiming paid as free does not make router eligible — ForgeZero authoritative", () => {
    const fw = new ForgeZero();
    // Register a legitimate free and a paid that renderer claims is free
    const free = createGenericFreeRecord();
    const paidClaim = paidMasqueradingAsFree();
    fw.register(free);
    fw.register(paidClaim);
    const eligible = fw.eligibleModels();
    expect(eligible.map((x) => x.modelId)).toContain(free.modelId);
    expect(eligible.map((x) => x.modelId)).not.toContain(paidClaim.modelId);
  });
});
