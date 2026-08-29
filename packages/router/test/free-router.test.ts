import { describe, it, expect } from "vitest";
import { ForgeZero, type FreeModelRecord } from "@codeforge/forge-zero";
import { ForgeRouter } from "../src/index.js";

const NOW = new Date("2026-08-29T12:00:00Z");
const ctx = { now: () => NOW };

function verifiedFree(providerId: string, modelId: string, over: Partial<FreeModelRecord> = {}): FreeModelRecord {
  return {
    providerId,
    modelId,
    displayName: modelId,
    freeStatus: "verified_free",
    freeStatusVerifiedAt: NOW.toISOString(),
    tier: "free",
    accessClass: "FREE_ROUTED",
    authMode: "OAUTH_PKCE",
    privacyClass: "standard",
    contextWindow: 128000,
    capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    costProfile: { inputCostPerMillion: 0, outputCostPerMillion: 0, cacheReadCostPerMillion: 0, cacheWriteCostPerMillion: 0, isFree: true, freeTierVerifiedAt: NOW.toISOString(), paidFallbackPossible: false, paidFallbackDisabled: true, source: "test" },
    isRemote: true,
    isCloudHosted: true,
    health: { status: "available", lastCheckedAt: NOW.toISOString() },
    ...over,
  };
}

const codingReq = { taskType: "agentic-coding", estimatedContextTokens: 40000, requiredCapabilities: ["coding", "toolCalling"] };

describe("ForgeRouter — free-first ranking", () => {
  it("topVerifiedFree is live-derived from eligibility and capped at the limit", () => {
    const fw = new ForgeZero({ context: ctx });
    for (let i = 0; i < 8; i++) fw.register(verifiedFree("openrouter", `m-${i}`, { codingScore: 20 + i * 10 }));
    const router = new ForgeRouter({ firewall: fw });
    const top = router.topVerifiedFree(codingReq, 5);
    expect(top).toHaveLength(5);
    // Higher empirical coding score ranks first (m-7 has the top codingScore of 90).
    expect(top[0]!.model.modelId).toBe("m-7");
  });

  it("ranking is deterministic (stable order for identical inputs)", () => {
    const fw = new ForgeZero({ context: ctx });
    fw.register(verifiedFree("openrouter", "b", { codingScore: 80 }));
    fw.register(verifiedFree("zai", "a", { codingScore: 80 }));
    const router = new ForgeRouter({ firewall: fw });
    const a = router.rank(codingReq).map((r) => r.model.modelId);
    const b = router.rank(codingReq).map((r) => r.model.modelId);
    expect(a).toEqual(b);
  });

  it("empirical tool reliability improves rank for tool tasks", () => {
    const fw = new ForgeZero({ context: ctx });
    fw.register(verifiedFree("openrouter", "reliable", { toolReliability: 0.98 }));
    fw.register(verifiedFree("openrouter", "flaky", { toolReliability: 0.2 }));
    const router = new ForgeRouter({ firewall: fw });
    expect(router.rank(codingReq)[0]!.model.modelId).toBe("reliable");
  });

  it("FREE_NATIVE outranks FREE_ROUTED when all else is equal (stability)", () => {
    const fw = new ForgeZero({ context: ctx });
    fw.register(verifiedFree("zai", "same", { accessClass: "FREE_NATIVE" }));
    fw.register(verifiedFree("openrouter", "same", { accessClass: "FREE_ROUTED" }));
    const router = new ForgeRouter({ firewall: fw });
    expect(router.rank(codingReq)[0]!.model.providerId).toBe("zai");
  });

  it("does not favor any model by id — reasons are capability-based, never a name", () => {
    const fw = new ForgeZero({ context: ctx });
    fw.register(verifiedFree("openrouter", "muse-spark-anything"));
    const router = new ForgeRouter({ firewall: fw });
    const r = router.route(codingReq)!;
    expect(r.reasons).not.toContain("muse_spark_selected");
  });

  it("returns null when no verified-free model is available (no paid fallback)", () => {
    const fw = new ForgeZero({ context: ctx });
    const router = new ForgeRouter({ firewall: fw });
    expect(router.route(codingReq)).toBeNull();
    expect(router.topVerifiedFree(codingReq)).toHaveLength(0);
    expect(router.resolveSelection({ mode: "forgezero-adaptive" }).ok).toBe(false);
  });
});
