import { describe, expect, it } from "vitest";
import { createSessionPersistence } from "@codeforge/sessions";
import { createDesktopWorkerBridge, DesktopWorkerExecutor } from "../src/desktop-worker-bridge.js";

const request = {
  actionId: "11111111-1111-4111-8111-111111111111",
  workflowId: "workflow-1",
  turnId: "turn-1",
  sessionId: "session-1",
  workerId: "desktop-1",
  type: "WRITE_PATCH" as const,
  arguments: { path: "src/example.ts", patch: "example" },
  idempotencyKey: "logical-write-1",
  expectedWorkspaceRevision: "head-1",
};

async function initializedPersistence() {
  const persistence = createSessionPersistence({ dbPath: ":memory:" });
  await persistence.init();
  const now = new Date().toISOString();
  await persistence.upsertSession({ id: request.sessionId, title: "desktop worker test", createdAt: now, updatedAt: now, status: "running" });
  return persistence;
}

describe("DesktopWorkerBridge", () => {
  it("pins an action to its worker and suppresses duplicate delivery", async () => {
    const persistence = await initializedPersistence();
    const bridge = createDesktopWorkerBridge(persistence);
    expect((await bridge.dispatch(request)).duplicate).toBe(false);
    expect((await bridge.dispatch(request)).duplicate).toBe(true);
    expect(await bridge.pending("desktop-1")).toHaveLength(1);
    expect(await bridge.pending("desktop-2")).toHaveLength(0);
    await expect(bridge.recordResult({ actionId: request.actionId, workerId: "desktop-2", status: "succeeded", output: "no" })).rejects.toThrow(/not authorized/);
    await persistence.close();
  });

  it("replays a locally durable result when delivery was lost after execution", async () => {
    const persistence = await initializedPersistence();
    const executor = new DesktopWorkerExecutor(persistence);
    let executions = 0;
    const handler = async () => {
      executions++;
      return { status: "succeeded" as const, output: "patch applied", changedResources: ["src/example.ts"], workspaceRevision: "head-2" };
    };
    const first = await executor.execute(request, handler);
    const replay = await executor.execute(request, handler);
    expect(first.output).toBe("patch applied");
    expect(replay).toEqual(first);
    expect(executions).toBe(1);
    await persistence.close();
  });
});
