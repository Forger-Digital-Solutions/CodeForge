import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@codeforge/providers";
import { compactSupersededToolOutputs } from "../src/history-compaction.js";

function assistantCall(id: string, name: string, args: Record<string, unknown>): ChatMessage {
  return {
    role: "assistant",
    content: "",
    toolCalls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

function toolResult(toolCallId: string, content: string): ChatMessage {
  return { role: "tool", toolCallId, content };
}

describe("compactSupersededToolOutputs", () => {
  it("returns the same array when no tool output is superseded", () => {
    const messages: ChatMessage[] = [
      assistantCall("c1", "read_file", { path: "a.ts" }),
      toolResult("c1", "contents of a"),
      assistantCall("c2", "read_file", { path: "b.ts" }),
      toolResult("c2", "contents of b"),
    ];
    const compacted = compactSupersededToolOutputs(messages);
    expect(compacted).toBe(messages);
    expect(compacted[1]?.content).toBe("contents of a");
  });

  it("compacts an earlier read_file result superseded by a newer identical read", () => {
    const messages: ChatMessage[] = [
      assistantCall("c1", "read_file", { path: "a.ts" }),
      toolResult("c1", "stale contents of a ".repeat(200)),
      assistantCall("c2", "read_file", { path: "a.ts" }),
      toolResult("c2", "fresh contents of a"),
    ];
    const compacted = compactSupersededToolOutputs(messages);
    expect(compacted).not.toBe(messages);
    expect(compacted[1]?.content).toContain("superseded");
    expect(compacted[1]?.content.length).toBeLessThan(200);
    expect(compacted[3]?.content).toBe("fresh contents of a");
    // Durable history is not mutated — the transform operates on a copy.
    expect(messages[1]?.content).toContain("stale contents");
  });

  it("treats argument JSON as order-insensitive", () => {
    const first = assistantCall("c1", "search_files", { query: "foo", regex: true });
    const second: ChatMessage = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c2", type: "function", function: { name: "search_files", arguments: "{\"regex\":true,\"query\":\"foo\"}" } }],
    };
    const messages: ChatMessage[] = [first, toolResult("c1", "old results ".repeat(100)), second, toolResult("c2", "new results")];
    const compacted = compactSupersededToolOutputs(messages);
    expect(compacted[1]?.content).toContain("superseded");
    expect(compacted[3]?.content).toBe("new results");
  });

  it("does not compact run_command outputs — identical reruns are meaningful progression", () => {
    const messages: ChatMessage[] = [
      assistantCall("c1", "run_command", { command: "npm test" }),
      toolResult("c1", "1 failing test"),
      assistantCall("c2", "run_command", { command: "npm test" }),
      toolResult("c2", "all tests pass"),
    ];
    const compacted = compactSupersededToolOutputs(messages);
    expect(compacted[1]?.content).toBe("1 failing test");
    expect(compacted[3]?.content).toBe("all tests pass");
  });

  it("does not compact different arguments of the same tool", () => {
    const messages: ChatMessage[] = [
      assistantCall("c1", "list_files", { path: "src", recursive: false }),
      toolResult("c1", "top level"),
      assistantCall("c2", "list_files", { path: "src", recursive: true }),
      toolResult("c2", "recursive listing"),
    ];
    const compacted = compactSupersededToolOutputs(messages);
    expect(compacted[1]?.content).toBe("top level");
  });

  it("keeps only the latest of three identical reads and compacts both stale copies", () => {
    const messages: ChatMessage[] = [
      assistantCall("c1", "read_file", { path: "a.ts" }),
      toolResult("c1", "v1 ".repeat(300)),
      assistantCall("c2", "read_file", { path: "a.ts" }),
      toolResult("c2", "v2 ".repeat(300)),
      assistantCall("c3", "read_file", { path: "a.ts" }),
      toolResult("c3", "v3"),
    ];
    const compacted = compactSupersededToolOutputs(messages);
    expect(compacted[1]?.content).toContain("superseded");
    expect(compacted[3]?.content).toContain("superseded");
    expect(compacted[5]?.content).toBe("v3");
  });

  it("leaves already-invalidated short markers untouched — replacing a 130-char marker saves nothing", () => {
    const messages: ChatMessage[] = [
      assistantCall("c1", "read_file", { path: "a.ts" }),
      toolResult("c1", "Runtime invalidated this prior read of a.ts after a successful workspace mutation."),
      assistantCall("c2", "read_file", { path: "a.ts" }),
      toolResult("c2", "fresh"),
    ];
    const compacted = compactSupersededToolOutputs(messages);
    expect(compacted[1]?.content).toContain("Runtime invalidated");
  });

  it("marks a read stale after a successful write to the same path", () => {
    const messages: ChatMessage[] = [
      assistantCall("c1", "read_file", { path: "a.ts" }),
      toolResult("c1", "old contents ".repeat(100)),
      assistantCall("c2", "edit_file", { path: "a.ts", oldText: "x", newText: "y" }),
      toolResult("c2", "Successfully edited a.ts (after hash: abc123)"),
      assistantCall("c3", "read_file", { path: "unrelated.ts" }),
      toolResult("c3", "untouched contents ".repeat(100)),
    ];
    const compacted = compactSupersededToolOutputs(messages);
    expect(compacted[1]?.content).toContain("stale");
    expect(compacted[1]?.content).toContain("a.ts");
    expect(compacted[5]?.content).toContain("untouched contents");
  });

  it("does not mark reads stale when the write to that path failed", () => {
    const messages: ChatMessage[] = [
      assistantCall("c1", "read_file", { path: "a.ts" }),
      toolResult("c1", "contents ".repeat(100)),
      assistantCall("c2", "edit_file", { path: "a.ts", oldText: "x", newText: "y" }),
      toolResult("c2", "Error: oldText not found in a.ts"),
    ];
    const compacted = compactSupersededToolOutputs(messages);
    expect(compacted[1]?.content).toContain("contents");
  });

  it("ignores tool messages whose call had malformed arguments", () => {
    const broken: ChatMessage = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{not json" } }],
    };
    const messages: ChatMessage[] = [
      broken,
      toolResult("c1", "output"),
      assistantCall("c2", "read_file", { path: "a.ts" }),
      toolResult("c2", "output2"),
    ];
    const compacted = compactSupersededToolOutputs(messages);
    expect(compacted[1]?.content).toBe("output");
  });

  it("is idempotent — recompacting an already compacted list changes nothing", () => {
    const messages: ChatMessage[] = [
      assistantCall("c1", "read_file", { path: "a.ts" }),
      toolResult("c1", "v1 ".repeat(500)),
      assistantCall("c2", "read_file", { path: "a.ts" }),
      toolResult("c2", "v2"),
    ];
    const once = compactSupersededToolOutputs(messages);
    const twice = compactSupersededToolOutputs(once);
    expect(twice[1]?.content).toBe(once[1]?.content);
  });
});
