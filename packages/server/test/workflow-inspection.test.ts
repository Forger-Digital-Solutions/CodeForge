import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEventStore, createSessionPersistence, type WorkItem } from "@codeforge/sessions";
import { WorkflowService } from "../src/workflow-service.js";

const workspaces: string[] = [];

describe("WorkflowService run inspection evidence", () => {
  afterEach(() => {
    for (const workspace of workspaces.splice(0)) fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("persists an immutable Agent-run receipt without including an unrelated dirty user file", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codeforge-cf13-workflow-"));
    workspaces.push(workspace);
    fs.mkdirSync(path.join(workspace, "src"));
    fs.writeFileSync(path.join(workspace, "src", "calc.ts"), "export function add(a:number,b:number){return a - b}\n");
    fs.writeFileSync(path.join(workspace, "user-notes.txt"), "unrelated local notes\n");
    fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }));

    const eventStore = createEventStore();
    const persistenceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codeforge-cf16r-session-"));
    workspaces.push(persistenceDirectory);
    const persistencePath = path.join(persistenceDirectory, "workflow-evidence.sqlite");
    const persistence = createSessionPersistence({ dbPath: persistencePath });
    const service = new WorkflowService({ eventStore, persistence, workspacePath: workspace });
    const started = await service.startWorkflow({
      sessionId: "session-a",
      message: "Fix add function using sk-proj-12345678901234567890",
      verificationCommands: ["node -e \"process.exit(0)\""],
      forceHeuristic: true,
    });
    const workflow = service.getWorkflow(started.taskId);
    expect(workflow).toBeDefined();
    // The production workflow may legitimately pause for a plan approval. Resolve only the
    // authoritative pending record in this fixture, then bound the wait so this E2E cannot leak.
    const completion = workflow!.promise;
    for (let attempt = 0; attempt < 100; attempt++) {
      const pending = service.getApprovalService().getAllPending();
      for (const approval of pending) service.getApprovalService().resolve(approval.approvalId, "allow_once");
      const settled = await Promise.race([
        completion.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
      ]);
      if (settled) break;
      if (attempt === 99) throw new Error("workflow fixture did not settle within 2 seconds");
    }

    const inspection = (await persistence.getWorkItems("session-a")).find((item): item is Extract<WorkItem, { kind: "run_inspection" }> => item.kind === "run_inspection");
    expect(inspection).toBeDefined();
    expect(inspection).toMatchObject({ runId: started.taskId, executionMode: "agent" });
    expect(inspection?.diffs.map((diff) => diff.path)).toContain("src/calc.ts");
    expect(inspection?.diffs.map((diff) => diff.path)).not.toContain("user-notes.txt");
    expect(inspection?.verificationAttempts).toHaveLength(1);
    expect(inspection?.repairs).toEqual([]);
    expect(inspection?.verificationAttempts[0]?.verifiers[0]).toMatchObject({ command: "node -e \"process.exit(0)\"", exitCode: 0 });
    expect(inspection?.verification).toMatchObject({ verificationComplete: true, requiredCount: 1, satisfiedCount: 1 });
    expect(JSON.stringify(inspection)).not.toContain("sk-proj-12345678901234567890");

    const forgeVerifyRecords = (await persistence.getWorkItems("session-a")).filter((item) => item.kind === "verification");
    expect(forgeVerifyRecords.map((item) => item.recordType).sort()).toEqual(["attempt", "evidence", "plan"]);
    expect(forgeVerifyRecords.find((item) => item.recordType === "evidence")?.status).toBe("passed");

    const events = eventStore.getBySession("session-a");
    expect(events.filter((event) => event.runId === started.taskId).every((event) => event.runId === started.taskId)).toBe(true);
    expect(events.some((event) => event.type === "workflow.verification_completed")).toBe(true);
    expect(events.some((event) => event.type === "forgeverify.plan_created")).toBe(true);
    expect(events.some((event) => event.type === "forgeverify.evidence_created")).toBe(true);
    expect(events.some((event) => event.type === "workflow.completion_decided")).toBe(true);
    await persistence.close();
    const reloaded = createSessionPersistence({ dbPath: persistencePath });
    const recovered = (await reloaded.getWorkItems("session-a")).filter((item) => item.kind === "verification");
    expect(recovered).toHaveLength(3);
    expect(recovered.find((item) => item.recordType === "evidence")?.status).toBe("passed");
    await reloaded.close();
  });
});
