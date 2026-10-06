import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { renderFileRead } from "../src/file-read.js";

describe("bounded file read pages", () => {
  it("keeps short default reads and their whole-file hash", () => {
    const raw = "first\r\nsecond";
    expect(renderFileRead(raw)).toBe(`${raw}\n[hash:${createHash("sha256").update(raw).digest("hex")}]`);
    expect(renderFileRead(raw, { endLine: 1 })).toContain("first\r\n[lines:1-1 of 2]");
  });

  it("offers the next page instead of silently ending at line 400", () => {
    const raw = Array.from({ length: 601 }, (_, i) => `line ${i + 1}`).join("\n");
    expect(renderFileRead(raw)).toContain("showing lines 1-400 of 601");
    const page = renderFileRead(raw, { startLine: 401, endLine: 999 });
    expect(page).toContain("line 401\n");
    expect(page).toContain("line 601\n[lines:401-601 of 601]");
    expect(page).not.toContain("TRUNCATED");
  });

  it("preserves UTF-8 and hash provenance within the broker byte cap", () => {
    const raw = "€".repeat(30000);
    const output = renderFileRead(raw, {}, 64 * 1024 - 1024);
    expect(Buffer.byteLength(output, "utf8")).toBeLessThan(64 * 1024);
    expect(output).not.toContain("�");
    expect(output).toContain("last line may be partial");
    expect(output).toContain(`[hash:${createHash("sha256").update(raw).digest("hex")}]`);
  });
});
