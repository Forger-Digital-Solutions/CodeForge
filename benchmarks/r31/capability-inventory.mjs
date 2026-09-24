// R31 platform addendum §17: machine-readable capability inventory.
// Enumerates the real agent-visible tool surface from the built packages — definitions are
// read from the shipped code, not transcribed — then fuses that with the audited subsystem
// classifications recorded in capability-inventory-notes.md.
// Usage: node benchmarks/r31/capability-inventory.mjs
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(root, "docs", "evidence", "r31-production-release-closure", "19-capability-registry");
mkdirSync(outDir, { recursive: true });

const { BUILT_IN_TOOL_DEFINITIONS } = await import("@codeforge/tools");
const { BROWSER_TOOL_DEFINITIONS, DEFAULT_BROWSER_POLICY } = await import("@codeforge/browser");
const { COMPUTER_TOOL_DEFINITIONS, DEFAULT_COMPUTER_USE_POLICY } = await import("@codeforge/computer-use");

const head = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: root }).toString().trim();

const tool = (d, extra) => ({
  id: d.name,
  kind: "tool",
  requiredPermission: d.requiredPermission ?? null,
  readOnly: d.readOnly,
  executionClass: d.executionClass,
  schemaKeys: Object.keys(d.parameters?.properties ?? {}),
  required: d.parameters?.required ?? [],
  ...extra,
});

const capabilities = [
  // --- Core built-in tools (always registered; permission-gated per role) ---
  ...Object.values(BUILT_IN_TOOL_DEFINITIONS).map((d) =>
    tool(d, {
      category: "built_in_tool",
      source: "packages/tools",
      availability: "always",
      state: "IMPLEMENTED_AND_USED",
    }),
  ),
  // --- Browser (opt-in external surface) ---
  ...BROWSER_TOOL_DEFINITIONS.map((d) =>
    tool(d, {
      category: "browser",
      source: "packages/browser",
      availability: "opt_in_external_tools",
      enablePath: "~/.codeforge/external-tools.json browser.enabled | CODEFORGE_BROWSER=1",
      state: "IMPLEMENTED_AND_USED",
    }),
  ),
  // --- Computer Use (opt-in, win32 only) ---
  ...COMPUTER_TOOL_DEFINITIONS.map((d) =>
    tool(d, {
      category: "computer_use",
      source: "packages/computer-use",
      availability: "opt_in_external_tools_win32_only",
      enablePath: "external-tools.json computerUse.enabled | CODEFORGE_COMPUTER_USE=1",
      state: "IMPLEMENTED_PARTIAL",
      note: "coordinate-space input injection via PowerShell+user32; bounds-checked, budgeted, hashed PNG evidence; no UIA/window grounding yet",
    }),
  ),
  // --- Subsystems ---
  {
    id: "tool_registry", category: "registry", source: "packages/tools ToolRegistry+ToolBroker",
    availability: "always", state: "IMPLEMENTED_AND_USED",
    note: "single canonical registry; BUILT_IN + namespaced external defs; broker validates JSON args, denies sensitive paths, emits ToolExecutionRecord",
  },
  {
    id: "external_tool_surface", category: "registry", source: "packages/server/src/external-tools.ts",
    availability: "opt_in", state: "IMPLEMENTED_AND_USED",
    note: "composition root; disabled by default; CODEFORGE_EXTERNAL_TOOLS=0 hard-disable; namespace guard rejects un-prefixed external defs",
  },
  {
    id: "mcp_servers", category: "tool_servers", source: "packages/mcp",
    availability: "configured_only", state: "IMPLEMENTED_AND_USED",
    note: "McpRegistry + GovernedMcpClient; stdio+http transports; states configured/connecting/connected/degraded/dead/disabled; mcp__ns namespacing; effect classes deny/network_read/external; readOnlyHint untrusted by default; output wrapped as untrusted data",
  },
  {
    id: "extensions", category: "extensions", source: "packages/plugins ExtensionManager+ExtensionHost",
    availability: "desktop", state: "IMPLEMENTED_AND_USED",
    note: "managed dir + dev-mode loading; node:vm sandbox (no require/process/fs/net); eval/activate/command timeouts; 16KB result bound; enable/disable/uninstall persisted; IPC + settings UI",
  },
  {
    id: "plugin_command_bridge", category: "plugins", source: "external-tools.ts pluginCommands",
    availability: "desktop", state: "IMPLEMENTED_AND_USED",
    note: "plugin__<ext>__<cmd> tools; write-gated Tier2; re-enumerated per run so disable takes effect without restart",
  },
  {
    id: "permissions", category: "permissions", source: "packages/permissions TaskAuthority",
    availability: "always", state: "IMPLEMENTED_AND_USED",
    note: "tier0-4 deterministic classifyAction; lease grants never cover tier3/4; read-only subagent actor caps; receipts for every decision",
  },
  {
    id: "approval_ux", category: "permissions", source: "packages/server approval-service + renderer approval cards",
    availability: "interactive", state: "IMPLEMENTED_AND_USED",
    note: "allow_once/task/workspace scopes mint lease grants; deny/cancel paths exercised in workflow tests",
  },
  {
    id: "subagents", category: "orchestration", source: "packages/server subagent-manager.ts",
    availability: "always", state: "IMPLEMENTED_AND_USED",
    note: "role-scoped runtimes; explorer/planner/reviewer are read-only capped; delegated tool surface follows role contract",
  },
  {
    id: "parallel_workstreams", category: "orchestration", source: "parallel-orchestrator.ts parallel-state.ts",
    availability: "always", state: "IMPLEMENTED_AND_USED",
  },
  {
    id: "mission_supervisor", category: "orchestration", source: "mission-supervisor.ts mission-state.ts",
    availability: "always", state: "IMPLEMENTED_AND_USED",
  },
  {
    id: "forgezero", category: "policy", source: "packages/forge-zero",
    availability: "always", state: "IMPLEMENTED_AND_USED",
    note: "zero-billing firewall; fail-closed model eligibility",
  },
  {
    id: "forgegreen", category: "efficiency", source: "packages/forge-green + duplicate-suppression.ts",
    availability: "always", state: "IMPLEMENTED_AND_USED",
    note: "context optimizer + duplicate tool suppression with state-window invalidation",
  },
  {
    id: "capacity_governor", category: "providers", source: "packages/providers capacity-governor.ts",
    availability: "always", state: "IMPLEMENTED_AND_USED",
    note: "R31 fix: streaming 429 now records cooldown (previously slot released without health update)",
  },
  {
    id: "route_health", category: "providers", source: "packages/eight-bit route-health-authority.ts",
    availability: "always", state: "IMPLEMENTED_AND_USED",
  },
  {
    id: "terminal", category: "tools", source: "packages/terminal",
    availability: "always", state: "IMPLEMENTED_AND_USED",
    note: "pty-loader, sessions, shells incl. wsl; run_command built-in is the governed path",
  },
  {
    id: "repo_intelligence", category: "tools", source: "packages/repo-intelligence + repo_* tools",
    availability: "always", state: "IMPLEMENTED_AND_USED",
  },
  {
    id: "lsp", category: "tools", source: "packages/lsp",
    availability: "always", state: "IMPLEMENTED_PARTIAL",
    note: "package exists; not wired into the agent tool surface (no lsp__ tools)",
  },
  {
    id: "checkpoints", category: "persistence", source: "checkpoint-service.ts + create_checkpoint tool",
    availability: "always", state: "IMPLEMENTED_AND_USED",
  },
  {
    id: "persistence", category: "persistence", source: "packages/sessions sqlite (node:sqlite + better-sqlite3 fallback)",
    availability: "always", state: "IMPLEMENTED_AND_USED",
  },
  {
    id: "github", category: "integration", source: "github-pr-client.ts",
    availability: "always", state: "IMPLEMENTED_AND_USED",
  },
  {
    id: "cloud", category: "integration", source: "cloud-* packages + cloud-api app",
    availability: "configured", state: "IMPLEMENTED_AND_USED",
  },
  {
    id: "sandbox_exec", category: "tools", source: "packages/sandbox",
    availability: "internal", state: "IMPLEMENTED_PARTIAL",
    note: "package exists; command execution is governed by run_command/terminal, not exposed as a separate agent tool",
  },
  {
    id: "vision", category: "model_capability", source: "computer_screenshot + browser_screenshot receipts",
    availability: "opt_in", state: "IMPLEMENTED_PARTIAL",
    note: "screenshots persist as hashed evidence files; receipts cross the tool boundary, image bytes do not feed model vision in this surface",
  },
  {
    id: "marketplace", category: "catalog", source: "(none)",
    availability: "absent", state: "MISSING",
    note: "no remote extension/plugin catalog; extension install is local-folder + dev-mode only; model-registry 'catalog' is the provider model catalog, unrelated",
  },
  {
    id: "capability_health_endpoint", category: "registry", source: "external-tools describe() + settings UI",
    availability: "always", state: "IMPLEMENTED_AND_USED",
    note: "describe() exposes browser/computer/mcp/plugin states to status endpoints",
  },
];

const inventory = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  head, branch,
  surfaces: {
    builtInTools: Object.values(BUILT_IN_TOOL_DEFINITIONS).length,
    browserTools: BROWSER_TOOL_DEFINITIONS.length,
    computerTools: COMPUTER_TOOL_DEFINITIONS.length,
    namespaces: ["(builtin)", "browser_", "mcp__<server>__<tool>", "plugin__<ext>__<cmd>", "computer_"],
    externalSurfaceDefault: "disabled",
    browserPolicyDefaults: DEFAULT_BROWSER_POLICY,
    computerPolicyDefaults: DEFAULT_COMPUTER_USE_POLICY,
  },
  capabilities,
  counts: {
    total: capabilities.length,
    byState: capabilities.reduce((acc, c) => ((acc[c.state] = (acc[c.state] ?? 0) + 1), acc), {}),
  },
};

const outPath = path.join(outDir, "capability-inventory.json");
writeFileSync(outPath, JSON.stringify(inventory, null, 2) + "\n");
console.log(`wrote ${outPath}`);
console.log(`capabilities: ${capabilities.length} | tools enumerated: ${inventory.surfaces.builtInTools}+${inventory.surfaces.browserTools}+${inventory.surfaces.computerTools}`);
console.log(JSON.stringify(inventory.counts.byState));
