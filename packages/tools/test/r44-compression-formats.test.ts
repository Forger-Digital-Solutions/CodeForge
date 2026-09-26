import { describe, it, expect } from "vitest";
import { compressToolOutput } from "../src/compress.js";

function pad(before: number, after: number): { head: string; tail: string } {
  const head: string[] = [];
  for (let i = 0; i < before; i++) head.push(`   ✓ benign check ${i} completed (${i % 11}ms)`);
  const tail: string[] = [];
  for (let i = 0; i < after; i++) tail.push(`   ✓ benign check ${before + i} completed (${i % 7}ms)`);
  return { head: head.join("\n"), tail: tail.join("\n") };
}

function bury(middle: string, before = 600, after = 600): string {
  const { head, tail } = pad(before, after);
  return `${head}\n${middle}\n${tail}`;
}

describe("R44 real-world failure-format retention", () => {
  it("keeps vitest failure blocks with file, assertion, and expected/actual", () => {
    const output = bury([
      " ✗ packages/server/test/edit.test.ts > applies hash-checked edits (1241ms)",
      "   AssertionError: expected '{\"ok\":true}' to contain 'applied'",
      "   Expected: applied",
      "   Received: {\"ok\":false}",
      "   at expectEdit (packages/server/test/edit.test.ts:88:14)",
    ].join("\n"));
    const result = compressToolOutput(output, { artifactRef: "rw-1" });
    for (const needle of ["applies hash-checked edits", "AssertionError", "Expected: applied", "edit.test.ts:88:14"]) {
      expect(result.representation).toContain(needle);
    }
  });

  it("keeps jest failure blocks with ● markers and stack frames", () => {
    const output = bury([
      "  ● AuthenticationService › rejects expired tokens",
      "    expect(received).toBe(expected) // Object.is equality",
      "    Expected: 401",
      "    Received: 200",
      "      at Object.toBe (src/auth.test.ts:42:19)",
    ].join("\n"));
    const result = compressToolOutput(output, { artifactRef: "rw-2" });
    expect(result.representation).toContain("rejects expired tokens");
    expect(result.representation).toContain("Expected: 401");
  });

  it("keeps TypeScript compiler errors with file:line:col", () => {
    const output = bury([
      "src/router.ts(128,31): error TS2345: Argument of type 'string' is not assignable to parameter of type 'Route'.",
      "src/router.ts(140,9): error TS2322: Type 'undefined' is not assignable to type 'Config'.",
    ].join("\n"));
    const result = compressToolOutput(output, { artifactRef: "rw-3" });
    expect(result.representation).toContain("error TS2345");
    expect(result.representation).toContain("router.ts(128,31)");
    expect(result.representation).toContain("error TS2322");
  });

  it("keeps eslint error summaries and per-file violations", () => {
    const output = bury([
      "src/session.ts",
      "  45:11  error  'state' is assigned a value but never used  @typescript-eslint/no-unused-vars",
      "  ✖ 1 problem (1 error, 0 warnings)",
    ].join("\n"));
    const result = compressToolOutput(output, { artifactRef: "rw-4" });
    expect(result.representation).toContain("session.ts");
    expect(result.representation).toContain("no-unused-vars");
    expect(result.representation).toContain("1 error");
  });

  it("keeps go test --- FAIL markers and python FAILED/pytest assertion lines", () => {
    const output = bury([
      "--- FAIL: TestParseHeader (0.00s)",
      "    parser_test.go:77: got status 500, want 200",
      "FAILED tests/test_auth.py::test_expired_token - AssertionError: assert 200 == 401",
      "E       assert 200 == 401",
    ].join("\n"));
    const result = compressToolOutput(output, { artifactRef: "rw-5" });
    expect(result.representation).toContain("--- FAIL: TestParseHeader");
    expect(result.representation).toContain("got status 500");
    expect(result.representation).toContain("FAILED tests/test_auth.py");
    expect(result.representation).toContain("assert 200 == 401");
  });

  it("keeps rust panicked/crash lines and repeated stack traces", () => {
    const stack = [
      "thread 'main' panicked at src/engine.rs:214:9:",
      "called `Option::unwrap()` on a `None` value",
      "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace",
    ].join("\n");
    const repeated = Array.from({ length: 40 }, () => "    at Runtime.tick (src/runtime.ts:55:5)").join("\n");
    const output = bury(`${stack}\nSegmentation fault (core dumped)\n${repeated}`, 500, 500);
    const result = compressToolOutput(output, { artifactRef: "rw-6" });
    expect(result.representation).toContain("panicked at src/engine.rs:214");
    expect(result.representation).toContain("Segmentation fault");
    expect(result.representation).toContain("identical line repeated");
  });

  it("keeps command timeout/exit markers at head and tail", () => {
    const output = `Exit code: 124\n${Array.from({ length: 900 }, (_, i) => `processing batch ${i} of dataset`).join("\n")}\nCommand timed out after 30000ms`;
    const result = compressToolOutput(output, { artifactRef: "rw-7" });
    expect(result.representation).toContain("Exit code: 124");
    expect(result.representation).toContain("timed out");
  });

  it("bounds huge git diffs at head+tail with an explicit omission marker", () => {
    const lines = ["diff --git a/src/big.ts b/src/big.ts", "index abc..def 100644", "--- a/src/big.ts", "+++ b/src/big.ts"];
    for (let i = 0; i < 4000; i++) lines.push(`${i % 2 ? "+" : "-"} line ${i} of the very large diff body`);
    lines.push("diff --git a/src/tail.ts b/src/tail.ts");
    const result = compressToolOutput(lines.join("\n"), { artifactRef: "rw-8", maxBytes: 8192 });
    expect(result.compressedBytes).toBeLessThanOrEqual(8192 + 512);
    expect(result.representation).toContain("diff --git a/src/big.ts");
    expect(result.representation).toContain("omitted");
    expect(result.representation).toContain("a/src/tail.ts");
  });

  it("bounds huge grep/search results while keeping head hits", () => {
    const lines: string[] = [];
    for (let i = 0; i < 2500; i++) lines.push(`src/module-${i % 40}.ts:${i + 1}: const value${i} = compute(${i});`);
    const result = compressToolOutput(lines.join("\n"), { artifactRef: "rw-9", maxBytes: 8192 });
    expect(result.compressedBytes).toBeLessThanOrEqual(8192 + 512);
    expect(result.representation).toContain("src/module-0.ts:1:");
  });
});
