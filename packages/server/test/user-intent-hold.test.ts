import { describe, expect, it } from "vitest";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { UserIntentHoldController } from "../src/user-intent-hold.js";

async function setup() {
  const persistence = createSessionPersistence();
  await persistence.init();
  await persistence.upsertSession({
    id: "session-a",
    title: "hold test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
  });
  const eventStore = new EventStore();
  const controller = new UserIntentHoldController({ eventStore, persistence, staleLeaseMs: 10 });
  await controller.init();
  return { persistence, controller, eventStore };
}

describe("CF-17 UserIntentHold", () => {
  it("blocks future dispatch, lets release unblock it, and rejects stale generations", async () => {
    const { persistence, controller } = await setup();
    try {
      const entered = await controller.request("session-a", "run-a", "turn-a");
      expect(entered.state).toBe("user_intent_hold");
      let dispatched = false;
      const pending = controller.waitForDispatch("session-a", "tool").then(() => { dispatched = true; });
      await Promise.resolve();
      expect(dispatched).toBe(false);
      expect(await controller.release("session-a", entered.generation - 1)).toBe(false);
      expect(await controller.release("session-a", entered.generation)).toBe(true);
      await pending;
      expect(dispatched).toBe(true);
      expect(controller.workAvoided("session-a")).toBe(1);
    } finally {
      await persistence.close();
    }
  });

  it("keeps rapid steers ordered and idempotent, while model reconciliation has priority", async () => {
    const { persistence, controller } = await setup();
    try {
      await controller.request("session-a", "run-a", "turn-a");
      const first = await controller.queueSteer("session-a", "run-a", "turn-a", "A", "steer-a");
      const duplicate = await controller.queueSteer("session-a", "run-a", "turn-a", "A", "steer-a");
      await controller.queueSteer("session-a", "run-a", "turn-a", "B", "steer-b");
      expect(duplicate).toEqual(first);
      expect(controller.queuedSteers("session-a").map((steer) => steer.message)).toEqual(["A", "B"]);
      await controller.waitForDispatch("session-a", "model");
      await controller.beginReconciliation("session-a", "turn-a", ["steer-a", "steer-b"]);
      await controller.completeReconciliation("session-a", "turn-a", ["steer-a", "steer-b"]);
      expect(controller.snapshot("session-a")?.state).toBe("running");
    } finally {
      await persistence.close();
    }
  });

  it("reconstructs a hold and submitted steer from durable state after controller restart", async () => {
    const { persistence, controller, eventStore } = await setup();
    try {
      const entered = await controller.request("session-a", "run-a", "turn-a");
      await controller.queueSteer("session-a", "run-a", "turn-a", "keep adapter compatibility", "steer-1");
      const recovered = new UserIntentHoldController({ eventStore, persistence });
      await recovered.init();
      expect(recovered.snapshot("session-a")?.generation).toBe(entered.generation);
      expect(recovered.queuedSteers("session-a").map((steer) => steer.steerId)).toEqual(["steer-1"]);
      expect(recovered.snapshot("session-a")?.state).toBe("steer_queued");
    } finally {
      await persistence.close();
    }
  });

  it("records no savings when no dispatch boundary was eligible", async () => {
    const { persistence, controller } = await setup();
    try {
      await controller.request("session-a", "run-a");
      expect(controller.workAvoided("session-a")).toBe(0);
    } finally {
      await persistence.close();
    }
  });

  it("terminalizes a held turn without allowing its queued steer to affect a later turn", async () => {
    const { persistence, controller } = await setup();
    try {
      await controller.request("session-a", "run-a", "turn-a");
      await controller.queueSteer("session-a", "run-a", "turn-a", "do not continue", "steer-a");
      let released = false;
      const pending = controller.waitForDispatch("session-a", "tool").then(() => { released = true; });
      await Promise.resolve();
      await controller.resolveForTerminal("session-a", "turn-a");
      await pending;
      expect(released).toBe(true);
      expect(controller.snapshot("session-a")).toMatchObject({ state: "running", reason: "terminal", queuedSteers: [] });
      expect(controller.hasQueuedSteer("session-a")).toBe(false);
    } finally {
      await persistence.close();
    }
  });
});
