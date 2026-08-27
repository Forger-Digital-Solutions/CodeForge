import { describe, it, expect } from "vitest";
import { ForgeZero } from "../src/firewall.js";
import {
  FREE_CATALOG,
  PAID_CATALOG,
  ALL_CATALOG,
  MUSE_SPARK_1_2,
  MUSE_SPARK_PAID,
  MUSE_SPARK_CONTRIBUTOR_PAID,
  PROVIDER_META,
  createMuseSparkPaidRecord,
} from "../src/catalog.js";
import { ForgeRouter } from "@codeforge/router";

describe("Paid catalog packaging", () => {
  it("PAID_CATALOG contains verified OpenRouter Muse Spark paid models", () => {
    expect(PAID_CATALOG).toHaveLength(2);
    const paid = PAID_CATALOG.find((m) => m.modelId === "meta/muse-spark-1.2");
    expect(paid).toBeDefined();
    expect(paid!.providerId).toBe("openrouter");
    expect(paid!.costProfile.isFree).toBe(false);
    expect(paid!.tier).toBe("paid");
    expect(paid!.freeStatus).toBe("paid");
    expect(paid!.costProfile.inputCostPerMillion).toBe(1.25);
    expect(paid!.costProfile.outputCostPerMillion).toBe(4.25);
    expect(paid!.contextWindow).toBe(1048576);

    const contrib = PAID_CATALOG.find((m) => m.modelId === "meta/muse-spark-1.2-contributor");
    expect(contrib!.providerId).toBe("openrouter");
    expect(contrib!.costProfile.inputCostPerMillion).toBe(0.1);
    expect(contrib!.costProfile.outputCostPerMillion).toBe(0.2);
  });

  it("FREE_CATALOG does not contain paid models", () => {
    expect(FREE_CATALOG.every((m) => m.tier === "free")).toBe(true);
    expect(FREE_CATALOG.find((m) => m.modelId === "meta/muse-spark-1.2")).toBeUndefined();
    const freeSpark = FREE_CATALOG.find((m) => m.modelId === "muse-spark-1.2-contributor-free");
    expect(freeSpark!.providerId).toBe("opencode");
    expect(freeSpark!.costProfile.isFree).toBe(true);
  });

  it("ALL_CATALOG combines free and paid distinct identities", () => {
    expect(ALL_CATALOG.length).toBe(FREE_CATALOG.length + PAID_CATALOG.length);
    const keys = ALL_CATALOG.map((m) => `${m.providerId}::${m.modelId}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("opencode::muse-spark-1.2-contributor-free");
    expect(keys).toContain("openrouter::meta/muse-spark-1.2");
  });

  it("ForgeZero excludes paid from eligibleModels", () => {
    const fw = new ForgeZero();
    for (const m of ALL_CATALOG) fw.register(m);
    const eligibleIds = fw.eligibleModels().map((m) => `${m.providerId}::${m.modelId}`);
    expect(eligibleIds).not.toContain("openrouter::meta/muse-spark-1.2");
    expect(eligibleIds).not.toContain("openrouter::meta/muse-spark-1.2-contributor");
    expect(eligibleIds).toContain("opencode::muse-spark-1.2-contributor-free");
  });

  it("Full-Auto never picks paid when free-only", () => {
    const fw = new ForgeZero();
    for (const m of ALL_CATALOG) fw.register(m);
    const router = new ForgeRouter({ firewall: fw });
    const decision = router.route({ taskType: "coding", estimatedContextTokens: 8000, requiredCapabilities: ["coding"] });
    expect(decision).not.toBeNull();
    expect(decision!.model.tier).toBe("free");
    expect(decision!.model.costProfile.isFree).toBe(true);
  });

  it("all free unavailable -> NO_FREE_PROVIDER even though paid exist", () => {
    const fw = new ForgeZero();
    for (const m of ALL_CATALOG) fw.register(m);
    // make free offline
    fw.unregister("opencode", "muse-spark-1.2-contributor-free");
    fw.unregister("codeforge", "free-model-1");
    const now = new Date().toISOString();
    const offlineFree = { ...MUSE_SPARK_1_2, health: { status: "offline" as const, lastCheckedAt: now } };
    fw.register(offlineFree as never);
    const offlineGeneric = { ...FREE_CATALOG[0]!, health: { status: "offline" as const, lastCheckedAt: now } };
    fw.register(offlineGeneric as never);
    // paid still registered
    const router = new ForgeRouter({ firewall: fw });
    expect(router.route({ taskType: "coding", estimatedContextTokens: 8000, requiredCapabilities: ["coding"] })).toBeNull();
    expect(router.resolveSelection({ mode: "forgezero-adaptive" }).ok).toBe(false);
  });

  it("paid record cannot become free via verification", () => {
    const paid = createMuseSparkPaidRecord();
    const fw = new ForgeZero();
    fw.register(paid);
    expect(fw.canRouteTo("openrouter", "meta/muse-spark-1.2")).toBe(false);
    expect(fw.verify("openrouter", "meta/muse-spark-1.2").ok).toBe(false);
  });

  it("provider isolation: free and paid distinct canonical keys", () => {
    expect("opencode::muse-spark-1.2-contributor-free").not.toBe("openrouter::meta/muse-spark-1.2");
    expect("opencode::muse-spark-1.2-contributor-free").not.toBe("openrouter::meta/muse-spark-1.2-contributor");
  });

  it("PROVIDER_META ships display info for easy setup", () => {
    expect(PROVIDER_META.opencode.displayName).toBe("OpenCode Zen");
    expect(PROVIDER_META.opencode.endpoint).toBe("https://opencode.ai/zen/v1");
    expect(PROVIDER_META.opencode.authEnv).toBe("OPENCODE_API_KEY");
    expect(PROVIDER_META.openrouter.authEnv).toBe("OPENROUTER_API_KEY");
    expect(PROVIDER_META.codeforge.authEnv).toBeNull();
  });
});
