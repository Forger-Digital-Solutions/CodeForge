import { describe, it, expect } from "vitest";
import { parseAssistantContent, parseInlineSpans, reasoningSummary } from "../src/assistant-content.js";

/**
 * The conversation used to render assistant text raw, so a model that reasons in `<think>` tags and
 * answers in fenced code showed the user literal `<think>` and literal backticks. These tests pin
 * the structure the view needs — including the streaming cases, where the newest block is by
 * definition unterminated and must still never leak as markup.
 */
describe("assistant content", () => {
  it("separates reasoning from the answer", () => {
    const blocks = parseAssistantContent("<think>\nLet me check the files.\n</think>\nHere is the answer.");
    expect(blocks).toEqual([
      { kind: "reasoning", text: "Let me check the files.", open: false },
      { kind: "text", text: "Here is the answer." },
    ]);
  });

  it("keeps an unterminated reasoning block as reasoning while it streams", () => {
    const blocks = parseAssistantContent("<think>\nStill working th");
    expect(blocks).toEqual([{ kind: "reasoning", text: "Still working th", open: true }]);
  });

  it("extracts fenced code with its language", () => {
    const blocks = parseAssistantContent("Run this:\n```bash\nnpm test\n```\nDone.");
    expect(blocks).toEqual([
      { kind: "text", text: "Run this:" },
      { kind: "code", language: "bash", code: "npm test", open: false },
      { kind: "text", text: "Done." },
    ]);
  });

  it("treats an unclosed fence as code that is still streaming", () => {
    const blocks = parseAssistantContent("```ts\nexport const a = 1;");
    expect(blocks).toEqual([{ kind: "code", language: "ts", code: "export const a = 1;", open: true }]);
  });

  it("handles a fence with no language", () => {
    const blocks = parseAssistantContent("```\ntree /f\n```");
    expect(blocks).toEqual([{ kind: "code", language: undefined, code: "tree /f", open: false }]);
  });

  it("handles reasoning followed by code, the shape the packaged app actually produced", () => {
    const raw = "<think>\nI should list the workspace.\n</think>\nI'll explore the structure.\n\n```\ntree /f C:\\ws\n```";
    expect(parseAssistantContent(raw)).toEqual([
      { kind: "reasoning", text: "I should list the workspace.", open: false },
      { kind: "text", text: "I'll explore the structure." },
      { kind: "code", language: undefined, code: "tree /f C:\\ws", open: false },
    ]);
  });

  it("returns plain prose untouched", () => {
    expect(parseAssistantContent("Just a sentence.")).toEqual([{ kind: "text", text: "Just a sentence." }]);
  });

  it("emits nothing for empty or whitespace-only text", () => {
    expect(parseAssistantContent("")).toEqual([]);
    expect(parseAssistantContent("   \n  ")).toEqual([]);
  });

  it("splits inline code and strong spans", () => {
    expect(parseInlineSpans("Call `add(a, b)` and it is **fixed**.")).toEqual([
      { kind: "plain", text: "Call " },
      { kind: "code", text: "add(a, b)" },
      { kind: "plain", text: " and it is " },
      { kind: "strong", text: "fixed" },
      { kind: "plain", text: "." },
    ]);
  });

  it("leaves unmatched markup punctuation as written", () => {
    expect(parseInlineSpans("a * b ** c")).toEqual([{ kind: "plain", text: "a * b ** c" }]);
  });

  it("summarises reasoning honestly", () => {
    expect(reasoningSummary("anything", true)).toBe("Thinking…");
    expect(reasoningSummary("one two three", false)).toBe("Thought for 3 words");
    expect(reasoningSummary("one", false)).toBe("Thought for 1 word");
    expect(reasoningSummary("   ", false)).toBe("Thought briefly");
  });
});

describe("stripToolProtocol (R9 raw protocol leak)", () => {
  it("removes complete mcp-tool blocks", () => {
    const raw = 'Reading files now.\n\n<mcp-tool>\n<server_name>filesystem</server_name>\n<tool_name>read_file</tool_name>\n</mcp-tool>\n\nDone reading.';
    const blocks = parseAssistantContent(raw);
    const joined = blocks.map((b) => ("text" in b ? b.text : "")).join(" ");
    expect(joined).not.toContain("mcp-tool");
    expect(joined).not.toContain("filesystem");
    expect(joined).toContain("Reading files now.");
    expect(joined).toContain("Done reading.");
  });

  it("removes task_act directives with embedded JSON", () => {
    const raw = '<task_act><!-- { "tool_id": "edit_file", "dry_run": true } --></task_act> Proceeding with the plan.';
    const blocks = parseAssistantContent(raw);
    const joined = blocks.map((b) => ("text" in b ? b.text : "")).join(" ");
    expect(joined).not.toContain("task_act");
    expect(joined).toContain("Proceeding with the plan.");
  });

  it("holds back an unterminated opener while streaming", () => {
    const raw = "Working on it. <mcp-tool>\n<tool_name>read_file</tool_name>";
    const blocks = parseAssistantContent(raw);
    const joined = blocks.map((b) => ("text" in b ? b.text : "")).join(" ");
    expect(joined).not.toContain("read_file");
    expect(joined).toContain("Working on it.");
  });
});
