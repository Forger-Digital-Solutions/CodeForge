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
