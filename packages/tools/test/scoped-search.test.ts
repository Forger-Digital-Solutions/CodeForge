import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createToolBroker } from "../src/index.js";

describe("standalone search scope", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cf-broker-search-"));
    await writeFile(join(root, "a-unrelated.ts"), "const Needle = 'unrelated';\n".repeat(100));
    await mkdir(join(root, "scoped"));
    await writeFile(join(root, "scoped", "target.ts"), "const Needle = 'target';\n");
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function search(path: unknown) {
    return createToolBroker().executeTool({ name: "search_files", arguments: { path, query: "Needle", maxMatches: 1 } }, {
      workspacePath: root, role: "explorer", runId: "scope-run", agentId: "scope-explorer",
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
    });
  }

  it.each(["scoped", "scoped/target.ts"])("keeps the %s scope despite unrelated matches filling the global limit", async scope => {
    const result = await search(scope);
    expect(result.success).toBe(true);
    expect(result.output.replaceAll("\\", "/")).toContain("scoped/target.ts:1:");
    expect(result.output).not.toContain("unrelated");
  });

  it.each(["../outside.ts", "missing.ts", 42])("fails closed for an invalid scope %s", async scope => {
    const result = await search(scope);
    expect(result.success).toBe(false);
    expect(result.output).not.toContain("a-unrelated.ts:1:");
    expect(result.output).not.toContain("target.ts:1:");
  });
});
