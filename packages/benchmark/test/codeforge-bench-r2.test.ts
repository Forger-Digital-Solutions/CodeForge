import { describe, expect, it } from "vitest";
import {
  CODEFORGE_BENCH_R1_CASES,
  CODEFORGE_BENCH_R2_CASES,
  CODEFORGE_BENCH_R2_PROTECTED_CASES,
  CODEFORGE_BENCH_R2_SPLITS,
  runCodeForgeBenchR2Campaign,
  summarizeCodeForgeBenchR2,
  type CodeForgeBenchR2Attempt,
} from "../src/index.js";
import { evaluateProtectedAcceptance } from "../src/index.js";

function attempt(overrides: Partial<CodeForgeBenchR2Attempt> = {}): CodeForgeBenchR2Attempt {
  return {
    caseId: "CBR2-CD-01",
    status: "completed",
    verified: true,
    hiddenAcceptance: "passed",
    runId: "run-1",
    attemptNumber: 1,
    recordedAt: "2026-09-17T12:00:00.000Z",
    repositoryCommit: "repo-commit",
    codeforgeCommit: "codeforge-commit",
    mode: "default",
    configDigest: "config-digest",
    verification: {
      verifierId: "independent-test-runner",
      visibleAcceptance: "passed",
      protectedAcceptance: "passed",
      forgeVerify: "passed",
    },
    metrics: { wallTimeMs: 100, contextTokens: 200, toolCalls: 3, outputTokens: 40, retries: 0 },
    ...overrides,
  };
}

describe("CodeForgeBench R2", () => {
  it("carries every R1 case forward and adds two cases for each R2 capability family", () => {
    expect(CODEFORGE_BENCH_R2_CASES).toHaveLength(48);
    const r2Ids = new Set(CODEFORGE_BENCH_R2_CASES.map((item) => item.id));
    expect(CODEFORGE_BENCH_R1_CASES.every((item) => r2Ids.has(item.id))).toBe(true);
    const categoryCounts = new Map<string, number>();
    for (const item of CODEFORGE_BENCH_R2_CASES) categoryCounts.set(item.category, (categoryCounts.get(item.category) ?? 0) + 1);
    expect([...categoryCounts.values()].every((count) => count === 2)).toBe(true);
    expect(CODEFORGE_BENCH_R2_PROTECTED_CASES.length).toBeGreaterThan(0);
    expect(new Set(CODEFORGE_BENCH_R2_CASES.map((item) => item.split))).toEqual(new Set(CODEFORGE_BENCH_R2_SPLITS));
  });

  it("keeps a no-execution baseline honest and reports all split counts", () => {
    const summary = summarizeCodeForgeBenchR2([]);
    expect(summary.successRate).toBeNull();
    expect(summary.passAt1Rate).toBeNull();
    expect(summary.falseCompletions).toBe(0);
    expect(summary.cases).toBe(48);
    expect(summary.publicCases + summary.protectedCases).toBe(summary.cases);
    expect(Object.keys(summary.bySplit)).toHaveLength(4);
  });

  it("counts only completed, independently verified, non-rejected work", () => {
    const summary = summarizeCodeForgeBenchR2([
      attempt({ runId: "run-success", caseId: "CBR2-CD-01" }),
      attempt({ runId: "run-blocked", caseId: "CBR2-CD-02", status: "blocked", verified: true }),
      attempt({ runId: "run-false", caseId: "CBR2-TC-01", verified: false, hiddenAcceptance: "failed", verification: { verifierId: "independent-test-runner", visibleAcceptance: "passed", protectedAcceptance: "failed", forgeVerify: "failed" } }),
      attempt({ runId: "run-retry", caseId: "CBR2-TC-02", attemptNumber: 2 }),
      attempt({ runId: "run-retry-first", caseId: "CBR2-TC-02", attemptNumber: 1, verified: false, hiddenAcceptance: "failed", verification: { verifierId: "independent-test-runner", visibleAcceptance: "failed", protectedAcceptance: "not_run", forgeVerify: "blocked" } }),
    ]);
    expect(summary.verifiedSuccesses).toBe(2);
    expect(summary.successRate).toBe(0.4);
    expect(summary.passAt1Successes).toBe(1);
    expect(summary.passAt1Rate).toBe(0.25);
    expect(summary.falseCompletions).toBe(2);
    expect(summary.bySplit.PROTECTED_TEST.attempts).toBe(1);
  });

  it("rejects untraceable attempts and inconsistent ForgeVerify claims", () => {
    expect(() => summarizeCodeForgeBenchR2([attempt({ repositoryCommit: "", runId: "" })])).toThrow(/traceability/);
    expect(() => summarizeCodeForgeBenchR2([attempt({ verification: { verifierId: "runner", visibleAcceptance: "passed", protectedAcceptance: "passed", forgeVerify: "failed" } })])).toThrow(/ForgeVerify/);
  });

  it("does not accept a protected case without protected acceptance evidence", () => {
    const summary = summarizeCodeForgeBenchR2([attempt({
      caseId: "CBR2-CD-02",
      verification: { verifierId: "runner", visibleAcceptance: "passed", protectedAcceptance: "not_run", forgeVerify: "passed" },
    }),]);
    expect(summary.verifiedSuccesses).toBe(0);
    expect(summary.falseCompletions).toBe(1);
  });

  it("accepts protected work only with complete independent final-state evidence", () => {
    const result = evaluateProtectedAcceptance({
      split: "PROTECTED_TEST",
      requiredEvidence: ["Protected acceptance passes."],
      visibleAcceptance: "passed",
      hiddenAcceptance: "passed",
      forgeVerify: "passed",
      finalState: { terminalStatus: "completed", diffHash: "a".repeat(64), changedFiles: ["src/fix.ts"] },
      checks: [
        { id: "workspace-final-state", source: "workspace", observed: true, detail: "Final diff hash and changed-file set recorded." },
        { id: "execution-trace", source: "trace", observed: true, detail: "Terminal trace contains no duplicate mutation." },
      ],
    });
    expect(result.state).toBe("accepted");
    expect(result.evidence.stageId).toBe("codeforge-r12-protected-acceptance");
  });

  it("rejects a protected case when an independent check fails", () => {
    const result = evaluateProtectedAcceptance({
      split: "PROTECTED_TEST",
      requiredEvidence: ["Protected acceptance passes."],
      visibleAcceptance: "passed",
      hiddenAcceptance: "passed",
      forgeVerify: "passed",
      finalState: { terminalStatus: "completed", diffHash: "b".repeat(64), changedFiles: ["src/fix.ts"] },
      checks: [
        { id: "workspace-final-state", source: "workspace", observed: true, detail: "Final state recorded." },
        { id: "authority-boundary", source: "authority", observed: false, detail: "Reviewer did not see the final diff." },
      ],
    });
    expect(result.state).toBe("rejected");
  });

  it("distinguishes missing evidence, malformed results, and public cases", () => {
    const missing = evaluateProtectedAcceptance({ split: "PROTECTED_TEST", requiredEvidence: ["required"], visibleAcceptance: "passed", hiddenAcceptance: "passed", forgeVerify: "passed" });
    expect(missing.state).toBe("infrastructure_blocked");
    const malformed = evaluateProtectedAcceptance({
      split: "PROTECTED_TEST",
      requiredEvidence: ["required"],
      visibleAcceptance: "passed",
      hiddenAcceptance: "passed",
      forgeVerify: "passed",
      finalState: { terminalStatus: "completed", diffHash: "c".repeat(64), changedFiles: [] },
      checks: [{ id: "bad", source: "workspace", observed: true, detail: "" }],
    });
    expect(malformed.state).toBe("rejected");
    const publicCase = evaluateProtectedAcceptance({ split: "PUBLIC", requiredEvidence: [], visibleAcceptance: "passed", hiddenAcceptance: "not_run", forgeVerify: "passed" });
    expect(publicCase.state).toBe("not_applicable");
  });

  it("executes every public case and records an executor failure instead of omitting it", async () => {
    const attempted: string[] = [];
    const attempts = await runCodeForgeBenchR2Campaign({
      repositoryCommit: "fixture-commit",
      codeforgeCommit: "codeforge-commit",
      configDigest: "fixed-route-config",
      mode: "fixed_route",
      now: () => new Date("2026-09-17T12:00:00.000Z"),
      newRunId: () => `run-${attempted.length + 1}`,
      executor: {
        async executeCase(context) {
          attempted.push(context.case.id);
          if (context.case.id === "CBR2-CD-01") throw new Error("fixture unavailable");
          return { status: "blocked", verified: false, hiddenAcceptance: "not_run", reason: "deliberate test block" };
        },
      },
    });
    expect(attempted).toHaveLength(40);
    expect(attempts).toHaveLength(40);
    expect(attempts.every((item) => item.caseId !== "CBR2-CD-02")).toBe(true);
    expect(attempts.find((item) => item.caseId === "CBR2-CD-01")).toMatchObject({
      status: "failed",
      verified: false,
      failure: { failureMode: "executor_error" },
    });
  });

  it("supports a bounded public qualification subset without admitting protected cases", async () => {
    const attempts = await runCodeForgeBenchR2Campaign({
      repositoryCommit: "fixture-head",
      codeforgeCommit: "codeforge-head",
      configDigest: "qualification",
      mode: "fixed_route",
      caseIds: ["CBR1-SF-01"],
      executor: { executeCase: async () => attempt() },
    });
    expect(attempts.map((item) => item.caseId)).toEqual(["CBR1-SF-01"]);
    await expect(runCodeForgeBenchR2Campaign({
      repositoryCommit: "fixture-head",
      codeforgeCommit: "codeforge-head",
      configDigest: "qualification",
      mode: "fixed_route",
      caseIds: ["CBR2-CD-02"],
      executor: { executeCase: async () => attempt() },
    })).rejects.toThrow(/protected/);
  });
});
