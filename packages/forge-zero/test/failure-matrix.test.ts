import { describe, it, expect } from "vitest";
import { ForgeZero } from "../src/firewall.js";
import { createMuseSparkRecord, createGenericFreeRecord } from "../src/catalog.js";
import type { VerifyContext } from "../src/verifier.js";

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

describe("Failure matrix — ForgeZero eligibility", () => {
  it("free model healthy may be selected (eligible)", () => {
    const fw = new ForgeZero({ context: ctx });
    fw.register(freshMuse());
    expect(fw.eligibleModels()).toHaveLength(1);
    expect(fw.canRouteTo("opencode", "muse-spark-1.2-contributor-free")).toBe(true);
  });

  it("free model offline excluded", () => {
    const fw = new ForgeZero({ context: ctx });
    fw.register(freshMuse({ health: { status: "offline", lastCheckedAt: now.toISOString() } } as never));
    expect(fw.eligibleModels()).toHaveLength(0);
    expect(fw.verify("opencode", "muse-spark-1.2-contributor-free").ok).toBe(false);
  });

  it("free model quota_exhausted excluded", () => {
    const fw = new ForgeZero({ context: ctx });
    fw.register(freshMuse({ health: { status: "quota_exhausted", lastCheckedAt: now.toISOString() } } as never));
    expect(fw.eligibleModels()).toHaveLength(0);
  });

  it("free model rate_limited excluded", () => {
    const fw = new ForgeZero({ context: ctx });
    fw.register(freshMuse({ health: { status: "rate_limited", lastCheckedAt: now.toISOString() } } as never));
    expect(fw.eligibleModels()).toHaveLength(0);
  });

  it("free model expired excluded (7-day window)", () => {
    const fw = new ForgeZero({ context: ctx });
    const old = new Date("2025-01-01T00:00:00Z").toISOString();
    fw.register({
      ...createMuseSparkRecord(),
      freeStatusVerifiedAt: old,
      costProfile: { ...createMuseSparkRecord().costProfile, freeTierVerifiedAt: old },
      health: { status: "available", lastCheckedAt: now.toISOString() },
    } as never);
    expect(fw.verify("opencode", "muse-spark-1.2-contributor-free").ok).toBe(false);
    expect(fw.eligibleModels()).toHaveLength(0);
  });

  it("free model missing credential proxy: health offline treated as unavailable (credential separation)", () => {
    const fw = new ForgeZero({ context: ctx });
    fw.register(freshMuse({ health: { status: "offline", lastCheckedAt: now.toISOString() } } as never));
    expect(fw.canRouteTo("opencode", "muse-spark-1.2-contributor-free")).toBe(false);
  });

  it("free model becomes paid excluded (cost non-zero)", () => {
    const fw = new ForgeZero({ context: ctx });
    fw.register(
      freshMuse({
        costProfile: {
          inputCostPerMillion: 1.25,
          outputCostPerMillion: 4.25,
          isFree: false,
          paidFallbackPossible: false,
          paidFallbackDisabled: true,
          source: "paid",
          freeTierVerifiedAt: now.toISOString(),
        },
      } as never),
    );
    expect(fw.eligibleModels()).toHaveLength(0);
    expect(fw.verify("opencode", "muse-spark-1.2-contributor-free").ok).toBe(false);
  });

  it("paid fallback enabled rejected", () => {
    const fw = new ForgeZero({ context: ctx });
    fw.register(
      freshMuse({
        costProfile: {
          inputCostPerMillion: 0,
          outputCostPerMillion: 0,
          isFree: true,
          paidFallbackPossible: true,
          paidFallbackDisabled: false,
          source: "test",
          freeTierVerifiedAt: now.toISOString(),
        },
      } as never),
    );
    expect(fw.eligibleModels()).toHaveLength(0);
  });

  it("only paid models remain -> no eligible free model", () => {
    const fw = new ForgeZero({ context: ctx });
    const paid = freshMuse({
      modelId: "paid-model",
      providerId: "openrouter",
      costProfile: {
        inputCostPerMillion: 5,
        outputCostPerMillion: 10,
        isFree: false,
        paidFallbackPossible: false,
        paidFallbackDisabled: true,
        source: "paid",
        freeTierVerifiedAt: now.toISOString(),
      },
      freeStatus: "paid" as const,
    } as never);
    fw.register(paid);
    expect(fw.eligibleModels()).toHaveLength(0);
    expect(fw.canRouteTo("openrouter", "paid-model")).toBe(false);
  });

  it("another free model available when one offline -> still eligible", () => {
    const fw = new ForgeZero({ context: ctx });
    fw.register(freshMuse({ health: { status: "offline", lastCheckedAt: now.toISOString() } } as never));
    fw.register(freshGeneric());
    expect(fw.eligibleModels()).toHaveLength(1);
    expect(fw.eligibleModels()[0]!.modelId).toBe("free-model-1");
  });

  it("freeStatus unknown excluded", () => {
    const fw = new ForgeZero({ context: ctx });
    fw.register(freshMuse({ freeStatus: "unknown" as const } as never));
    expect(fw.eligibleModels()).toHaveLength(0);
  });

  it("health unknown excluded", () => {
    const fw = new ForgeZero({ context: ctx });
    fw.register(freshMuse({ health: { status: "unknown", lastCheckedAt: now.toISOString() } } as never));
    expect(fw.eligibleModels()).toHaveLength(0);
  });

  it("local model not eligible even with zero cost", () => {
    const fw = new ForgeZero({ context: ctx });
    fw.register(freshMuse({ isRemote: false, isCloudHosted: false } as never));
    expect(fw.eligibleModels()).toHaveLength(0);
  });
});
