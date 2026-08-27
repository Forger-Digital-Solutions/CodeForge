import { describe, expect, it } from "vitest";
import { ForgeZero } from "../src/firewall.js";
import { MUSE_SPARK_1_2, createMuseSparkRecord, createGenericFreeRecord } from "../src/catalog.js";
import type { VerifyContext } from "../src/verifier.js";

const now = new Date("2026-08-23T12:00:00Z");
const testContext: VerifyContext = { now: () => now };

function freshMuseSpark(overrides: Record<string, unknown> = {}) {
  const base = createMuseSparkRecord();
  return {
    ...base,
    ...overrides,
    freeStatusVerifiedAt: now.toISOString(),
    costProfile: {
      ...base.costProfile,
      ...(overrides.costProfile as object ?? {}),
      freeTierVerifiedAt: now.toISOString(),
    },
    health: (overrides.health as { status: string } | undefined) ?? { status: "available", lastCheckedAt: now.toISOString() },
  } as typeof base;
}

describe("Muse Spark 1.2 — catalog & ForgeZero", () => {
  it("1. is discoverable when available (eligibleModels includes it)", () => {
    const fw = new ForgeZero({ context: testContext });
    fw.register(freshMuseSpark());
    const eligible = fw.eligibleModels();
    expect(eligible.some((m) => m.modelId === MUSE_SPARK_1_2.modelId)).toBe(true);
  });

  it("2. provider/model identity is correct (canonical opencode ID)", () => {
    expect(MUSE_SPARK_1_2.providerId).toBe("opencode");
    expect(MUSE_SPARK_1_2.modelId).toBe("muse-spark-1.2-contributor-free");
    expect(MUSE_SPARK_1_2.displayName).toBe("Muse Spark 1.2");
  });

  it("3. capability metadata is correct for coding/agentic/long-context", () => {
    const caps = MUSE_SPARK_1_2.capabilities;
    expect(caps.coding).toBe(true);
    expect(caps.toolCalling).toBe(true);
    expect(caps.longContext).toBe(true);
    expect(caps.text).toBe(true);
    expect(caps.structuredOutput).toBe(true);
    expect(MUSE_SPARK_1_2.contextWindow).toBeGreaterThanOrEqual(128000);
    expect(MUSE_SPARK_1_2.benchmarkProfile?.coding).toBeGreaterThanOrEqual(85);
    expect(MUSE_SPARK_1_2.benchmarkProfile?.toolCalling).toBeGreaterThanOrEqual(85);
    expect(MUSE_SPARK_1_2.benchmarkProfile?.reasoning).toBeGreaterThanOrEqual(80);
    expect(MUSE_SPARK_1_2.benchmarkProfile?.longContext).toBeGreaterThanOrEqual(85);
  });

  it("free-first: Muse Spark is verified_free with zero cost and remote cloud-hosted", () => {
    expect(MUSE_SPARK_1_2.freeStatus).toBe("verified_free");
    expect(MUSE_SPARK_1_2.costProfile.isFree).toBe(true);
    expect(MUSE_SPARK_1_2.costProfile.inputCostPerMillion).toBe(0);
    expect(MUSE_SPARK_1_2.costProfile.outputCostPerMillion).toBe(0);
    expect(MUSE_SPARK_1_2.costProfile.paidFallbackPossible).toBe(false);
    expect(MUSE_SPARK_1_2.costProfile.paidFallbackDisabled).toBe(true);
    expect(MUSE_SPARK_1_2.isRemote).toBe(true);
    expect(MUSE_SPARK_1_2.isCloudHosted).toBe(true);
    expect(MUSE_SPARK_1_2.tier).toBe("free");
  });

  it("7. free-first filtering behaves correctly (verified via verifier)", () => {
    const fw = new ForgeZero({ context: testContext });
    fw.register(freshMuseSpark());
    const result = fw.verify("opencode", "muse-spark-1.2-contributor-free");
    expect(result.ok).toBe(true);
  });

  it("free-first: paid fallback not disabled would be rejected", () => {
    const fw = new ForgeZero({ context: testContext });
    fw.register(
      freshMuseSpark({
        costProfile: {
          inputCostPerMillion: 0,
          outputCostPerMillion: 0,
          isFree: true,
          paidFallbackPossible: true,
          paidFallbackDisabled: false,
          source: "test",
          freeTierVerifiedAt: now.toISOString(),
        },
      } as unknown as Record<string, unknown>),
    );
    const result = fw.verify("opencode", "muse-spark-1.2-contributor-free");
    expect(result.ok).toBe(false);
  });

  it("8. unavailable Muse Spark is not selected (health offline)", () => {
    const fw = new ForgeZero({ context: testContext });
    fw.register(
      freshMuseSpark({
        health: { status: "offline", lastCheckedAt: now.toISOString() },
      } as unknown as Record<string, unknown>),
    );
    expect(fw.eligibleModels()).toHaveLength(0);
    expect(fw.canRouteTo("opencode", "muse-spark-1.2-contributor-free")).toBe(false);
  });

  it("8b. quota_exhausted Muse Spark is not eligible", () => {
    const fw = new ForgeZero({ context: testContext });
    fw.register(
      freshMuseSpark({
        health: { status: "quota_exhausted", lastCheckedAt: now.toISOString() },
      } as unknown as Record<string, unknown>),
    );
    expect(fw.eligibleModels()).toHaveLength(0);
  });

  it("8c. expired verification is not eligible", () => {
    const fw = new ForgeZero({ context: testContext });
    const old = new Date("2025-01-01T00:00:00Z").toISOString();
    const expired: typeof MUSE_SPARK_1_2 = {
      ...MUSE_SPARK_1_2,
      freeStatusVerifiedAt: old,
      costProfile: {
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
        isFree: true,
        paidFallbackPossible: false,
        paidFallbackDisabled: true,
        source: "test",
        freeTierVerifiedAt: old,
      },
      health: { status: "available", lastCheckedAt: now.toISOString() },
    };
    fw.register(expired);
    const result = fw.verify("opencode", "muse-spark-1.2-contributor-free");
    expect(result.ok).toBe(false);
  });

  it("local model is not eligible even with zero cost", () => {
    const fw = new ForgeZero({ context: testContext });
    fw.register(
      freshMuseSpark({
        isRemote: false,
        isCloudHosted: false,
      } as unknown as Record<string, unknown>),
    );
    expect(fw.canRouteTo("opencode", "muse-spark-1.2-contributor-free")).toBe(false);
  });
});

