import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { searchWorkspace } from "../src/search-service.js";

describe("workspace search responsiveness", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cf-search-responsive-"));
    await Promise.all(Array.from({ length: 96 }, (_, index) => writeFile(join(root, `${index}.ts`), `export const ordinary${index} = true;\n`)));
    await writeFile(join(root, "late.ts"), "export const LateSearchNeedle = true;\n");
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("lets control-plane work execute before a sparse search finishes without losing matches", async () => {
    let controlPlaneRan = false;
    const heartbeat = setImmediate(() => { controlPlaneRan = true; });
    try {
      const result = await searchWorkspace({ workspacePath: root, query: "latesearchneedle" });
      expect(controlPlaneRan).toBe(true);
      expect(result.matches.map(match => [match.file, match.line, match.column])).toEqual([["late.ts", 1, 14]]);
      expect(result.truncated).toBe(false);
    } finally { clearImmediate(heartbeat); }
  });

  it("honors cancellation delivered after the search starts", async () => {
    const controller = new AbortController();
    const cancel = setImmediate(() => controller.abort());
    try {
      const result = await searchWorkspace({ workspacePath: root, query: "absentNeedle", signal: controller.signal });
      expect(result.truncated).toBe(true);
      expect(result.reason).toBe("cancelled");
      expect(result.filesScanned).toBeLessThan(97);
    } finally { clearImmediate(cancel); }
  });

  it("searches only the requested file even when unrelated files fill the match limit", async () => {
    const result = await searchWorkspace({ workspacePath: root, path: "late.ts", query: "export", maxMatches: 1 });
    expect(result.matches.map(match => match.file)).toEqual(["late.ts"]);
    expect(result.filesScanned).toBe(1);
  });

  it("searches only the requested directory and keeps workspace-relative match paths", async () => {
    await mkdir(join(root, "scoped"));
    await writeFile(join(root, "scoped", "fixture.ts"), "export const ScopedNeedle = true;\n");
    const result = await searchWorkspace({ workspacePath: root, path: "scoped", query: "export" });
    expect(result.matches.map(match => match.file)).toEqual(["scoped/fixture.ts"]);
    expect(result.filesScanned).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("rejects traversal and missing scopes instead of falling back to a workspace-wide search", async () => {
    await expect(searchWorkspace({ workspacePath: root, path: "../outside.ts", query: "export" })).rejects.toThrow(/Path traversal denied/);
    await expect(searchWorkspace({ workspacePath: root, path: "missing.ts", query: "export" })).rejects.toThrow(/Search path unavailable/);
  });

  it("rejects a scoped junction that points outside the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "cf-search-outside-"));
    try {
      await writeFile(join(outside, "private.ts"), "export const PrivateNeedle = true;\n");
      await symlink(outside, join(root, "escape"), "junction");
      await expect(searchWorkspace({ workspacePath: root, path: "escape/private.ts", query: "export" })).rejects.toThrow(/Path traversal denied/);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
});
