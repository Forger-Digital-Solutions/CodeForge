import { describe, expect, it } from "vitest";
import { CODEFORGE_BENCH_R1_CASES, summarizeCodeForgeBenchR1 } from "../src/codeforge-bench-r1.js";

describe("CodeForgeBench R1", () => {
  it("freezes two solution-neutral cases for each mandatory category and covers every difficulty", () => {
    expect(CODEFORGE_BENCH_R1_CASES).toHaveLength(24);
    const categories = new Map<string, number>();
    for (const item of CODEFORGE_BENCH_R1_CASES) categories.set(item.category, (categories.get(item.category) ?? 0) + 1);
    expect([...categories.values()]).toEqual(Array(12).fill(2));
    expect(new Set(CODEFORGE_BENCH_R1_CASES.map((item) => item.difficulty))).toEqual(new Set(["trivial", "easy", "medium", "hard", "very_hard"]));
    expect(CODEFORGE_BENCH_R1_CASES.every((item) => item.acceptance.length > 0 && item.failureTraps.length > 0)).toBe(true);
  });

  it("counts only independently verified and non-rejected attempts as successes", () => {
    const summary = summarizeCodeForgeBenchR1([
      { caseId: "CBR1-RU-01", status: "completed", verified: true, hiddenAcceptance: "passed" },
      { caseId: "CBR1-RU-02", status: "completed", verified: true, hiddenAcceptance: "failed" },
      { caseId: "CBR1-SF-01", status: "not_run", verified: false, reason: "route unqualified" },
    ]);
    expect(summary.verifiedSuccesses).toBe(1);
    expect(summary.successRate).toBe(0.5);
    expect(summary.unrun).toBe(1);
    expect(summary.byCategory.repository_understanding.successRate).toBe(0.5);
  });
});
