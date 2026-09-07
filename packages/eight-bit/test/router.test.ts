import { describe, expect, it } from "vitest";
import { ForgeZero } from "@codeforge/forge-zero";
import { EightBitHealthTracker } from "../src/health.js";
import { EightBitReliabilityTracker } from "../src/reliability.js";
import { EightBitRouter, type BindingScope, type SelectRouteOptions } from "../src/router.js";
import { makeModel, makePaidModel } from "./fixtures.js";

function setup() {
  const fw = new ForgeZero();
  const health = new EightBitHealthTracker(fw);
  const reliability = new EightBitReliabilityTracker();
  const router = new EightBitRouter(fw, health, reliability);
  return { fw, health, reliability, router };
}

const scope: BindingScope = { sessionId: "s1", role: "CODER" };
const baseOptions: Omit<SelectRouteOptions, "scope"> = { policyMode: "adaptive", hasAdapter: () => true };

describe("EightBitRouter — deterministic adaptive routing", () => {
  it("[PASS] role gets an eligible route", () => {
    const { fw, router } = setup();
    fw.register(makeModel());
    const result = router.selectRoute({ ...baseOptions, scope });
    expect(result.outcome).toBe("selected");
  });

  it("[PASS] a route with insufficient context is rejected even if otherwise best-ranked", () => {
    const { fw, router } = setup();
    fw.register(makeModel({ modelId: "tiny", contextWindow: 2_000 }));
    const result = router.selectRoute({ ...baseOptions, scope, estimatedContextTokens: 50_000 });
    expect(result.outcome).toBe("no_eligible_route");
  });

  it("[PASS] a provider with no registered adapter is skipped (orphan guard)", () => {
    const { fw, router } = setup();
    fw.register(makeModel());
    const result = router.selectRoute({ ...baseOptions, scope, hasAdapter: () => false });
    expect(result.outcome).toBe("no_eligible_route");
  });

  it("[PASS] a paid route never wins adaptive routing even with a much higher benchmark profile (hard gate beats ranking score)", () => {
    const { fw, router } = setup();
    fw.register(makeModel({ modelId: "ok-free" }));
    fw.register(makePaidModel({ benchmarkProfile: { coding: 100, toolCalling: 100, reasoning: 100, speed: 100, longContext: 100 } }));
    const result = router.selectRoute({ ...baseOptions, scope });
    expect(result.outcome).toBe("selected");
    if (result.outcome === "selected") expect(result.model.modelId).toBe("ok-free");
  });

  it("[PASS] sticky session retains its bound route across repeated selection when still eligible", () => {
    const { fw, router } = setup();
    fw.register(makeModel({ modelId: "route-a" }));
    fw.register(makeModel({ modelId: "route-b" }));
    const first = router.selectRoute({ ...baseOptions, scope });
    expect(first.outcome).toBe("selected");
    const second = router.selectRoute({ ...baseOptions, scope });
    expect(second.outcome).toBe("selected");
    if (first.outcome === "selected" && second.outcome === "selected") {
      expect(second.model.modelId).toBe(first.model.modelId);
      expect(second.sticky).toBe(true);
    }
  });

  it("[PASS] a tiny score delta does not cause route flapping", () => {
    const { fw, router } = setup();
    fw.register(makeModel({ modelId: "incumbent", benchmarkProfile: { coding: 80 } }));
    fw.register(makeModel({ modelId: "marginally-better", benchmarkProfile: { coding: 81 } }));
    router.selectRoute({ ...baseOptions, scope, requiredCapabilities: ["coding"] });
    const bound = router.currentBinding(scope);
    const second = router.selectRoute({ ...baseOptions, scope, requiredCapabilities: ["coding"] });
    expect(second.outcome).toBe("selected");
    if (second.outcome === "selected") expect(second.model.modelId).toBe(bound?.modelId);
  });

  it("[PASS] a meaningfully better route (beyond the promotion margin) is adopted", () => {
    const { fw, router } = setup();
    fw.register(makeModel({ modelId: "incumbent", benchmarkProfile: { coding: 10 } }));
    router.selectRoute({ ...baseOptions, scope, requiredCapabilities: ["coding"] });
    fw.register(makeModel({ modelId: "much-better", benchmarkProfile: { coding: 100 }, codingScore: 100 }));
    const second = router.selectRoute({ ...baseOptions, scope, requiredCapabilities: ["coding"] });
    expect(second.outcome).toBe("selected");
    if (second.outcome === "selected") expect(second.model.modelId).toBe("much-better");
  });

  it("[PASS] when the incumbent becomes unhealthy it is dropped even without a better alternative present", () => {
    const { fw, health, router } = setup();
    fw.register(makeModel({ providerId: "openrouter", modelId: "route-a" }));
    fw.register(makeModel({ providerId: "groq", modelId: "route-b" }));
    router.selectRoute({ ...baseOptions, scope });
    const bound = router.currentBinding(scope)!;
    health.recordFailure(bound.providerId, bound.modelId, "RATE_LIMITED");
    const second = router.selectRoute({ ...baseOptions, scope });
    expect(second.outcome).toBe("selected");
    if (second.outcome === "selected") expect(second.model.modelId).not.toBe(bound.modelId);
  });

  it("[PASS] selectReplacement excludes the failed route explicitly, even if health hasn't fully propagated", () => {
    const { fw, router } = setup();
    fw.register(makeModel({ modelId: "route-a" }));
    fw.register(makeModel({ modelId: "route-b" }));
    const result = router.selectReplacement({ ...baseOptions, scope }, { providerId: "openrouter", modelId: "route-a" });
    expect(result.outcome).toBe("selected");
    if (result.outcome === "selected") expect(result.model.modelId).toBe("route-b");
  });

  it("[PASS] no eligible route at all is reported explicitly, not silently substituted", () => {
    const { router } = setup();
    const result = router.selectRoute({ ...baseOptions, scope });
    expect(result.outcome).toBe("no_eligible_route");
    if (result.outcome === "no_eligible_route") expect(result.reasonCodes).toContain("NO_ELIGIBLE_FREE_MODEL");
  });

  it("[FG-4] applies advisory capability guidance through 8-Bit's own hard eligibility and ranking", () => {
    const { fw, router } = setup();
    fw.register(makeModel({ modelId: "guided-free" }));
    const result = router.selectRoute({
      ...baseOptions,
      scope,
      capabilityGuidance: { minimumRole: "REASONER", reasonCodes: ["CROSS_PACKAGE_DEPENDENCY"] },
    });
    expect(result.outcome).toBe("selected");
    if (result.outcome === "selected") {
      expect(result.model.modelId).toBe("guided-free");
      expect(result.reasons).toEqual(expect.arrayContaining(["FG4_CAPABILITY:REASONER", "CROSS_PACKAGE_DEPENDENCY"]));
    }
  });
});
