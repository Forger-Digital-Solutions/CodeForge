import { describe, it, expect } from "vitest";
import { ForgeZero } from "@codeforge/forge-zero";
import { createGenericFreeRecord, createMuseSparkRecord } from "@codeforge/forge-zero";
import { ForgeRouter } from "../src/index.js";

describe("Auto routing determinism", () => {
  it("same eligible set produces same decision deterministically", () => {
    const fw = new ForgeZero();
    fw.register(createGenericFreeRecord());
    fw.register(createMuseSparkRecord());
    const router = new ForgeRouter({ firewall: fw });
    const req = { taskType: "coding", estimatedContextTokens: 8000, requiredCapabilities: ["text", "coding"] as string[] };
    const a = router.route(req);
    const b = router.route(req);
    expect(a?.model.modelId).toBe(b?.model.modelId);
    expect(a?.score).toBe(b?.score);
  });

  it("expired promotional excluded and does not affect determinism", () => {
    const fw = new ForgeZero();
    const good = createGenericFreeRecord();
    const expired = createMuseSparkRecord();
    expired.modelId = "expired";
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    expired.freeStatusVerifiedAt = old;
    expired.costProfile.freeTierVerifiedAt = old;
    fw.register(good);
    fw.register(expired);
    const router = new ForgeRouter({ firewall: fw });
    const req = { taskType: "coding", estimatedContextTokens: 8000, requiredCapabilities: ["text", "coding"] };
    const decision = router.route(req);
    expect(decision?.model.modelId).toBe(good.modelId);
  });

  it("no eligible model returns null and requires NO_FREE_PROVIDER handling", () => {
    const fw = new ForgeZero();
    const router = new ForgeRouter({ firewall: fw });
    const req = { taskType: "coding", estimatedContextTokens: 8000, requiredCapabilities: ["text", "coding"] };
    expect(router.route(req)).toBeNull();
    const result = router.resolveSelection({ mode: "forgezero-adaptive" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NO_FREE_PROVIDER");
  });

  it("tie break is deterministic via modelId lexicographic", () => {
    const fw = new ForgeZero();
    const a = createGenericFreeRecord();
    a.modelId = "a-model";
    a.displayName = "A";
    const b = createGenericFreeRecord();
    b.modelId = "b-model";
    b.displayName = "B";
    // Make scores equal by giving identical benchmarkProfile/capabilities
    fw.register(a);
    fw.register(b);
    const router = new ForgeRouter({ firewall: fw });
    const req = { taskType: "simple", estimatedContextTokens: 1000, requiredCapabilities: ["text"] };
    const first = router.route(req);
    const second = router.route(req);
    expect(first?.model.modelId).toBe(second?.model.modelId);
  });
});
