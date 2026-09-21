import { describe, expect, it } from "vitest";
import { bootstrapPairs, comparePairs, describe as describeStats, headline, armTotals, pairRecords, seededRandom, wilcoxonSignedRank } from "../src/r23/report.js";
import type { RunRecord } from "../src/r23/run-record.js";

/**
 * R23 M4 — golden tests for the analysis layer (protocol §8.3). The statistics must be exact on
 * known inputs, the bootstrap must be reproducible from its recorded seed, incomplete pairs must be
 * reported rather than dropped, and UNKNOWN token totals must never enter token metrics.
 */

function record(overrides: { taskId: string; arm: "control" | "optimized"; repetition?: number; pairId?: string; tokens?: number; verified?: boolean; claimed?: boolean; calls?: number; wallMs?: number; taskClass?: string; cost?: number }): RunRecord {
  const tokens = overrides.tokens;
  const verified = overrides.verified ?? true;
  const claimed = overrides.claimed ?? verified;
  return {
    schemaVersion: "r23-run-record-1",
    identity: { benchmarkVersion: "CodeForge-EfficiencyBench-R23", protocolId: "codeforge-efficiency-protocol-r23", protocolVersion: "1.0.2", protocolDigest: "0".repeat(64), harnessVersion: "t", campaignId: "c", phase: "fixture", runId: `${overrides.taskId}-${overrides.arm}-${overrides.repetition ?? 1}`, pairId: overrides.pairId ?? `${overrides.taskId}-p${overrides.repetition ?? 1}`, taskId: overrides.taskId, taskClass: overrides.taskClass ?? "small_fix", taskLanguage: "js", repoSizeClass: "small", arm: overrides.arm, armConfigurationDigest: "d", pairOrder: "control-first", repetition: overrides.repetition ?? 1, codeforgeCommit: "abc", codeforgeTreeDirty: false, startingTreeHash: "s", endingTreeHash: "e", taskDigest: "td", modelId: "m", providerId: "p", routeClass: "free", forgeGreenEnabled: overrides.arm === "optimized", subagentsEnabled: overrides.arm === "optimized", topology: "orchestrated:tiny", environmentFingerprint: "f", startedAt: "2026-09-21T00:00:00.000Z", endedAt: "2026-09-21T00:00:05.000Z" },
    outcome: { runtimeStatus: claimed ? "completed" : "blocked", stopReason: "x", claimedComplete: claimed, verifierRan: true, verifierPassed: verified, completionAuthority: verified ? "PASS" : "FAIL", completionBlockers: [], forbiddenActionObserved: false, verifiedComplete: verified, falseComplete: claimed && !verified, classification: verified ? "verified_complete" : claimed ? "false_complete" : "verification_failed", completionReason: "", filesChanged: [], linesAdded: 0, linesRemoved: 0 },
    inference: {
      totalInputTokens: tokens === undefined ? { source: "UNKNOWN" } : { value: Math.round(tokens * 0.9), source: "OBSERVED", origin: "PROVIDER" },
      totalOutputTokens: tokens === undefined ? { source: "UNKNOWN" } : { value: tokens - Math.round(tokens * 0.9), source: "OBSERVED", origin: "PROVIDER" },
      totalTokens: tokens === undefined ? { source: "UNKNOWN" } : { value: tokens, source: "DERIVED", origin: "PROVIDER" },
      cachedInputTokens: { source: "UNKNOWN" }, uncachedInputTokens: { source: "UNKNOWN" }, reasoningTokens: { source: "UNKNOWN" },
      modelCalls: overrides.calls ?? 5, callsWithProviderUsage: tokens === undefined ? 0 : overrides.calls ?? 5, failedModelCalls: 0, retriedModelCalls: 0, rateLimitedCalls: 0, providerFailovers: 0, modelFailovers: 0, duplicateRequestsSuppressed: 0, calls: [],
    },
    context: { transmittedContextBytes: 1000, finalConversationBytes: 400, providerStatelessnessRepeatBytes: 600, avoidableDuplicateBytes: 0, avoidableDuplicateTokens: { source: "UNKNOWN" }, avoidableDuplicateEvents: [], finalComposition: { systemBytes: 0, userTaskBytes: 0, assistantBytes: 0, toolResultBytes: 0, toolResultBytesByTool: {}, otherBytes: 0 }, bootstrapContextBytes: 0, bootstrapSelectedFiles: 0, bootstrapCandidateFiles: 0, canonicalCacheHits: 0, canonicalCacheMisses: 0, toolOutputBytesAvoidedByCompression: 0, providerCacheHitCalls: 0 },
    activity: { role: "coder", toolCallsRequested: 3, toolCallsExecuted: 3, toolCallsFailed: 0, duplicateActionsSuppressed: 0, byTool: {}, fileReads: 1, fileWrites: 1, searches: 0, listings: 0, shellCalls: 0, browserCalls: 0, mcpCalls: 0, pluginCalls: 0, subagentCount: 0, subagentModelCalls: 0 },
    time: { wallClockMs: overrides.wallMs ?? 10_000, activeAgentMs: 8000, modelWaitMs: 5000, toolMs: { source: "UNKNOWN" }, verificationMs: 500, rateLimitWaitMs: 0, forgeGreenOverheadMs: { source: "UNKNOWN" } },
    economics: { pricingSnapshotId: "s", actualCostUsd: { value: 0, source: "OBSERVED", origin: "PROVIDER" }, equivalentPublicApiCostUsd: overrides.cost === undefined ? { source: "UNKNOWN" } : { value: overrides.cost, source: "DERIVED", origin: "SNAPSHOT" }, equivalentPublicApiPriceRef: "ref", equivalentMarketCostUsd: { source: "UNKNOWN" }, equivalentMarketPriceRef: "ref" },
    resources: { cpuUserMs: { source: "UNKNOWN" }, cpuSystemMs: { source: "UNKNOWN" }, peakRssBytes: { source: "UNKNOWN" }, providerResponseBytes: { source: "UNKNOWN" }, providerRequestBytes: { source: "UNKNOWN" }, gpuPowerDrawWattsIdleSample: { source: "UNKNOWN" }, sampler: "none" },
    telemetry: { efficiencyReasonCodes: [] },
    notes: [],
  };
}

describe("R23 report — pairing and totals", () => {
  it("pairs control/optimized runs by task, repetition and pair id, and reports incomplete pairs instead of dropping them", () => {
    const records = [record({ taskId: "a", arm: "control", tokens: 100 }), record({ taskId: "a", arm: "optimized", tokens: 80 }), record({ taskId: "b", arm: "control", tokens: 200 })];
    const { pairs, unpaired } = pairRecords(records);
    expect(pairs.map((p) => p.taskId)).toEqual(["a"]);
    expect(unpaired.map((r) => r.identity.runId)).toEqual(["b-control-1"]);
  });

  it("keeps UNKNOWN token totals out of token metrics and says how many runs were known", () => {
    const totals = armTotals([record({ taskId: "a", arm: "control", tokens: 1000 }), record({ taskId: "b", arm: "control", tokens: undefined })]);
    expect(totals.runs).toBe(2);
    expect(totals.runsWithKnownTokens).toBe(1);
    expect(totals.totalTokens).toBe(1000);
    const h = headline(totals);
    // Not every run has known tokens → token-based headline metrics are undefined, not fabricated.
    expect(h.verifiedTasksPer1MTokens).toBeUndefined();
    expect(h.tokensPerVerifiedTask).toBeUndefined();
    expect(h.verifiedSuccessRate).toBe(1);
  });

  it("computes headline metrics exactly on a known arm", () => {
    const totals = armTotals([record({ taskId: "a", arm: "optimized", tokens: 250_000, cost: 0.10 }), record({ taskId: "b", arm: "optimized", tokens: 250_000, verified: false, claimed: true, cost: 0.10 })]);
    const h = headline(totals);
    expect(h.verifiedTasksPer1MTokens).toBe(1 / 0.5);
    expect(h.tokensPerVerifiedTask).toBe(500_000);
    expect(h.verifiedSuccessRate).toBe(0.5);
    expect(h.falseCompletionRate).toBe(0.5);
    expect(h.verifiedTasksPer100Calls).toBe(1 / 0.1);
    expect(h.verifiedTasksPerDollarEquivalent).toBe(5);
    expect(h.equivalentCostPerVerifiedTask).toBeCloseTo(0.2, 12);
  });
});

describe("R23 report — statistics", () => {
  it("descriptive statistics are exact", () => {
    const stats = describeStats([1, 2, 3, 4, 10])!;
    expect(stats.n).toBe(5);
    expect(stats.mean).toBe(4);
    expect(stats.median).toBe(3);
    expect(stats.p25).toBe(2);
    expect(stats.p75).toBe(4);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(10);
    expect(stats.stdDev).toBeCloseTo(Math.sqrt(12.5), 12);
    expect(describeStats([])).toBeUndefined();
  });

  it("the bootstrap is reproducible from its seed and brackets the estimate", () => {
    const pairs = Array.from({ length: 12 }, (_, i) => ({ d: i % 2 === 0 ? -100 - i : -50 - i }));
    const a = bootstrapPairs(pairs, (s) => s.reduce((sum, p) => sum + p.d, 0) / s.length, { resamples: 2000, seed: 7 })!;
    const b = bootstrapPairs(pairs, (s) => s.reduce((sum, p) => sum + p.d, 0) / s.length, { resamples: 2000, seed: 7 })!;
    expect(a).toEqual(b);
    expect(a.lower).toBeLessThanOrEqual(a.estimate);
    expect(a.upper).toBeGreaterThanOrEqual(a.estimate);
    expect(a.upper).toBeLessThan(0);
    const other = bootstrapPairs(pairs, (s) => s.reduce((sum, p) => sum + p.d, 0) / s.length, { resamples: 2000, seed: 8 })!;
    expect(other.lower === a.lower && other.upper === a.upper).toBe(false);
    expect(bootstrapPairs([], () => 1)).toBeUndefined();
    const r1 = seededRandom(1);
    const r2 = seededRandom(1);
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
  });

  it("Wilcoxon signed-rank handles ties and small n honestly", () => {
    const small = wilcoxonSignedRank([-3, -2, -1, 0, 4]);
    expect(small.n).toBe(4);
    expect(small.pTwoSided).toBeUndefined();
    const larger = wilcoxonSignedRank([-10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 1, 2]);
    expect(larger.n).toBe(12);
    expect(larger.pTwoSided).toBeDefined();
    expect(larger.pTwoSided!).toBeLessThan(0.05);
    expect(larger.wMinus).toBeGreaterThan(larger.wPlus);
  });
});

describe("R23 report — paired comparison and §9 verdict inputs", () => {
  it("produces paired differences, intervals and verdict inputs for a clean saving", () => {
    const records: RunRecord[] = [];
    for (let i = 0; i < 12; i += 1) {
      records.push(record({ taskId: `t${i}`, arm: "control", tokens: 10_000 + 100 * i, taskClass: i % 3 === 0 ? "feature" : "small_fix" }));
      records.push(record({ taskId: `t${i}`, arm: "optimized", tokens: 7_000 + 100 * i, taskClass: i % 3 === 0 ? "feature" : "small_fix" }));
    }
    const { pairs } = pairRecords(records);
    const comparison = comparePairs(pairs, { resamples: 1000, seed: 3 });
    expect(comparison.pairs).toBe(12);
    expect(comparison.differences.totalTokens?.mean).toBe(-3000);
    expect(comparison.differences.verified).toEqual({ both: 12, onlyControl: 0, onlyOptimized: 0, neither: 0 });
    expect(comparison.intervals.meanTokenDifference?.upper).toBeLessThan(0);
    expect(comparison.intervals.tokenRatioOfTotals?.estimate).toBeCloseTo((12 * 7000 + 100 * 66) / (12 * 10_000 + 100 * 66), 9);
    expect(comparison.verdictInputs.nonInferiority.passes).toBe(true);
    expect(comparison.verdictInputs.falseCompletionGuard.passes).toBe(true);
    expect(comparison.verdictInputs.tokenSaving.direction).toBe("optimized_fewer");
    expect(comparison.verdictInputs.tokenSaving.intervalExcludesZero).toBe(true);
    expect(Object.keys(comparison.byClass).sort()).toEqual(["feature", "small_fix"]);
    expect(comparison.byClass.feature!.pairs).toBe(4);
  });

  it("fails non-inferiority when the optimized arm loses verified tasks, regardless of token savings", () => {
    const records: RunRecord[] = [];
    for (let i = 0; i < 10; i += 1) {
      records.push(record({ taskId: `t${i}`, arm: "control", tokens: 10_000, verified: true }));
      records.push(record({ taskId: `t${i}`, arm: "optimized", tokens: 5_000, verified: i >= 3, claimed: true }));
    }
    const comparison = comparePairs(pairRecords(records).pairs, { resamples: 500, seed: 1 });
    expect(comparison.verdictInputs.nonInferiority.rateDifference).toBeCloseTo(-0.3, 9);
    expect(comparison.verdictInputs.nonInferiority.passes).toBe(false);
    expect(comparison.verdictInputs.falseCompletionGuard.passes).toBe(false);
    expect(comparison.differences.verified.onlyControl).toBe(3);
  });
});
