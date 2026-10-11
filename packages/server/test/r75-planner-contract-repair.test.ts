import { describe, expect, it } from "vitest";
import type { PlannerResult } from "@codeforge/agent";
import { repairPlannerContract } from "../src/planner-contract-repair.js";

describe("repairPlannerContract", () => {
  it("retains exact user constraints and supplied checks while completing reviewer edges", () => {
    const goal = "Add normalizeTags(values) to src/tags.mjs and re-export it from src/index.mjs. Trim and lowercase strings, remove empty entries and duplicates, and sort alphabetically. Use the existing normalization helper. Do not mutate input or modify tests. This is a public synthetic fixture with no user source, credentials, or confidential data.";
    const plan: PlannerResult = {
      protocol: "task_graph_v1",
      summary: "Add normalizeTags(values) and re-export it.",
      tasks: [
        { id: "task_1", title: "Update src/tags.mjs", objective: "Use the existing helper to normalize tags.", dependencies: [], assignedRole: "coder" },
        { id: "task_2", title: "Update src/index.mjs", objective: "Re-export normalizeTags(values).", dependencies: ["task_1"], assignedRole: "coder" },
        { id: "task_3", title: "Review src/tags.mjs", objective: "Review normalization and preserve input.", dependencies: ["task_1"], assignedRole: "reviewer" },
        { id: "task_4", title: "Review src/index.mjs", objective: "Review the public re-export.", dependencies: ["task_2"], assignedRole: "reviewer" },
        { id: "task_5", title: "Verify normalization", objective: "Verify all acceptance conditions.", dependencies: ["task_3", "task_4"], assignedRole: "reviewer" },
      ],
      planningIntent: { constraints: [], verification: [], completionEvidence: [] },
    };

    const repaired = repairPlannerContract({ plan, goal, verificationCommands: ["node --test test/tags.test.mjs"] });

    expect(repaired).toBeDefined();
    expect(repaired!.repairs).toContain("linked the Reviewer to every implementation task");
    expect(repaired!.plan.tasks[0]).toEqual(plan.tasks[0]);
    expect(repaired!.plan.tasks[1]).toEqual(plan.tasks[1]);
    expect(repaired!.plan.tasks[2]?.dependencies).toEqual(["task_1", "task_2"]);
    for (const task of repaired!.plan.tasks.filter((task) => task.assignedRole === "reviewer")) {
      expect(task.dependencies).toEqual(expect.arrayContaining(["task_1", "task_2"]));
    }
    expect(repaired!.plan.planningIntent?.constraints).toContain("Do not mutate input or modify tests.");
    expect(repaired!.plan.planningIntent?.constraints).toContain("This is a public synthetic fixture with no user source, credentials, or confidential data.");
    expect(repaired!.plan.planningIntent?.verification).toContain("node --test test/tags.test.mjs");
  });

  it("adds only the mandatory lifecycle roles and preserves existing plan decisions", () => {
    const goal = "Implement the requested change.";
    const plan: PlannerResult = {
      protocol: "task_graph_v1",
      summary: "Investigate the implementation before coding.",
      tasks: [
        { id: "explore", title: "Inspect relevant files", objective: "Find the implementation entry point.", dependencies: [], assignedRole: "explorer" },
      ],
    };

    const repaired = repairPlannerContract({ plan, goal, verificationCommands: ["node --test test/implementation.test.mjs"] });

    expect(repaired).toBeDefined();
    expect(repaired!.plan.tasks.map((task) => task.assignedRole)).toEqual(["explorer", "coder", "reviewer"]);
    expect(repaired!.plan.tasks[1]?.objective).toBe(goal);
    expect(repaired!.plan.tasks[2]?.dependencies).toEqual(["runtime-coder"]);
    expect(repaired!.plan.tasks[0]).toEqual(plan.tasks[0]);
    expect(repaired!.repairs).toContain("added the mandatory Coder task using the original request verbatim");
    expect(repaired!.repairs).toContain("added the mandatory independent Reviewer task");
    expect(repaired!.plan.planningIntent?.verification).toEqual(["node --test test/implementation.test.mjs"]);
  });

  it("fails closed on ambiguous duplicate task identities", () => {
    const plan: PlannerResult = {
      protocol: "task_graph_v1",
      summary: "A plan with ambiguous task references.",
      tasks: [
        { id: "same", title: "First", objective: "First task.", dependencies: [], assignedRole: "coder" },
        { id: "same", title: "Second", objective: "Second task.", dependencies: [], assignedRole: "reviewer" },
      ],
    };

    expect(repairPlannerContract({ plan, goal: "Implement a change.", verificationCommands: [] })).toBeUndefined();
  });

  it("fails closed instead of truncating explicit user constraints", () => {
    const plan: PlannerResult = {
      protocol: "task_graph_v1",
      summary: "Implement the request.",
      tasks: [
        { id: "code", title: "Implement", objective: "Implement the request.", dependencies: [], assignedRole: "coder" },
        { id: "review", title: "Review", objective: "Review the changes.", dependencies: ["code"], assignedRole: "reviewer" },
      ],
    };
    const constraints = Array.from({ length: 25 }, (_, index) => `Do not break requirement ${index + 1}.`).join("\n");

    expect(repairPlannerContract({ plan, goal: constraints, verificationCommands: [] })).toBeUndefined();
  });

  it("leaves cyclic plans for the bounded Planner correction", () => {
    const plan: PlannerResult = {
      protocol: "task_graph_v1",
      summary: "A cyclic plan.",
      tasks: [
        { id: "code", title: "Implement", objective: "Implement the request.", dependencies: ["review"], assignedRole: "coder" },
        { id: "review", title: "Review", objective: "Review the implementation.", dependencies: ["code"], assignedRole: "reviewer" },
      ],
    };

    expect(repairPlannerContract({ plan, goal: "Implement a change.", verificationCommands: ["npm test"] })).toBeUndefined();
  });

  it("refuses a cycle introduced by completing a later Reviewer's implementation dependencies", () => {
    const plan: PlannerResult = {
      protocol: "task_graph_v1", summary: "Implement and review in two rounds.",
      tasks: [
        { id: "first-code", title: "Implement", objective: "Implement", dependencies: [], assignedRole: "coder" },
        { id: "first-review", title: "Review", objective: "Review", dependencies: ["first-code", "second-code"], assignedRole: "reviewer" },
        { id: "second-review", title: "Review", objective: "Review", dependencies: ["first-code"], assignedRole: "reviewer" },
        { id: "second-code", title: "Implement", objective: "Implement", dependencies: ["second-review"], assignedRole: "coder" },
      ],
    };
    expect(repairPlannerContract({ plan, goal: "Implement a change.", verificationCommands: ["node --test"] })).toBeUndefined();
    expect(plan.tasks[2]?.dependencies).toEqual(["first-code"]);
  });
});
