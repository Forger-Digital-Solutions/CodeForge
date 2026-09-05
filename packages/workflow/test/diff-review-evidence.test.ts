import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reviewDiff, type BeforeSnapshot } from "../src/diff-review.js";

const fixtures: string[] = [];

function snapshot(content: string): BeforeSnapshot {
  return { kind: "text", content, size: Buffer.byteLength(content), hash: crypto.createHash("sha256").update(content).digest("hex") };
}

describe("reviewDiff run-bound evidence", () => {
  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fs.rmSync(fixture, { recursive: true, force: true });
  });

  it("excludes an unrelated pre-existing dirty file while retaining text and binary Agent changes", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codeforge-cf13-diff-"));
    fixtures.push(workspace);
    fs.writeFileSync(path.join(workspace, "agent.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(workspace, "user-notes.txt"), "my uncommitted notes\n");
    fs.writeFileSync(path.join(workspace, "asset.bin"), Buffer.from([0, 1, 2]));

    const snapshots = new Map<string, BeforeSnapshot>([
      ["agent.ts", snapshot("export const value = 1;\n")],
      ["user-notes.txt", snapshot("my uncommitted notes\n")],
      ["asset.bin", { kind: "binary", size: 3, hash: crypto.createHash("sha256").update(Buffer.from([0, 1, 2])).digest("hex") }],
    ]);
    fs.writeFileSync(path.join(workspace, "agent.ts"), "export const value = 2;\n");
    fs.writeFileSync(path.join(workspace, "asset.bin"), Buffer.from([0, 1, 3, 4]));

    const review = await reviewDiff(workspace, { beforeSnapshots: snapshots });
    expect(review.diffs.map((diff) => diff.path)).toEqual(["agent.ts", "asset.bin"]);
    expect(review.diffs.find((diff) => diff.path === "user-notes.txt")).toBeUndefined();
    expect(review.diffs.find((diff) => diff.path === "asset.bin")).toMatchObject({ binary: true, beforeSize: 3, afterSize: 4, diff: "" });
    expect(review.diffs.find((diff) => diff.path === "agent.ts")?.diff).toContain("+export const value = 2;");

    // This is the evidence object persisted by the workflow. Later workspace mutations cannot
    // change it because the inspector consumes this snapshot rather than asking Git again.
    const historicalPaths = review.diffs.map((diff) => diff.path);
    fs.writeFileSync(path.join(workspace, "user-notes.txt"), "later unrelated mutation\n");
    expect(historicalPaths).toEqual(["agent.ts", "asset.bin"]);
  });
});
