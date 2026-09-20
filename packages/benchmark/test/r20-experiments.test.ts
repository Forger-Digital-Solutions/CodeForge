import { describe, expect, it } from "vitest";
import { R20MatchedExperimentHarness, type R20ExecutionMetrics } from "../src/r20-experiments.js";

const metrics = (overrides: Partial<R20ExecutionMetrics> = {}): R20ExecutionMetrics => ({
  status: "completed",
  correct: true,
  wallTimeMs: 1_000,
  tokens: 10_000,
  modelCalls: 10,
  providerRequests: 10,
  toolCalls: 20,
  duplicateReads: 4,
  duplicateSearches: 2,
  commands: 2,
  filesTouched: 2,
  conflicts: 0,
  reviewDefectsFound: 0,
  verificationPassed: true,
  ...overrides,
});

const task = { taskId: "task", taskType: "bug_fix" as const, repositoryDigest: "digest", modelId: "model", topology: "T0" as const };

describe("R20MatchedExperimentHarness", () => {
  it("compares ForgeGreen OFF and ON while holding topology constant", async () => {
    const harness = new R20MatchedExperimentHarness();
    const result = await harness.run(task, [
      { id: "off", forgeGreen: false, topology: "T3", execute: async () => metrics() },
      { id: "on", forgeGreen: true, topology: "T3", execute: async () => metrics({ wallTimeMs: 800, tokens: 8_000, modelCalls: 8, toolCalls: 15, duplicateReads: 1, duplicateSearches: 0 }) },
    ]);
    const comparison = harness.compareForgeGreen(result, "off", "on");
    expect(comparison.correctnessDelta).toBe(0);
    expect(comparison.tokenReductionPercent).toBe(20);
    expect(comparison.modelCallReductionPercent).toBe(20);
    expect(comparison.duplicateReadReductionPercent).toBe(75);
    expect(comparison.promotable).toBe(true);
  });

  it("refuses ForgeGreen promotion when correctness regresses", async () => {
    const harness = new R20MatchedExperimentHarness();
    const result = await harness.run(task, [
      { id: "off", forgeGreen: false, topology: "T0", execute: async () => metrics() },
      { id: "on", forgeGreen: true, topology: "T0", execute: async () => metrics({ correct: false, tokens: 1_000 }) },
    ]);
    expect(harness.compareForgeGreen(result, "off", "on").promotable).toBe(false);
  });

  it("rejects an invalid OFF/ON comparison across different topologies", async () => {
    const harness = new R20MatchedExperimentHarness();
    const result = await harness.run(task, [
      { id: "off", forgeGreen: false, topology: "T0", execute: async () => metrics() },
      { id: "on", forgeGreen: true, topology: "T3", execute: async () => metrics() },
    ]);
    expect(() => harness.compareForgeGreen(result, "off", "on")).toThrow(/identical topology/);
  });

  it("preserves the inherited losing team baseline instead of forcing a positive score", async () => {
    const harness = new R20MatchedExperimentHarness();
    const result = await harness.run(task, [
      { id: "single", forgeGreen: false, topology: "T0", execute: async () => metrics({ wallTimeMs: 96_000, tokens: 30_000, providerRequests: 10 }) },
      { id: "team", forgeGreen: false, topology: "T4", execute: async () => metrics({ wallTimeMs: 151_000, tokens: 121_594, providerRequests: 41 }) },
    ]);
    const [team] = harness.compareTopologies(result, "single");
    expect(team?.tokenMultiplier).toBeCloseTo(4.0531, 3);
    expect(team?.requestMultiplier).toBe(4.1);
    expect(team?.wallTimeDeltaPercent).toBeCloseTo(57.291, 2);
    expect(team?.benefitScore).toBeLessThan(0);
  });

  it("credits reviewer topology only when it finds additional defects", async () => {
    const harness = new R20MatchedExperimentHarness();
    const result = await harness.run(task, [
      { id: "single", forgeGreen: false, topology: "T0", execute: async () => metrics({ correct: false }) },
      { id: "reviewed", forgeGreen: false, topology: "T2", execute: async () => metrics({ reviewDefectsFound: 2, tokens: 15_000, providerRequests: 15 }) },
    ]);
    const [reviewed] = harness.compareTopologies(result, "single");
    expect(reviewed?.defectDetectionDelta).toBe(2);
    expect(reviewed?.benefitScore).toBeGreaterThan(0);
  });
});
