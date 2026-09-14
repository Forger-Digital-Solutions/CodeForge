import { describe, expect, it } from "vitest";
import type { FreeModelRecord } from "@codeforge/forge-zero";
import { roleDimensions, scoreForSeat } from "../src/role-scores.js";

function makeModel(overrides: Partial<FreeModelRecord> = {}): FreeModelRecord {
  return {
    providerId: "test-provider",
    modelId: "test-model",
    displayName: "Test Model",
    freeStatus: "verified_free",
    freeStatusVerifiedAt: new Date().toISOString(),
    tier: "free",
    accessClass: "FREE_NATIVE",
    authMode: "no_auth",
    privacyClass: "public",
    family: "test",
    upstreamSource: "test",
    deprecated: false,
    contextWindow: 32768,
    maxOutput: 4096,
    capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: false },
    costProfile: {
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      isFree: true,
      freeTierVerifiedAt: new Date().toISOString(),
      paidFallbackPossible: false,
      paidFallbackDisabled: true,
      source: "test",
    },
    benchmarkProfile: {
      coding: 75,
      reasoning: 70,
      speed: 80,
      toolCalling: 75,
    },
    ...overrides,
  };
}

describe("Forge Auto Role Scoring", () => {
  it("derives role dimensions from record facts and benchmarks", () => {
    const model = makeModel({
      contextWindow: 128000,
      codingScore: 85,
      toolReliability: 0.95,
      health: { status: "healthy", consecutiveSuccesses: 10, recentFailureCount: 0, lastCheckAt: new Date().toISOString() },
    });
    const dims = roleDimensions(model);
    expect(dims.swe).toBeGreaterThan(70);
    expect(dims.tool).toBe(95);
    expect(dims.reliability).toBe(100);
    expect(dims.availability).toBe(90);
  });

  it("differentiates planner vs swe specialists by role weighting", () => {
    // Model A: Reasoning & large context monster, average coding speed
    const plannerModel = makeModel({
      modelId: "deep-thinker",
      contextWindow: 200000,
      benchmarkProfile: { coding: 60, reasoning: 95, speed: 40, toolCalling: 60 },
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    });

    // Model B: Fast coding / tool specialist, smaller context
    const sweModel = makeModel({
      modelId: "fast-coder",
      contextWindow: 16000,
      codingScore: 92,
      benchmarkProfile: { coding: 90, reasoning: 65, speed: 95, toolCalling: 90 },
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: false },
    });

    const plannerForPlan = scoreForSeat(plannerModel, "PLANNER");
    const sweForPlan = scoreForSeat(sweModel, "PLANNER");
    expect(plannerForPlan.score).toBeGreaterThan(sweForPlan.score);

    const plannerForSwe = scoreForSeat(plannerModel, "SWE");
    const sweForSwe = scoreForSeat(sweModel, "SWE");
    expect(sweForSwe.score).toBeGreaterThan(plannerForSwe.score);
  });

  it("penalizes degraded and failing routes in scoring", () => {
    const healthy = makeModel({
      health: { status: "healthy", consecutiveSuccesses: 5, recentFailureCount: 0, lastCheckAt: new Date().toISOString() },
    });
    const degraded = makeModel({
      health: { status: "degraded", consecutiveSuccesses: 0, recentFailureCount: 3, lastCheckAt: new Date().toISOString() },
    });

    const scoreH = scoreForSeat(healthy, "SWE");
    const scoreD = scoreForSeat(degraded, "SWE");
    expect(scoreH.score).toBeGreaterThan(scoreD.score);
  });
});