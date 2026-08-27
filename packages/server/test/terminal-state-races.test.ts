import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowEngine } from "@codeforge/workflow";

describe("WorkflowEngine terminal-state races", () => {
  let workspacePath: string;

  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), "codeforge-terminal-"));
    mkdirSync(join(workspacePath, "src"));
    writeFileSync(join(workspacePath, "src", "calc.ts"), "export function add(a: number, b: number): number {\n  return a - b;\n}\n");
    writeFileSync(join(workspacePath, "package.json"), JSON.stringify({ type: "module", name: "fixture" }));
  });

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true });
  });

  it("keeps completed terminal when cancellation arrives late and emits it once", async () => {
    const controller = new AbortController();
    const phases: string[] = [];
    const engine = createWorkflowEngine({
      workspacePath,
      sessionId: "terminal-completed",
      signal: controller.signal,
      askForApproval: async () => "allow_once",
      verificationCommands: [],
      onPhaseChange: (phase) => phases.push(phase),
    });

    const result = await engine.run("Fix the add function that incorrectly returns a - b instead of a + b");
    controller.abort();

    expect(result.status).toBe("completed");
    expect(engine.getTask().phase).toBe("completed");
    expect(phases.filter((phase) => phase === "completed")).toHaveLength(1);
    expect(phases).not.toContain("cancelled");
  });

  it("keeps failed terminal when verification fails and never emits completion", async () => {
    const phases: string[] = [];
    const engine = createWorkflowEngine({
      workspacePath,
      sessionId: "terminal-failed",
      maxRepairAttempts: 0,
      verificationCommands: ["node -e \"process.exit(1)\""],
      onPhaseChange: (phase) => phases.push(phase),
    });

    const result = await engine.run("Fix the add function that incorrectly returns a - b instead of a + b");

    expect(result.status).toBe("failed");
    expect(result.phase).toBe("failed");
    expect(engine.getTask().phase).toBe("failed");
    expect(phases.filter((phase) => phase === "failed")).toHaveLength(1);
    expect(phases).not.toContain("completed");
  });

  it("fails closed when a consequential plan has no approval handler", async () => {
    const phases: string[] = [];
    const engine = createWorkflowEngine({
      workspacePath,
      sessionId: "terminal-no-approval-handler",
      verificationCommands: [],
      onPhaseChange: (phase) => phases.push(phase),
    });

    const result = await engine.run("Implement a multi file feature across several modules");

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("Approval is required");
    expect(engine.getTask().phase).toBe("failed");
    expect(phases).not.toContain("implementing");
  });
});