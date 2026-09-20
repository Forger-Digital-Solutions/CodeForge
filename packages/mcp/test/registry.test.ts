import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { McpRegistry } from "../src/index.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-fixture-server.mjs");

const registries: McpRegistry[] = [];
function registry(opts: { connectTimeoutMs?: number } = {}): McpRegistry {
  const r = new McpRegistry(opts);
  registries.push(r);
  return r;
}

afterEach(async () => {
  await Promise.all(registries.splice(0).map((r) => r.closeAll()));
});

function fixtureConfig(name: string, mode = "normal") {
  return {
    name,
    transport: "stdio" as const,
    command: process.execPath,
    args: [FIXTURE, mode],
    trust: { enabled: true, defaultEffect: "external" as const },
  };
}

describe("McpRegistry — tool bridging", () => {
  it("bridges enumerated tools into namespaced ToolDefinitions", async () => {
    const r = registry();
    r.configure(fixtureConfig("fixture"));
    await r.connect("fixture");

    const defs = r.toolDefinitions();
    expect(defs.map((d) => d.name).sort()).toEqual([
      "mcp__fixture__echo",
      "mcp__fixture__mutate_things",
      "mcp__fixture__read_things",
    ]);
    for (const def of defs) {
      expect(def.requiredPermission).toBe("network");
      expect(def.executionClass).toBe("network");
      expect(def.readOnly).toBe(false); // annotations untrusted by default
    }
    expect(r.effectOf("mcp__fixture__echo")).toBe("external");
    expect(r.effectOf("browser_navigate")).toBeUndefined();
  });

  it("executor returns undefined for non-MCP tools and untrusted-wrapped output for MCP tools", async () => {
    const r = registry();
    r.configure(fixtureConfig("fixture"));
    await r.connect("fixture");
    const exec = r.executor();

    expect(await exec("read_file", {})).toBeUndefined();
    const out = await exec("mcp__fixture__echo", { text: "hi" });
    expect(out).toContain("UNTRUSTED_DATA");
    expect(out).toContain("echo:hi");
    expect(out).toContain('"receipt"');
  });

  it("a deny-effect tool is never advertised to the model", async () => {
    const r = registry();
    r.configure({
      ...fixtureConfig("fixture"),
      trust: { enabled: true, defaultEffect: "external", toolEffects: { mutate_things: "deny" } },
    });
    await r.connect("fixture");
    expect(r.toolDefinitions().map((d) => d.name)).not.toContain("mcp__fixture__mutate_things");
    await expect(r.executor()("mcp__fixture__mutate_things", {})).rejects.toMatchObject({
      code: "MCP_TOOL_DENIED",
    });
  });

  it("connectAll degrades a failing server without killing healthy ones", async () => {
    const r = registry({ connectTimeoutMs: 800 });
    r.configure(fixtureConfig("good"));
    r.configure(fixtureConfig("bad", "slow-init"));
    const results = await r.connectAll();
    expect(results.get("good")).toBeInstanceOf(Array);
    expect(results.get("bad")).toBeInstanceOf(Error);
    expect(r.toolDefinitions().length).toBe(3);
  });

  it("unknown MCP tool names fail with MCP_TOOL_UNKNOWN", async () => {
    const r = registry();
    r.configure(fixtureConfig("fixture"));
    await r.connect("fixture");
    await expect(r.executor()("mcp__fixture__nope", {})).rejects.toMatchObject({ code: "MCP_TOOL_UNKNOWN" });
  });
});
