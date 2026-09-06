import { describe, it, expect } from "vitest";
import { compressToolOutput } from "../src/compress.js";

function repeatedLines(line: string, count: number): string {
  return Array.from({ length: count }, () => line).join("\n");
}

describe("FG-1B deterministic tool-output compression", () => {
  it("leaves small outputs untouched", () => {
    const output = "Exit code: 0\nall tests passed\n";
    const result = compressToolOutput(output);
    expect(result.applied).toBe(false);
    expect(result.representation).toBe(output);
    expect(result.compressedBytes).toBe(result.originalBytes);
  });

  it("is deterministic for identical inputs", () => {
    const output = `${repeatedLines("PASS src/a.test.ts", 500)}\nError: expected 1 to be 2\n${repeatedLines("PASS src/b.test.ts", 500)}`;
    const first = compressToolOutput(output, { artifactRef: "exec-1" });
    const second = compressToolOutput(output, { artifactRef: "exec-1" });
    expect(first.representation).toBe(second.representation);
    expect(first.strategies).toEqual(second.strategies);
  });

  it("materially shrinks repetitive successful output and preserves counts", () => {
    const output = repeatedLines("PASS packages/core/src/x.test.ts > core > adds numbers", 2000);
    const result = compressToolOutput(output, { artifactRef: "exec-2" });
    expect(result.applied).toBe(true);
    expect(result.compressedBytes).toBeLessThan(result.originalBytes / 4);
    expect(result.representation).toContain("identical line repeated");
    expect(result.strategies).toContain("consecutive_repeat_fold");
  });

  it("preserves failure lines at the beginning, middle, and end of huge output", () => {
    const lines: string[] = [];
    for (let i = 0; i < 800; i++) lines.push(`ok ${i} — suite ran cleanly without any anomalies`);
    lines[10] = "Error: first failure — assertion mismatch";
    lines[400] = "Error: middle failure — assertion mismatch";
    lines[799] = "Error: final failure — assertion mismatch";
    const output = lines.join("\n");
    const result = compressToolOutput(output, { artifactRef: "exec-3" });
    expect(result.applied).toBe(true);
    expect(result.compressedBytes).toBeLessThan(result.originalBytes);
    expect(result.representation).toContain("first failure");
    expect(result.representation).toContain("middle failure");
    expect(result.representation).toContain("final failure");
  });

  it("preserves the exit-code head marker even when bounding hard", () => {
    const output = `Exit code: 1\n${repeatedLines("npm WARN deprecated package-a@1.0.0: use package-b instead", 3000)}\nError: build failed with 3 errors`;
    const result = compressToolOutput(output, { artifactRef: "exec-4", maxBytes: 8192 });
    expect(result.compressedBytes).toBeLessThanOrEqual(8192 + 512);
    // The provenance header precedes the retained head; the exit-code marker must survive both.
    expect(result.representation).toContain("[forgegreen tool-output compression:");
    expect(result.representation).toContain("Exit code: 1");
    expect(result.representation).toContain("build failed with 3 errors");
  });

  it("never exceeds the hard byte bound and marks the authoritative artifact", () => {
    const output = repeatedLines("some diagnostic line with modest length", 20000);
    const result = compressToolOutput(output, { artifactRef: "exec-5", maxBytes: 4096 });
    const overhead = Buffer.byteLength(result.representation.split("\n")[0] ?? "", "utf8") + 512;
    expect(result.compressedBytes).toBeLessThanOrEqual(4096 + overhead);
    expect(result.representation).toContain("artifact=exec-5");
  });

  it("keeps redaction markers exactly as provided (compression never un-redacts)", () => {
    const output = `${repeatedLines("token=[REDACTED] scope ok", 900)}\nError: request failed\n${repeatedLines("token=[REDACTED] scope ok", 900)}`;
    const result = compressToolOutput(output, { artifactRef: "exec-6" });
    expect(result.representation).toContain("[REDACTED]");
    expect(result.representation).not.toContain("sk-live");
  });

  it("does not fold failure lines away even when identical", () => {
    const output = `${repeatedLines("Error: connection refused", 100)}\n${repeatedLines("ok", 100)}`;
    const result = compressToolOutput(output, { artifactRef: "exec-7" });
    expect(result.representation).toContain("Error: connection refused");
  });
});
