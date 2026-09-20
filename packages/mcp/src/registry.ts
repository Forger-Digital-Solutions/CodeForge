import { formatUntrustedData } from "@codeforge/agent";
import type { ToolDefinition } from "@codeforge/tools";
import { GovernedMcpClient, MCP_ERRORS, McpError, type GovernedMcpClientOptions } from "./client.js";
import type { McpServerConfig, McpServerState, McpToolDescriptor } from "./types.js";

/**
 * MCP registry: the bridge between configured MCP servers and CodeForge's tool surface.
 *
 * Bridged tools are namespaced `mcp__<server>__<tool>` so they can never shadow built-ins or
 * collide across servers. Every descriptor carries a CodeForge effect class decided by the
 * server's trust profile — the model-visible schema is the server's own, but authority stays
 * with CodeForge policy, not with anything the server claims.
 */

export class McpRegistry {
  private readonly clients = new Map<string, GovernedMcpClient>();
  private readonly configs = new Map<string, McpServerConfig>();

  constructor(private readonly clientOptions: GovernedMcpClientOptions = {}) {}

  configure(config: McpServerConfig): void {
    if (!/^[A-Za-z0-9_-]{1,48}$/.test(config.name)) {
      throw new McpError(MCP_ERRORS.MCP_MALFORMED_DESCRIPTOR, `Unsafe MCP server name "${config.name}"`);
    }
    this.configs.set(config.name, config);
    this.clients.delete(config.name);
  }

  remove(name: string): void {
    this.configs.delete(name);
    const client = this.clients.get(name);
    this.clients.delete(name);
    void client?.close().catch(() => undefined);
  }

  listServerStates(): McpServerState[] {
    return [...this.configs.keys()].map((name) => this.clients.get(name)?.getState() ?? { name, status: "configured" });
  }

  /** Connect one configured server and enumerate its tools. */
  async connect(name: string): Promise<McpToolDescriptor[]> {
    const config = this.configs.get(name);
    if (!config) throw new McpError(MCP_ERRORS.MCP_TOOL_UNKNOWN, `MCP server "${name}" is not configured`);
    let client = this.clients.get(name);
    if (!client) {
      client = new GovernedMcpClient(config, this.clientOptions);
      this.clients.set(name, client);
    }
    await client.connect();
    return client.listTools();
  }

  /** Connect every enabled server; per-server failures degrade that server, never the registry. */
  async connectAll(): Promise<Map<string, McpToolDescriptor[] | McpError>> {
    const results = new Map<string, McpToolDescriptor[] | McpError>();
    for (const [name, config] of this.configs) {
      if (!config.trust.enabled) {
        results.set(name, new McpError(MCP_ERRORS.MCP_SERVER_DISABLED, `MCP server "${name}" is disabled`));
        continue;
      }
      try {
        results.set(name, await this.connect(name));
      } catch (error) {
        results.set(name, error instanceof McpError ? error : new McpError(MCP_ERRORS.MCP_CONNECT_FAILED, String(error)));
      }
    }
    return results;
  }

  /** All currently-enumerated tools that policy permits the model to see (excludes `deny`). */
  toolDescriptors(): McpToolDescriptor[] {
    const out: McpToolDescriptor[] = [];
    for (const client of this.clients.values()) {
      for (const tool of client.listTools()) {
        if (tool.effect !== "deny") out.push(tool);
      }
    }
    return out;
  }

  /** ToolDefinition view for ToolRegistry.register — one entry per bridged tool. */
  toolDefinitions(): ToolDefinition[] {
    return this.toolDescriptors().map((tool) => ({
      name: tool.toolName,
      description: `[MCP:${tool.serverName}] ${tool.description || tool.remoteName}`.slice(0, 400),
      parameters: normalizeSchema(tool.inputSchema),
      requiredPermission: "network",
      readOnly: tool.effect === "network_read",
      executionClass: "network",
    }));
  }

  /**
   * Executor for the ToolBroker `customExecutor` seam. Returns undefined for non-MCP tools.
   * Output is wrapped as untrusted data — MCP results are evidence, never instruction.
   */
  executor(): (name: string, args: Record<string, unknown>) => Promise<string | undefined> {
    return async (name, args) => {
      if (!name.startsWith("mcp__")) return undefined;
      for (const client of this.clients.values()) {
        const descriptor = client.listTools().find((t) => t.toolName === name);
        if (!descriptor) continue;
        const { output, receipt } = await client.callTool(name, args);
        return formatUntrustedData(
          JSON.stringify({ receipt, output }),
          `MCP server ${descriptor.serverName}`,
        );
      }
      throw new McpError(MCP_ERRORS.MCP_TOOL_UNKNOWN, `No connected MCP server provides ${name}`);
    };
  }

  /** Effect class of a bridged tool — the authority layer maps this onto a permission tier. */
  effectOf(toolName: string): "network_read" | "external" | undefined {
    for (const client of this.clients.values()) {
      const tool = client.listTools().find((t) => t.toolName === toolName);
      if (tool) return tool.effect === "deny" ? undefined : tool.effect;
    }
    return undefined;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => undefined)));
  }
}

function normalizeSchema(schema: Record<string, unknown>): ToolDefinition["parameters"] {
  const properties =
    typeof schema.properties === "object" && schema.properties !== null && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : undefined;
  return { type: "object", properties, ...(required ? { required } : {}) };
}
