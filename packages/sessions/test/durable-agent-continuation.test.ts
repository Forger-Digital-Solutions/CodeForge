import { describe, expect, it } from "vitest";
import { createDesktopWorkerBridge, createDurableAgentContinuationStore, createSessionPersistence, type DurableAgentContinuation } from "../src/index.js";

describe("DurableAgentContinuationStore", () => {
  it("makes one persisted worker result available and claims its observation once", async () => {
    const persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    const now = new Date().toISOString();
    await persistence.upsertSession({ id: "session-a", title: "Continuation", status: "running", createdAt: now, updatedAt: now });
    const bridge = createDesktopWorkerBridge(persistence);
    const store = createDurableAgentContinuationStore(persistence);
    const action = { actionId: "55555555-5555-4555-8555-555555555555", workflowId: "workflow-a", turnId: "turn-a", sessionId: "session-a", workerId: "worker-a", type: "READ_FILE" as const, arguments: { path: "src/a.ts" }, idempotencyKey: "continuation-read" };
    await bridge.dispatch(action);
    const continuation: DurableAgentContinuation = {
      kind: "agent_continuation",
      id: "continuation-a",
      sessionId: "session-a",
      workflowId: "workflow-a",
      workflowRevision: 3,
      turnId: "turn-a",
      version: 2,
      state: "prepared",
      providerId: "provider-a",
      modelId: "model-a",
      messages: [{ role: "user", content: "Inspect file" }],
      pendingTool: { actionId: action.actionId, workerId: "worker-a", toolCallId: "tool-a", toolName: "read_file", argumentsJson: JSON.stringify(action.arguments), argumentsHash: "a".repeat(64) },
      createdAt: now,
      updatedAt: now,
    };
    await store.create(continuation);
    expect((await store.markActionIssued(continuation.id)).state).toBe("awaiting_worker");
    await bridge.recordResult({ actionId: action.actionId, workerId: "worker-a", status: "succeeded", output: "contents", changedResources: [] });
    expect((await store.markResultAvailable(action.actionId))?.state).toBe("result_available");
    const claim = await store.claimResult(continuation.id);
    expect(claim).toMatchObject({ continuation: { state: "result_consumed", workflowRevision: 3 }, result: { actionId: action.actionId, output: "contents" } });
    expect(await store.claimResult(continuation.id)).toBeUndefined();
    await persistence.close();
  });

  it("refuses to make a continuation resumable before its issued action has a result", async () => {
    const persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    const now = new Date().toISOString();
    await persistence.upsertSession({ id: "session-b", title: "Continuation", status: "running", createdAt: now, updatedAt: now });
    const bridge = createDesktopWorkerBridge(persistence);
    const store = createDurableAgentContinuationStore(persistence);
    const continuation: DurableAgentContinuation = {
      kind: "agent_continuation", id: "continuation-b", sessionId: "session-b", workflowId: "workflow-b", workflowRevision: 0, turnId: "turn-b", version: 2, state: "prepared",
      messages: [{ role: "user", content: "Inspect file" }],
      pendingTool: { actionId: "66666666-6666-4666-8666-666666666666", workerId: "worker-b", toolCallId: "tool-b", toolName: "read_file", argumentsJson: "{}", argumentsHash: "b".repeat(64) },
      createdAt: now, updatedAt: now,
    };
    await store.create(continuation);
    await expect(store.markActionIssued(continuation.id)).rejects.toThrow("not durably issued");
    await bridge.dispatch({ actionId: continuation.pendingTool.actionId, workflowId: continuation.workflowId, turnId: continuation.turnId, sessionId: continuation.sessionId, workerId: continuation.pendingTool.workerId, type: "READ_FILE", arguments: {}, idempotencyKey: "continuation-b-action" });
    expect((await store.rebindPrepared(continuation.id))?.state).toBe("awaiting_worker");
    await persistence.close();
  });

  it("persists context with the claim and leases concurrent resume attempts", async () => {
    const persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    const now = new Date().toISOString();
    await persistence.upsertSession({ id: "session-c", title: "Continuation", status: "running", createdAt: now, updatedAt: now });
    const bridge = createDesktopWorkerBridge(persistence);
    const store = createDurableAgentContinuationStore(persistence);
    const action = { actionId: "77777777-7777-4777-8777-777777777777", workflowId: "workflow-c", turnId: "turn-c", sessionId: "session-c", workerId: "worker-c", type: "READ_FILE" as const, arguments: { path: "src/c.ts" }, idempotencyKey: "continuation-c" };
    await bridge.dispatch(action);
    await store.create({
      kind: "agent_continuation", id: "continuation-c", sessionId: "session-c", workflowId: "workflow-c", workflowRevision: 0, turnId: "turn-c", version: 2,
      state: "prepared", providerId: "provider-c", modelId: "model-c", messages: [{ role: "user", content: "Inspect file" }],
      pendingTool: { actionId: action.actionId, workerId: action.workerId, toolCallId: "tool-c", toolName: "read_file", argumentsJson: JSON.stringify(action.arguments), argumentsHash: "c".repeat(64) },
      createdAt: now, updatedAt: now,
    });
    await store.markActionIssued("continuation-c");
    await bridge.recordResult({ actionId: action.actionId, workerId: action.workerId, status: "succeeded", output: "contents", changedResources: [] });
    await store.markResultAvailable(action.actionId);
    const observation = { resultId: action.actionId, toolCallId: "tool-c", output: "contents", success: true } as const;
    const messages = [{ role: "user" as const, content: "Inspect file" }, { role: "tool" as const, content: "contents", toolCallId: "tool-c" }];
    const firstClaim = await store.claimResultForResume({ continuationId: "continuation-c", ownerId: "88888888-8888-4888-8888-888888888888", messages, observation, leaseMs: 60_000 });
    const secondClaim = await store.claimResultForResume({ continuationId: "continuation-c", ownerId: "99999999-9999-4999-8999-999999999999", messages, observation, leaseMs: 60_000 });
    expect(firstClaim).toBeDefined();
    expect(secondClaim).toBeUndefined();
    const stored = await persistence.getWorkItem("continuation-c");
    expect(stored).toMatchObject({ kind: "agent_continuation", state: "result_consumed", resumeState: "leased", observation });
    if (!stored || stored.kind !== "agent_continuation") throw new Error("claimed continuation missing");
    expect(stored.messages.filter((message) => message.role === "tool" && message.toolCallId === "tool-c")).toHaveLength(1);
    await persistence.close();
  });
});
