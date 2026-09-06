import { describe, expect, it } from "vitest";
import { EightBitReliabilityTracker } from "../src/reliability.js";

describe("EightBitReliabilityTracker", () => {
  it("[PASS] a new/never-used model has no score yet (explicit unknown, not a failure)", () => {
    const tracker = new EightBitReliabilityTracker();
    const s = tracker.score("openrouter", "brand-new-model");
    expect(s.score).toBeUndefined();
    expect(s.sampleSize).toBe(0);
    expect(s.quarantined).toBe(false);
  });

  it("[PASS] a model with consistently valid tool calls scores high and is not demoted", () => {
    const tracker = new EightBitReliabilityTracker();
    for (let i = 0; i < 10; i++) tracker.record("p", "good-model", "valid");
    const s = tracker.score("p", "good-model");
    expect(s.score).toBe(1);
    expect(s.demoted).toBe(false);
  });

  it("[PASS] a model with mostly malformed calls is demoted once enough samples exist", () => {
    const tracker = new EightBitReliabilityTracker();
    for (let i = 0; i < 8; i++) tracker.record("p", "bad-model", "malformed");
    for (let i = 0; i < 2; i++) tracker.record("p", "bad-model", "valid");
    const s = tracker.score("p", "bad-model");
    expect(s.score).toBeCloseTo(0.2);
    expect(s.demoted).toBe(true);
  });

  it("[PASS] repeated consecutive malformed calls quarantine the route regardless of older good history", () => {
    const tracker = new EightBitReliabilityTracker();
    for (let i = 0; i < 20; i++) tracker.record("p", "flaky-model", "valid");
    for (let i = 0; i < 4; i++) tracker.record("p", "flaky-model", "malformed");
    const s = tracker.score("p", "flaky-model");
    expect(s.quarantined).toBe(true);
  });

  it("[PASS] a single valid call after a bad streak resets the quarantine streak counter (not the quarantine flag itself)", () => {
    const tracker = new EightBitReliabilityTracker();
    for (let i = 0; i < 3; i++) tracker.record("p", "recovering-model", "malformed");
    tracker.record("p", "recovering-model", "valid");
    for (let i = 0; i < 3; i++) tracker.record("p", "recovering-model", "malformed");
    // 3 bad, 1 good (streak reset), 3 bad again = never hit 4 consecutive -> not quarantined
    const s = tracker.score("p", "recovering-model");
    expect(s.quarantined).toBe(false);
  });

  it("[PASS] clearQuarantine explicitly lifts a quarantine (never lifted silently by time alone)", () => {
    const tracker = new EightBitReliabilityTracker();
    for (let i = 0; i < 4; i++) tracker.record("p", "m", "malformed");
    expect(tracker.score("p", "m").quarantined).toBe(true);
    tracker.clearQuarantine("p", "m");
    expect(tracker.score("p", "m").quarantined).toBe(false);
  });

  it("[PASS] tracks distinct outcome categories in the rolling sample", () => {
    const tracker = new EightBitReliabilityTracker();
    tracker.record("p", "m2", "valid");
    tracker.record("p", "m2", "unknown_tool");
    tracker.record("p", "m2", "missing_args");
    tracker.record("p", "m2", "schema_violation");
    tracker.record("p", "m2", "structured_output_failure");
    const sample = tracker.sample("p", "m2");
    expect(sample).toEqual({ attempts: 5, validCalls: 1, malformedCalls: 0, unknownToolCalls: 1, missingArgCalls: 1, schemaViolations: 1, structuredOutputFailures: 1 });
  });
});
