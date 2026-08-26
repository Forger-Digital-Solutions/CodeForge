# OpenCode Architecture Research

**Source:** `anomalyco/opencode` (active; `opencode-ai/opencode` is archived)
**License:** MIT — Copyright (c) 2025 opencode
**Stars:** ~201k

## Repository Structure
- Bun workspace monorepo orchestrated with Turborepo
- Core packages: `opencode` (CLI/TUI/server/runtime), `app` (SolidJS web UI), `desktop`, `core`, `sdk/js`, `plugin`, `ui`, `llm`
- VS Code extension in `sdks/vscode/`
- Core internal modules: `agent/`, `cli/`, `config/`, `provider/`, `session/`, `tool/`, `mcp/`, `lsp/`, `plugin/`, `permission/`, `project/`, `server/`, `worktree/`, `snapshot/`, `storage/`, `bus/`, `pty/`, `git/`, `shell/`

## CLI
- Built with yargs. Entry: `packages/opencode/src/index.ts`
- Commands: `run`, `serve`, `web`, `acp`, `providers`, `models`, `mcp`, `session`, `agent`, `plugin`, `pr`, `stats`, `db`, `debug`
- TUI and server run in different threads, communicate via RPC through `GlobalBus`

## Server/Runtime
- Effect Platform `HttpRouter`/`HttpApiServer`, runtime: Bun
- REST + OpenAPI 3.1.0 + SSE (10s heartbeat) + WebSocket (PTY)
- Each project directory gets its own server instance
- mDNS service discovery, OpenTelemetry tracing

## Provider Abstraction
- Vercel AI SDK v5 `LanguageModelV2` interface
- 75+ providers via models.dev + Vercel AI SDK
- Bundled SDKs load without install; others installed on demand via bun
- Provider loading: models.dev → config → env → stored keys → plugin auth → custom loaders → overrides
- Model data from models.dev with 3-tier fallback (local → snapshot → remote)

## Session System
- SQLite via Drizzle ORM (`bun:sqlite`), WAL mode, 64MB cache
- Tables: Session, Message, Part, Todo, Permission, Event
- Compaction agent, forkable sessions, shareable
- v2 event-sourced format in development

## Tool System
- `Tool.Info<Params, Metadata>` with Zod parameters, lazy `init()`
- 22+ tools: read/write/edit/apply_patch, grep/glob/codesearch, bash/batch, webfetch/websearch, task/question/skill, todowrite, lsp, plan_exit
- Edit tool: 9-layer fallback matching
- Bash tool: tree-sitter permission analysis
- MCP tools converted to same format as built-in

## VS Code Integration
- Extension `sst-dev.opencode`, auto-install detection via TERM_PROGRAM/GIT_ASKPASS
- ACP (Agent Client Protocol) JSON-RPC over stdio for Zed/JetBrains/Neovim

## Desktop
- Electron (`electron-vite` + `electron-builder`), wraps web UI (SolidJS)
- Platforms: macOS (arm/x64), Windows x64, Linux

## Worktrees/Subagents
- Experimental worktree API: POST/GET/DELETE `/experimental/worktree`
- Subagents: build, plan, general, explore, scout, title, summary, compaction
- Worktrees in `~/.local/share/opencode/worktree/<project-id>/<branch>/`

## Key Patterns to Adapt
1. Client/server model — even TUI connects via HTTP
2. SQLite persistence with WAL
3. Typed event bus for decoupled communication
4. Zod schema-first config/API
5. Layered fallbacks for uncertainty
6. Directory-scoped server instances
