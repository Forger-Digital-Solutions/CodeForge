import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  parseSha256Sums,
  verifyReleaseHashes,
  applyPins,
  sha256OfFile,
} from "../scripts/verify-release-hashes.mjs";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

describe("parseSha256Sums", () => {
  it("parses standard two-space sha256sum lines", () => {
    const map = parseSha256Sums(`${"a".repeat(64)}  CodeForge-Portable.exe\n${"b".repeat(64)}  CodeForge-Setup-0.1.0.exe\n`);
    expect(map.get("CodeForge-Portable.exe")).toBe("a".repeat(64));
    expect(map.get("CodeForge-Setup-0.1.0.exe")).toBe("b".repeat(64));
  });

  it("accepts the binary '*' marker and skips blanks/comments", () => {
    const map = parseSha256Sums(`# comment\n\n${"c".repeat(64)} *portable.exe\n`);
    expect(map.get("portable.exe")).toBe("c".repeat(64));
    expect(map.size).toBe(1);
  });

  it("lowercases hashes", () => {
    const map = parseSha256Sums(`${"A".repeat(64)}  x.exe`);
    expect(map.get("x.exe")).toBe("a".repeat(64));
  });

  it("throws on a malformed line", () => {
    expect(() => parseSha256Sums("not-a-valid-hash  file.exe")).toThrow(/Malformed/);
  });

  it("throws on an empty manifest", () => {
    expect(() => parseSha256Sums("\n\n# only comments\n")).toThrow(/empty/);
  });
});

describe("verifyReleaseHashes", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-relhash-"));
    writeFileSync(join(dir, "good.bin"), "hello-codeforge");
    writeFileSync(join(dir, "bad.bin"), "tampered-bytes");
  });
  afterAll(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("computes a file hash matching node crypto", () => {
    expect(sha256OfFile(join(dir, "good.bin"))).toBe(sha256("hello-codeforge"));
  });

  it("passes when every file matches", () => {
    const expected = new Map([["good.bin", sha256("hello-codeforge")]]);
    const { ok, results } = verifyReleaseHashes(dir, expected);
    expect(ok).toBe(true);
    expect(results[0]?.status).toBe("OK");
  });

  it("rejects a tampered file (hash mismatch)", () => {
    const expected = new Map([["bad.bin", sha256("the-original-untampered-bytes")]]);
    const { ok, results } = verifyReleaseHashes(dir, expected);
    expect(ok).toBe(false);
    expect(results[0]?.status).toBe("MISMATCH");
  });

  it("rejects a missing file", () => {
    const expected = new Map([["does-not-exist.exe", sha256("x")]]);
    const { ok, results } = verifyReleaseHashes(dir, expected);
    expect(ok).toBe(false);
    expect(results[0]?.status).toBe("MISSING");
  });
});

describe("applyPins (authoritative hashes)", () => {
  it("adds a pin that agrees with the manifest", () => {
    const map = parseSha256Sums(`${"a".repeat(64)}  setup.exe`);
    applyPins(map, [`setup.exe=${"a".repeat(64)}`]);
    expect(map.get("setup.exe")).toBe("a".repeat(64));
  });

  it("throws when a pin contradicts the manifest", () => {
    const map = parseSha256Sums(`${"a".repeat(64)}  setup.exe`);
    expect(() => applyPins(map, [`setup.exe=${"b".repeat(64)}`])).toThrow(/AUTHORITATIVE MISMATCH/);
  });

  it("throws on an invalid pin hash", () => {
    const map = parseSha256Sums(`${"a".repeat(64)}  setup.exe`);
    expect(() => applyPins(map, ["setup.exe=not-hex"])).toThrow(/Invalid pin/);
  });
});
