import { describe, expect, it } from "vitest";
import type { ForgeVerifyObserver, VerificationPlan } from "@codeforge/workflow";
import { analyzeOutliers, createTimelineObserver, OUTLIER_RULE, round, summarize, timed, timedSync } from "../src/fg12e/timing.js";
import { buildBenchProjectFiles, DEFAULT_BENCH_SHAPE } from "../src/fg12e/workloads.js";

describe("FG-12E timing & statistics", () => {
  it("summarize reports n/median/mean/min/max/p25/p75 — never a single average", () => {
    const s = summarize([10, 20, 30, 40, 100]);
    expect(s.n).toBe(5);
    expect(s.median).toBe(30);
    expect(s.mean).toBe(40);
    expect(s.min).toBe(10);
    expect(s.max).toBe(100);
    expect(s.p25).toBe(20);
    expect(s.p75).toBe(40);
    expect(s.stdev).toBeGreaterThan(0);
    expect(s.cv).not.toBeNull();
  });

  it("summarize of an empty series is NaN-valued with n=0 (never throws, never fabricates)", () => {
    const s = summarize([]);
    expect(s.n).toBe(0);
    expect(Number.isNaN(s.median)).toBe(true);
    expect(s.cv).toBeNull();
  });

  it("outlier rule flags but never deletes; reports with and without", () => {
    const values = [100, 102, 98, 101, 99, 100, 103, 900];
    const analysis = analyzeOutliers(values);
    expect(analysis.rule).toBe(OUTLIER_RULE);
    expect(analysis.flaggedIndices).toEqual([7]);
    expect(analysis.withOutliers.n).toBe(8);
    expect(analysis.withOutliers.max).toBe(900);
    expect(analysis.withoutOutliers.n).toBe(7);
    expect(analysis.withoutOutliers.max).toBe(103);
    // The raw series is untouched.
    expect(values).toHaveLength(8);
  });

  it("outlier rule does not flag sub-25ms jitter on tight series", () => {
    const analysis = analyzeOutliers([10, 10.1, 10.2, 9.9, 10, 30]);
    expect(analysis.flaggedIndices).toEqual([]);
  });

  it("timed spans are monotonic-clock based and sub-millisecond precise", async () => {
    const sync = timedSync(() => 42);
    expect(sync.result).toBe(42);
    expect(sync.ms).toBeGreaterThanOrEqual(0);
    const asyncSpan = await timed(async () => "x");
    expect(asyncSpan.result).toBe("x");
    expect(round(1.23456, 2)).toBe(1.23);
  });

  it("timeline observer records production hook marks and attributes downstream observer time separately", async () => {
    let downstreamCalls = 0;
    const downstream: ForgeVerifyObserver = {
      planCreated: async () => {
        downstreamCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
      coverageReceiptCreated: async () => {
        downstreamCalls += 1;
      },
    };
    const { observer, timeline } = createTimelineObserver(downstream);
    const plan = { planId: "p", runId: "r", policyVersion: "v", workspacePath: "w", inputStateHash: "h", scope: "workspace", verifiers: [], createdAt: "" } as unknown as VerificationPlan;
    await observer.planCreated!(plan);
    await observer.attemptStarted!({ attemptId: "a", planId: "p", verifierId: "v1", verifierVersion: "1", runId: "r", startedAt: "", status: "running" } as never);
    await observer.attemptTerminal!({ attemptId: "a", planId: "p", verifierId: "v1", verifierVersion: "1", runId: "r", startedAt: "", status: "passed" } as never);
    await observer.evidenceCreated!({ verifierId: "v1", elapsedMs: 77 } as never);
    await observer.coverageReceiptCreated!({} as never);
    expect(timeline.planCreatedAt).toBeDefined();
    expect(timeline.plan).toBe(plan);
    expect(timeline.attempts).toHaveLength(1);
    expect(timeline.attempts[0]!.elapsedMs).toBe(77);
    expect(timeline.attempts[0]!.terminalAt).toBeGreaterThanOrEqual(timeline.attempts[0]!.startedAt);
    expect(timeline.coverageReceiptAt).toBeGreaterThanOrEqual(timeline.planCreatedAt!);
    expect(downstreamCalls).toBe(2);
    expect(timeline.downstreamObserverMs).toBeGreaterThanOrEqual(4);
  });

  it("bench project files are deterministic (byte-identical across materializations)", () => {
    const a = buildBenchProjectFiles(DEFAULT_BENCH_SHAPE);
    const b = buildBenchProjectFiles(DEFAULT_BENCH_SHAPE);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.keys(a).filter((k) => k.startsWith("src/mod-"))).toHaveLength(DEFAULT_BENCH_SHAPE.moduleCount);
    expect(Object.keys(a).filter((k) => k.startsWith("tests/unit-"))).toHaveLength(DEFAULT_BENCH_SHAPE.testFileCount);
  });
});
