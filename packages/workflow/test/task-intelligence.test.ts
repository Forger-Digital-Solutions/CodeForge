import { describe, it, expect } from "vitest";
import { understandTask } from "../src/task-intelligence.js";

describe("TaskIntelligence", () => {
  it("classifies bugfix tasks", () => {
    const intent = understandTask("Fix the add function that returns a - b instead of a + b");
    expect(intent.taskType).toBe("bugfix");
    expect(intent.keywords).toContain("add");
    expect(intent.goals.length).toBeGreaterThan(0);
    expect(intent.risk).toBe("medium");
  });

  it("classifies implementation tasks", () => {
    const intent = understandTask("Implement user authentication with JWT");
    expect(intent.taskType).toBe("implementation");
    expect(intent.title).toContain("Implement");
  });

  it("classifies multi-file feature", () => {
    const intent = understandTask("Implement multi file feature for provider routing across several modules");
    expect(intent.taskType).toBe("multi_file_feature");
  });

  it("handles empty message", () => {
    const intent = understandTask("");
    expect(intent.title).toBe("Empty task");
  });

  it("extracts keywords and assesses high risk for destructive", () => {
    const intent = understandTask("Delete the database and reset schema");
    expect(intent.risk).toBe("high");
    expect(intent.requiresApproval).toBe(true);
  });

  it("low risk for documentation", () => {
    const intent = understandTask("Document the API for the user module");
    expect(intent.taskType).toBe("documentation");
    expect(intent.risk).toBe("low");
  });
});

describe("TaskIntelligence R9 regression (read-only commissioning)", () => {
  it("classifies explanation tasks as documentation even when they mention failures", () => {
    const intent = understandTask(
      "Explain how CodeForge routes a task to a model under ForgeAuto/Free: which components decide eligibility, what the zero-billing firewall enforces, and what happens when every free candidate fails. Do not modify any files.",
    );
    expect(intent.taskType).toBe("documentation");
  });

  it("extracts an explicit read-only constraint", () => {
    const intent = understandTask("Review the router module. Do not modify any files.");
    expect(intent.constraints.some((c) => c.includes("read-only"))).toBe(true);
  });

  it("keeps genuine bugfix intent when the user asks to fix a failure", () => {
    const intent = understandTask("Find why this focused test fails, fix the root cause, and run the relevant verification.");
    expect(intent.taskType).toBe("bugfix");
    expect(intent.constraints.some((c) => c.includes("read-only"))).toBe(false);
  });
});
