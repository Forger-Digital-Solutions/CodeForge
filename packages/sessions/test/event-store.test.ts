import { describe, expect, it } from "vitest";
import { EventStore } from "@codeforge/sessions";
import type { WorkspaceEvent } from "@codeforge/protocol";

function makeEvent(overrides: Partial<WorkspaceEvent> = {}): WorkspaceEvent {
  return {
    type: "turn.started",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId: "default",
    payload: { turnId: "turn-1", userMessage: "Hello" },
    ...overrides,
  };
}

describe("EventStore", () => {
  it("appends events and assigns sequence numbers", () => {
    const store = new EventStore();
    const e1 = makeEvent({ type: "turn.started", seq: 0 });
    const e2 = makeEvent({ type: "turn.completed", seq: 0 });

    store.append(e1);
    store.append(e2);

    const all = store.getAll();
    expect(all).toHaveLength(2);
    expect(all[0]!.seq).toBe(1);
    expect(all[1]!.seq).toBe(2);
  });

  it("filters by sessionId", () => {
    const store = new EventStore();
    store.append(makeEvent({ sessionId: "a" }));
    store.append(makeEvent({ sessionId: "b" }));
    store.append(makeEvent({ sessionId: "a" }));

    const aEvents = store.getAll({ sessionId: "a" });
    expect(aEvents).toHaveLength(2);
    expect(aEvents.every((e) => e.sessionId === "a")).toBe(true);
  });

  it("filters by event types", () => {
    const store = new EventStore();
    store.append(makeEvent({ type: "turn.started" }));
    store.append(makeEvent({ type: "turn.completed" }));
    store.append(makeEvent({ type: "turn.started" }));

    const started = store.getAll({ types: ["turn.started"] });
    expect(started).toHaveLength(2);
    expect(started.every((e) => e.type === "turn.started")).toBe(true);
  });

  it("filters by afterSeq", () => {
    const store = new EventStore();
    store.append(makeEvent({ seq: 0 }));
    store.append(makeEvent({ seq: 0 }));
    store.append(makeEvent({ seq: 0 }));

    const afterFirst = store.getAll({ afterSeq: 1 });
    expect(afterFirst).toHaveLength(2);
    expect(afterFirst[0]!.seq).toBe(2);
    expect(afterFirst[1]!.seq).toBe(3);
  });

  it("applies limit from end", () => {
    const store = new EventStore();
    for (let i = 0; i < 5; i++) {
      store.append(makeEvent({ seq: 0 }));
    }

    const last2 = store.getAll({ limit: 2 });
    expect(last2).toHaveLength(2);
    expect(last2[0]!.seq).toBe(4);
    expect(last2[1]!.seq).toBe(5);
  });

  it("getBySession returns events for a session", () => {
    const store = new EventStore();
    store.append(makeEvent({ sessionId: "a" }));
    store.append(makeEvent({ sessionId: "b" }));

    expect(store.getBySession("a")).toHaveLength(1);
    expect(store.getBySession("b")).toHaveLength(1);
    expect(store.getBySession("c")).toHaveLength(0);
  });

  it("tracks last sequence number", () => {
    const store = new EventStore();
    expect(store.getLastSeq()).toBe(0);
    store.append(makeEvent({ seq: 0 }));
    expect(store.getLastSeq()).toBe(1);
    store.append(makeEvent({ seq: 0 }));
    expect(store.getLastSeq()).toBe(2);
  });

  it("notifies subscribers on append", () => {
    const store = new EventStore();
    const received: WorkspaceEvent[] = [];
    const unsub = store.subscribe((e) => received.push(e));

    store.append(makeEvent({ type: "turn.started" }));
    store.append(makeEvent({ type: "turn.completed" }));

    expect(received).toHaveLength(2);
    unsub();
    store.append(makeEvent({ type: "turn.started" }));
    expect(received).toHaveLength(2);
  });

  it("supports multiple subscribers", () => {
    const store = new EventStore();
    const a: WorkspaceEvent[] = [];
    const b: WorkspaceEvent[] = [];
    store.subscribe((e) => a.push(e));
    store.subscribe((e) => b.push(e));

    store.append(makeEvent({}));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("receives events after subscription", () => {
    const store = new EventStore();
    store.append(makeEvent({}));

    const received: WorkspaceEvent[] = [];
    const unsub = store.subscribe((e) => received.push(e));
    store.append(makeEvent({}));

    expect(received).toHaveLength(1);
    unsub();
  });

  it("does not duplicate deliveries", () => {
    const store = new EventStore();
    const received: WorkspaceEvent[] = [];
    store.subscribe((e) => received.push(e));

    store.append(makeEvent({}));
    store.append(makeEvent({}));
    expect(received).toHaveLength(2);
  });

  it("maintains ordering", () => {
    const store = new EventStore();
    const received: WorkspaceEvent[] = [];
    store.subscribe((e) => received.push(e));

    for (let i = 0; i < 10; i++) {
      store.append(makeEvent({ seq: 0, payload: { turnId: `turn-${i}` } }));
    }

    for (let i = 0; i < 10; i++) {
      expect(received[i]!.payload.turnId).toBe(`turn-${i}`);
      expect(received[i]!.seq).toBe(i + 1);
    }
  });

  it("clear resets store", () => {
    const store = new EventStore();
    store.append(makeEvent({}));
    store.append(makeEvent({}));
    store.clear();
    expect(store.getAll()).toHaveLength(0);
    expect(store.getLastSeq()).toBe(0);
  });

  it("hydrates persisted events and continues the global sequence", () => {
    const store = new EventStore();
    store.hydrate([
      makeEvent({ sessionId: "session-1", type: "turn.started", seq: 4 }),
      makeEvent({ sessionId: "session-1", type: "turn.completed", seq: 5 }),
    ]);
    expect(store.getAll().map((event) => event.seq)).toEqual([4, 5]);
    store.append(makeEvent({ sessionId: "session-1", type: "turn.started", seq: 1 }));
    expect(store.getLastSeq()).toBe(6);
  });
});
