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

  it("renders a user prompt once when a turn-start event is replayed", () => {
    reset();
    const first = ev("turn.started", { turnId: "t1", userMessage: "hi" });
    const replay = ev("turn.started", { turnId: "t1", userMessage: "hi" });

    const tl = buildTimeline([first, replay]);

    expect(tl.filter((item) => item.kind === "user")).toHaveLength(1);
  });
});

describe("buildTimeline — tool rows carry their target and own their file events", () => {
  // Exactly the event order the runtime emits for one read_file call.
  const readCall = (id: string, path: string, lines: number) => [
    ev("tool.call_started", { turnId: "t1", toolCallId: id, toolName: "read_file" }),
    ev("tool.call_completed", { turnId: "t1", toolCallId: id, toolName: "read_file", argsJson: JSON.stringify({ path }) }),
    ev("tool.execution_started", { turnId: "t1", toolCallId: id, toolName: "read_file", argsJson: JSON.stringify({ path }) }),
    ev("file.read", { fileCallId: `f-${id}`, path, lines }),
    ev("tool.execution_completed", { turnId: "t1", toolCallId: id, toolName: "read_file", result: ["hash: abc", ...Array.from({ length: lines }, () => "x")].join("\n") }),
  ];

  it("picks up the arguments that arrive after the call is announced", () => {
    reset();
    const tl = buildTimeline([ev("turn.started", { turnId: "t1", userMessage: "go" }), ...readCall("c1", "src/index.ts", 6)]);
    const tool = tl.find((i) => i.kind === "tool") as any;
    expect(tool.argsJson).toBe(JSON.stringify({ path: "src/index.ts" }));
    expect(tool.status).toBe("completed");
  });

  it("shows one row per read, carrying the file's own line count", () => {
    reset();
    const tl = buildTimeline([ev("turn.started", { turnId: "t1", userMessage: "go" }), ...readCall("c1", "src/index.ts", 6), ...readCall("c2", "test/helpers.ts", 16)]);
    expect(tl.map((i) => i.kind)).toEqual(["user", "tool", "tool"]);
    expect((tl[1] as any).fileDetail).toBe("6 lines");
    expect((tl[2] as any).fileDetail).toBe("16 lines");
  });

  it("folds a write into its edit_file row, and keeps standalone file events when no tool owns them", () => {
    reset();
    const tl = buildTimeline([
      ev("turn.started", { turnId: "t1", userMessage: "go" }),
      ev("tool.call_started", { turnId: "t1", toolCallId: "e1", toolName: "edit_file" }),
      ev("tool.call_completed", { turnId: "t1", toolCallId: "e1", toolName: "edit_file", argsJson: JSON.stringify({ path: "src\\types.ts", oldText: "a", newText: "b" }) }),
      ev("tool.execution_started", { turnId: "t1", toolCallId: "e1", toolName: "edit_file", argsJson: JSON.stringify({ path: "src\\types.ts", oldText: "a", newText: "b" }) }),
      ev("file.written", { fileCallId: "w1", path: "src/types.ts", bytesOrChars: 724 }),
      ev("tool.execution_completed", { turnId: "t1", toolCallId: "e1", toolName: "edit_file", result: "ok" }),
      // The heuristic implementer writes without a tool call: that still needs a row.
      ev("file.written", { fileCallId: "w2", path: "src/feature.ts", bytesOrChars: 10 }),
    ]);
    expect(tl.map((i) => i.kind)).toEqual(["user", "tool", "file"]);
    expect((tl[1] as any).fileDetail).toBe("written");
    expect((tl[2] as any).path).toBe("src/feature.ts");
  });
});

describe("buildTimeline — command executions fold into their owning run_command call", () => {
  const runCommand = (id: string, command: string) => [
    ev("tool.call_started", { turnId: "t1", toolCallId: id, toolName: "run_command" }),
    ev("tool.execution_started", { turnId: "t1", toolCallId: id, toolName: "run_command", argsJson: JSON.stringify({ command }) }),
  ];

  it("replaces the owning tool row instead of showing the same command twice", () => {
    reset();
    const tl = buildTimeline([
      ev("turn.started", { turnId: "t1", userMessage: "fix it" }),
      ...runCommand("c1", "npm test"),
      ev("command.executed", { commandId: "x1", command: "npm test", output: "4 passed", exitCode: 0 }),
      ev("tool.execution_completed", { turnId: "t1", toolCallId: "c1", toolName: "run_command", result: "4 passed" }),
    ]);
    expect(tl.map((i) => i.kind)).toEqual(["user", "command"]);
    expect((tl[1] as any)).toMatchObject({ command: "npm test", exitCode: 0, output: "4 passed" });
  });

  it("keeps a standalone command row when no run_command call owns it", () => {
    reset();
    const tl = buildTimeline([
      ev("turn.started", { turnId: "t1", userMessage: "go" }),
      ev("command.executed", { commandId: "x1", command: "npm run build", output: "ok", exitCode: 0 }),
    ]);
    expect(tl.map((i) => i.kind)).toEqual(["user", "command"]);
  });

  it("does not steal the wrong call's row when a different command is in flight", () => {
    reset();
    const tl = buildTimeline([
      ev("turn.started", { turnId: "t1", userMessage: "go" }),
      ...runCommand("c1", "npm test"),
      ev("command.executed", { commandId: "x1", command: "npm run lint", output: "clean", exitCode: 0 }),
    ]);
    expect(tl.map((i) => i.kind)).toEqual(["user", "tool", "command"]);
  });

  it("shows subagent lifecycle so delegated work is visible in the conversation", () => {
    reset();
    const tl = buildTimeline([
      ev("turn.started", { turnId: "t1", userMessage: "audit the repo" }),
      ev("subagent.started", { agentId: "a1", role: "Explorer", task: "Map the routes" }),
      ev("subagent.completed", { agentId: "a1", result: "done" }),
    ]);
    const rows = tl.filter((i) => i.kind === "subagent") as Array<Extract<(typeof tl)[number], { kind: "subagent" }>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agentId: "a1", role: "Explorer", task: "Map the routes", status: "completed", result: "done" });
  });
});

describe("buildTimeline — streaming command lifecycle", () => {
  it("reconstructs one live row from started → output → completed", () => {
    reset();
    const tl = buildTimeline([
      ev("turn.started", { turnId: "t1", userMessage: "run tests" }),
      ev("command.started", { commandId: "c1", command: "npm test", workingDirectory: "G:/repo" }),
      ev("command.output", { commandId: "c1", output: "running…\n", stream: "stdout" }),
      ev("command.output", { commandId: "c1", output: "5 passed\n", stream: "stdout" }),
      ev("command.completed", { commandId: "c1", exitCode: 0, durationMs: 4200 }),
    ]);
    expect(tl.map((i) => i.kind)).toEqual(["user", "command"]);
    const cmd = tl[1] as Extract<(typeof tl)[number], { kind: "command" }>;
    expect(cmd).toMatchObject({ command: "npm test", status: "completed", exitCode: 0, durationMs: 4200, workingDirectory: "G:/repo" });
    expect(cmd.output).toBe("running…\n5 passed\n");
  });

  it("shows a running command as live, and marks nonzero exits failed", () => {
    reset();
    const running = buildTimeline([ev("command.started", { commandId: "c1", command: "vitest" })]);
    expect((running[0] as any).status).toBe("running");
    reset();
    const failed = buildTimeline([
      ev("command.started", { commandId: "c1", command: "vitest" }),
      ev("command.completed", { commandId: "c1", exitCode: 1, durationMs: 900 }),
    ]);
    expect((failed[0] as any)).toMatchObject({ status: "failed", exitCode: 1 });
  });

  it("adopts the running run_command tool row in place instead of a second row", () => {
    reset();
    const tl = buildTimeline([
      ev("turn.started", { turnId: "t1", userMessage: "go" }),
      ev("tool.execution_started", { turnId: "t1", toolCallId: "t1c", toolName: "run_command", argsJson: JSON.stringify({ command: "npm test" }) }),
      ev("command.started", { commandId: "cmd1", command: "npm test" }),
      ev("command.output", { commandId: "cmd1", output: "ok\n" }),
      ev("command.completed", { commandId: "cmd1", exitCode: 0, durationMs: 100 }),
    ]);
    expect(tl.map((i) => i.kind)).toEqual(["user", "command"]);
    expect((tl[1] as any).output).toBe("ok\n");
  });
});

describe("buildTimeline — steering, capacity, and file changes", () => {
  it("renders a steering message as a steer row", () => {
    reset();
    const tl = buildTimeline([
      ev("turn.started", { turnId: "t1", userMessage: "refactor auth" }),
      ev("turn.steered", { turnId: "t1", steering: "keep the session store in memory" }),
    ]);
    const steer = tl.find((i) => i.kind === "steer") as any;
    expect(steer.text).toBe("keep the session store in memory");
  });

  it("surfaces free-capacity waits as parked notices, not failures", () => {
    reset();
    const tl = buildTimeline([
      ev("turn.started", { turnId: "t1", userMessage: "go" }),
      ev("eightbit.status", { event: "FREE_CAPACITY_WAIT", role: "agent", reasonCodes: ["ALL_ROUTES_BUSY"], accessibleText: "All free routes are busy — resuming when capacity frees" }),
      ev("eightbit.status", { event: "ROUTE_ROTATED", role: "agent", reasonCodes: [], accessibleText: "On groq", selected: { providerId: "groq", modelId: "llama-3.3" } }),
      ev("eightbit.status", { event: "CATALOG_SCAN_STARTED", role: "agent", reasonCodes: [], accessibleText: "scanning" }),
    ]);
    const notices = tl.filter((i) => i.kind === "notice") as Array<Extract<(typeof tl)[number], { kind: "notice" }>>;
    expect(notices).toHaveLength(2);
    expect(notices[0].notice).toBe("capacity_wait");
    expect(notices[0].detail).toContain("busy");
    expect(notices[1].notice).toBe("route_switch");
    expect(notices[1].text).toContain("groq");
  });

  it("keeps subagent lifecycle states honest — queued, blocked, failed stay themselves", () => {
    reset();
    const tl = buildTimeline([
      ev("subagent.lifecycle", { agentId: "a1", role: "Coder", task: "Write module", state: "blocked", capsuleVersion: 1, reason: "VERIFY_FAILED" }),
      ev("subagent.lifecycle", { agentId: "a2", role: "Scout", task: "Scan repo", state: "queued", capsuleVersion: 1 }),
    ]);
    const rows = tl.filter((i) => i.kind === "subagent") as Array<Extract<(typeof tl)[number], { kind: "subagent" }>>;
    expect(rows[0].status).toBe("blocked");
    expect(rows[1].status).toBe("queued");
  });

  it("threads progress and artifacts onto the worker's single row", () => {
    reset();
    const tl = buildTimeline([
      ev("subagent.started", { agentId: "a1", role: "Coder", task: "Write module" }),
      ev("subagent.progress", { agentId: "a1", message: "Writing parser", percent: 40 }),
      ev("subagent.artifact_written", { agentId: "a1", artifact: { kind: "file", ref: "src/parser.ts", digest: "d", producerAgentId: "a1", createdAt: "2026-01-01T00:00:00Z" } }),
      ev("subagent.failed", { agentId: "a1", error: "budget exhausted" }),
    ]);
    const row = tl.find((i) => i.kind === "subagent") as Extract<(typeof tl)[number], { kind: "subagent" }>;
    expect(row.status).toBe("failed");
    expect(row.progress).toBe("Writing parser");
    expect(row.percent).toBe(40);
    expect(row.artifacts).toEqual(["src/parser.ts"]);
  });

  it("tracks a proposed file change through applied and reverted", () => {
    reset();
    const applied = buildTimeline([
      ev("file.change_proposed", { changeId: "ch1", path: "src/a.ts", changeType: "modified", additions: 4, deletions: 1, diff: "@@" }),
      ev("file.change_applied", { changeId: "ch1", path: "src/a.ts" }),
    ]);
    const rowA = applied[0] as Extract<(typeof applied)[number], { kind: "file" }>;
    expect(rowA).toMatchObject({ action: "modified", additions: 4, deletions: 1, detail: "applied" });
    reset();
    const reverted = buildTimeline([
      ev("file.change_proposed", { changeId: "ch1", path: "src/a.ts", changeType: "modified", additions: 4, deletions: 1 }),
      ev("file.change_reverted", { changeId: "ch1", path: "src/a.ts" }),
    ]);
    expect((reverted[0] as any).action).toBe("reverted");
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

describe("buildTimeline — workflow-dispatched turns are not the user's words", () => {
  it("suppresses internal builder turns entirely — the phase strip carries that meaning", () => {
    reset();
    const tl = buildTimeline([
      ev("turn.started", { turnId: "wf", userMessage: "Add coupon support" }),
      ev("turn.started", { turnId: "builder", userMessage: "You are CodeForge, an autonomous coding agent. Implement the following plan…", origin: "workflow", label: "Implementing the approved plan" }),
    ]);
    expect(tl.map((i) => i.kind)).toEqual(["user"]);
    expect((tl[0] as any).text).toBe("Add coupon support");
  });

  it("renders verification, repair, review, and completion events as compact phase rows", () => {
    reset();
    const tl = buildTimeline([
      ev("turn.started", { turnId: "wf", userMessage: "Add coupon support" }),
      ev("workflow.verification_completed", { attempt: 1, passed: 10, failed: 2, skipped: 0 }),
      ev("workflow.repair_attempted", { attempt: 1, summary: "fix the failing assertions" }),
      ev("workflow.review_completed", { approved: true, findings: [], diffCount: 3 }),
      ev("workflow.completion_decided", { outcome: "completed", rationale: "all verifiers passed" }),
    ]);
    const phases = tl.filter((i) => i.kind === "phase") as Array<Extract<typeof tl[number], { kind: "phase" }>>;
    expect(phases.map((p) => p.phase)).toEqual(["testing", "repairing", "reviewing", "outcome"]);
    expect(phases[0].text).toBe("Verification · attempt 1");
    expect(phases[0].detail).toBe("10 passed · 2 failed");
    expect(phases[1].detail).toBe("fix the failing assertions");
    expect(phases[3].text).toBe("Done");
  });
});

describe("buildTimeline — parallel run workstream lifecycle", () => {
  it("labels workstream dispatch, review, and blocked outcomes", () => {
    reset();
    const ws = (type: string, workstreamId: string, payload: unknown = {}) =>
      ({ type, payload, workstreamId, seq: ++seq, sessionId: "s1", timestamp: new Date().toISOString() }) as unknown as WorkspaceEvent;
    const tl = buildTimeline([
      ev("parallel.plan.validated", { order: ["add-jsdoc"] }),
      ws("workstream.dispatched", "add-jsdoc"),
      ws("workstream.reviewing", "add-jsdoc", { revisionRound: 0 }),
      ws("workstream.blocked", "add-jsdoc", { error: "Legacy verifier requires a shell" }),
    ]);
    const texts = tl.map((i) => i.text);
    expect(texts).toContain("Parallel plan ready — 1 workstream");
    expect(texts).toContain("Workstream add-jsdoc started in an isolated worktree");
    expect(texts).toContain("Workstream add-jsdoc under review");
    expect(texts.some((t) => t.includes("Workstream add-jsdoc blocked") && t.includes("Legacy verifier"))).toBe(true);
  });
});
