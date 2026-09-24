import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolBroker } from "../src/index.js";

describe("write progress evidence", () => {
  let workspacePath: string;
  const broker = new ToolBroker();
  const permissions = { read: true, search: true, write: true, executeCommand: false, network: false };

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), "no-effect-write-"));
    await writeFile(join(workspacePath, "target.ts"), "export const value = 1;\n");
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  it("rejects an identical whole-file write without touching the file", async () => {
    const target = join(workspacePath, "target.ts");
    const mtime = (await stat(target)).mtimeMs;
    const result = await broker.executeTool(
      { name: "write_file", arguments: { path: "target.ts", content: "export const value = 1;\n" } },
      { workspacePath, permissions, role: "coder" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("TOOL_NO_EFFECT");
    expect(result.output).toContain("Re-read the target");
    expect(await readFile(target, "utf-8")).toBe("export const value = 1;\n");
    expect((await stat(target)).mtimeMs).toBe(mtime);
  });

  it("rejects an identical exact edit and accepts a real same-line replacement", async () => {
    const context = { workspacePath, permissions, role: "coder" };
    const unchanged = await broker.executeTool(
      { name: "edit_file", arguments: { path: "target.ts", oldText: "value = 1", newText: "value = 1" } },
      context,
    );
    expect(unchanged.success).toBe(false);
    expect(unchanged.error).toBe("TOOL_NO_EFFECT");
    const changed = await broker.executeTool(
      { name: "edit_file", arguments: { path: "target.ts", oldText: "value = 1", newText: "value = 2" } },
      context,
    );
    expect(changed.success).toBe(true);
    expect(await readFile(join(workspacePath, "target.ts"), "utf-8")).toContain("value = 2");
  });
});
