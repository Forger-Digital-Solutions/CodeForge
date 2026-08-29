import { describe, it, expect } from "vitest";
import { parseDiff } from "../src/DiffViewer.js";

const unifiedDiff = [
  "--- a/src/calc.ts",
  "+++ b/src/calc.ts",
  "@@ -1,4 +1,5 @@",
  " export function add(a: number, b: number): number {",
  "-  return a - b;",
  "+  return a + b;",
  "+}",
  " }",
].join("\n");

describe("parseDiff", () => {
  it("skips --- and +++ file-header lines", () => {
    const { lines } = parseDiff(unifiedDiff, "src/calc.ts");
    expect(lines.some((l) => l.text.startsWith("--- ") || l.text.startsWith("+++ "))).toBe(false);
    // The mangled "++ b/..." artifact from the old parser must not appear.
    expect(lines.some((l) => l.text.startsWith("++ b/"))).toBe(false);
  });

  it("renders the @@ hunk header as a meta line without stripping its first char", () => {
    const { lines } = parseDiff(unifiedDiff, "src/calc.ts");
    const meta = lines.filter((l) => l.type === "meta");
    expect(meta).toHaveLength(1);
    expect(meta[0]!.text).toBe("@@ -1,4 +1,5 @@");
  });

  it("numbers additions by new-file line and removals by old-file line from the hunk anchor", () => {
    const { lines } = parseDiff(unifiedDiff, "src/calc.ts");
    const removal = lines.find((l) => l.type === "removal");
    const additions = lines.filter((l) => l.type === "addition");
    expect(removal?.oldLine).toBe(2);
    expect(additions.map((a) => a.newLine)).toEqual([2, 3]);
  });

  it("derives the file name from the +++ header when none is supplied", () => {
    const { file } = parseDiff(unifiedDiff);
    expect(file).toBe("src/calc.ts");
  });

  it("prefers an explicit fileName over the header", () => {
    const { file } = parseDiff(unifiedDiff, "explicit/path.ts");
    expect(file).toBe("explicit/path.ts");
  });

  it("handles a header-less diff by numbering from line 1", () => {
    const { lines } = parseDiff("+added line\n unchanged", "x.ts");
    const addition = lines.find((l) => l.type === "addition");
    const context = lines.find((l) => l.type === "context");
    expect(addition?.newLine).toBe(1);
    expect(context?.newLine).toBe(2);
  });
});
