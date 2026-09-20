import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Conversation, { groupConsecutiveToolActivity } from "../src/Conversation.js";
import type { TimelineItem } from "../src/timeline.js";
import type { WorkspaceEvent } from "@codeforge/protocol";
import type { TurnRecord } from "@codeforge/sessions";

let seq = 0;
const ev = (type: string, payload: Record<string, unknown>): WorkspaceEvent =>
  ({ type, seq: ++seq, timestamp: "2026-10-01T00:00:00.000Z", sessionId: "s1", payload }) as unknown as WorkspaceEvent;

const turnStarted = (turnId = "t1") => ev("turn.started", { turnId, userMessage: "Fix the bug" });
const toolStart = (turnId: string, callId: string, toolName: string, argsJson?: string) =>
  ev("tool.call_started", { turnId, toolCallId: callId, toolName, argsJson });
const toolDone = (callId: string, result = "ok") => ev("tool.execution_completed", { toolCallId: callId, result });
const toolBlocked = (callId: string, reason: string) => ev("tool.execution_blocked", { toolCallId: callId, reason });
const assistantMsg = (turnId: string, messageId: string, text: string) => [
  ev("assistant.message.started", { turnId, messageId }),
  ev("assistant.message.completed", { turnId, messageId, text }),
];

const tool = (id: string, toolName: string, status: "running" | "completed" | "failed" | "blocked" = "completed"): Extract<TimelineItem, { kind: "tool" }> =>
  ({ kind: "tool", id, seq: Number(id.replace(/\D/g, "")), turnId: "t1", toolCallId: id, toolName, status });

const assistant = (id: string, text: string): Extract<TimelineItem, { kind: "assistant" }> =>
  ({ kind: "assistant", id, seq: Number(id.replace(/\D/g, "")), turnId: "t1", messageId: id, text, streaming: false });

function markup(events: WorkspaceEvent[], props: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    React.createElement(Conversation, {
      turns: [],
      workItems: [],
      displayMode: "detailed",
      events,
      ...props,
    }),
  );
}

describe("R19 — activity group bridging", () => {
  it("folds a short narration between same-kind reads into the group, preserving order", () => {
    const grouped = groupConsecutiveToolActivity([
      tool("t1", "read_file"),
      assistant("m2", "Checking the tests next."),
      tool("t3", "read_file"),
    ]);
    expect(grouped).toHaveLength(1);
    const group = grouped[0]!;
    expect(group.kind).toBe("tool_group");
    if (group.kind === "tool_group") {
      expect(group.items.map((i) => i.kind)).toEqual(["tool", "assistant", "tool"]);
      expect(group.items[1]).toMatchObject({ text: "Checking the tests next." });
    }
  });

  it("does not bridge a question or a long message — those are real turns", () => {
    const items = [tool("t1", "read_file"), assistant("m2", "Which variant should I use?"), tool("t3", "read_file")];
    expect(groupConsecutiveToolActivity(items).every((i) => i.kind !== "tool_group")).toBe(true);
    const long = [tool("t1", "read_file"), assistant("m2", `Analysis: ${"x".repeat(200)}`), tool("t3", "read_file")];
    expect(groupConsecutiveToolActivity(long).every((i) => i.kind !== "tool_group")).toBe(true);
  });

  it("does not bridge across turns or into a failed/running call", () => {
    const crossTurn = [tool("t1", "read_file"), { ...assistant("m2", "note"), turnId: "other" }, tool("t3", "read_file")];
    expect(groupConsecutiveToolActivity(crossTurn).every((i) => i.kind !== "tool_group")).toBe(true);
    const failing = [tool("t1", "read_file"), assistant("m2", "note"), tool("t3", "read_file", "failed")];
    expect(groupConsecutiveToolActivity(failing).every((i) => i.kind !== "tool_group")).toBe(true);
  });

  it("still requires at least two tool calls before grouping", () => {
    const grouped = groupConsecutiveToolActivity([tool("t1", "read_file"), assistant("m2", "note")]);
    expect(grouped.map((i) => i.kind)).toEqual(["tool", "assistant"]);
  });
});

describe("R19 — tool row truth", () => {
  it("renders duplicate-read suppression as a muted skip, not an error", () => {
    const html = markup([
      turnStarted(),
      toolStart("t1", "c1", "read_file", JSON.stringify({ path: "inventory.js" })),
      toolBlocked("c1", "forgegreen_duplicate_suppressed"),
    ]);
    expect(html).toContain("Skipped — duplicate of an unchanged read");
    expect(html).toContain("activity-meta-muted");
    expect(html).not.toContain("activity-meta-error");
    expect(html).not.toContain('data-activity-kind="error"');
  });

  it("renders a genuine block reason with warning treatment", () => {
    const html = markup([
      turnStarted(),
      toolStart("t1", "c1", "run_command", JSON.stringify({ command: "rm -rf x" })),
      toolBlocked("c1", "policy_denied"),
    ]);
    expect(html).toContain("activity-meta-warning");
    expect(html).not.toContain("activity-meta-error");
  });

  it("marks a still-running call Cancelled once the run is terminal, never Working", () => {
    const events = [turnStarted(), toolStart("t1", "c1", "run_command", JSON.stringify({ command: "npm test" }))];
    const live = markup(events, { isRunning: true, turns: [{ id: "t1" } as TurnRecord] });
    expect(live).toContain("Working");
    const terminal = markup(events, { isRunning: false, turns: [{ id: "t1" } as TurnRecord] });
    expect(terminal).not.toContain("Working");
    expect(terminal).toContain("Cancelled — the run ended first");
  });

  it("renders the review phase once — no 'Review Review'", () => {
    const html = markup([
      turnStarted(),
      ev("workflow.review_completed", { approved: true }),
    ]);
    const matches = html.match(/>Review</g) ?? [];
    expect(matches).toHaveLength(1);
    expect(html).toContain("approved");
  });

  it("prints the outcome word as the row subject with the rationale attached", () => {
    const html = markup([
      turnStarted(),
      ev("workflow.completion_decided", { outcome: "blocked", rationale: "no forward progress" }),
    ]);
    expect(html).toContain(">Blocked</span>");
    expect(html).toContain("no forward progress");
  });
});

describe("R19 — speaker hierarchy", () => {
  it("labels the first assistant message of a run, not every message", () => {
    const html = markup([
      turnStarted(),
      ...assistantMsg("t1", "m1", "First, I will inspect the files."),
      ...assistantMsg("t1", "m2", "Now I will edit."),
    ]);
    expect(html.match(/assistant-message-label/g)).toHaveLength(1);
  });

  it("re-labels after tool activity — the speaker changed", () => {
    const html = markup([
      turnStarted(),
      ...assistantMsg("t1", "m1", "Reading the file first."),
      toolStart("t1", "c1", "read_file", JSON.stringify({ path: "a.ts" })),
      toolDone("c1"),
      ...assistantMsg("t1", "m2", "Done reading."),
    ]);
    expect(html.match(/assistant-message-label/g)).toHaveLength(2);
  });
});
