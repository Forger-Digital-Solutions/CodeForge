import { describe, expect, it } from "vitest";
import { WorkspaceEventSchema } from "../src/workspace-events.js";

const base = { sessionId: "session", runId: "run", seq: 1, timestamp: "2026-09-04T12:00:00.000Z" };

describe("run inspection event protocol", () => {
  it("accepts structured verification evidence only when every verifier has a canonical result", () => {
    const valid = WorkspaceEventSchema.safeParse({
      ...base,
      type: "workflow.verification_completed",
      payload: {
        taskId: "run", attempt: 1, notConfigured: false, passed: 1, failed: 0, skipped: 0, durationMs: 12,
        verifiers: [{ id: "test", kind: "test", command: "npm test", required: true, status: "passed", passed: 1, failed: 0, skipped: 0, exitCode: 0, durationMs: 12 }],
      },
    });
    expect(valid.success).toBe(true);

    const invalid = WorkspaceEventSchema.safeParse({
      ...base,
      type: "workflow.verification_completed",
      payload: { taskId: "run", attempt: 1, notConfigured: false, passed: 1, failed: 0, skipped: 0, durationMs: 12, verifiers: [{ id: "test" }] },
    });
    expect(invalid.success).toBe(false);
  });

  it("allows Agent evidence to be scoped to a run but does not require Chat events to invent one", () => {
    expect(WorkspaceEventSchema.safeParse({
      ...base,
      type: "task.created",
      payload: { taskId: "run", title: "Agent work", mode: "autonomous" },
    }).success).toBe(true);
    expect(WorkspaceEventSchema.safeParse({
      sessionId: "session", seq: 2, timestamp: "2026-09-04T12:00:01.000Z",
      type: "turn.started", payload: { turnId: "chat", userMessage: "hello" },
    }).success).toBe(true);
  });
});
