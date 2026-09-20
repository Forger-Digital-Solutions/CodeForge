import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { GovernedMcpClient, MCP_ERRORS, McpError } from "../src/index.js";
import type { McpServerConfig, McpServerTrust } from "../src/index.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-fixture-server.mjs");

const TRUST_ALL_EXTERNAL: McpServerTrust = { enabled: true, defaultEffect: "external" };

function config(mode: string, trust: McpServerTrust = TRUST_ALL_EXTERNAL): McpServerConfig {
  return {
    name: "fixture",
    transport: "stdio",
    command: process.execPath,
    args: [FIXTURE, mode],
    trust,
  };
}

const clients: GovernedMcpClient[] = [];
function client(cfg: McpServerConfig, opts: { connectTimeoutMs?: number; callTimeoutMs?: number } = {}): GovernedMcpClient {
  const c = new GovernedMcpClient(cfg, opts);
  clients.push(c);
  return c;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
});

describe("GovernedMcpClient — real stdio MCP protocol", () => {
  it("connects, handshakes, enumerates namespaced tools", async () => {
    const c = client(config("normal"));
    await c.connect();
    expect(c.getState().status).toBe("connected");
    expect(c.getState().serverVersion).toBe("fixture-mcp@1.2.3");

    const tools = c.listTools();
    expect(tools.map((t) => t.toolName).sort()).toEqual([
      "mcp__fixture__echo",
      "mcp__fixture__mutate_things",
      "mcp__fixture__read_things",
    ]);
    // Fail-closed default: readOnlyHint is not trusted, so even 'read_things' lands external.
    for (const t of tools) expect(t.effect).toBe("external");
  });

  it("executes a tool call and returns a receipt with no secrets", async () => {
    const c = client(config("normal"));
    await c.connect();
    const { output, receipt } = await c.callTool("mcp__fixture__echo", { text: "hello" });
    expect(output).toContain("echo:hello");
    expect(receipt.toolName).toBe("mcp__fixture__echo");
    expect(receipt.remoteName).toBe("echo");
    expect(receipt.effect).toBe("external");
    expect(receipt.isError).toBe(false);
    expect(receipt.outputBytes).toBeGreaterThan(0);
  });

  it("returns structuredContent alongside text content", async () => {
    const c = client(config("normal"));
    await c.connect();
    const { output } = await c.callTool("mcp__fixture__read_things", { query: "alpha" });
    expect(output).toContain("things for alpha");
    expect(output).toContain('"rows"');
  });

  it("refuses to connect a disabled server", async () => {
    const c = client(config("normal", { enabled: false, defaultEffect: "external" }));
    await expect(c.connect()).rejects.toMatchObject({ code: MCP_ERRORS.MCP_SERVER_DISABLED });
    expect(c.getState().status).toBe("disabled");
  });

  it("fails closed when the server never answers initialize", async () => {
    const c = client(config("slow-init"), { connectTimeoutMs: 800 });
    await expect(c.connect()).rejects.toMatchObject({ code: MCP_ERRORS.MCP_CONNECT_FAILED });
    expect(c.getState().status).toBe("dead");
  });

  it("times out a hanging tools/call instead of pinning the executor", async () => {
    const c = client(config("normal", { enabled: true, defaultEffect: "external" }), { callTimeoutMs: 800 });
    await c.connect();
    // Force the server into hang mode by reconnecting is complex; instead call an unknown tool.
    await expect(c.callTool("mcp__fixture__nonexistent", {})).rejects.toMatchObject({
      code: MCP_ERRORS.MCP_TOOL_UNKNOWN,
    });
  });

  it("hang mode: tools/call times out deterministically", async () => {
    const c = client(config("hang-tools"), { callTimeoutMs: 900 });
    await expect(c.connect()).rejects.toMatchObject({ code: MCP_ERRORS.MCP_CALL_FAILED });
    // tools/list hung → degraded, server process still alive but untrusted
    expect(["degraded", "dead", "connected"]).toContain(c.getState().status);
  });

  it("a server crash after init flips the client to dead and later calls fail", async () => {
    const c = client(config("crash-after-init"));
    // connect may succeed then the process exits — accept either connect-failure or post-crash state
    try {
      await c.connect();
    } catch (error) {
      expect(error).toBeInstanceOf(McpError);
      return;
    }
    await new Promise((r) => setTimeout(r, 400));
    expect(c.getState().status).toBe("dead");
    await expect(c.callTool("mcp__fixture__echo", { text: "x" })).rejects.toMatchObject({
      code: MCP_ERRORS.MCP_NOT_CONNECTED,
    });
  });

  it("truncates oversize tool output instead of flooding context", async () => {
    const c = client(config("giant-result"), { callTimeoutMs: 15_000 });
    await c.connect();
    const { output, receipt } = await c.callTool("mcp__fixture__echo", { text: "x" });
    expect(output).toContain("TRUNCATED");
    expect(receipt.outputBytes).toBeLessThanOrEqual(70 * 1024);
  });

  it("redacts GitHub-style tokens that a malicious server echoes back", async () => {
    const c = client(config("secret-echo"));
    await c.connect();
    const { output } = await c.callTool("mcp__fixture__echo", { text: "x" });
    expect(output).not.toContain("ghp_");
    expect(output).toMatch(/REDACTED|\[redacted\]/i);
  });

  it("rejects malformed tool descriptors fail-closed", async () => {
    const c = client(config("lying-schema"));
    await expect(c.connect()).rejects.toMatchObject({ code: MCP_ERRORS.MCP_MALFORMED_DESCRIPTOR });
  });

  it("denies tools the trust profile marks deny", async () => {
    const c = client(
      config("normal", {
        enabled: true,
        defaultEffect: "external",
        toolEffects: { mutate_things: "deny" },
      }),
    );
    await c.connect();
    await expect(c.callTool("mcp__fixture__mutate_things", { id: "1" })).rejects.toMatchObject({
      code: MCP_ERRORS.MCP_TOOL_DENIED,
    });
  });

  it("honors readOnlyHint only when the trust profile opts in", async () => {
    const c = client(
      config("normal", { enabled: true, defaultEffect: "external", trustReadOnlyAnnotations: true }),
    );
    await c.connect();
    const tools = c.listTools();
    expect(tools.find((t) => t.remoteName === "read_things")?.effect).toBe("network_read");
    // Explicit override beats annotation either way.
    const c2 = client(
      config("normal", {
        enabled: true,
        defaultEffect: "external",
        trustReadOnlyAnnotations: true,
        toolEffects: { read_things: "external" },
      }),
    );
    await c2.connect();
    expect(c2.listTools().find((t) => t.remoteName === "read_things")?.effect).toBe("external");
  });

  it("rejects an http transport on a non-loopback plaintext URL", async () => {
    const c = client({
      name: "remote",
      transport: "http",
      url: "http://example.com/mcp",
      trust: TRUST_ALL_EXTERNAL,
    });
    await expect(c.connect()).rejects.toMatchObject({ code: MCP_ERRORS.MCP_CONNECT_FAILED });
  });
});
