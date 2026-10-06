import { describe, expect, it } from "vitest";
import { EventStore, createSessionPersistence, type WorkItem } from "@codeforge/sessions";
import { WorkflowService } from "../src/workflow-service.js";

describe("terminal task reconciliation", () => {
  it.each(["failed", "blocked"] as const)("settles a persisted approval wait when its owning task is %s", async (status) => {
    const persistence = createSessionPersistence();
    await persistence.init();
    try {
      const now = new Date().toISOString();
      await persistence.upsertSession({ id: "terminal-session", title: "Task", status, createdAt: now, updatedAt: now });
      await persistence.upsertTurn({ id: "orphaned-turn", sessionId: "terminal-session", seq: 1, userMessage: "edit", status: "waiting_for_approval", startedAt: now });
      await persistence.upsertWorkItem({
        kind: "approval", id: "orphaned-approval", sessionId: "terminal-session", turnId: "orphaned-turn",
        tool: "edit_file", action: "edit_file", description: "edit", risk: "moderate", createdAt: now,
      } as WorkItem);

      const service = new WorkflowService({ eventStore: new EventStore(), persistence });
      await service.init();

      expect(await persistence.getTurn("orphaned-turn")).toMatchObject({ status });
      expect(await persistence.getSession("terminal-session")).toMatchObject({ status });
      expect(await persistence.getWorkItem("orphaned-approval")).toMatchObject({ cancellationReason: "Task ended" });
    } finally {
      await persistence.close();
    }
  });
});
