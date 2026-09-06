import { describe, expect, it } from "vitest";
import { WorkspaceEventSchema } from "@codeforge/protocol";
import { createEventStore, createSessionPersistence } from "@codeforge/sessions";
import { createWorkspaceEventAdapter } from "../src/workspace-event-adapter.js";

describe("WorkspaceEventAdapter run evidence", () => {
  it("uses one durable global sequence and attaches the workflow run to every emitted fact", async () => {
    const eventStore = createEventStore();
    const persistence = createSessionPersistence({ dbPath: ":memory:" });
    const workflow = createWorkspaceEventAdapter({ sessionId: "session", runId: "run-a", eventStore, persistence });
    const chat = createWorkspaceEventAdapter({ sessionId: "session", eventStore, persistence });

    workflow.emitTaskCreated("run-a", "Agent run", "autonomous");
    workflow.emitWorkflowVerificationCompleted("run-a", 1, {
      passed: 1,
      failed: 0,
      skipped: 0,
      durationMs: 5,
      verifiers: [{
        id: "test", kind: "test", command: "npm test", required: true, status: "passed",
        passed: 1, failed: 0, skipped: 0, exitCode: 0, durationMs: 5,
      }],
    });
    chat.emitTurnStarted("chat-turn", "hello");

    const live = eventStore.getBySession("session");
    const persisted = await persistence.getEvents("session");
    expect(live.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(persisted.map((event) => (event as { seq: number }).seq)).toEqual([1, 2, 3]);
    expect(live[0]?.runId).toBe("run-a");
    expect(live[1]?.runId).toBe("run-a");
    expect(live[2]?.runId).toBeUndefined();
    expect(WorkspaceEventSchema.safeParse(persisted[1]).success).toBe(true);

    await persistence.close();
  });

  it("redacts and bounds persisted Agent evidence before it reaches SSE or reload storage", async () => {
    const eventStore = createEventStore();
    const persistence = createSessionPersistence({ dbPath: ":memory:" });
    const adapter = createWorkspaceEventAdapter({ sessionId: "session", runId: "run-a", eventStore, persistence });
    const secret = "sk-proj-12345678901234567890";

    await adapter.emitFileChangeProposed("change", "src/example.ts", "modified", 1, 1, `Uses ${secret}`, `+const key = '${secret}'`);
    adapter.emitToolExecutionStarted("turn", "tool", "run_command", JSON.stringify({ token: secret }));
    adapter.emitToolExecutionCompleted("turn", "tool", "run_command", secret);
    adapter.emitToolExecutionCompleted("turn", "large-tool", "run_command", "safe-output-".repeat(4_000));

    const durableEvidence = JSON.stringify([...eventStore.getBySession("session"), ...(await persistence.getEvents("session"))]);
    expect(durableEvidence).not.toContain(secret);
    expect(durableEvidence).toContain("[truncated]");
    await persistence.close();
  });
});
