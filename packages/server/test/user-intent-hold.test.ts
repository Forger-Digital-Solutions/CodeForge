import { describe, expect, it } from "vitest";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { UserIntentHoldController } from "../src/user-intent-hold.js";

function setup() {
  const persistence = createSessionPersistence();
  persistence.upsertSession({
    id: "session-a",
    title: "hold test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
  });
  const eventStore = new EventStore();
  return { persistence, controller: new UserIntentHoldController({ eventStore, persistence, staleLeaseMs: 10 }), eventStore };
}

describe("CF-17 UserIntentHold", () => {
  it("blocks future dispatch, lets release unblock it, and rejects stale generations", async () => {
    const { persistence, controller } = setup();
    try {
      const entered = controller.request("session-a", "run-a", "turn-a");
      expect(entered.state).toBe("user_intent_hold");
      let dispatched = false;
      const pending = controller.waitForDispatch("session-a", "tool").then(() => { dispatched = true; });
      await Promise.resolve();
      expect(dispatched).toBe(false);
      expect(controller.release("session-a", entered.generation - 1)).toBe(false);
      expect(controller.release("session-a", entered.generation)).toBe(true);
      await pending;
      expect(dispatched).toBe(true);
      expect(controller.workAvoided("session-a")).toBe(1);
    } finally {
      persistence.close();
    }
  });

  it("keeps rapid steers ordered and idempotent, while model reconciliation has priority", async () => {
    const { persistence, controller } = setup();
    try {
      controller.request("session-a", "run-a", "turn-a");
      const first = controller.queueSteer("session-a", "run-a", "turn-a", "A", "steer-a");
      const duplicate = controller.queueSteer("session-a", "run-a", "turn-a", "A", "steer-a");
      controller.queueSteer("session-a", "run-a", "turn-a", "B", "steer-b");
      expect(duplicate).toEqual(first);
      expect(controller.queuedSteers("session-a").map((steer) => steer.message)).toEqual(["A", "B"]);
      await controller.waitForDispatch("session-a", "model");
      controller.beginReconciliation("session-a", "turn-a", ["steer-a", "steer-b"]);
      controller.completeReconciliation("session-a", "turn-a", ["steer-a", "steer-b"]);
      expect(controller.snapshot("session-a")?.state).toBe("running");
    } finally {
      persistence.close();
    }
  });

  it("reconstructs a hold and submitted steer from durable state after controller restart", () => {
    const { persistence, controller, eventStore } = setup();
    try {
      const entered = controller.request("session-a", "run-a", "turn-a");
      controller.queueSteer("session-a", "run-a", "turn-a", "keep adapter compatibility", "steer-1");
      const recovered = new UserIntentHoldController({ eventStore, persistence });
      expect(recovered.snapshot("session-a")?.generation).toBe(entered.generation);
      expect(recovered.queuedSteers("session-a").map((steer) => steer.steerId)).toEqual(["steer-1"]);
      expect(recovered.snapshot("session-a")?.state).toBe("steer_queued");
    } finally {
      persistence.close();
    }
  });

  it("records no savings when no dispatch boundary was eligible", () => {
    const { persistence, controller } = setup();
    try {
      controller.request("session-a", "run-a");
      expect(controller.workAvoided("session-a")).toBe(0);
    } finally {
      persistence.close();
    }
  });
});
