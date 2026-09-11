import { describe, expect, it } from "vitest";
import { runFallbackCase, runRaceCase, runRepeatedReuseCase, runRestartCases } from "../src/fg12d/special-cases.js";

describe("FG-12D restart proof (spec §16)", () => {
  it("valid restart reuse + workspace-changed restart refusal", async () => {
    const results = await runRestartCases();
    for (const result of results) {
      expect(result.failureReasons).toEqual([]);
      expect(result.passed).toBe(true);
    }
    expect(results.map((r) => r.id).sort()).toEqual(["restart-stale-refused", "restart-valid"]);
  }, 30_000);
});

describe("FG-12D race/TOCTOU proof (spec §17)", () => {
  it("the authoritative execution boundary revalidates and refuses a stale advisor proposal", async () => {
    const result = await runRaceCase();
    expect(result.failureReasons).toEqual([]);
    expect(result.passed).toBe(true);
  }, 20_000);
});

describe("FG-12D fallback proof (spec §19)", () => {
  it("a thrown advisor never blocks fresh verification", async () => {
    const result = await runFallbackCase();
    expect(result.failureReasons).toEqual([]);
    expect(result.passed).toBe(true);
  }, 20_000);
});

describe("FG-12D repeated-reuse / duplicate-accounting safety (amendment §1)", () => {
  it("two sequential calls each independently recheck validity with no double-counting", async () => {
    const result = await runRepeatedReuseCase();
    expect(result.failureReasons).toEqual([]);
    expect(result.passed).toBe(true);
  }, 20_000);
});
