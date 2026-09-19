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

describe("EventStore.hydrate with a restarted sequence (R16)", () => {
  it("keeps every event and re-sequences chronologically when persisted seqs collide", () => {
    const store = new EventStore();
    // Two process lifetimes that both numbered from 1: the later run (small seqs, later timestamps)
    // must sort AFTER the earlier run instead of being interleaved before it or dropped.
    const early = (seq: number, type: string, ts: string) => makeEvent({ seq, type: type as WorkspaceEvent["type"], timestamp: ts, payload: { turnId: `e${seq}`, userMessage: "x" } as never });
    const persisted = [
      early(50, "turn.started", "2026-08-29T20:45:00.000Z"),
      early(51, "status.changed", "2026-08-29T20:45:01.000Z"),
      early(52, "task.state_changed", "2026-08-29T20:45:02.000Z"),
      early(5, "turn.failed", "2026-08-29T20:46:04.694Z"),
      early(6, "status.changed", "2026-08-29T20:46:04.700Z"),
      early(7, "agent.completed", "2026-08-29T20:46:04.701Z"),
      early(5, "turn.started", "2026-08-29T20:46:04.556Z"),
    ];
    store.hydrate(persisted);
    const all = store.getAll();
    expect(all).toHaveLength(7);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(all.map((e) => e.type)).toEqual(["turn.started", "status.changed", "task.state_changed", "turn.started", "turn.failed", "status.changed", "agent.completed"]);
    expect(store.getLastSeq()).toBe(7);
    store.append(makeEvent({ type: "turn.started" }));
    expect(store.getAll().at(-1)!.seq).toBe(8);
  });

  it("leaves a healthy monotonic history untouched", () => {
    const store = new EventStore();
    store.hydrate([makeEvent({ seq: 3 }), makeEvent({ seq: 1 }), makeEvent({ seq: 2 })]);
    expect(store.getAll().map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(store.getLastSeq()).toBe(3);
  });

  it("keeps orchestration records persisted without a seq and orders them by timestamp", () => {
    const store = new EventStore();
    const noSeq = (type: string, ts: string) =>
      ({ type, timestamp: ts, sessionId: "session-1", payload: {} }) as unknown as WorkspaceEvent;
    store.hydrate([
      makeEvent({ seq: 1, type: "turn.started", timestamp: "2026-09-19T22:00:00.000Z" }),
      noSeq("workstream.dispatched", "2026-09-19T22:00:01.000Z"),
      noSeq("workstream.blocked", "2026-09-19T22:00:05.000Z"),
      makeEvent({ seq: 2, type: "turn.completed", timestamp: "2026-09-19T22:00:10.000Z" }),
    ]);
    const all = store.getAll();
    expect(all).toHaveLength(4);
    expect(all.map((e) => e.type)).toEqual(["turn.started", "workstream.dispatched", "workstream.blocked", "turn.completed"]);
    expect(all.every((e) => Number.isSafeInteger(e.seq) && e.seq > 0)).toBe(true);
    expect(store.getLastSeq()).toBe(4);
  });
});
