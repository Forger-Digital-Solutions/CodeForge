import { describe, expect, it } from "vitest";
import { groupConsecutiveToolActivity } from "../src/Conversation.js";
import type { TimelineItem } from "../src/timeline.js";

const tool = (id: string, toolName: string, status: "completed" | "failed" = "completed"): Extract<TimelineItem, { kind: "tool" }> => ({
  kind: "tool", id, seq: Number(id.slice(1)), turnId: "turn-1", toolCallId: id, toolName, status,
  ts: new Date(Number(id.slice(1)) * 1000).toISOString(),
});

const file = (id: string, action: "read" | "written" | "created" | "modified" | "deleted" | "reverted" = "written"): Extract<TimelineItem, { kind: "file" }> => ({
  kind: "file", id, seq: Number(id.slice(1)), path: `src/${id}.ts`, action,
  ts: new Date(Number(id.slice(1)) * 1000).toISOString(),
});

const command = (id: string, status: "completed" | "failed" | "running" = "completed"): Extract<TimelineItem, { kind: "command" }> => ({
  kind: "command", id, seq: Number(id.slice(1)), command: `cmd-${id}`, status, exitCode: status === "completed" ? 0 : undefined,
  ts: new Date(Number(id.slice(1)) * 1000).toISOString(),
});

describe("groupConsecutiveToolActivity", () => {
  it("groups adjacent completed reads but retains individual audit detail", () => {
    const grouped = groupConsecutiveToolActivity([tool("t1", "read_file"), tool("t2", "read_file")]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ kind: "tool_group", activityKind: "read", mixed: false });
    expect(grouped[0]?.kind === "tool_group" && grouped[0].items).toHaveLength(2);
  });

  it("folds a mixed completed run into one 'steps' group — reads + edits + commands together", () => {
    const grouped = groupConsecutiveToolActivity([tool("t1", "read_file"), tool("t2", "edit_file"), command("t3")]);
    expect(grouped).toHaveLength(1);
    const group = grouped[0] as Extract<(typeof grouped)[number], { kind: "tool_group" }>;
    expect(group.mixed).toBe(true);
    expect(group.items).toHaveLength(3);
  });

  it("leaves a two-item mixed sequence alone — too small to summarize", () => {
    const grouped = groupConsecutiveToolActivity([tool("t1", "read_file"), tool("t2", "edit_file")]);
    expect(grouped.every((item) => item.kind === "tool")).toBe(true);
    expect(grouped).toHaveLength(2);
  });

  it("a file row participates in a mixed run; a reverted file stays explicit", () => {
    const grouped = groupConsecutiveToolActivity([tool("t1", "read_file"), file("t2", "written"), command("t3"), file("t4", "reverted")]);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]?.kind).toBe("tool_group");
    expect(grouped[1]?.kind).toBe("file");
  });

  it("a failed command stays explicit even inside a long completed run", () => {
    const grouped = groupConsecutiveToolActivity([tool("t1", "read_file"), tool("t2", "read_file"), command("t3", "failed"), tool("t4", "read_file"), tool("t5", "read_file")]);
    expect(grouped.map((item) => item.kind)).toEqual(["tool_group", "command", "tool_group"]);
  });

  it("never hides a failed operation inside a summary", () => {
    const grouped = groupConsecutiveToolActivity([tool("t1", "read_file"), tool("t2", "read_file", "failed")]);
    expect(grouped).toHaveLength(2);
    expect(grouped.every((item) => item.kind === "tool")).toBe(true);
  });
});
