import { describe, expect, it } from "vitest";
import type { VerificationResult, WorkflowResult } from "@codeforge/workflow";
import { describeWorkflowOutcome } from "../src/workflow-service.js";

const verification: VerificationResult = {
  passed: 5, failed: 0, skipped: 0, durationMs: 1600,
  output: "5 passed", exitCode: 0, command: "npm test", failures: [],
};

describe("interrupted workflow outcome evidence", () => {
  it.each([
    { status: "failed", summary: "Task timed out: Workflow timed out after 30 minutes", reasonCode: "timed_out" },
    { status: "cancelled", summary: "Task stopped before completion.", reasonCode: "user_stopped" },
  ] as const)("keeps observed verification and unresolved review after $reasonCode", ({ status, summary, reasonCode }) => {
    const result: WorkflowResult = {
      taskId: "interrupted", status, phase: status, summary, verification, verificationAttempts: [verification],
      review: { approved: false, summary: "Review interrupted", diffs: [], issues: ["No verdict"], findings: [{ code: "goal_review_inconclusive", severity: "blocking", path: "", message: "No verdict" }] },
    };
    const outcome = describeWorkflowOutcome(result, "root-turn");
    expect(outcome).toMatchObject({ outcome: status, reasonCode, verification: "passed", review: "findings", completion: "not_evaluated" });
    expect(outcome.outcome).not.toBe("completed");
    expect(result.verificationAttempts).toEqual([verification]);
  });

  it("does not invent evidence for an early timeout", () => {
    const outcome = describeWorkflowOutcome({ taskId: "early", status: "failed", phase: "failed", summary: "Task timed out: Workflow timed out after 30 minutes" }, "root-turn");
    expect(outcome).toMatchObject({ outcome: "failed", reasonCode: "timed_out", verification: "not_run", review: "not_run", completion: "not_evaluated" });
  });
});
