import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog } from "@codeforge/providers";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { createAgentRuntime } from "../src/agent-runtime.js";
import { classifyToolRecovery, recoverDurableToolExecutions, type DurableToolExecutionRecord } from "../src/agent-runtime.js";
import type { WorkItem } from "@codeforge/sessions";
import { UserIntentHoldController } from "../src/user-intent-hold.js";

describe("Agent Turn Recovery & State Persistence (CF-07)", () => {
  let tmpDir: string;
  let persistence: ReturnType<typeof createSessionPersistence>;
  let eventStore: EventStore;
  let firewall: ForgeZero;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-recovery-test-"));
    persistence = createSessionPersistence();
    await persistence.init();
    eventStore = new EventStore();
    firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord());
  });

  afterEach(async () => {
    await persistence.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("persists turn records to SQLite backing store and recovers status", async () => {
    const catalog = new InMemoryProviderCatalog();
    const runtime = createAgentRuntime({
      sessionId: "session-recovery-1",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: tmpDir,
      demoMode: true,
    });

    const turnId = await runtime.startTurn("Initial instruction");
    const turn = await persistence.getTurn(turnId);

    expect(turn).toBeDefined();
    expect(turn?.sessionId).toBe("session-recovery-1");
    expect(turn?.userMessage).toBe("Initial instruction");
    expect(turn?.status).toBe("running");

    await runtime.cancelTurn(turnId);
    const updatedTurn = await persistence.getTurn(turnId);
    expect(updatedTurn?.status).toBe("cancelled");
  });

  it("classifies interrupted tool side effects conservatively without replaying them", async () => {
    const now = new Date().toISOString();
    persistence.upsertSession({ id: "session-recovery-1", title: "Recovery", status: "running", createdAt: now, updatedAt: now });
    const makeRecord = (id: string, executionClass: DurableToolExecutionRecord["executionClass"], state: DurableToolExecutionRecord["state"]): DurableToolExecutionRecord => ({
      kind: "agent_tool_execution", id, sessionId: "session-recovery-1", runId: "run-recovery", agentId: "coder", turnId: "turn-1", toolName: "tool", argumentsHash: "hash", executionClass, state,
      recoveryDisposition: "blocked", createdAt: now, updatedAt: now,
    });
    const records = [
      makeRecord("read-started", "read_only", "started"),
      makeRecord("write-requested", "write", "requested"),
      makeRecord("write-started", "write", "started"),
      makeRecord("write-completed", "write", "completed"),
      makeRecord("write-observed", "write", "observation_recorded"),
      makeRecord("command-started", "command", "started"),
    ];
    for (const record of records) await persistence.upsertWorkItem(record as unknown as WorkItem);

    expect(classifyToolRecovery(records[0]!)).toBe("safe_to_retry");
    expect(classifyToolRecovery(records[1]!)).toBe("safe_to_retry");
    expect(classifyToolRecovery(records[2]!)).toBe("requires_revalidation");
    expect(classifyToolRecovery(records[3]!)).toBe("requires_revalidation");
    expect(classifyToolRecovery(records[4]!)).toBe("already_completed");
    expect(classifyToolRecovery(records[5]!)).toBe("unknown_side_effect");

    const recovered = await recoverDurableToolExecutions(persistence, "run-recovery");
    expect(recovered.map((record) => record.recoveryDisposition)).toEqual([
      "safe_to_retry", "safe_to_retry", "requires_revalidation", "requires_revalidation", "already_completed", "unknown_side_effect",
    ]);
    expect(await persistence.getWorkItem("write-started")).toMatchObject({ recoveryDisposition: "requires_revalidation" });
  });

  it("CF-17 runtime recovery hydrates queued intent once and requires a fresh replan", async () => {
    const now = new Date().toISOString();
    const sessionId = "cf17-restart";
    const turnId = "cf17-turn";
    await persistence.upsertSession({ id: sessionId, title: "original task", status: "running", createdAt: now, updatedAt: now });
    await persistence.upsertTurn({ id: turnId, sessionId, seq: 1, userMessage: "implement the original behavior", status: "running", startedAt: now });
    await persistence.upsertWorkItem({
      kind: "agent_tool_execution", id: "cf17-command", sessionId, runId: turnId, agentId: "agent", turnId,
      toolName: "run_command", argumentsHash: "redacted", executionClass: "command", state: "started",
      recoveryDisposition: "blocked", createdAt: now, updatedAt: now,
    });
    const hold = new UserIntentHoldController({ eventStore, persistence });
    await hold.init();
    await hold.queueSteer(sessionId, turnId, turnId, "use the revised behavior", "cf17-steer");

    const runtime = createAgentRuntime({ sessionId, eventStore, persistence, firewall, providerCatalog: new InMemoryProviderCatalog(), workspacePath: tmpDir, demoMode: true, userIntentHold: hold });
    await runtime.init();
    expect(runtime.getTurn(turnId)).toMatchObject({ status: "recovering", userMessage: "implement the original behavior" });
    expect(hold.queuedSteers(sessionId)).toEqual([expect.objectContaining({ steerId: "cf17-steer", message: "use the revised behavior" })]);
    expect(await persistence.getWorkItem("cf17-command")).toMatchObject({ recoveryDisposition: "unknown_side_effect" });
    expect(await persistence.getWorkItem(`agent-turn-recovery-${turnId}`)).toMatchObject({ state: "replan_required", staleExecutionCount: 1 });

    const restartedHold = new UserIntentHoldController({ eventStore: new EventStore(), persistence });
    await restartedHold.init();
    const restarted = createAgentRuntime({ sessionId, eventStore: new EventStore(), persistence, firewall, providerCatalog: new InMemoryProviderCatalog(), workspacePath: tmpDir, demoMode: true, userIntentHold: restartedHold });
    await restarted.init();
    expect(restarted.getTurn(turnId)).toMatchObject({ status: "recovering", userMessage: "implement the original behavior" });
    expect(await persistence.getWorkItem(`agent-turn-recovery-${turnId}`)).toMatchObject({ generation: 1, state: "replan_required" });
  });

  it("CF-17 runtime recovery restores a pending approval without restoring its tool continuation", async () => {
    const now = new Date().toISOString();
    const sessionId = "cf17-approval";
    const turnId = "cf17-approval-turn";
    await persistence.upsertSession({ id: sessionId, title: "approval", status: "waiting_for_approval", createdAt: now, updatedAt: now });
    await persistence.upsertTurn({ id: turnId, sessionId, seq: 1, userMessage: "write a file", status: "waiting_for_approval", startedAt: now });
    await persistence.upsertWorkItem({
      kind: "approval", id: "approval-restart", sessionId, turnId, tool: "write_file", action: "write", description: "write a file", risk: "moderate", createdAt: now,
    });
    const runtime = createAgentRuntime({ sessionId, eventStore, persistence, firewall, providerCatalog: new InMemoryProviderCatalog(), workspacePath: tmpDir, demoMode: true });
    await runtime.init();
    expect(runtime.getTurn(turnId)?.status).toBe("waiting_for_approval");
    expect(runtime.getPendingApproval("approval-restart")).toBeDefined();

    await runtime.resolveApproval("approval-restart", "allow_once");
    expect(runtime.getTurn(turnId)?.status).toBe("recovering");
    expect(await persistence.getWorkItem("approval-restart")).toMatchObject({ decision: "allow_once" });
    expect(await persistence.getWorkItem(`agent-turn-recovery-${turnId}`)).toMatchObject({ state: "replan_required" });
  });

  it("CF-17 runtime recovery never resurrects a terminal turn", async () => {
    const now = new Date().toISOString();
    await persistence.upsertSession({ id: "cf17-terminal", title: "done", status: "completed", createdAt: now, updatedAt: now });
    await persistence.upsertTurn({ id: "cf17-terminal-turn", sessionId: "cf17-terminal", seq: 1, userMessage: "done", status: "completed", startedAt: now, completedAt: now });
    const runtime = createAgentRuntime({ sessionId: "cf17-terminal", eventStore, persistence, firewall, providerCatalog: new InMemoryProviderCatalog(), workspacePath: tmpDir, demoMode: true });
    await runtime.init();
    expect(runtime.getTurn("cf17-terminal-turn")).toBeUndefined();
    expect(runtime.getActiveTurns()).toEqual([]);
  });
});
