import { describe, it, expect } from "vitest";
import { evaluateCompletion, DEFAULT_COMPLETION_POLICY } from "../src/completion-gate.js";
import type {
  FailureAnalysis,
  ReviewDecision,
  VerificationResult,
  WorkflowPlan,
  PlanStep,
} from "../src/types.js";
import type { TaskRiskClass, AnalyzabilityClass } from "@codeforge/forge-green";

function plan(steps: Partial<PlanStep>[] = []): WorkflowPlan {
  return {
    id: "plan-1",
    title: "test plan",
    taskId: "task-1",
    status: "approved",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: steps.map((s, i) => ({
      id: s.id ?? `step-${i}`,
      description: s.description ?? "step",
      status: s.status ?? "completed",
      kind: s.kind ?? "read",
      risk: s.risk ?? "safe",
      requiresApproval: s.requiresApproval ?? false,
      targetPath: s.targetPath,
    })),
  };
}

function passingVerification(): VerificationResult {
  return {
    passed: 3,
    failed: 0,
    skipped: 0,
    durationMs: 10,
    output: "3 passed",
    exitCode: 0,
    command: "npm test",
    failures: [],
  };
}

function failingVerification(): VerificationResult {
  return { ...passingVerification(), passed: 0, failed: 2, exitCode: 1, output: "2 failed" };
}

function unconfiguredVerification(): VerificationResult {
  return {
    passed: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
    output: "",
    exitCode: 0,
    command: "",
    failures: [],
    notConfigured: true,
  };
}

function analysis(overrides: Partial<FailureAnalysis> = {}): FailureAnalysis {
  return {
    hasFailures: false,
    summary: "ok",
    diagnostics: [],
    suggestedRepairs: [],
    isRepairable: false,
    ...overrides,
  };
}

function review(overrides: Partial<ReviewDecision> = {}): ReviewDecision {
  return {
    approved: true,
    issues: [],
    findings: [],
    diffs: [
      {
        path: "src/a.ts",
        changeType: "modified",
        additions: 1,
        deletions: 1,
        diff: "-a\n+b",
        beforeHash: "x",
        afterHash: "y",
      },
    ],
    summary: "1 file changed",
    ...overrides,
  };
}

describe("completion gate — the runtime, not the model, decides completion", () => {
  it("completes when every required check passes", () => {
    const d = evaluateCompletion({
      plan: plan([{ kind: "edit", status: "completed" }]),
      verification: passingVerification(),
      analysis: analysis(),
      review: review(),
    });
    expect(d.outcome).toBe("completed");
    expect(d.blockers).toHaveLength(0);
  });

  it("BLOCKS completion when no verification ran — unverified is not success", () => {
    const d = evaluateCompletion({
      plan: plan([{ kind: "edit", status: "completed" }]),
      verification: unconfiguredVerification(),
      analysis: analysis(),
      review: review(),
    });
    expect(d.outcome).toBe("blocked");
    expect(d.blockers.map((b) => b.code)).toContain("verification_not_run");
  });

  it("FAILS when a verifier ran and failed", () => {
    const d = evaluateCompletion({
      plan: plan([{ kind: "edit", status: "completed" }]),
      verification: failingVerification(),
      analysis: analysis({ hasFailures: true, summary: "2 failed" }),
      review: review(),
    });
    expect(d.outcome).toBe("failed");
    expect(d.blockers.map((b) => b.code)).toContain("verification_failed");
  });

  it("BLOCKS when the diff review raises a blocking finding", () => {
    const d = evaluateCompletion({
      plan: plan([{ kind: "edit", status: "completed" }]),
      verification: passingVerification(),
      analysis: analysis(),
      review: review({
        approved: false,
        issues: ["Sensitive file modified: .env"],
        findings: [
          { code: "sensitive_file", severity: "blocking", path: ".env", message: "Sensitive file modified: .env" },
        ],
      }),
    });
    expect(d.outcome).toBe("blocked");
    expect(d.blockers.map((b) => b.code)).toContain("review_rejected");
  });

  it("does NOT block on an advisory-only review finding", () => {
    const d = evaluateCompletion({
      plan: plan([{ kind: "edit", status: "completed" }]),
      verification: passingVerification(),
      analysis: analysis(),
      review: review({
        approved: false,
        issues: ["Large diff"],
        findings: [
          { code: "oversized_diff", severity: "advisory", path: "src/a.ts", message: "Large diff" },
        ],
      }),
    });
    expect(d.outcome).toBe("completed");
    expect(d.advisories.map((a) => a.code)).toContain("review_rejected");
  });

  it("BLOCKS when edit steps claim success but the workspace diff is empty", () => {
    const d = evaluateCompletion({
      plan: plan([{ kind: "edit", status: "completed", targetPath: "src/a.ts" }]),
      verification: passingVerification(),
      analysis: analysis(),
      review: review({ diffs: [] }),
    });
    expect(d.outcome).toBe("blocked");
    expect(d.blockers.map((b) => b.code)).toContain("no_effective_change");
  });

  it("does not invent a change blocker for read-only work", () => {
    const d = evaluateCompletion({
      plan: plan([{ kind: "read", status: "completed" }]),
      verification: passingVerification(),
      analysis: analysis(),
      review: review({ diffs: [] }),
    });
    expect(d.outcome).toBe("completed");
  });

  it("BLOCKS when the execution budget was exhausted rather than finished", () => {
    const d = evaluateCompletion({
      plan: plan([{ kind: "edit", status: "completed" }]),
      verification: passingVerification(),
      analysis: analysis(),
      review: review(),
      budgetExhausted: true,
      budgetDetail: "3/3 repair attempts",
    });
    expect(d.outcome).toBe("blocked");
    expect(d.blockers.map((b) => b.code)).toContain("budget_exhausted");
  });

  it("BLOCKS when a plan step failed", () => {
    const d = evaluateCompletion({
      plan: plan([
        { kind: "edit", status: "completed" },
        { id: "s2", kind: "edit", status: "failed" },
      ]),
      verification: passingVerification(),
      analysis: analysis(),
      review: review(),
    });
    expect(d.outcome).toBe("blocked");
    expect(d.blockers.map((b) => b.code)).toContain("plan_steps_unfinished");
  });

  it("a failed verifier outranks other blockers and yields `failed`, not `blocked`", () => {
    const d = evaluateCompletion({
      plan: plan([{ kind: "edit", status: "completed" }]),
      verification: failingVerification(),
      analysis: analysis({ hasFailures: true }),
      review: review({ diffs: [] }),
      budgetExhausted: true,
    });
    expect(d.outcome).toBe("failed");
  });

  it("policy can downgrade a check to advisory, and the default policy does not", () => {
    const input = {
      plan: plan([{ kind: "edit" as const, status: "completed" as const }]),
      verification: unconfiguredVerification(),
      analysis: analysis(),
      review: review(),
    };
    expect(evaluateCompletion(input).outcome).toBe("blocked");
    expect(DEFAULT_COMPLETION_POLICY.requireVerification).toBe(true);

    const relaxed = evaluateCompletion({ ...input, policy: { requireVerification: false } });
    expect(relaxed.outcome).toBe("completed");
    expect(relaxed.advisories.map((a) => a.code)).toContain("verification_not_run");
  });

  it("is pure — the same evidence always yields the same verdict", () => {
    const input = {
      plan: plan([{ kind: "edit" as const, status: "completed" as const }]),
      verification: unconfiguredVerification(),
      analysis: analysis(),
      review: review(),
    };
    expect(evaluateCompletion(input)).toEqual(evaluateCompletion(input));
  });

  it("does not treat a best-case FG-4 risk result as verification or completion authority", () => {
    const riskAdvice: { risk: TaskRiskClass; analyzability: AnalyzabilityClass } = { risk: "LOCAL", analyzability: "HIGH" };
    expect(riskAdvice).toEqual({ risk: "LOCAL", analyzability: "HIGH" });
    const decision = evaluateCompletion({
      plan: plan([{ kind: "edit", status: "completed" }]),
      verification: unconfiguredVerification(),
      analysis: analysis(),
      review: review(),
    });
    expect(decision.outcome).toBe("blocked");
    expect(decision.blockers.map((blocker) => blocker.code)).toContain("verification_not_run");
  });
});
