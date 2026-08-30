import { describe, it, expect } from "vitest";
import { describeToolTarget, summarizeToolResult, hasToolDetail, formatElapsed } from "../src/tool-activity.js";

/**
 * The tool feed is how a user follows an agent's work in progress. It previously rendered only the
 * tool name and a status word, so every call looked identical and carried no information about what
 * was actually touched. These tests pin the two things each row must convey: the target and the
 * outcome.
 */
describe("tool activity", () => {
  describe("target", () => {
    it("prefers the path a file tool acted on", () => {
      expect(describeToolTarget("read_file", JSON.stringify({ path: "src/calc.ts", encoding: "utf8" }))).toBe("src/calc.ts");
      expect(describeToolTarget("write_file", JSON.stringify({ file_path: "src/index.ts" }))).toBe("src/index.ts");
    });

    it("shows the command for a shell tool", () => {
      expect(describeToolTarget("run_command", JSON.stringify({ command: "npm test" }))).toBe("npm test");
    });

    it("shows the query for a search tool", () => {
      expect(describeToolTarget("search", JSON.stringify({ pattern: "TODO" }))).toBe("TODO");
    });

    it("falls back to the first string argument for an unknown tool", () => {
      expect(describeToolTarget("mystery_tool", JSON.stringify({ whatever: "value-here", n: 3 }))).toBe("value-here");
    });

    it("keeps the tail of a long path, which is the identifying part", () => {
      const target = describeToolTarget("read_file", JSON.stringify({ path: `${"a/".repeat(60)}calc.ts` }));
      expect(target!.startsWith("…")).toBe(true);
      expect(target!.endsWith("calc.ts")).toBe(true);
      expect(target!.length).toBeLessThanOrEqual(72);
    });

    it("returns nothing rather than guessing when there are no arguments", () => {
      expect(describeToolTarget("read_file", undefined)).toBeUndefined();
      expect(describeToolTarget("read_file", "not json")).toBeUndefined();
      expect(describeToolTarget("read_file", JSON.stringify({ n: 1 }))).toBeUndefined();
    });
  });

  describe("result summary", () => {
    it("says nothing while a call is still running", () => {
      expect(summarizeToolResult({ status: "running" })).toBeUndefined();
    });

    it("shows a short single-line result verbatim", () => {
      expect(summarizeToolResult({ status: "completed", result: "3 matches" })).toBe("3 matches");
    });

    it("reports multi-line output by size rather than showing a misleading fragment", () => {
      expect(summarizeToolResult({ status: "completed", result: "a\nb\nc" })).toBe("3 lines");
    });

    it("distinguishes empty output from no output", () => {
      expect(summarizeToolResult({ status: "completed", result: "   " })).toBe("no output");
    });

    it("surfaces the error for failed and blocked calls", () => {
      expect(summarizeToolResult({ status: "failed", error: "ENOENT: no such file" })).toBe("ENOENT: no such file");
      expect(summarizeToolResult({ status: "blocked", error: "outside workspace" })).toBe("outside workspace");
      expect(summarizeToolResult({ status: "blocked" })).toBe("blocked");
    });
  });

  it("offers expansion only when there is more to see", () => {
    expect(hasToolDetail({ result: "ok" })).toBe(false);
    expect(hasToolDetail({ result: "a\nb" })).toBe(true);
    expect(hasToolDetail({ result: "x".repeat(200) })).toBe(true);
    expect(hasToolDetail({ error: "boom\nstack" })).toBe(true);
  });

  it("formats elapsed time compactly", () => {
    expect(formatElapsed(420)).toBe("420ms");
    expect(formatElapsed(1500)).toBe("1.5s");
    expect(formatElapsed(42000)).toBe("42s");
    expect(formatElapsed(95000)).toBe("1m 35s");
    expect(formatElapsed(-1)).toBe("");
  });
});
