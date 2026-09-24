import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BROWSER_TOOL_DEFINITIONS,
  DEFAULT_BROWSER_POLICY,
  GovernedBrowserRuntime,
  createBrowserToolExecutor,
  isBrowserTool,
  type BrowserPolicy,
} from "@codeforge/browser";
import {
  COMPUTER_TOOL_DEFINITIONS,
  GovernedComputerRuntime,
  createComputerToolExecutor,
  isComputerTool,
} from "@codeforge/computer-use";
import { McpRegistry, type McpServerConfig } from "@codeforge/mcp";
import type { ToolDefinition } from "@codeforge/tools";

/**
 * R22 composition root for governed external tools (browser + MCP).
 *
 * Nothing here is enabled by default: an absent config file means the agent's tool surface is
 * byte-for-byte the R21 surface. Enabling requires an explicit opt-in — `externalTools` in
 * ServerOptions (tests/embedding), a `~/.codeforge/external-tools.json` file, or the
 * CODEFORGE_BROWSER env switch — so a first-run install never advertises network-capable tools
 * the owner never asked for. CODEFORGE_EXTERNAL_TOOLS=0 hard-disables the whole surface.
 */
export interface ExternalToolConfig {
  browser?: {
    enabled?: boolean;
    headless?: boolean;
    /** Policy overrides; unspecified fields keep the fail-closed defaults. */
    allowPrivateNetwork?: boolean;
    allowLoopbackHttp?: boolean;
    allowPlainHttp?: boolean;
    allowedHosts?: string[];
    deniedHosts?: string[];
    maxSessions?: number;
  };
  /**
   * Real-desktop input/capture. Off by default and independently gated: enabling here only
   * *exposes* the tools — every input-injection call still requires the executeCommand
   * permission flag and maps to the highest approval tier.
   */
  computerUse?: {
    enabled?: boolean;
    maxActionsPerSession?: number;
    minActionIntervalMs?: number;
    maxTypeLength?: number;
    allowMultiMonitor?: boolean;
    maxUiaElements?: number;
  };
  /** Explicit MCP server list. Only named servers are ever spawned. */
  mcpServers?: McpServerConfig[];
  clientTimeoutsMs?: { connect?: number; call?: number };
  /** When a plugin host is injected, contributed commands are bridged unless this is false. */
  plugins?: { exposeCommands?: boolean };
}

/**
 * Structural view of the extension host (`ExtensionManager` in the desktop process). Kept
 * duck-typed so @codeforge/server gains no dependency edge on @codeforge/plugins — the desktop
 * injects its live manager, tests inject a stub.
 */
export interface PluginToolHost {
  list(): Array<{
    id: string;
    enabled: boolean;
    status: string;
    permissions: string[];
    commands: Array<{ id: string; title: string }>;
  }>;
  runCommand(extensionId: string, commandId: string, args: unknown[]): Promise<{ ok: boolean; error?: string; result?: string }>;
}

export interface ExternalToolSurface {
  /**
   * Model-visible definitions. Read per-run so plugin enable/disable changes are reflected
   * without a server restart; stable within a single run's registration.
   */
  readonly definitions: ToolDefinition[];
  execute(name: string, args: Record<string, unknown>): Promise<string | undefined>;
  effectOf(toolName: string): "network_read" | "external" | undefined;
  init(): Promise<void>;
  close(): Promise<void>;
  /** Introspection for status endpoints and evidence — states, never payloads. */
  describe(): { browser: { enabled: boolean }; computerUse?: { enabled: boolean }; mcpServers: { name: string; status: string; tools: number }[]; plugins: { bridgedCommands: number } };
}

/**
 * Browser tools that change page/session state — after one of these runs, prior read results
 * are stale and must not be replayed by ForgeGreen duplicate suppression.
 */
export const BROWSER_STATE_CHANGING_TOOLS: ReadonlySet<string> = new Set([
  "browser_launch",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_select",
  "browser_submit",
  "browser_close",
]);

/**
 * Browser tools that only observe current page/session state — identical calls inside one
 * interaction-state window are eligible for duplicate suppression with a transparent replay
 * marker.
 */
export const BROWSER_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "browser_inspect",
  "browser_state",
  "browser_wait",
  "browser_screenshot",
]);

const DISABLED_SURFACE: ExternalToolSurface = {
  definitions: [],
  execute: async () => undefined,
  effectOf: () => undefined,
  init: async () => {},
  close: async () => {},
  describe: () => ({ browser: { enabled: false }, mcpServers: [], plugins: { bridgedCommands: 0 } }),
};

/** Tool names must survive provider wire constraints ([a-zA-Z0-9_-]); dots are not allowed. */
function sanitizeToolSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function pluginToolName(extensionId: string, commandId: string): string {
  return `plugin__${sanitizeToolSegment(extensionId)}__${sanitizeToolSegment(commandId)}`;
}

export function defaultExternalToolsConfigPath(): string {
  return path.join(os.homedir(), ".codeforge", "external-tools.json");
}

/** Reads the on-disk config; a missing or unparseable file yields an empty (disabled) config. */
export function loadExternalToolConfig(configPath?: string): ExternalToolConfig {
  const resolved = configPath ?? process.env.CODEFORGE_EXTERNAL_TOOLS_CONFIG ?? defaultExternalToolsConfigPath();
  try {
    const raw = fs.readFileSync(resolved, "utf8");
    const parsed = JSON.parse(raw) as ExternalToolConfig;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function createExternalToolSurface(
  config: ExternalToolConfig,
  opts: { configDir?: string; pluginHost?: PluginToolHost } = {},
): ExternalToolSurface {
  if (process.env.CODEFORGE_EXTERNAL_TOOLS === "0") return DISABLED_SURFACE;

  const browserCfg = config.browser ?? {};
  const browserEnabled =
    (browserCfg.enabled ?? process.env.CODEFORGE_BROWSER === "1") && process.env.CODEFORGE_BROWSER !== "0";
  const computerCfg = config.computerUse ?? {};
  const computerEnabled =
    (computerCfg.enabled ?? process.env.CODEFORGE_COMPUTER_USE === "1") &&
    process.env.CODEFORGE_COMPUTER_USE !== "0" &&
    process.platform === "win32";
  const mcpConfigs = (config.mcpServers ?? []).filter((s) => s.trust?.enabled !== false);
  const pluginHost =
    opts.pluginHost && config.plugins?.exposeCommands !== false ? opts.pluginHost : undefined;
  if (!browserEnabled && !computerEnabled && mcpConfigs.length === 0 && !pluginHost) return DISABLED_SURFACE;

  const baseDir = opts.configDir ?? path.join(os.homedir(), ".codeforge");
  const coreDefinitions: ToolDefinition[] = [];

  /**
   * Contributed commands of active extensions become `plugin__<ext>__<command>` tools. The
   * mapping is re-enumerated per access so enabling/disabling an extension takes effect on the
   * next run without a restart. Classification is uniform and fail-closed: every bridged
   * command is a potentially-mutating `write`-gated tool (extensions can write settings and
   * raise notifications); TaskAuthority maps it to a grantable Tier 2 on interactive runs.
   */
  const pluginCommands = (): Map<string, { extensionId: string; commandId: string; def: ToolDefinition }> => {
    const map = new Map<string, { extensionId: string; commandId: string; def: ToolDefinition }>();
    if (!pluginHost) return map;
    for (const ext of pluginHost.list()) {
      if (!ext.enabled || ext.status !== "active") continue;
      for (const cmd of ext.commands) {
        const name = pluginToolName(ext.id, cmd.id);
        map.set(name, {
          extensionId: ext.id,
          commandId: cmd.id,
          def: {
            name,
            description: `[extension ${ext.id}] ${cmd.title}`,
            parameters: {
              type: "object",
              properties: {
                args: {
                  type: "array",
                  description: "Arguments forwarded to the extension command handler",
                },
              },
            },
            requiredPermission: "write",
            readOnly: false,
            executionClass: "write",
          },
        });
      }
    }
    return map;
  };

  let browserRuntime: GovernedBrowserRuntime | undefined;
  let browserExecutor: ((name: string, args: Record<string, unknown>) => Promise<string | undefined>) | undefined;
  if (browserEnabled) {
    const policy: BrowserPolicy = {
      ...DEFAULT_BROWSER_POLICY,
      ...(browserCfg.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {}),
      ...(browserCfg.allowLoopbackHttp === false ? { allowLoopbackHttp: false } : {}),
      ...(browserCfg.allowPlainHttp === true ? { allowPlainHttp: true } : {}),
      ...(Array.isArray(browserCfg.allowedHosts) ? { allowedHosts: new Set(browserCfg.allowedHosts.map((h) => h.toLowerCase())) } : {}),
      ...(Array.isArray(browserCfg.deniedHosts) ? { deniedHosts: new Set(browserCfg.deniedHosts.map((h) => h.toLowerCase())) } : {}),
    };
    browserRuntime = new GovernedBrowserRuntime({
      policy,
      downloadDir: path.join(baseDir, "browser-downloads"),
      screenshotDir: path.join(baseDir, "browser-evidence"),
      ...(browserCfg.headless !== undefined ? { headless: browserCfg.headless } : {}),
      ...(browserCfg.maxSessions !== undefined ? { maxSessions: browserCfg.maxSessions } : {}),
    });
    browserExecutor = createBrowserToolExecutor(browserRuntime);
    coreDefinitions.push(...BROWSER_TOOL_DEFINITIONS);
  }

  let computerRuntime: GovernedComputerRuntime | undefined;
  let computerExecutor: ((name: string, args: Record<string, unknown>) => Promise<string | undefined>) | undefined;
  if (computerEnabled) {
    computerRuntime = new GovernedComputerRuntime({
      evidenceDir: path.join(baseDir, "computer-evidence"),
      policy: {
        ...(computerCfg.maxActionsPerSession !== undefined ? { maxActionsPerSession: computerCfg.maxActionsPerSession } : {}),
        ...(computerCfg.minActionIntervalMs !== undefined ? { minActionIntervalMs: computerCfg.minActionIntervalMs } : {}),
        ...(computerCfg.maxTypeLength !== undefined ? { maxTypeLength: computerCfg.maxTypeLength } : {}),
        ...(computerCfg.allowMultiMonitor !== undefined ? { allowMultiMonitor: computerCfg.allowMultiMonitor } : {}),
        ...(computerCfg.maxUiaElements !== undefined ? { maxUiaElements: computerCfg.maxUiaElements } : {}),
      },
    });
    computerExecutor = createComputerToolExecutor(computerRuntime);
    coreDefinitions.push(...COMPUTER_TOOL_DEFINITIONS);
  }

  const registry = new McpRegistry({
    ...(config.clientTimeoutsMs?.connect !== undefined ? { connectTimeoutMs: config.clientTimeoutsMs.connect } : {}),
    ...(config.clientTimeoutsMs?.call !== undefined ? { callTimeoutMs: config.clientTimeoutsMs.call } : {}),
  });
  let mcpInitialized = false;
  for (const serverConfig of mcpConfigs) registry.configure(serverConfig);

  return {
    get definitions() {
      return [...coreDefinitions, ...[...pluginCommands().values()].map((c) => c.def)];
    },

    async execute(name, args) {
      if (isBrowserTool(name)) {
        if (!browserExecutor) {
          throw new Error("browser is disabled — enable it in external-tools.json or CODEFORGE_BROWSER=1");
        }
        return browserExecutor(name, args);
      }
      if (isComputerTool(name)) {
        if (!computerExecutor) {
          throw new Error("computer use is disabled — enable it in external-tools.json or CODEFORGE_COMPUTER_USE=1");
        }
        return computerExecutor(name, args);
      }
      if (name.startsWith("mcp__")) return registry.executor()(name, args);
      if (name.startsWith("plugin__")) {
        const command = pluginCommands().get(name);
        if (!command || !pluginHost) {
          throw new Error(`plugin command for "${name}" is not registered by an active extension`);
        }
        const forward = Array.isArray(args.args) ? (args.args as unknown[]) : [];
        const outcome = await pluginHost.runCommand(command.extensionId, command.commandId, forward);
        if (!outcome.ok) return `Error: ${outcome.error ?? "extension command failed"}`;
        return outcome.result ?? "ok";
      }
      return undefined;
    },

    effectOf(toolName) {
      return registry.effectOf(toolName);
    },

    /** Enumerate MCP servers once — bridged definitions must exist before a run registers them. */
    async init() {
      if (mcpInitialized) return;
      mcpInitialized = true;
      await registry.connectAll();
      for (const def of registry.toolDefinitions()) coreDefinitions.push(def);
    },

    async close() {
      await registry.closeAll();
      await browserRuntime?.shutdown();
      await computerRuntime?.shutdown();
    },

    describe() {
      return {
        browser: { enabled: browserEnabled },
        computerUse: { enabled: computerEnabled },
        mcpServers: registry.listServerStates().map((s) => ({
          name: s.name,
          status: s.status,
          tools: s.toolCount ?? 0,
        })),
        plugins: { bridgedCommands: pluginCommands().size },
      };
    },
  };
}
