import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectRepository } from "../src/repo-inspector.js";
import { understandTask } from "../src/task-intelligence.js";

describe("RepoInspector", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "inspect-"));
    await mkdir(join(ws, "src"), { recursive: true });
    await writeFile(join(ws, "src", "calc.ts"), "export function add(a: number, b: number){ return a - b; }");
    await writeFile(join(ws, "src", "util.ts"), "export const x = 1;");
    await writeFile(join(ws, "package.json"), JSON.stringify({ name: "test" }));
    await writeFile(join(ws, "README.md"), "# Test");
  });
  afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

  it("collects files and searches by keywords", async () => {
    const intent = understandTask("Fix add function");
    const map = await inspectRepository(ws, intent);
    expect(map.files.length).toBeGreaterThanOrEqual(3);
    expect(map.searchedMatches.some((m) => m.file.includes("calc.ts"))).toBe(true);
    expect(map.readFiles.length).toBeGreaterThan(0);
    expect(map.readFiles[0]!.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("respects workspace boundary", async () => {
    const intent = understandTask("test");
    await expect(inspectRepository("/nonexistent/path/xyz", intent)).rejects.toThrow();
  });

  it("handles cancellation via signal", async () => {
    const intent = understandTask("Fix add");
    const controller = new AbortController();
    controller.abort();
    await expect(inspectRepository(ws, intent, { signal: controller.signal })).rejects.toThrow();
  });

  it("redacts secrets in preview", async () => {
    await writeFile(join(ws, "src", "secret.ts"), "const k = 'sk-proj-1234567890abcdef';");
    const intent = understandTask("sk-proj");
    const map = await inspectRepository(ws, intent);
    for (const m of map.searchedMatches) {
      expect(m.preview).not.toContain("sk-proj-1234567890");
    }
  });
});
