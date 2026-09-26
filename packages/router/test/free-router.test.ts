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

describe("ForgeRouter — name hint never overrides measured evidence", () => {
  it("a coding-named route wins on the name hint only while no empirical score exists", () => {
    const fw = new ForgeZero({ context: ctx });
    fw.register(verifiedFree("openrouter", "aaa-generic"));
    fw.register(verifiedFree("openrouter", "zzz-coder"));
    const router = new ForgeRouter({ firewall: fw });
    // Identical records otherwise: the +8 name/family hint is the only thing that can beat
    // the aaa-* alphabetical tiebreak, and it does — but only while nothing is measured.
    const top = router.rank(codingReq);
    expect(top.map((r) => r.model.modelId)).toEqual(["zzz-coder", "aaa-generic"]);
    expect(top[0]!.score - top[1]!.score).toBe(8);
  });

  it("an equal measured agentScore suppresses the name hint — the tiebreak decides", () => {
    const fw = new ForgeZero({ context: ctx });
    fw.register(verifiedFree("openrouter", "aaa-generic", { agentScore: 50 }));
    fw.register(verifiedFree("openrouter", "zzz-coder", { agentScore: 50 }));
    const router = new ForgeRouter({ firewall: fw });
    // agentic-coding → both gain the same +5 agentScore term; the per-route name-hint gate
    // sees a measured score and stays off, so identical totals fall to the modelId tiebreak.
    const top = router.rank(codingReq);
    expect(top.map((r) => r.model.modelId)).toEqual(["aaa-generic", "zzz-coder"]);
    expect(top[0]!.score).toBe(top[1]!.score);
  });

  it("an equal measured toolReliability suppresses the name hint — the tiebreak decides", () => {
    const fw = new ForgeZero({ context: ctx });
    fw.register(verifiedFree("openrouter", "aaa-generic", { toolReliability: 0.9 }));
    fw.register(verifiedFree("openrouter", "zzz-coder", { toolReliability: 0.9 }));
    const router = new ForgeRouter({ firewall: fw });
    const top = router.rank(codingReq);
    expect(top.map((r) => r.model.modelId)).toEqual(["aaa-generic", "zzz-coder"]);
    expect(top[0]!.score).toBe(top[1]!.score);
  });

  it("a provided codingScore stays authoritative — measured score, not the name, decides both directions", () => {
    const strongGeneric = new ForgeZero({ context: ctx });
    strongGeneric.register(verifiedFree("openrouter", "aaa-generic", { codingScore: 90 }));
    strongGeneric.register(verifiedFree("openrouter", "zzz-coder", { codingScore: 30 }));
    expect(new ForgeRouter({ firewall: strongGeneric }).rank(codingReq)[0]!.model.modelId).toBe("aaa-generic");

    const strongNamed = new ForgeZero({ context: ctx });
    strongNamed.register(verifiedFree("openrouter", "aaa-generic", { codingScore: 30 }));
    strongNamed.register(verifiedFree("openrouter", "zzz-coder", { codingScore: 90 }));
    expect(new ForgeRouter({ firewall: strongNamed }).rank(codingReq)[0]!.model.modelId).toBe("zzz-coder");
  });

  it("the free-only filter still applies before any scoring — a paid coding-named route never ranks", () => {
    const fw = new ForgeZero({ context: ctx });
    fw.register(verifiedFree("openrouter", "aaa-generic", { codingScore: 40 }));
    fw.register(verifiedFree("openrouter", "super-coder-9000", {
      freeStatus: "paid",
      codingScore: 100,
      costProfile: { inputCostPerMillion: 3, outputCostPerMillion: 15, isFree: false, paidFallbackPossible: true, paidFallbackDisabled: false, source: "test" },
    }));
    const router = new ForgeRouter({ firewall: fw });
    expect(router.rank(codingReq).map((r) => r.model.modelId)).toEqual(["aaa-generic"]);
    expect(router.route(codingReq)!.model.modelId).toBe("aaa-generic");
  });
});

describe("ForgeRouter — required capabilities are requirements", () => {
  it("never ranks a route that lacks a required capability, however well it would score", () => {
    const fw = new ForgeZero({ context: ctx });
    // A big, otherwise attractive $0 route that the provider serves WITHOUT native tool calling
    // (a content-safety classifier, a music model, a ":free" variant with tools disabled) …
    fw.register(verifiedFree("openrouter", "big/no-tools:free", {
      contextWindow: 1_000_000,
      codingScore: 95,
      capabilities: { text: true, coding: true, toolCalling: false, vision: false, structuredOutput: true, longContext: true },
    }));
    // … and a modest one that can actually drive the agent loop.
    fw.register(verifiedFree("openrouter", "small/with-tools:free", { contextWindow: 64000, codingScore: 40 }));
    const router = new ForgeRouter({ firewall: fw });

    const ranked = router.rank(codingReq).map((r) => r.model.modelId);
    expect(ranked).toEqual(["small/with-tools:free"]);
    expect(router.route(codingReq)!.model.modelId).toBe("small/with-tools:free");
    expect(router.topVerifiedFree(codingReq, 5).map((r) => r.model.modelId)).toEqual(["small/with-tools:free"]);
  });

  it("returns no route at all when nothing eligible meets the requirements", () => {
    const fw = new ForgeZero({ context: ctx });
    fw.register(verifiedFree("openrouter", "no-tools:free", {
      capabilities: { text: true, coding: true, toolCalling: false, vision: false, structuredOutput: true, longContext: true },
    }));
    const router = new ForgeRouter({ firewall: fw });
    expect(router.route(codingReq)).toBeNull();
    // Requirements the record cannot state remain advisory: the model is still routable for them.
    expect(router.route({ ...codingReq, requiredCapabilities: ["coding", "reasoning"] })!.model.modelId).toBe("no-tools:free");
  });
});
