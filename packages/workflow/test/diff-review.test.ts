import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewDiff } from "../src/diff-review.js";

describe("DiffReview", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "diff-"));
    await writeFile(join(ws, "file.txt"), "hello\nworld\n");
  });
  afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

  it("detects no changes", async () => {
    const before = new Map<string, string>([["file.txt", "hello\nworld\n"]]);
    const review = await reviewDiff(ws, { beforeSnapshots: before });
    expect(review.diffs.length).toBe(0);
    expect(review.approved).toBe(true);
  });

  it("detects modification", async () => {
    const before = new Map<string, string>([["file.txt", "hello\nworld\n"]]);
    await writeFile(join(ws, "file.txt"), "hello\nchanged\n");
    const review = await reviewDiff(ws, { beforeSnapshots: before });
    expect(review.diffs.length).toBe(1);
    expect(review.diffs[0]!.diff).toContain("changed");
    expect(review.diffs[0]!.additions).toBe(1);
    expect(review.diffs[0]!.deletions).toBe(1);
    expect(review.summary).toContain("1 file");
  });

  it("detects new file", async () => {
    const before = new Map<string, string>([["file.txt", "hello\nworld\n"]]);
    await writeFile(join(ws, "new.txt"), "new content\n");
    const review = await reviewDiff(ws, { beforeSnapshots: before });
    expect(review.diffs).toEqual([expect.objectContaining({ path: "new.txt", changeType: "created" })]);
  });

  it.each([true, false])("reviews nested untracked files with snapshots=%s", async (snapshots) => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: ws, windowsHide: true });
    git("init");
    await writeFile(join(ws, ".gitignore"), "ignored/\n");
    git("add", ".");
    git("-c", "user.name=Review Test", "-c", "user.email=review@example.invalid", "commit", "-m", "baseline");
    await mkdir(join(ws, "new tests"));
    await mkdir(join(ws, "ignored"));
    const nestedPath = "new tests/régression → spec.cjs";
    const content = "const answer = 42;\n";
    await writeFile(join(ws, nestedPath), content);
    await writeFile(join(ws, "root-test.cjs"), content);
    await writeFile(join(ws, "ignored", "ignored.cjs"), content);
    await writeFile(join(ws, "old-untracked.cjs"), content);
    await utimes(join(ws, "old-untracked.cjs"), 1, 1);
    const review = await reviewDiff(ws, snapshots ? {
      beforeSnapshots: new Map([["file.txt", "hello\nworld\n"]]),
      sinceMs: Date.now() - 60_000,
    } : {});
    expect(review.diffs.map(entry => entry.path).sort()).toEqual([
      nestedPath, ...(snapshots ? [] : ["old-untracked.cjs"]), "root-test.cjs",
    ].sort());
    expect(review.diffs.find(entry => entry.path === nestedPath)).toMatchObject({
      changeType: "created", afterHash: createHash("sha256").update(content).digest("hex"),
    });
    expect(review.diffs.find(entry => entry.path === nestedPath)?.diff).toContain("+const answer = 42;");
  });

  it("redacts secrets in diff", async () => {
    const before = new Map<string, string>([["file.txt", "hello\n"]]);
    await writeFile(join(ws, "file.txt"), "sk-proj-1234567890abcdef\n");
    const review = await reviewDiff(ws, { beforeSnapshots: before });
    if (review.diffs.length > 0) {
      expect(review.diffs[0]!.diff).not.toContain("sk-proj-1234567890");
    }
  });

  it("handles abort", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(reviewDiff(ws, { signal: controller.signal })).rejects.toThrow();
  });
});
