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

describe("Agent Turn Recovery & State Persistence (CF-07)", () => {
  let tmpDir: string;
  let persistence: ReturnType<typeof createSessionPersistence>;
  let eventStore: EventStore;
  let firewall: ForgeZero;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-recovery-test-"));
    persistence = createSessionPersistence();
    eventStore = new EventStore();
    firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord());
  });

  afterEach(async () => {
    persistence.close();
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
    const turn = persistence.getTurn(turnId);

    expect(turn).toBeDefined();
    expect(turn?.sessionId).toBe("session-recovery-1");
    expect(turn?.userMessage).toBe("Initial instruction");
    expect(turn?.status).toBe("running");

    runtime.cancelTurn(turnId);
    const updatedTurn = persistence.getTurn(turnId);
    expect(updatedTurn?.status).toBe("cancelled");
  });

  it("classifies interrupted tool side effects conservatively without replaying them", () => {
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
    for (const record of records) persistence.upsertWorkItem(record as unknown as WorkItem);

    expect(classifyToolRecovery(records[0]!)).toBe("safe_to_retry");
    expect(classifyToolRecovery(records[1]!)).toBe("safe_to_retry");
    expect(classifyToolRecovery(records[2]!)).toBe("requires_revalidation");
    expect(classifyToolRecovery(records[3]!)).toBe("requires_revalidation");
    expect(classifyToolRecovery(records[4]!)).toBe("already_completed");
    expect(classifyToolRecovery(records[5]!)).toBe("unknown_side_effect");

    const recovered = recoverDurableToolExecutions(persistence, "run-recovery");
    expect(recovered.map((record) => record.recoveryDisposition)).toEqual([
      "safe_to_retry", "safe_to_retry", "requires_revalidation", "requires_revalidation", "already_completed", "unknown_side_effect",
    ]);
    expect(persistence.getWorkItem("write-started")).toMatchObject({ recoveryDisposition: "requires_revalidation" });
  });
});
