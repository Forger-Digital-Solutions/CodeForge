import { describe, it, expect } from "vitest";
import { buildContext } from "../src/context-builder.js";
import { understandTask } from "../src/task-intelligence.js";
import type { RepoMap } from "../src/types.js";

describe("ContextBuilder", () => {
  it("builds context with relevance scoring", () => {
    const intent = understandTask("Fix add function in calc.ts");
    const repoMap: RepoMap = {
      workspacePath: "/tmp/ws",
      files: [
        { path: "/tmp/ws/src/calc.ts", relativePath: "src/calc.ts", size: 100, lines: 10 },
        { path: "/tmp/ws/src/util.ts", relativePath: "src/util.ts", size: 100, lines: 10 },
        { path: "/tmp/ws/README.md", relativePath: "README.md", size: 20, lines: 2 },
      ],
      searchedMatches: [{ file: "src/calc.ts", line: 1, column: 1, preview: "add" }],
      readFiles: [
        { path: "src/calc.ts", content: "export function add(){return a - b}", hash: "abc", lines: 5, truncated: false },
        { path: "src/util.ts", content: "export const x=1", hash: "def", lines: 1, truncated: false },
      ],
    };
    const ctx = buildContext(intent, repoMap);
    expect(ctx.primaryFiles).toContain("src/calc.ts");
    expect(ctx.relevanceScores.get("src/calc.ts")).toBeGreaterThan(ctx.relevanceScores.get("src/util.ts") ?? 0);
    expect(ctx.tokensApprox).toBeGreaterThan(0);
    expect(ctx.summary).toContain("calc");
  });

  it("fallback when no matches", () => {
    const intent = understandTask("Do something");
    const repoMap: RepoMap = {
      workspacePath: "/tmp/ws",
      files: [{ path: "/tmp/ws/a.ts", relativePath: "a.ts", size: 10, lines: 1 }],
      searchedMatches: [],
      readFiles: [],
    };
    const ctx = buildContext(intent, repoMap);
    expect(ctx.primaryFiles.length).toBeGreaterThan(0);
  });
});
