import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveWithinWorkspace, realpathDeepestExisting } from "../src/path-security.js";

describe("resolveWithinWorkspace - lexical traversal", () => {
  let workspaceRoot: string;
  let outsideRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-lexical-"));
    outsideRoot = await mkdtemp(join(tmpdir(), "out-lexical-"));
    await writeFile(join(outsideRoot, "secret.txt"), "secret data");
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });

  it("allows a valid workspace-relative path", () => {
    const result = resolveWithinWorkspace(workspaceRoot, "src/app.ts");
    expect(result.valid).toBe(true);
    expect(result.resolvedPath).toBeDefined();
  });

  it("rejects ../ traversal to outside", () => {
    const result = resolveWithinWorkspace(
      workspaceRoot,
      join("..", outsideRoot.split(/[\\/]/).pop() ?? "outside", "secret.txt"),
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/traversal/i);
  });

  it("rejects deep ../../ traversal", () => {
    const result = resolveWithinWorkspace(workspaceRoot, "../../../etc/passwd");
    expect(result.valid).toBe(false);
  });

  it("rejects absolute paths outside the workspace", () => {
    const result = resolveWithinWorkspace(workspaceRoot, resolve(join(outsideRoot, "secret.txt")));
    expect(result.valid).toBe(false);
  });

  it("rejects sibling directories that merely share a name prefix", () => {
    const sibling = workspaceRoot + "-evil";
    fs.mkdirSync(sibling, { recursive: true });
    try {
      const result = resolveWithinWorkspace(workspaceRoot, sibling);
      expect(result.valid).toBe(false);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });
});

describe("resolveWithinWorkspace - symlink/junction attacks", () => {
  let workspaceRoot: string;
  let outsideRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-link-"));
    outsideRoot = await mkdtemp(join(tmpdir(), "out-link-"));
    await mkdir(join(workspaceRoot, "safe"), { recursive: true });
    await writeFile(join(outsideRoot, "secret.txt"), "secret data");
    // Attacker-controlled junction inside the workspace pointing outside.
    fs.symlinkSync(outsideRoot, join(workspaceRoot, "escape"), "junction");
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });

  it("realpathDeepestExisting resolves existing links", () => {
    const real = realpathDeepestExisting(join(workspaceRoot, "escape"));
    expect(real.toLowerCase()).toBe(resolve(outsideRoot).toLowerCase());
  });

  it("rejects reads/writes through an escape junction", () => {
    const result = resolveWithinWorkspace(workspaceRoot, join("escape", "secret.txt"));
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/traversal/i);
  });

  it("rejects the escape junction itself as a directory target (list/run cwd)", () => {
    const result = resolveWithinWorkspace(workspaceRoot, "escape");
    expect(result.valid).toBe(false);
  });

  it("rejects absolute escape through the junction", () => {
    const viaJunction = resolve(join(workspaceRoot, "escape", "sub", "..", "secret.txt"));
    const result = resolveWithinWorkspace(workspaceRoot, viaJunction);
    expect(result.valid).toBe(false);
  });

  it("still allows legitimate nested paths and non-existent files inside the workspace", () => {
    const ok = resolveWithinWorkspace(workspaceRoot, join("safe", "new-file.ts"));
    expect(ok.valid).toBe(true);

    const missingDir = resolveWithinWorkspace(workspaceRoot, join("does-not-exist-yet", "file.ts"));
    expect(missingDir.valid).toBe(true);
  });

  it("allows links that point back inside the workspace", () => {
    fs.symlinkSync(join(workspaceRoot, "safe"), join(workspaceRoot, "inside"), "junction");
    const result = resolveWithinWorkspace(workspaceRoot, join("inside", "app.ts"));
    expect(result.valid).toBe(true);
  });
});
