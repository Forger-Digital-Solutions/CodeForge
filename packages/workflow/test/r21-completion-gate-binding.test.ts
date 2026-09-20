import { describe, expect, it } from "vitest";
import { evaluateCompletion } from "../src/completion-gate.js";
import type { FailureAnalysis, ReviewDecision, VerificationReport, VerifierRunResult, WorkflowPlan } from "../src/types.js";
import type { VerificationSummary, VerificationPlan } from "../src/forge-verify.js";
import { recordR21Evidence } from "./r21-evidence.js";

/**
 * R21 completion-gate binding rules, exercised as pure decisions:
 *  - ForgeVerify evidence is bound to the workspace state observed at decision time;
 *  - a report that claims ForgeVerify but carries no summary fails closed;
 *  - "exit 0, no tests discovered" is unverified, never success;
 *  - "exit 0, runner reports failures" is a failure, never success;
 *  - a passing required test verifier with no runner signal is surfaced as an advisory.
 */

const plan: WorkflowPlan = {
  id: "p", title: "t", taskId: "r21", status: "completed", createdAt: "", updatedAt: "",
  steps: [
    { id: "edit", description: "edit", status: "completed", kind: "edit", risk: "safe", requiresApproval: false, targetPath: "a.ts" },
    { id: "verify", description: "verify", status: "completed", kind: "verify", risk: "safe", requiresApproval: false },
  ],
};
const analysis: FailureAnalysis = { hasFailures: false, summary: "", diagnostics: [], suggestedRepairs: [], isRepairable: false };
const review: ReviewDecision = { approved: true, issues: [], findings: [], diffs: [{ path: "a.ts", changeType: "modified", additions: 1, deletions: 0, diff: "+x", beforeHash: "a", afterHash: "b" }], summary: "1 file" };

function verifier(overrides: Partial<VerifierRunResult> = {}): VerifierRunResult {
  return { id: "test", kind: "test", command: "npm test", required: true, status: "passed", passed: 5, failed: 0, skipped: 0, exitCode: 0, durationMs: 10, output: "5 passed", failures: [], testSignal: "counts", ...overrides };
}

function forgeVerifyPlan(inputStateHash: string): VerificationPlan {
  return { planId: "plan-1", runId: "r21", policyVersion: "v1", workspacePath: "/ws", inputStateHash, scope: "workspace", verifiers: [{ verifierId: "test", verifierVersion: "1", definitionDigest: "d", requirement: "required" }], createdAt: "" } as unknown as VerificationPlan;
}

function summary(complete: boolean, inputStateHash?: string): VerificationSummary {
  return { planId: "plan-1", requiredCount: 1, satisfiedCount: complete ? 1 : 0, failedCount: 0, missingCount: complete ? 0 : 1, staleCount: 0, verificationComplete: complete, satisfiedEvidenceIds: [], missingRequiredVerifiers: complete ? [] : ["test"], reasons: complete ? [] : ["missing"], ...(inputStateHash ? { inputStateHash } : {}) } as unknown as VerificationSummary;
}

function report(overrides: Partial<VerificationReport> = {}, verifiers: VerifierRunResult[] = [verifier()], fv?: { plan: VerificationPlan; summary?: VerificationSummary }): VerificationReport {
  const requiredPassed = verifiers.every((entry) => !entry.required || (entry.status === "passed" && !entry.noTestsDiscovered && !entry.contradictoryOutput));
  return {
    verifiers, requiredPassed, hasFailures: !requiredPassed, advisories: [], overallStatus: requiredPassed ? "passed" : "failed", summary: "",
    passed: 5, failed: 0, skipped: 0, durationMs: 10, output: "", exitCode: requiredPassed ? 0 : 1, command: "npm test", failures: [],
    ...(fv ? { forgeVerify: { plan: fv.plan, attempts: [], evidence: [], summary: fv.summary as VerificationSummary } } : {}),
    ...overrides,
  };
}

describe("R21 completion gate — workspace-state binding", () => {
  it("completes when the evidence state equals the state observed at decision time", () => {
    const decision = evaluateCompletion({ plan, analysis, review, verification: report({}, [verifier()], { plan: forgeVerifyPlan("S1"), summary: summary(true, "S1") }), currentVerificationInputStateHash: "S1" });
    expect(decision.outcome).toBe("completed");
  });

  it("blocks with verification_not_current when the workspace state differs from the evidence state (plan identity)", () => {
    const decision = evaluateCompletion({ plan, analysis, review, verification: report({}, [verifier()], { plan: forgeVerifyPlan("S1"), summary: summary(true, "S1") }), currentVerificationInputStateHash: "S2" });
    expect(decision.outcome).toBe("blocked");
    expect(decision.blockers.map((blocker) => blocker.code)).toContain("verification_not_current");
    recordR21Evidence("completion-gate-binding", { case: "plan_identity_mismatch", outcome: decision.outcome });
  });

  it("binds through the legacy result's inputStateHash when no structured report exists", () => {
    const legacy = { passed: 1, failed: 0, skipped: 0, durationMs: 1, output: "1 passed", exitCode: 0, command: "npm test", failures: [], inputStateHash: "S1" };
    expect(evaluateCompletion({ plan, analysis, review, verification: legacy, currentVerificationInputStateHash: "S1" }).outcome).toBe("completed");
    const stale = evaluateCompletion({ plan, analysis, review, verification: legacy, currentVerificationInputStateHash: "S2" });
    expect(stale.outcome).toBe("blocked");
    expect(stale.blockers.map((blocker) => blocker.code)).toContain("verification_not_current");
  });

  it("an explicit verifiedVerificationInputStateHash overrides whatever the report claims", () => {
    const decision = evaluateCompletion({ plan, analysis, review, verification: report({}, [verifier()], { plan: forgeVerifyPlan("S1"), summary: summary(true, "S1") }), verifiedVerificationInputStateHash: "S0", currentVerificationInputStateHash: "S1" });
    expect(decision.outcome).toBe("blocked");
  });

  it("does not block when no current state is supplied (legacy callers keep their existing semantics)", () => {
    const decision = evaluateCompletion({ plan, analysis, review, verification: report({}, [verifier()], { plan: forgeVerifyPlan("S1"), summary: summary(true, "S1") }) });
    expect(decision.outcome).toBe("completed");
  });
});

describe("R21 completion gate — malformed and hollow verification reports", () => {
  it("a report that claims ForgeVerify but has no summary fails closed", () => {
    const decision = evaluateCompletion({ plan, analysis, review, verification: report({}, [verifier()], { plan: forgeVerifyPlan("S1") }) });
    expect(decision.outcome).toBe("blocked");
    expect(decision.blockers.map((blocker) => blocker.code)).toContain("verification_not_run");
    recordR21Evidence("completion-gate-binding", { case: "forgeverify_without_summary", outcome: decision.outcome });
  });

  it("a stale summary reason maps to verification_not_current, not verification_not_run", () => {
    const stale = { ...summary(false, "S2"), reasons: ["stale"], staleCount: 1 } as unknown as VerificationSummary;
    const decision = evaluateCompletion({ plan, analysis, review, verification: report({}, [verifier()], { plan: forgeVerifyPlan("S1"), summary: stale }) });
    expect(decision.blockers.map((blocker) => blocker.code)).toContain("verification_not_current");
  });

  it("exit 0 with no tests discovered is unverified (verification_not_run), never success — structured and legacy", () => {
    const structured = evaluateCompletion({ plan, analysis, review, verification: report({ noTestsDiscovered: true }, [verifier({ passed: 0, noTestsDiscovered: true, testSignal: "counts", output: "ℹ tests 0" })], { plan: forgeVerifyPlan("S1"), summary: summary(true, "S1") }) });
    expect(structured.outcome).toBe("blocked");
    expect(structured.blockers.map((blocker) => blocker.code)).toContain("verification_not_run");
    const legacy = evaluateCompletion({ plan, analysis, review, verification: { passed: 1, failed: 0, skipped: 0, durationMs: 1, output: "No test files found", exitCode: 0, command: "npm test", failures: [], noTestsDiscovered: true } });
    expect(legacy.outcome).toBe("blocked");
    expect(legacy.blockers.map((blocker) => blocker.code)).toContain("verification_not_run");
    recordR21Evidence("completion-gate-binding", { case: "no_tests_discovered", structured: structured.outcome, legacy: legacy.outcome });
  });

  it("exit 0 contradicted by the runner's own failure count is a failure — structured and legacy", () => {
    const structured = evaluateCompletion({ plan, analysis, review, verification: report({ contradictoryOutput: true }, [verifier({ failed: 2, contradictoryOutput: true, output: "Tests: 2 failed, 3 passed" })], { plan: forgeVerifyPlan("S1"), summary: summary(true, "S1") }) });
    expect(structured.outcome).toBe("failed");
    expect(structured.blockers.map((blocker) => blocker.code)).toContain("verification_failed");
    const legacy = evaluateCompletion({ plan, analysis, review, verification: { passed: 3, failed: 2, skipped: 0, durationMs: 1, output: "Tests: 2 failed, 3 passed", exitCode: 0, command: "npm test", failures: [], contradictoryOutput: true } });
    expect(legacy.outcome).toBe("failed");
    recordR21Evidence("completion-gate-binding", { case: "contradictory_output", structured: structured.outcome, legacy: legacy.outcome });
  });

  it("a passing required test verifier with no runner signal completes with an advisory, and a typecheck verifier does not get one", () => {
    const decision = evaluateCompletion({ plan, analysis, review, verification: report({}, [verifier({ testSignal: "none", passed: 1, output: "ok" }), verifier({ id: "typecheck", kind: "typecheck", command: "npm run typecheck", testSignal: "none" })], { plan: forgeVerifyPlan("S1"), summary: summary(true, "S1") }) });
    expect(decision.outcome).toBe("completed");
    const advisories = decision.advisories.filter((advisory) => advisory.code === "verification_no_test_signal");
    expect(advisories).toHaveLength(1);
    expect(advisories[0]!.message).toContain("'test'");
  });

  it("is still pure: identical inputs yield identical decisions", () => {
    const input = { plan, analysis, review, verification: report({}, [verifier()], { plan: forgeVerifyPlan("S1"), summary: summary(true, "S1") }), currentVerificationInputStateHash: "S2" };
    expect(evaluateCompletion(input)).toEqual(evaluateCompletion(input));
  });
});
