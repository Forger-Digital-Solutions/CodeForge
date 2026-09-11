import path from "node:path";
import { describe, expect, it } from "vitest";
import { runFallbackBenchmark, runRestartBenchmarks } from "../src/fg12e/restart-fallback-bench.js";
import { produceBaselineEvidence } from "../src/fg12e/pair-runner.js";
import { profileReusePathComponents } from "../src/fg12e/component-profile.js";
import { benchVerifiers, disposeBenchWorkspace, materializeBenchWorkspace, toVerifier } from "../src/fg12e/workloads.js";

const repoRoot = path.resolve(__dirname, "..", "..", "..");

describe("FG-12E restart, fallback, and component profile with an expensive verifier", () => {
  it("[restart] persisted tsc evidence survives a persistence restart and is genuinely reused; a post-persist mutation forces fresh tsc", async () => {
    const [valid, stale] = await runRestartBenchmarks(repoRoot, 2);
    expect(valid!.passed, valid!.failureReasons.join("; ")).toBe(true);
    expect(valid!.expensiveVerifierActuallySkipped).toBe(true);
    expect(valid!.loadedEvidenceCount).toBe(1);
    expect(valid!.durableEvidenceLoadMs).toBeGreaterThanOrEqual(0);
    expect(valid!.historicalElapsedMsFromPersistedEvidence[0]).toBeGreaterThan(200);
    const validScored = valid!.receipts.filter((r) => r.scored);
    expect(validScored.every((r) => r.treatment.freshAttempts === 0 && r.actualVerifierExecutionsAvoided === 1)).toBe(true);

    expect(stale!.passed, stale!.failureReasons.join("; ")).toBe(true);
    expect(stale!.expensiveVerifierActuallySkipped).toBe(true);
    const staleScored = stale!.receipts.filter((r) => r.scored);
    expect(staleScored.every((r) => r.treatment.freshAttempts === 1 && r.actualVerifierExecutionsAvoided === 0)).toBe(true);
  }, 90_000);

  it("[fallback] advisor failure during an expensive verification still runs fresh tsc and records the fallback reason", async () => {
    const result = await runFallbackBenchmark(repoRoot, 2);
    expect(result.passed, result.failureReasons.join("; ")).toBe(true);
    expect(result.freshVerificationAlwaysExecuted).toBe(true);
    expect(result.fallbackReasons.every((r) => r.includes("simulated ForgeGreen advisor failure"))).toBe(true);
    const scored = result.receipts.filter((r) => r.scored);
    expect(scored.every((r) => r.treatment.freshAttempts === 1 && r.treatment.overallStatus === "passed")).toBe(true);
  }, 60_000);

  it("[component profile] decomposes the reuse path without spawning any verifier and with non-overlapping totals", async () => {
    const v = benchVerifiers(repoRoot);
    const fixture = materializeBenchWorkspace();
    try {
      const baseline = await produceBaselineEvidence(fixture, [toVerifier(v.syntaxCheck!)]);
      const profile = await profileReusePathComponents(fixture, [toVerifier(v.syntaxCheck!)], baseline.evidence, 3);
      expect(profile.iterations).toBe(3);
      expect(profile.samples).toHaveLength(3);
      for (const sample of profile.samples) {
        const a = sample.advisory;
        expect(a.totalMs).toBeCloseTo(a.commandAvailabilityMs + a.adaptAndRegistryMs + a.preliminaryPlanMs + a.advisorTotalMs, 1);
        expect(sample.reusePathTotalMs).toBeCloseTo(a.totalMs + sample.authoritative.runVerificationReuseWallMs, 1);
        // The advisor's own logic is tiny; the input-state hash dominates the preliminary plan.
        expect(a.advisorTotalMs).toBeLessThan(a.preliminaryPlanMs);
        expect(sample.inputStateHashMs).toBeGreaterThan(0);
      }
      expect(profile.stats["reusePathTotalMs"]!.n).toBe(3);
    } finally {
      disposeBenchWorkspace(fixture);
    }
  }, 60_000);
});
