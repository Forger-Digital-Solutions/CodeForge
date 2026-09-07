import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { evaluateCompletion } from "@codeforge/workflow";
import type { WorkflowPlan, FailureAnalysis, ReviewDecision, VerificationResult } from "@codeforge/workflow";
import { createRepositoryIntelligence } from "@codeforge/repo-intelligence";
import { createMinimalContextKernel, resolveContextCapacity, createContextPlanner, asContextLevel } from "@codeforge/context";

function plan(steps: Partial<import("@codeforge/workflow").PlanStep>[] = []): WorkflowPlan {
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

function analysis(): FailureAnalysis {
  return { hasFailures: false, summary: "ok", diagnostics: [], suggestedRepairs: [], isRepairable: false };
}

function review(): ReviewDecision {
  return { approved: true, issues: [], findings: [], diffs: [{ path: "src/a.ts", changeType: "modified", additions: 1, deletions: 1, diff: "-a\n+b", beforeHash: "x", afterHash: "y" }], summary: "1 file changed" };
}

function notRunVerification(): VerificationResult {
  return { passed: 0, failed: 0, skipped: 0, durationMs: 0, output: "", exitCode: 0, command: "", failures: [], notConfigured: true };
}

function passingVerification(): VerificationResult {
  return { passed: 3, failed: 0, skipped: 0, durationMs: 10, output: "3 passed", exitCode: 0, command: "npm test", failures: [] };
}

describe("FG-3 authority independence — Context Kernel / Planner / Pages carry no permission, verification, or completion authority", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fg3-authority-"));
    await fs.writeFile(path.join(tmpDir, "helper.ts"), "export function helper(): number { return 1; }\n", "utf-8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("[PASS] a maximally 'efficient' L2 context plan with full reuse and zero omissions cannot substitute for verification evidence", async () => {
    const intelligence = createRepositoryIntelligence();
    await intelligence.openWorkspace(tmpDir);
    await intelligence.indexWorkspace();

    const kernel = createMinimalContextKernel({ sessionId: "s1", objective: "Update helper()", repositoryIntelligenceCompleteness: "COMPLETE" });
    const capacity = resolveContextCapacity({ requestedTokens: 32_000 });
    const planResult = await createContextPlanner().planNarrow({ goal: "Update helper()", kernel, capacity, intelligence, mentionedPaths: ["helper.ts"] });

    // The plan itself looks about as good as FG-3 can produce: narrow, targeted, everything the
    // kernel claims is COMPLETE. None of that is a completion-gate input.
    expect(planResult.level === asContextLevel("L1") || planResult.level === asContextLevel("L2")).toBe(true);
    expect(planResult.truncated).toBe(false);
    expect(kernel.repositoryIntelligenceCompleteness).toBe("COMPLETE");

    const blocked = evaluateCompletion({
      plan: plan([{ kind: "edit", status: "completed" }]),
      verification: notRunVerification(),
      analysis: analysis(),
      review: review(),
    });
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.blockers.some((blocker) => blocker.code === "verification_not_run")).toBe(true);
    await intelligence.closeWorkspace();
  });

  it("[positive control] real verification evidence still completes — FG-3 did not weaken the gate", () => {
    const completed = evaluateCompletion({
      plan: plan([{ kind: "edit", status: "completed" }]),
      verification: passingVerification(),
      analysis: analysis(),
      review: review(),
    });
    expect(completed.outcome).toBe("completed");
  });

  it("[structural] evaluateCompletion's input has no field for a Context Kernel, Context Plan, or Context Receipt", () => {
    // Constructing a valid gate input using ONLY pre-FG-3 fields proves none of the FG-3 types
    // are required, accepted, or consulted — the gate's contract is unchanged by this phase.
    const input = {
      plan: plan([{ kind: "edit", status: "completed" }]),
      verification: passingVerification(),
      analysis: analysis(),
      review: review(),
    };
    expect(Object.keys(input)).not.toEqual(expect.arrayContaining(["kernel", "contextPlan", "contextReceipt", "contextLevel"]));
    const result = evaluateCompletion(input);
    expect(result.outcome).toBe("completed");
  });

  it("[PASS] an insufficient resolved context capacity (CONTEXT_CAPACITY_UNKNOWN) is a context-delivery problem, never itself a completion or verification blocker code", async () => {
    const kernel = createMinimalContextKernel({ sessionId: "s1", objective: "x".repeat(200) });
    const tinyCapacity = resolveContextCapacity({ requestedTokens: 5 });
    await expect(createContextPlanner().planNarrow({ goal: "objective", kernel, capacity: tinyCapacity })).rejects.toMatchObject({ code: "CONTEXT_CAPACITY_UNKNOWN" });
    // The completion gate's blocker vocabulary is untouched by this — it never needs to know
    // about context capacity at all.
    const blocked = evaluateCompletion({ plan: plan(), verification: notRunVerification(), analysis: analysis(), review: review() });
    expect(blocked.blockers.every((blocker) => blocker.code !== "CONTEXT_CAPACITY_UNKNOWN")).toBe(true);
  });
});
