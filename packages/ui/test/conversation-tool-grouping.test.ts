import { describe, expect, it } from "vitest";
import { groupConsecutiveToolActivity } from "../src/Conversation.js";
import type { TimelineItem } from "../src/timeline.js";

const tool = (id: string, toolName: string, status: "completed" | "failed" = "completed"): Extract<TimelineItem, { kind: "tool" }> => ({
  kind: "tool", id, seq: Number(id.slice(1)), turnId: "turn-1", toolCallId: id, toolName, status,
});

describe("groupConsecutiveToolActivity", () => {
  it("groups adjacent completed reads but retains individual audit detail", () => {
    const grouped = groupConsecutiveToolActivity([tool("t1", "read_file"), tool("t2", "read_file"), tool("t3", "search")]);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toMatchObject({ kind: "tool_group", activityKind: "read" });
    expect(grouped[0]?.kind === "tool_group" && grouped[0].items).toHaveLength(2);
  });

  it("never hides a failed operation inside a summary", () => {
    const grouped = groupConsecutiveToolActivity([tool("t1", "read_file"), tool("t2", "read_file", "failed")]);
    expect(grouped).toHaveLength(2);
    expect(grouped.every((item) => item.kind === "tool")).toBe(true);
  });
});
