import { describe, it, expect } from "vitest";
import { createPlan, planRequiresApproval, updatePlanStatus, updateStepStatus } from "../src/plan-service.js";
import { understandTask } from "../src/task-intelligence.js";
import { buildContext } from "../src/context-builder.js";
import type { RepoMap } from "../src/types.js";

describe("PlanService", () => {
  it("creates plan with steps", () => {
    const intent = understandTask("Fix add function");
    const repoMap: RepoMap = {
      workspacePath: "/tmp",
      files: [{ path: "/tmp/src/calc.ts", relativePath: "src/calc.ts", size: 100, lines: 10 }],
      searchedMatches: [{ file: "src/calc.ts", line: 1, column: 1, preview: "add" }],
      readFiles: [{ path: "src/calc.ts", content: "return a - b", hash: "abc", lines: 5, truncated: false }],
    };
    const ctx = buildContext(intent, repoMap);
    const plan = createPlan(intent, ctx, repoMap, "task-123");
    expect(plan.title).toContain("Fix");
    expect(plan.steps.length).toBeGreaterThan(3);
    expect(plan.steps.some((s) => s.kind === "edit")).toBe(true);
    expect(plan.steps.some((s) => s.kind === "verify")).toBe(true);
  });

  it("detects approval requirement", () => {
    const intent = understandTask("Fix add");
    const repoMap: RepoMap = {
      workspacePath: "/tmp",
      files: [{ path: "/tmp/src/calc.ts", relativePath: "src/calc.ts", size: 100, lines: 10 }],
      searchedMatches: [],
      readFiles: [{ path: "src/calc.ts", content: "x", hash: "abc", lines: 1, truncated: false }],
    };
    const ctx = buildContext(intent, repoMap);
    const plan = createPlan(intent, ctx, repoMap, "task-1");
    expect(planRequiresApproval(plan)).toBe(true);
  });

  it("updates plan and step status", () => {
    const intent = understandTask("Fix add");
    const repoMap: RepoMap = {
      workspacePath: "/tmp",
      files: [],
      searchedMatches: [],
      readFiles: [],
    };
    const ctx = buildContext(intent, repoMap);
    const plan = createPlan(intent, ctx, repoMap, "task-2");
    const updated = updatePlanStatus(plan, "approved");
    expect(updated.status).toBe("approved");
    const stepId = updated.steps[0]!.id;
    const stepUpdated = updateStepStatus(updated, stepId, "completed");
    expect(stepUpdated.steps.find((s) => s.id === stepId)?.status).toBe("completed");
  });
});

describe("PlanService R9 regression (read-only commissioning)", () => {
  const repoMap: RepoMap = {
    workspacePath: "/tmp",
    files: [{ path: "/tmp/src/calc.ts", relativePath: "src/calc.ts", size: 100, lines: 10 }],
    searchedMatches: [{ file: "src/calc.ts", line: 1, column: 1, preview: "add" }],
    readFiles: [{ path: "src/calc.ts", content: "return a - b", hash: "abc", lines: 5, truncated: false }],
  };

  it("plans no edit or command steps for an explanation task", () => {
    const intent = understandTask(
      "Explain how CodeForge routes a task to a model under ForgeAuto/Free: what happens when every free candidate fails. Do not modify any files.",
    );
    const ctx = buildContext(intent, repoMap);
    const plan = createPlan(intent, ctx, repoMap, "task-ro-1");
    expect(plan.steps.some((s) => s.kind === "edit" || s.kind === "write")).toBe(false);
    expect(plan.steps.some((s) => s.kind === "command")).toBe(false);
  });

  it("still plans edits for bugfix tasks", () => {
    const intent = understandTask("Fix add function to return a + b");
    const ctx = buildContext(intent, repoMap);
    const plan = createPlan(intent, ctx, repoMap, "task-fix-1");
    expect(plan.steps.some((s) => s.kind === "edit")).toBe(true);
  });

  it("plans edit steps for code-documentation tasks without read-only constraints", () => {
    const intent = understandTask("Document current add function after restart recovery");
    const ctx = buildContext(intent, repoMap);
    const plan = createPlan(intent, ctx, repoMap, "task-doc-1");
    expect(plan.steps.some((s) => s.kind === "edit")).toBe(true);
  });
});
