import { describe, it, expect } from "vitest";
import { analyzeFailures } from "../src/failure-analyzer.js";
import type { VerificationResult } from "../src/types.js";

describe("FailureAnalyzer", () => {
  it("detects passing verification", () => {
    const result: VerificationResult = {
      passed: 5,
      failed: 0,
      skipped: 0,
      durationMs: 100,
      output: "5 passed",
      exitCode: 0,
      command: "npm test",
      failures: [],
    };
    const analysis = analyzeFailures(result);
    expect(analysis.hasFailures).toBe(false);
    expect(analysis.isRepairable).toBe(false);
  });

  it("analyzes failing test", () => {
    const result: VerificationResult = {
      passed: 0,
      failed: 1,
      skipped: 0,
      durationMs: 100,
      output: "FAIL src/calc.test.ts\nError: expected 5 but got -1\n at calc.ts:2",
      exitCode: 1,
      command: "npm test",
      failures: [{ test: "calc", message: "expected 5" }],
    };
    const analysis = analyzeFailures(result);
    expect(analysis.hasFailures).toBe(true);
    expect(analysis.diagnostics.length).toBeGreaterThan(0);
    expect(analysis.summary).toContain("failed");
  });

  it("handles secret redaction", () => {
    const result: VerificationResult = {
      passed: 0,
      failed: 1,
      skipped: 0,
      durationMs: 0,
      output: "Error with sk-proj-1234567890abcdef",
      exitCode: 1,
      command: "test",
      failures: [{ test: "t", message: "fail" }],
    };
    const analysis = analyzeFailures(result);
    expect(analysis.diagnostics.join("")).not.toContain("sk-proj-1234567890");
  });
});
