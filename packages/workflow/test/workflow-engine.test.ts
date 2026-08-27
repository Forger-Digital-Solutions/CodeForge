import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";
import { createWorkflowEngine } from "../src/workflow-engine.js";

describe("WorkflowEngine — Real Autonomous Coding Workflow", () => {
  let ws: string;
  const approvePlan = async () => "allow_once" as const;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "wf-"));
    await mkdir(join(ws, "src"), { recursive: true });
    await writeFile(join(ws, "src", "calc.ts"), "export function add(a: number, b: number): number {\n  return a - b;\n}\n");
    await writeFile(join(ws, "src", "calc.test.ts"), "import { add } from './calc.js';\nif (add(2,3) !== 5) { console.log('FAIL'); process.exit(1); } console.log('PASS');\n");
    await writeFile(join(ws, "package.json"), JSON.stringify({ type: "module", name: "test" }));
  });
  afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

  it("turns natural-language task into disciplined workflow: Understand → Inspect → Context → Plan → Implement → Verify → Repair → Review → Summarize", async () => {
    const phases: string[] = [];
    const engine = createWorkflowEngine({
      workspacePath: ws,
      sessionId: "sess-1",
      onPhaseChange: (phase) => phases.push(phase),
      askForApproval: approvePlan,
      verificationCommands: ["node -e \"const fs=require('fs'); const c=fs.readFileSync('src/calc.ts','utf-8'); if(c.includes('a + b')){console.log('1 passed'); process.exit(0)} else {console.log('1 failed'); console.log('FAIL'); process.exit(1)}\""],
    });

    const result = await engine.run("Fix the add function that incorrectly returns a - b instead of a + b");

    expect(result.status).toBe("completed");
    expect(result.phase).toBe("completed");
    expect(phases).toContain("understanding");
    expect(phases).toContain("inspecting");
    expect(phases).toContain("building_context");
    expect(phases).toContain("planning");
    expect(phases).toContain("implementing");
    expect(phases).toContain("verifying");
    expect(phases).toContain("reviewing");
    expect(phases).toContain("summarizing");
    expect(phases).toContain("completed");

    expect(result.plan).toBeDefined();
    expect(result.verification).toBeDefined();
    expect(result.verification!.passed).toBeGreaterThan(0);
    expect(result.verification!.failed).toBe(0);
    expect(result.review).toBeDefined();
    expect(result.summary).toContain("Completed");

    const fixed = fs.readFileSync(join(ws, "src", "calc.ts"), "utf-8");
    expect(fixed).toContain("a + b");
    expect(result.diffSummary).toBeDefined();
    expect(result.diffSummary).toContain("calc.ts");
    expect(result.evidenceId).toBeDefined();
    expect(result.checkpointId).toBeDefined();
  });

  it("asks for approval when plan requires it", async () => {
    let approvalRequested = false;
    const engine = createWorkflowEngine({
      workspacePath: ws,
      sessionId: "sess-2",
      verificationCommands: ["node -e \"process.exit(0)\""],
      askForApproval: async () => {
        approvalRequested = true;
        return "allow_once";
      },
    });

    const result = await engine.run("Implement multi file feature for provider routing across several modules");
    expect(approvalRequested).toBe(true);
    expect(result.status).toBe("completed");
  });

  it("respects deny decision", async () => {
    const engine = createWorkflowEngine({
      workspacePath: ws,
      sessionId: "sess-3",
      verificationCommands: ["node -e \"process.exit(0)\""],
      askForApproval: async () => "deny",
    });
    const result = await engine.run("Delete database and reset schema — dangerous operation");
    // This task is high risk but our plan still requires approval; deny should fail
    // However our test task "Implement multi file feature" also requires approval; we test deny there
    const engine2 = createWorkflowEngine({
      workspacePath: ws,
      sessionId: "sess-3b",
      verificationCommands: ["node -e \"process.exit(0)\""],
      askForApproval: async () => "deny",
    });
    const result2 = await engine2.run("Implement multi file feature that touches many files");
    expect(result2.status).toBe("failed");
    expect(result2.summary).toContain("rejected");
  });

  it("handles repair loop when verification initially fails then recovers", async () => {
    // Start with buggy file; verification will fail first if we don't fix, but engine's defaultImplementer fixes a - b automatically.
    // To test repair loop, we make implementer initially not fix, then repair fixes.
    let implementCalls = 0;
    const engine = createWorkflowEngine({
      workspacePath: ws,
      sessionId: "sess-4",
      askForApproval: approvePlan,
      verificationCommands: ["node -e \"const c=require('fs').readFileSync('src/calc.ts','utf-8'); if(c.includes('a + b')){console.log('1 passed');} else {console.log('1 failed'); process.exit(1)}\""],
      implementer: async (step) => {
        if (step.kind === "edit" && implementCalls === 0) {
          implementCalls++;
          // Intentionally not fixing on first attempt
          return { success: true, diff: "skipped initial fix" };
        }
        // On repair loop second attempt, the repair logic inside engine will fix via heuristic directly on file, not via implementer.
        // So we need to allow default heuristic to run: we delegate to default by not handling?
        // For this test, we will manually fix file on second call
        if (implementCalls === 1) {
          const p = join(ws, "src/calc.ts");
          const content = fs.readFileSync(p, "utf-8");
          if (content.includes("a - b")) {
            fs.writeFileSync(p, content.replace("a - b", "a + b"), "utf-8");
          }
          implementCalls++;
          return { success: true };
        }
        return { success: true };
      },
    });

    // Reset to buggy
    await writeFile(join(ws, "src/calc.ts"), "export function add(a: number, b: number): number {\n  return a - b;\n}\n");
    const result = await engine.run("Fix add function");
    // Even if first implement skipped, repair should recover
    expect(result.verification).toBeDefined();
    expect(fs.readFileSync(join(ws, "src/calc.ts"), "utf-8")).toContain("a + b");
  });

  it("cancellation aborts workflow", async () => {
    const controller = new AbortController();
    const engine = createWorkflowEngine({
      workspacePath: ws,
      sessionId: "sess-5",
      signal: controller.signal,
      verificationCommands: ["node -e \"setTimeout(()=>process.exit(0), 5000)\""],
    });
    const promise = engine.run("Fix add function with long verification");
    controller.abort();
    const result = await promise;
    expect(result.status).toBe("cancelled");
  });

  it("re-test after repair succeeds", async () => {
    await writeFile(join(ws, "src", "calc.ts"), "export function add(a: number, b: number): number {\n  return a - b;\n}\n");
    const engine = createWorkflowEngine({
      workspacePath: ws,
      sessionId: "sess-6",
      askForApproval: approvePlan,
      verificationCommands: [
        "node -e \"const fs=require('fs'); const c=fs.readFileSync('src/calc.ts','utf-8'); if(c.includes('a + b')){console.log('1 passed'); process.exit(0)} else {console.log('1 failed'); process.exit(1)}\"",
      ],
    });
    const result = await engine.run("Fix add bug");
    expect(result.status).toBe("completed");
    expect(result.verification!.failed).toBe(0);
    expect(result.review!.diffs.length).toBeGreaterThan(0);
  });

  it("review diff summarizes changes and summarizes result", async () => {
    const engine = createWorkflowEngine({
      workspacePath: ws,
      sessionId: "sess-7",
      askForApproval: approvePlan,
      verificationCommands: ["node -e \"process.exit(0)\""],
    });
    const result = await engine.run("Fix add");
    expect(result.summary).toContain("Workflow Summary");
    expect(result.summary).toContain("Plan");
    expect(result.summary).toContain("Verification");
    expect(result.summary).toContain("Review");
  });

  it("secret redaction throughout workflow", async () => {
    await writeFile(join(ws, "src", "secret.ts"), "const s = 'sk-proj-1234567890abcdef';");
    const engine = createWorkflowEngine({
      workspacePath: ws,
      sessionId: "sess-8",
      askForApproval: approvePlan,
      verificationCommands: ["node -e \"process.exit(0)\""],
    });
    const result = await engine.run("Fix add and ensure secrets are redacted");
    expect(result.summary).not.toContain("sk-proj-1234567890");
    if (result.diffSummary) expect(result.diffSummary).not.toContain("sk-proj-1234567890");
  });

  it("simulates a long logical task through approval, model execution, repair, re-test, and completion", async () => {
    const phases: string[] = [];
    const events: string[] = [];
    const invocations: string[] = [];
    let approvals = 0;
    const engine = createWorkflowEngine({
      workspacePath: ws,
      sessionId: "sess-long-task",
      askForApproval: async () => {
        approvals++;
        return "allow_once";
      },
      onPhaseChange: (phase) => phases.push(phase),
      onEvent: (event) => events.push(event.type),
      verificationCommands: [
        "node -e \"const c=require('fs').readFileSync('src/calc.ts','utf8'); if(c.includes('a + b')){console.log('1 passed')}else{console.log('1 failed');console.log('FAIL src/calc.ts');process.exit(1)}\"",
      ],
      agentExecutor: {
        executePlan: async () => {
          invocations.push("model-plan");
          await Promise.resolve();
          return { success: true, output: "tool proposal completed without a valid fix" };
        },
        executeRepair: async () => {
          invocations.push("model-repair");
          await writeFile(join(ws, "src", "calc.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
          return { success: true, output: "bounded repair applied" };
        },
      },
    });

    const result = await engine.run("Fix add function through a long autonomous lifecycle");
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("Repair attempts: 1");
    expect(approvals).toBe(1);
    expect(invocations).toEqual(["model-plan", "model-repair"]);
    expect(phases.filter((phase) => phase === "verifying")).toHaveLength(2);
    expect(phases).toContain("repairing");
    expect(phases.at(-1)).toBe("completed");
    expect(events).toContain("workflow.implementation_started");
    expect(events).toContain("workflow.repair_attempted");
    expect(events.length).toBeLessThan(50);
  });
});
