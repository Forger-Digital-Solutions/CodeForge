import { describe, it, expect } from "vitest";
import type { WorkspaceEvent } from "@codeforge/protocol";
import { buildTimeline, hasAssistantProse } from "../src/timeline.js";
import { isEventForSession, mergeEvent } from "../src/session-events.js";

let seq = 0;
function ev(type: string, payload: unknown, sessionId = "s1"): WorkspaceEvent {
  return { type, payload, seq: ++seq, sessionId, timestamp: new Date().toISOString() } as unknown as WorkspaceEvent;
}
function reset() {
  seq = 0;
}

describe("buildTimeline — assistant prose reconstruction", () => {
  it("reconstructs a streamed assistant message from started + deltas + completed", () => {
    reset();
    const events = [
      ev("turn.started", { turnId: "t1", userMessage: "Explain the repo" }),
      ev("assistant.message.started", { turnId: "t1", messageId: "m1" }),
      ev("text.delta", { turnId: "t1", messageId: "m1", delta: "I'll inspect " }),
      ev("text.delta", { turnId: "t1", messageId: "m1", delta: "the catalog." }),
      ev("assistant.message.completed", { turnId: "t1", messageId: "m1", text: "I'll inspect the catalog." }),
    ];
    const tl = buildTimeline(events);
    expect(tl.map((i) => i.kind)).toEqual(["user", "assistant"]);
    const asst = tl[1] as Extract<(typeof tl)[number], { kind: "assistant" }>;
    expect(asst.text).toBe("I'll inspect the catalog.");
    expect(asst.streaming).toBe(false);
    expect(hasAssistantProse(tl)).toBe(true);
  });

  it("reconstructs prose on RELOAD from persisted boundaries even with no delta events", () => {
    reset();
    // Simulates hydration where only the boundary events survived (deltas are live-only in some transports).
    const events = [
      ev("turn.started", { turnId: "t1", userMessage: "hi" }),
      ev("assistant.message.started", { turnId: "t1", messageId: "m1" }),
      ev("assistant.message.completed", { turnId: "t1", messageId: "m1", text: "Final persisted answer." }),
    ];
    const asst = buildTimeline(events).find((i) => i.kind === "assistant") as any;
    expect(asst.text).toBe("Final persisted answer.");
    expect(asst.streaming).toBe(false);
  });

  it("interleaves assistant prose with tool activity in chronological order", () => {
    reset();
    const events = [
      ev("turn.started", { turnId: "t1", userMessage: "fix routing" }),
      ev("assistant.message.started", { turnId: "t1", messageId: "m1" }),
      ev("text.delta", { turnId: "t1", messageId: "m1", delta: "Inspecting the router." }),
      ev("assistant.message.completed", { turnId: "t1", messageId: "m1", text: "Inspecting the router." }),
      ev("tool.execution_started", { turnId: "t1", toolCallId: "c1", toolName: "read_file", argsJson: "{}" }),
      ev("tool.execution_completed", { turnId: "t1", toolCallId: "c1", toolName: "read_file", result: "ok" }),
      ev("assistant.message.started", { turnId: "t1", messageId: "m2" }),
      ev("assistant.message.completed", { turnId: "t1", messageId: "m2", text: "Fixed the invariant." }),
    ];
    const tl = buildTimeline(events);
    expect(tl.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect((tl[2] as any).status).toBe("completed");
    expect((tl[3] as any).text).toBe("Fixed the invariant.");
  });

  it("groups delta-only streams by turn when no messageId is present (back-compat)", () => {
    reset();
    const events = [
      ev("turn.started", { turnId: "t1", userMessage: "hi" }),
      ev("text.delta", { turnId: "t1", delta: "Hel" }),
      ev("text.delta", { turnId: "t1", delta: "lo" }),
    ];
    const tl = buildTimeline(events);
    const asst = tl.find((i) => i.kind === "assistant") as any;
    expect(asst.text).toBe("Hello");
  });

  it("reflects tool failure and blocked states", () => {
    reset();
    const events = [
      ev("tool.execution_started", { turnId: "t1", toolCallId: "c1", toolName: "run_command", argsJson: "{}" }),
      ev("tool.execution_failed", { turnId: "t1", toolCallId: "c1", toolName: "run_command", error: "boom" }),
      ev("tool.execution_started", { turnId: "t1", toolCallId: "c2", toolName: "write_file", argsJson: "{}" }),
      ev("tool.execution_blocked", { turnId: "t1", toolCallId: "c2", toolName: "write_file", reason: "needs approval" }),
    ];
    const tl = buildTimeline(events);
    expect((tl[0] as any).status).toBe("failed");
    expect((tl[1] as any).status).toBe("blocked");
  });

  it("is stable regardless of input event array order (sorts by seq)", () => {
    reset();
    const a = ev("turn.started", { turnId: "t1", userMessage: "hi" });
    const b = ev("assistant.message.completed", { turnId: "t1", messageId: "m1", text: "done" });
    const tl = buildTimeline([b, a]);
    expect(tl.map((i) => i.kind)).toEqual(["user", "assistant"]);
  });
});

describe("session isolation", () => {
  it("rejects events from other sessions and already-seen seqs", () => {
    expect(isEventForSession({ sessionId: "A", seq: 5 }, "A", 3)).toBe(true);
    expect(isEventForSession({ sessionId: "B", seq: 5 }, "A", 3)).toBe(false);
    expect(isEventForSession({ sessionId: "A", seq: 2 }, "A", 3)).toBe(false);
  });

  it("mergeEvent dedupes by seq (no duplicate rendering across replay/reconnect)", () => {
    reset();
    const e = ev("turn.started", { turnId: "t1", userMessage: "hi" });
    const list = mergeEvent([], e);
    expect(mergeEvent(list, e)).toBe(list); // same ref → no re-render
    expect(list).toHaveLength(1);
  });

  it("A/B isolation: a mixed stream filtered to session A builds only A's timeline", () => {
    reset();
    const mixed = [
      ev("turn.started", { turnId: "tA", userMessage: "A asks" }, "A"),
      ev("turn.started", { turnId: "tB", userMessage: "B asks" }, "B"),
      ev("assistant.message.completed", { turnId: "tA", messageId: "mA", text: "A answer" }, "A"),
      ev("assistant.message.completed", { turnId: "tB", messageId: "mB", text: "B answer" }, "B"),
    ];
    let lastSeq = 0;
    const forA: WorkspaceEvent[] = [];
    for (const e of mixed) {
      if (isEventForSession(e, "A", lastSeq)) {
        lastSeq = e.seq;
        forA.push(e);
      }
    }
    const tl = buildTimeline(forA);
    expect(tl.every((i) => !("text" in i) || !String((i as any).text).includes("B"))).toBe(true);
    expect((tl.find((i) => i.kind === "assistant") as any).text).toBe("A answer");
    expect(tl.filter((i) => i.kind === "user")).toHaveLength(1);
  });
});
