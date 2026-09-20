/**
 * MCP server trust + capability model (R22).
 *
 * A configured MCP server is an untrusted external capability provider. Declaring a server does
 * not grant it reach: every advertised tool maps onto a CodeForge effect class, and anything the
 * profile does not explicitly downgrade stays `external` (the always-ask tier). A server that
 * claims "read-only" in a tool description is lying until proven otherwise — descriptions are
 * never consulted for policy.
 */

export type McpTransportKind = "stdio" | "http";

/** What a bridged MCP tool is allowed to be, in CodeForge effect terms. */
export type McpToolEffect = "deny" | "network_read" | "external";

export interface McpServerTrust {
  /** Disabled servers are never connected and their tools are never advertised. */
  enabled: boolean;
  /**
   * Effect class applied to tools with no explicit override and (when annotations are not
   * trusted) no honored readOnly hint. Default must be `external` — fail closed.
   */
  defaultEffect: McpToolEffect;
  /** Per-tool overrides keyed by the server's own tool name. */
  toolEffects?: Record<string, McpToolEffect>;
  /**
   * When false (default), MCP `readOnlyHint` annotations are ignored: a hostile server can mark
   * a mutating tool read-only. Enable only for servers the operator has audited.
   */
  trustReadOnlyAnnotations?: boolean;
}

export interface McpStdioServerConfig {
  name: string;
  transport: "stdio";
  /** Executable to spawn. Launching a local MCP server is itself an executable boundary. */
  command: string;
  args?: string[];
  /** Explicit env only — the parent environment is never inherited wholesale. */
  env?: Record<string, string>;
  cwd?: string;
  trust: McpServerTrust;
}

export interface McpHttpServerConfig {
  name: string;
  transport: "http";
  /** https endpoint (or http loopback for local development servers). */
  url: string;
  /** Optional static headers. Values are credentials-adjacent: never logged, never in receipts. */
  headers?: Record<string, string>;
  trust: McpServerTrust;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export type McpServerStatus = "configured" | "connecting" | "connected" | "degraded" | "dead" | "disabled";

export interface McpServerState {
  name: string;
  status: McpServerStatus;
  serverVersion?: string;
  lastError?: string;
  connectedAt?: string;
  toolCount?: number;
}

export interface McpToolDescriptor {
  serverName: string;
  /** Name as the server advertised it. */
  remoteName: string;
  /** Namespaced agent-facing name: mcp__<server>__<tool>. */
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effect: McpToolEffect;
  readOnlyHint?: boolean;
}

export interface McpCallReceipt {
  serverName: string;
  toolName: string;
  remoteName: string;
  effect: McpToolEffect;
  isError: boolean;
  outputBytes: number;
  durationMs: number;
  at: string;
}
