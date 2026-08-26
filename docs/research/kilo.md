# Kilo Code Architecture Research

**Source:** `Kilo-Org/kilocode` (main branch)
**License:** MIT — Copyright (c) 2026 Kilo Code, Copyright (c) 2025 opencode
**Stars:** ~27k

## Repository Structure
- Bun workspaces + Turborepo
- `packages/opencode/` — `@kilocode/cli` (fork of OpenCode), kilocode-specific code in `src/kilocode/`
- `packages/kilo-vscode/` — VS Code extension
- `packages/kilo-jetbrains/` — JetBrains plugin
- `packages/kilo-gateway/` — local gateway client
- `packages/kilo-indexing/` — async codebase indexing
- `packages/kilo-ui/` — shared SolidJS components
- `packages/desktop/` — Tauri v2 (Rust + SolidJS)
- `packages/desktop-electron/` — Electron variant
- Related: `Kilo-Org/cloud` — hosted platform (Cloud Agent on Cloudflare Workers)

## CLI
- `kilo` (TUI), `kilo run` (headless, `--auto` for CI), `kilo serve`, `kilo daemon`
- Effect platform + Hono HTTP server + OpenAPI
- OpenTUI for TUI, Bun compile for native binary
- Fork of OpenCode; Kilo code in `kilocode/` dirs marked with `kilocode_change`

## Server/Runtime
- `kilo serve`: HTTP + SSE, port 4096 (daemon scans 4097..4116)
- One server hosts multiple directory-keyed instances (`InstanceStore`)
- Auth: HTTP Basic Auth + PTY ticket tokens
- Core subsystems: agent runtime, tool registry, LSP client, config service, SQLite storage, snapshot service, provider router

## Provider Abstraction
- `BUNDLED_PROVIDERS` map: npm package → Vercel AI SDK factory
- Custom loaders for credential chains, OAuth
- `ModelsDev` aggregate + `ModelCache` (5 min TTL)
- Auth stored in `${Global.Path.data}/auth.json` mode 0600
- `ProviderTransform` normalizes messages per provider
- `kilo-auto/*` tier IDs resolved server-side by gateway

## Agent/Multi-Agent
- Built-in: Code, Plan, Ask, Debug, Review
- `TaskTool` spawns subagents in separate sessions
- Cloud: Gas Town (Town/Rig/Bead/Convoy/Mayor/Polecat/Refinery/Triage)

## Session System
- SQLite (Drizzle), WAL mode, 5s busy timeout
- Session → Message → Parts (text, reasoning, tool calls, files, compaction)
- `SessionPrompt` dispatch loop, `SessionCompaction`, `SessionRevert`/`SessionUnrevert`
- SSE: `/event` per instance, `/global/event` multiplexed

## Tool System
- `Tool.define` factory, `ToolRegistry` scoped to `InstanceState`
- Tools: bash, read, write, edit, apply_patch, task, grep, webfetch, glob, notebook_read
- Kilo adds: repo_clone, repo_overview
- `Permission.Service`: allow/ask/deny

## VS Code Integration
- Thin client: bundles CLI binary, spawns `kilo serve`, HTTP REST + SSE via `@kilocode/sdk`
- `KiloConnectionService`, `KiloProvider`, `AgentManagerProvider`, `KiloClient`
- SolidJS webviews, Agent Manager with worktree isolation

## Desktop
- Tauri v2 primary (Rust backend spawns CLI sidecar, SolidJS frontend)
- Electron variant with main/renderer/preload

## Routing
- Provider router: direct providers → Kilo Gateway → custom endpoints
- `kilo-auto/*` tier IDs resolved server-side
- `InstanceStore` directory-keyed, `workspace` query param

## Key Patterns to Adapt
1. CLI as central backend; editors are thin clients
2. Directory-scoped instances multiplexed over one server
3. Snapshot service for diffs/revert
4. Agent Manager with worktree isolation
5. Generated SDK from OpenAPI
6. Fork-of-upstream model for clean separation
