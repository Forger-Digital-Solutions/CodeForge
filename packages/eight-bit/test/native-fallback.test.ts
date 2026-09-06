import { describe, expect, it } from "vitest";
import { ForgeZero } from "@codeforge/forge-zero";
import { EightBitHealthTracker } from "../src/health.js";
import { EightBitReliabilityTracker } from "../src/reliability.js";
import { buildNativeFallbackModelIds } from "../src/native-fallback.js";
import { makeModel, makePaidModel, makeUnknownCostModel } from "./fixtures.js";

describe("buildNativeFallbackModelIds — provider-native fallback list", () => {
  it("[PASS] includes only the primary when it is the sole eligible route", () => {
    const fw = new ForgeZero();
    fw.register(makeModel({ modelId: "primary" }));
    const ids = buildNativeFallbackModelIds({
      providerId: "openrouter",
      primaryModelId: "primary",
      role: "CODER",
      policyMode: "adaptive",
      firewall: fw,
      health: new EightBitHealthTracker(fw),
      reliability: new EightBitReliabilityTracker(),
    });
    expect(ids).toEqual(["primary"]);
  });

  it("[PASS] appends other eligible same-provider free routes, primary first", () => {
    const fw = new ForgeZero();
    fw.register(makeModel({ modelId: "primary" }));
    fw.register(makeModel({ modelId: "secondary", codingScore: 90 }));
    fw.register(makeModel({ modelId: "tertiary", codingScore: 50 }));
    const ids = buildNativeFallbackModelIds({
      providerId: "openrouter",
      primaryModelId: "primary",
      role: "CODER",
      policyMode: "adaptive",
      firewall: fw,
      health: new EightBitHealthTracker(fw),
      reliability: new EightBitReliabilityTracker(),
    });
    expect(ids[0]).toBe("primary");
    expect(ids).toContain("secondary");
    expect(ids).toContain("tertiary");
    expect(ids.indexOf("secondary")).toBeLessThan(ids.indexOf("tertiary"));
  });

  it("[PASS] never includes a paid route in an adaptive fallback list", () => {
    const fw = new ForgeZero();
    fw.register(makeModel({ modelId: "primary" }));
    fw.register(makePaidModel({ providerId: "openrouter", modelId: "expensive" }));
    const ids = buildNativeFallbackModelIds({
      providerId: "openrouter",
      primaryModelId: "primary",
      role: "CODER",
      policyMode: "adaptive",
      firewall: fw,
      health: new EightBitHealthTracker(fw),
      reliability: new EightBitReliabilityTracker(),
    });
    expect(ids).not.toContain("expensive");
  });

  it("[PASS] never includes an unknown-cost route", () => {
    const fw = new ForgeZero();
    fw.register(makeModel({ modelId: "primary" }));
    fw.register(makeUnknownCostModel({ providerId: "openrouter", modelId: "mystery" }));
    const ids = buildNativeFallbackModelIds({
      providerId: "openrouter",
      primaryModelId: "primary",
      role: "CODER",
      policyMode: "adaptive",
      firewall: fw,
      health: new EightBitHealthTracker(fw),
      reliability: new EightBitReliabilityTracker(),
    });
    expect(ids).not.toContain("mystery");
  });

  it("[PASS] excludes routes currently in cooldown", () => {
    const fw = new ForgeZero();
    fw.register(makeModel({ modelId: "primary" }));
    fw.register(makeModel({ modelId: "cooling" }));
    const health = new EightBitHealthTracker(fw);
    health.recordFailure("openrouter", "cooling", "RATE_LIMITED");
    const ids = buildNativeFallbackModelIds({
      providerId: "openrouter",
      primaryModelId: "primary",
      role: "CODER",
      policyMode: "adaptive",
      firewall: fw,
      health,
      reliability: new EightBitReliabilityTracker(),
    });
    expect(ids).not.toContain("cooling");
  });

  it("[PASS] an exact pin never silently expands into an adaptive fallback list", () => {
    const fw = new ForgeZero();
    fw.register(makeModel({ modelId: "primary" }));
    fw.register(makeModel({ modelId: "other" }));
    const ids = buildNativeFallbackModelIds({
      providerId: "openrouter",
      primaryModelId: "primary",
      role: "CODER",
      policyMode: "byok",
      firewall: fw,
      health: new EightBitHealthTracker(fw),
      reliability: new EightBitReliabilityTracker(),
    });
    expect(ids).toEqual(["primary"]);
  });
});
