import { describe, expect, it } from "vitest";
import { ForgeZero } from "@codeforge/forge-zero";
import { createMuseSparkRecord, createGenericFreeRecord } from "@codeforge/forge-zero";
import { ForgeRouter } from "../src/index.js";
import type { VerifyContext } from "@codeforge/forge-zero";

const now = new Date("2026-08-23T12:00:00Z");
const testContext: VerifyContext = { now: () => now };

function fwWithBoth(): ForgeZero {
  const fw = new ForgeZero({ context: testContext });
  const generic = createGenericFreeRecord();
  const muse = createMuseSparkRecord();
  const freshGeneric = {
    ...generic,
    freeStatusVerifiedAt: now.toISOString(),
    costProfile: { ...generic.costProfile, freeTierVerifiedAt: now.toISOString() },
    health: { status: "available" as const, lastCheckedAt: now.toISOString() },
  };
  const freshMuse = {
    ...muse,
    freeStatusVerifiedAt: now.toISOString(),
    costProfile: { ...muse.costProfile, freeTierVerifiedAt: now.toISOString() },
    health: { status: "available" as const, lastCheckedAt: now.toISOString() },
  };
  fw.register(freshGeneric as never);
  fw.register(freshMuse as never);
  return fw;
}

describe("Muse Spark 1.2 — ForgeRouter integration", () => {
  it("4. ForgeRouter considers Muse Spark for coding tasks", () => {
    const fw = fwWithBoth();
    const router = new ForgeRouter({ firewall: fw });
    const decision = router.route({
      taskType: "coding",
      estimatedContextTokens: 8000,
      requiredCapabilities: ["coding", "toolCalling"],
    });
    expect(decision).not.toBeNull();
    const eligibleIds = fw.eligibleModels().map((m) => m.modelId);
    expect(eligibleIds).toContain("muse-spark-1.2-contributor-free");
    expect(eligibleIds).toContain("free-model-1");
    expect(decision!.alternatives.length).toBeGreaterThan(0);
    const allCandidates = [decision!.model.modelId, ...decision!.alternatives.map((m) => m.modelId)];
    expect(allCandidates).toContain("muse-spark-1.2-contributor-free");
  });

  it("5. receives strong score for long-horizon repository coding", () => {
    const fw = fwWithBoth();
    const router = new ForgeRouter({ firewall: fw });
    const decision = router.route({
      taskType: "agentic-coding",
      estimatedContextTokens: 80000,
      requiredCapabilities: ["coding", "toolCalling", "longContext"],
    });
    expect(decision).not.toBeNull();
    expect(decision!.model.modelId).toBe("muse-spark-1.2-contributor-free");
    expect(decision!.score).toBeGreaterThan(80);
    expect(decision!.reasons).toContain("high_coding_score");
    expect(decision!.reasons).toContain("long_context_optimized");
    expect(decision!.reasons).toContain("agentic_capable");
  });

  it("5b. repository-scale + autonomous execution favors Muse Spark", () => {
    const fw = fwWithBoth();
    const router = new ForgeRouter({ firewall: fw });
    const decision = router.route({
      taskType: "repository-scale autonomous coding",
      estimatedContextTokens: 100000,
      requiredCapabilities: ["coding", "toolCalling", "longContext"],
    });
    expect(decision!.model.modelId).toBe("muse-spark-1.2-contributor-free");
  });

  it("5c. multi-file changes with large context favors Muse Spark", () => {
    const fw = fwWithBoth();
    const router = new ForgeRouter({ firewall: fw });
    const decision = router.route({
      taskType: "multi-file architecture-aware implementation",
      estimatedContextTokens: 90000,
      requiredCapabilities: ["coding", "longContext"],
    });
    expect(decision!.model.modelId).toBe("muse-spark-1.2-contributor-free");
  });

  it("6. does not automatically win simple text tasks (speed favors generic)", () => {
    const fw = fwWithBoth();
    const router = new ForgeRouter({ firewall: fw });
    const decision = router.route({
      taskType: "simple",
      estimatedContextTokens: 1500,
      requiredCapabilities: ["text"],
    });
    expect(decision).not.toBeNull();
    expect(decision!.model.modelId).toBe("free-model-1");
  });

  it("6b. does not win when generic has higher speed for small context", () => {
    const fw = fwWithBoth();
    const router = new ForgeRouter({ firewall: fw });
    const simple = router.route({
      taskType: "text",
      estimatedContextTokens: 2000,
      requiredCapabilities: ["text"],
    });
    const codingLarge = router.route({
      taskType: "agentic-coding",
      estimatedContextTokens: 80000,
      requiredCapabilities: ["coding", "toolCalling"],
    });
    expect(simple!.model.modelId).not.toBe(codingLarge!.model.modelId);
    expect(simple!.model.modelId).toBe("free-model-1");
    expect(codingLarge!.model.modelId).toBe("muse-spark-1.2-contributor-free");
  });

  it("8. unavailable Muse Spark is not selected (only generic remains)", () => {
    const fw = new ForgeZero({ context: testContext });
    const generic = createGenericFreeRecord();
    const museOffline = createMuseSparkRecord({
      health: { status: "offline" as const, lastCheckedAt: now.toISOString() },
    });
    fw.register({
      ...generic,
      freeStatusVerifiedAt: now.toISOString(),
      costProfile: { ...generic.costProfile, freeTierVerifiedAt: now.toISOString() },
      health: { status: "available" as const, lastCheckedAt: now.toISOString() },
    } as never);
    fw.register({
      ...museOffline,
      freeStatusVerifiedAt: now.toISOString(),
      costProfile: { ...museOffline.costProfile, freeTierVerifiedAt: now.toISOString() },
    } as never);
    const router = new ForgeRouter({ firewall: fw });
    const decision = router.route({
      taskType: "agentic-coding",
      estimatedContextTokens: 80000,
      requiredCapabilities: ["coding", "toolCalling", "longContext"],
    });
    expect(decision!.model.modelId).toBe("free-model-1");
    expect(decision!.alternatives).not.toContainEqual(
      expect.objectContaining({ modelId: "muse-spark-1.2-contributor-free" }),
    );
  });

  it("9. existing providers/models continue to route correctly (eligible pool)", () => {
    const fw = fwWithBoth();
    const eligible = fw.eligibleModels();
    expect(eligible).toHaveLength(2);
    expect(eligible.some((m) => m.modelId === "free-model-1")).toBe(true);
    expect(eligible.some((m) => m.modelId === "muse-spark-1.2-contributor-free")).toBe(true);
    const router = new ForgeRouter({ firewall: fw });
    const viaResolve = router.resolveSelection({ mode: "forgezero-adaptive" });
    expect(viaResolve.ok).toBe(true);
  });

  it("9b. exact-free still verifies Muse Spark via firewall", () => {
    const fw = fwWithBoth();
    const router = new ForgeRouter({ firewall: fw });
    const result = router.resolveSelection({
      mode: "exact-free",
      providerId: "opencode",
      modelId: "muse-spark-1.2-contributor-free",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.resolvedModelId).toBe("muse-spark-1.2-contributor-free");
    }
  });

  it("reasons explain Muse Spark selection for agentic long-context", () => {
    const fw = fwWithBoth();
    const router = new ForgeRouter({ firewall: fw });
    const decision = router.route({
      taskType: "agentic repository coding",
      estimatedContextTokens: 70000,
      requiredCapabilities: ["coding", "toolCalling", "longContext"],
    });
    expect(decision!.model.modelId).toBe("muse-spark-1.2-contributor-free");
    expect(decision!.reasons.length).toBeGreaterThan(3);
    expect(decision!.reasons).toContain("coding_capable");
    // No model-id favoritism: the router explains selection by capability, not by name.
    expect(decision!.reasons).not.toContain("muse_spark_selected");
    expect(decision!.reasons.some((r) => r.startsWith("access_"))).toBe(true);
  });

  it("does not hard-code winner: when Muse Spark offline, generic wins even for agentic task", () => {
    const fw = new ForgeZero({ context: testContext });
    const generic = createGenericFreeRecord();
    fw.register({
      ...generic,
      freeStatusVerifiedAt: now.toISOString(),
      costProfile: { ...generic.costProfile, freeTierVerifiedAt: now.toISOString() },
      health: { status: "available" as const, lastCheckedAt: now.toISOString() },
    } as never);
    const router = new ForgeRouter({ firewall: fw });
    const decision = router.route({
      taskType: "agentic-coding",
      estimatedContextTokens: 80000,
      requiredCapabilities: ["coding"],
    });
    expect(decision!.model.modelId).toBe("free-model-1");
  });

  it("benchmarkProfile drives scoring, not modelId hard-code (generic with high coding can compete)", () => {
    const fw = new ForgeZero({ context: testContext });
    const muse = createMuseSparkRecord();
    const genericHigh = createGenericFreeRecord({
      benchmarkProfile: { coding: 95, toolCalling: 92, reasoning: 90, longContext: 92, speed: 60 },
      contextWindow: 262144,
    });
    fw.register({
      ...muse,
      freeStatusVerifiedAt: now.toISOString(),
      costProfile: { ...muse.costProfile, freeTierVerifiedAt: now.toISOString() },
      health: { status: "available" as const, lastCheckedAt: now.toISOString() },
    } as never);
    fw.register({
      ...genericHigh,
      freeStatusVerifiedAt: now.toISOString(),
      costProfile: { ...genericHigh.costProfile, freeTierVerifiedAt: now.toISOString() },
      health: { status: "available" as const, lastCheckedAt: now.toISOString() },
    } as never);
    const router = new ForgeRouter({ firewall: fw });
    const decision = router.route({
      taskType: "agentic-coding",
      estimatedContextTokens: 80000,
      requiredCapabilities: ["coding", "toolCalling", "longContext"],
    });
    expect(decision!.model.modelId).toBe("free-model-1");
  });
});

