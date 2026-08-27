# CodeForge Architecture

## System Overview

CodeForge is a free-first autonomous software engineering agent platform. It routes engineering tasks across legitimate zero-cost cloud LLM providers using evidence-based routing, with a zero-billing firewall (ForgeZero) that prohibits paid inference and local LLM use.

### Design Principles

1. **Free-only intelligence** — Never routes to paid models, never runs local LLMs
2. **Fail-closed security** — If free status cannot be verified, do not route
3. **Event-sourced state** — All UI updates flow through WorkspaceEvent via SSE
4. **Tier isolation** — Premium model families never fall back to other families
5. **Windows-first** — Desktop app, CLI, and VS Code from one core runtime

---

## Package Map (30 packages)

```
packages/
├── core/           # Foundation primitives (Result, Branded types)
├── protocol/       # Event schemas, API types (Zod-validated)
├── forge-zero/     # Safety layer / model firewall
├── model-registry/ # Free model discovery and refresh
├── providers/      # Provider adapters (OpenRouter, mock)
├── router/         # Model routing with ForgeZero enforcement
├── director/       # Task execution orchestrator
├── sessions/        # Event store + SQLite persistence
├── server/         # HTTP REST API + SSE
├── cli/            # Command-line entry point
├── sdk/            # Client SDK
├── ui/             # React components (workbench)
├── vscode/         # VS Code extension
├── agent/          # Agent definitions
├── tools/          # Tool registry
├── mcp/            # Model Context Protocol client
├── permissions/    # Permission engine
├── context/        # Context assembly
├── git/            # Git operations
├── lsp/            # LSP client
├── sandbox/        # Process execution guard
├── secrets/        # Secret scanning
├── telemetry/     # Usage telemetry
├── gems/          # GEMS premium tier guard
├── plugins/       # Plugin system
├── identity/      # Authentication
├── shared/        # Utilities
├── benchmark/     # Benchmarking
└── integration-tests/  # E2E tests
```

### Dependency Layers

```
Layer 0 (foundation):
    @codeforge/core

Layer 1 (protocols):
    @codeforge/protocol

Layer 2 (infrastructure):
    @codeforge/forge-zero    # Safety
    @codeforge/sessions      # Persistence

Layer 3 (providers):
    @codeforge/providers
    @codeforge/model-registry

Layer 4 (routing):
    @codeforge/router
    @codeforge/director

Layer 5 (server):
    @codeforge/server

Layer 6 (clients):
    @codeforge/cli
    @codeforge/ui
    @codeforge/vscode
    @codeforge/sdk
```

---

## Core Components

### ForgeZero (packages/forge-zero/)

The zero-billing firewall. All model eligibility passes through this subsystem.

**Key methods:**
- `verify(providerId, modelId)` — Returns `{ok, error}` for model eligibility
- `eligibleModels()` — Returns only verified-free models
- `checkEntitlement(userId, providerId, modelId)` — Premium tier access check

**Fail-closed guarantees:**
- Paid models rejected unless explicitly entitled
- Unknown-cost models rejected (null cost = deny)
- Local models rejected (Ollama, localhost)
- Unverified providers rejected

### AgentRuntime (packages/server/src/agent-runtime.ts)

Turn execution engine. Manages turn lifecycle:

```typescript
interface TurnState {
  turnId: string;
  sessionId: string;
  status: "idle" | "running" | "paused" | "waiting_for_approval" | 
          "waiting_for_question" | "completed" | "failed" | "cancelled";
  userMessage: string;
  startedAt: Date;
  error?: string;
}
```

**Demo mode isolation:**
- When `demoMode: true`, skips `executeTurn()` entirely
- No provider calls, no real inference
- Turn state tracked for pause/resume/cancel operations
- Production turn path: `startTurn() → executeTurn() → provider.streamChat()`

### CodeForgeServer (packages/server/)

HTTP server exposing REST API and SSE endpoint.

**Key endpoints:**
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/send` | POST | Start a turn |
| `/api/sessions` | GET | List sessions |
| `/api/sessions/:id` | GET | Get session state |
| `/api/sessions/:id/turns/:turnId/pause` | POST | Pause turn |
| `/api/sessions/:id/turns/:turnId/resume` | POST | Resume paused turn |
| `/api/sessions/:id/turns/:turnId/cancel` | POST | Cancel turn |
| `/api/models` | GET | List eligible models |
| `/api/workspace/set` | POST | Set workspace path |
| `/api/workspace/tree` | GET | Get file tree |
| `/api/events` | GET | SSE stream |

---

## Execution Paths

### Demo Mode vs Real Runtime

```
┌─────────────────┐     ┌──────────────────┐
│   handleSend    │     │  AgentRuntime    │
├─────────────────┤     ├──────────────────┤
│ demoMode: false │────▶│ startTurn()      │
│                 │     │   executeTurn()  │
│                 │     │   provider.chat()│
│                 │     │   complete/fail  │
├─────────────────┤     └──────────────────┘
│ demoMode: true  │────▶│ startTurn()      │
│                 │     │   (skip execute) │
│                 │     │   runDemoRuntime()│
└─────────────────┘     └──────────────────┘
```

**Demo mode (useRealRuntime=false):**
- `AgentRuntime` created with `demoMode: true`
- `startTurn()` records state but skips execution
- `runDemoRuntime()` emits simulated events for UI testing
- Pause/resume/cancel operate on state map without cancellation tokens

**Real runtime (useRealRuntime=true, CODEFORGE_REAL_RUNTIME=true):**
- Requires provider API keys (e.g., OPENROUTER_API_KEY)
- `executeTurn()` resolves model via ForgeZero
- Streams chat via provider adapter
- Tools execute with workspace boundary enforcement

---

## Turn Lifecycle

### State Machine

```
                    ┌─────────┐
                    │  idle   │
                    └────┬────┘
                         │ startTurn()
                    ┌────▼────┐
          ┌────────│ running │────────┐
          │        └────┬────┘        │
          │             │               │
     pause()       complete()      cancel()
          │             │               │
    ┌─────▼─────┐  ┌────▼────┐   ┌──────▼──────┐
    │  paused   │  │completed│   │  cancelled  │
    └─────┬─────┘  └─────────┘   └─────────────┘
          │
     resume()
          │
    ┌─────▼─────┐
    │  running  │
    └───────────┘

[Error path: running ──▶ failed]
```

### Constraints

- **Pause**: Only valid from `running` state
- **Resume**: Only valid from `paused` state  
- **Cancel**: Valid from `running` or `paused`
- **Steer**: Only valid from `running` (appends to message)

---

## Persistence (packages/sessions/)

### SQLite Storage

Two driver modes:
1. `node:sqlite` (Node >= 22.5, built-in)
2. `better-sqlite3` (fallback, requires compilation)

**Database path resolution:**
```typescript
const dbPath = process.env.CODEFORGE_DB_PATH 
            || path.join(app.getPath('userData'), 'codeforge.db');
```

### Schema

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  status TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id),
  user_message TEXT,
  status TEXT,
  started_at TEXT,
  completed_at TEXT,
  error TEXT
);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY,
  session_id TEXT,
  type TEXT,
  timestamp TEXT,
  payload TEXT
);
```

---

## Client Applications

### CLI (packages/cli/)

```bash
forge version              # Show version
forge serve [--port=3210]  # Start server
```

**Environment:**
- `CODEFORGE_REAL_RUNTIME=true` — Enable real provider execution
- `CODEFORGE_DB_PATH=/path/to/db` — Override database location

### VS Code Extension (packages/vscode/)

**Commands:**
- `codeforge.startSession` — Start new session
- `codeforge.sendMessage` — Send message to current session
- `codeforge.openWebview` — Open CodeForge panel
- `codeforge.stopServer` — Stop background server

**Configuration:**
- `codeforge.serverUrl` — Server URL (default: http://localhost:3210)

### Desktop App (apps/desktop/)

Electron application bundling the server with native UI.

**Packaged mode validations:**
- API key required for real runtime
- dbPath resolves to `app.getPath('userData')`
- Single-instance lock prevents multiple processes

---

## Security Model

### Workspace Boundary

All file operations confined to workspace root:

```typescript
// Symlink/junction-aware containment
function resolveWithinWorkspace(workspace: string, requested: string): {
  valid: boolean;
  resolvedPath?: string;
  error?: string;
}
```

Rejects:
- Path traversal (`../`, absolute paths outside workspace)
- Symlink escapes
- Junction escapes (Windows)

### Execution Guard

Command risk classification:
- `safe` — No prompting needed
- `moderate` — Prompt once per session
- `high` — Prompt every execution
- `critical` — Always prompt, no session caching

### Secret Scanning

Before any content reaches a model:
```typescript
const { redacted, secrets } = scanSecrets(content);
```

---

## Testing

### Unit Tests
```bash
npm test  # Vitest, 290 tests
```

### Integration Tests
- `packages/integration-tests/test/pause-resume-cancel.test.ts` — Control flow
- `packages/integration-tests/test/demo-mode.test.ts` — Demo isolation

### Gap Analysis

**Not yet tested:**
- VS Code extension E2E (requires `@vscode/test-electron` CI setup)
- Packaged persistence CI (Electron rebuild verification)
- Real provider integration (requires API keys in CI)

---

## Open Items

1. **VS Code extension tests** — `@vscode/test-electron` installed but not wired to CI
2. **Packaged persistence** — SQLite driver resolution in Electron needs verification
3. **FileExplorer wiring** — UI component exists but backend integration incomplete
4. **Plugin API** — Registry defined, no runtime loading yet
