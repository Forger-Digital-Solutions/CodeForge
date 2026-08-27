import { describe, it, expect } from "vitest";
import { ForgeZero } from "@codeforge/forge-zero";
import { createMuseSparkRecord, createGenericFreeRecord } from "@codeforge/forge-zero";
import { ForgeRouter } from "../src/index.js";
import type { VerifyContext } from "@codeforge/forge-zero";

const now = new Date("2026-08-23T12:00:00Z");
const ctx: VerifyContext = { now: () => now };

function freshMuse(overrides: Record<string, unknown> = {}) {
  const base = createMuseSparkRecord();
  return {
    ...base,
    ...overrides,
    freeStatusVerifiedAt: now.toISOString(),
    costProfile: { ...base.costProfile, ...(overrides.costProfile as object ?? {}), freeTierVerifiedAt: now.toISOString() },
    health: (overrides.health as { status: string } | undefined) ?? { status: "available", lastCheckedAt: now.toISOString() },
  } as typeof base;
}
function freshGeneric(overrides: Record<string, unknown> = {}) {
  const base = createGenericFreeRecord();
  return {
    ...base,
    ...overrides,
    freeStatusVerifiedAt: now.toISOString(),
    costProfile: { ...base.costProfile, ...(overrides.costProfile as object ?? {}), freeTierVerifiedAt: now.toISOString() },
    health: (overrides.health as { status: string } | undefined) ?? { status: "available", lastCheckedAt: now.toISOString() },
  } as typeof base;
}

describe("Full-Auto lifecycle audit", () => {
  it("NO_ELIGIBLE_FREE_MODEL: when eligible free models = [] and paid models exist, router refuses (NO_FREE_PROVIDER)", () => {
    const fw = new ForgeZero({ context: ctx });
    // only paid models (should be ineligible)
    const paid = freshMuse({
      providerId: "openrouter",
      modelId: "meta/muse-spark-1.2",
      freeStatus: "paid" as const,
      costProfile: {
        inputCostPerMillion: 1.25,
        outputCostPerMillion: 4.25,
        isFree: false,
        paidFallbackPossible: false,
        paidFallbackDisabled: true,
        source: "paid",
        freeTierVerifiedAt: now.toISOString(),
      },
    } as never);
    fw.register(paid);
    const router = new ForgeRouter({ firewall: fw });
    const decision = router.route({ taskType: "coding", estimatedContextTokens: 8000, requiredCapabilities: ["coding"] });
    expect(decision).toBeNull();
    const resolve = router.resolveSelection({ mode: "forgezero-adaptive" });
    expect(resolve.ok).toBe(false);
    if (!resolve.ok) expect(resolve.error.code).toBe("NO_FREE_PROVIDER");
  });

  it("multi-provider free routing: openCode + openRouter free + another, then opencode unavailable -> another wins", () => {
    const fw = new ForgeZero({ context: ctx });
    const muse = freshMuse();
    const openRouterFree = freshGeneric({
      providerId: "openrouter",
      modelId: "openrouter-free-model",
      displayName: "OpenRouter Free",
    } as never);
    const anotherFree = freshGeneric({
      providerId: "another",
      modelId: "another-free-model",
      displayName: "Another Free",
    } as never);
    fw.register(muse as never);
    fw.register(openRouterFree as never);
    fw.register(anotherFree as never);
    // paid must not be selected even though present
    const paid = freshMuse({
      providerId: "openrouter",
      modelId: "meta/muse-spark-1.2",
      freeStatus: "paid" as const,
      costProfile: {
        inputCostPerMillion: 1.25,
        outputCostPerMillion: 4.25,
        isFree: false,
        paidFallbackPossible: false,
        paidFallbackDisabled: true,
        source: "paid",
        freeTierVerifiedAt: now.toISOString(),
      },
    } as never);
    fw.register(paid);

    const router = new ForgeRouter({ firewall: fw });
    let decision = router.route({ taskType: "agentic-coding", estimatedContextTokens: 80000, requiredCapabilities: ["coding", "toolCalling", "longContext"] });
    expect(decision).not.toBeNull();
    expect(decision!.model.modelId).toBe("muse-spark-1.2-contributor-free");

    // simulate OpenCode unavailable
    const fw2 = new ForgeZero({ context: ctx });
    fw2.register({ ...muse, health: { status: "offline", lastCheckedAt: now.toISOString() } } as never);
    fw2.register(openRouterFree as never);
    fw2.register(anotherFree as never);
    fw2.register(paid);
    const router2 = new ForgeRouter({ firewall: fw2 });
    decision = router2.route({ taskType: "agentic-coding", estimatedContextTokens: 80000, requiredCapabilities: ["coding", "toolCalling", "longContext"] });
    expect(decision).not.toBeNull();
    expect(decision!.model.providerId).not.toBe("opencode");
    expect(["openrouter", "another", "codeforge"]).toContain(decision!.model.providerId);

    // all free unavailable -> refuses
    const fw3 = new ForgeZero({ context: ctx });
    fw3.register({ ...muse, health: { status: "offline", lastCheckedAt: now.toISOString() } } as never);
    fw3.register({ ...openRouterFree, health: { status: "offline", lastCheckedAt: now.toISOString() } } as never);
    fw3.register({ ...anotherFree, health: { status: "offline", lastCheckedAt: now.toISOString() } } as never);
    fw3.register(paid);
    const router3 = new ForgeRouter({ firewall: fw3 });
    expect(router3.route({ taskType: "coding", estimatedContextTokens: 8000, requiredCapabilities: ["coding"] })).toBeNull();
    expect(router3.resolveSelection({ mode: "forgezero-adaptive" }).ok).toBe(false);
  });

  it("task-type routing: simple task favors speed, coding favors coding, agentic favors Muse Spark, large context favors longContext", () => {
    const fw = new ForgeZero({ context: ctx });
    fw.register(freshMuse() as never);
    fw.register(freshGeneric() as never);
    const router = new ForgeRouter({ firewall: fw });

    const simple = router.route({ taskType: "simple", estimatedContextTokens: 1500, requiredCapabilities: ["text"] });
    expect(simple!.model.modelId).toBe("free-model-1"); // speed 85 vs 72

    const coding = router.route({ taskType: "coding", estimatedContextTokens: 8000, requiredCapabilities: ["coding"] });
    expect(coding!.model.modelId).toBe("muse-spark-1.2-contributor-free");

    const agentic = router.route({ taskType: "agentic-coding", estimatedContextTokens: 80000, requiredCapabilities: ["coding", "toolCalling", "longContext"] });
    expect(agentic!.model.modelId).toBe("muse-spark-1.2-contributor-free");
    expect(agentic!.reasons).toContain("high_coding_score");

    const large = router.route({ taskType: "repository-scale autonomous coding", estimatedContextTokens: 100000, requiredCapabilities: ["coding", "longContext"] });
    expect(large!.model.modelId).toBe("muse-spark-1.2-contributor-free");
  });

  it("router remains capability-driven: generic with superior benchmark can beat Muse Spark", () => {
    const fw = new ForgeZero({ context: ctx });
    fw.register(freshMuse() as never);
    fw.register(
      freshGeneric({
        benchmarkProfile: { coding: 95, toolCalling: 92, reasoning: 90, longContext: 92, speed: 60 },
        contextWindow: 262144,
      }) as never,
    );
    const router = new ForgeRouter({ firewall: fw });
    const decision = router.route({ taskType: "agentic-coding", estimatedContextTokens: 80000, requiredCapabilities: ["coding", "toolCalling", "longContext"] });
    expect(decision!.model.modelId).toBe("free-model-1");
  });

  it("provider isolation: openrouter/meta/muse-spark-1.2 paid not interchangeable with opencode/muse-spark-1.2-contributor-free", () => {
    const fw = new ForgeZero({ context: ctx });
    fw.register(freshMuse() as never);
    expect(fw.canRouteTo("opencode", "muse-spark-1.2-contributor-free")).toBe(true);
    expect(fw.canRouteTo("openrouter", "muse-spark-1.2-contributor-free")).toBe(false);
    expect(fw.canRouteTo("openrouter", "meta/muse-spark-1.2")).toBe(false);
    expect(fw.canRouteTo("opencode", "meta/muse-spark-1.2")).toBe(false);
  });

  it("exact-free does not bypass ForgeZero: expired/op offline rejected", () => {
    const fw = new ForgeZero({ context: ctx });
    const old = new Date("2025-01-01T00:00:00Z").toISOString();
    fw.register({
      ...createMuseSparkRecord(),
      freeStatusVerifiedAt: old,
      costProfile: { ...createMuseSparkRecord().costProfile, freeTierVerifiedAt: old },
      health: { status: "available", lastCheckedAt: now.toISOString() },
    } as never);
    const router = new ForgeRouter({ firewall: fw });
    const res = router.resolveSelection({ mode: "exact-free", providerId: "opencode", modelId: "muse-spark-1.2-contributor-free" });
    expect(res.ok).toBe(false);
  });

  it("muse_spark_selected reason does not control score", () => {
    const fw = new ForgeZero({ context: ctx });
    fw.register(freshMuse() as never);
    fw.register(freshGeneric() as never);
    const router = new ForgeRouter({ firewall: fw });
    const simple = router.route({ taskType: "simple", estimatedContextTokens: 1000, requiredCapabilities: ["text"] });
    const agentic = router.route({ taskType: "agentic-coding", estimatedContextTokens: 80000, requiredCapabilities: ["coding", "toolCalling", "longContext"] });
    expect(agentic!.reasons).toContain("muse_spark_selected");
    expect(agentic!.model.modelId).toBe("muse-spark-1.2-contributor-free");
    expect(simple!.model.modelId).toBe("free-model-1");
    expect(simple!.reasons).not.toContain("muse_spark_selected");
  });
});
