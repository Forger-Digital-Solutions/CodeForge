# CodeForge Architecture Decisions

**Date:** 2026-08-23
**Status:** Phase 0 — Design

These decisions synthesize architectural patterns from OpenCode and Kilo (both MIT licensed,
code NOT copied — inspiration only) with CodeForge's own identity, constraints, and product goals.

---

## 1. Identity & Constraints

CodeForge is **not** a fork of OpenCode or Kilo. It is a new platform with its own architecture.

**Non-negotiable product rules:**
- Free cloud/remote models only — zero inference cost to the user
- No local LLM inference (no Ollama, llama.cpp, local HF, GPU/CPU inference)
- Zero-billing firewall (`ForgeZero`) is central, not an afterthought
- Provider failover bounded; when no free model is available, stop safely and report

**Environment constraints (this session):**
- Node v24.18.0, npm v12.0.2, PowerShell 7.6.5, git 2.55.0
- Bun NOT available → use npm workspaces (documented; Bun migration path preserved)
- ripgrep NOT available → Node-based search with documented ripgrep adapter point
- Rust/cargo NOT available → Rust components deferred behind narrow interface

---

## 2. Monorepo Strategy

**Decision:** npm workspaces (Bun unavailable). Turborepo-style orchestration via npm scripts
and a future `scripts/forge-build.mjs` if needed. Keep it simple; avoid heavy orchestration.

**Rationale:** Bun workspaces would be ideal but aren't available. npm workspaces are zero-extra-dependency,
well-understood, and sufficient. The workspace layout mirrors the logical package boundaries from OpenCode/Kilo
but uses CodeForge naming and structure.

**Structure:**
```
codeforge/
├── apps/              # runnable products
│   ├── desktop/       # Electron (Windows-first)
│   └── docs/          # documentation site
├── packages/
│   ├── core/          # shared types, errors, result types, ids
│   ├── forge-zero/    # zero-billing firewall (THE critical policy engine)
│   ├── model-registry/# free model discovery + records
│   ├── providers/     # provider adapters + credential storage
│   ├── router/        # ForgeRouter — capability-aware routing
│   ├── agent/         # agent definitions, prompts, roles
│   ├── director/      # ForgeDirector orchestrator
│   ├── tools/         # tool registry + built-in tools
│   ├── sessions/      # session/task persistence (SQLite)
│   ├── context/       # context selection/assembly
│   ├── git/           # git operations + checkpoints
│   ├── worktrees/     # isolated task worktrees
│   ├── permissions/   # permission policy engine
│   ├── sandbox/       # execution isolation, command classification
│   ├── secrets/       # secret scanning/redaction
│   ├── server/        # HTTP/SSE server (forge serve)
│   ├── protocol/      # API types, event shapes
│   ├── sdk/           # client SDK
│   ├── cli/           # CLI (forge)
│   ├── lsp/           # LSP client integration
│   ├── mcp/           # MCP client/server
│   ├── telemetry/     # local observability
│   ├── gems/          # GEMS Forge governed lane
│   ├── benchmark/     # benchmark profiles + task scoring
│   ├── plugins/       # plugin API
│   ├── ui/            # shared UI components
│   ├── shared/        # cross-cutting utilities
│   └── vscode/        # VS Code extension
├── plugins/           # first-party plugins
├── tests/             # integration/e2e/security/provider-contract
├── docs/
├── scripts/
└── .github/workflows/
```

---

## 3. Runtime Model

**Decision:** Client/server architecture. `forge serve` is the single source of truth for all
agent/runtime logic. CLI, Desktop, and VS Code are thin clients talking HTTP + SSE.

**Rationale:** Same pattern as OpenCode/Kilo. Avoids duplicating orchestration in every client.
One runtime to rule routing, permissions, tools, sessions.

**Server:** Node.js HTTP (built-in `node:http`) with SSE for streaming. No heavy framework — keep
dependencies minimal. OpenAPI types generated from Zod schemas (`packages/protocol`).

**Why not Hono/Express/Fastify initially:** Minimize dependency surface. Node's `node:http` is
sufficient for REST + SSE; wrap with a small typed router. Framework can be introduced later
if routing complexity demands it. This keeps the runtime lean and auditable.

---

## 4. Language & Tooling

**Decision:** TypeScript everywhere. React for UI (web/desktop). Electron for Windows desktop.

**Rationale:** Specified in product rules. Approachability for contributors.

**Rust:** Deferred. No cargo available. Sandbox/process isolation will use Node + Windows Job
Objects via a documented native interface. Rust can replace this behind the interface later.

**Package manager:** npm (Bun unavailable). Workspace protocol for local packages.

**TypeScript config:** strict mode, ESM (`"module": "NodeNext"`), `verbatimModuleSyntax`, composite
project references for build performance.

**Testing:** Vitest (fast, ESM-native, works without Bun). Test runner via `vitest run`.

**Linting/formatting:** To be determined — prefer `oxlint` + `oxc` if installable, else native TS.
Keep minimal for now; can add later.

---

## 5. Persistence

**Decision:** SQLite via `better-sqlite3` (synchronous, fast, no async overhead, well-supported on Windows).

**Rationale:** OpenCode uses `bun:sqlite`; Kilo uses Drizzle + SQLite. `better-sqlite3` is the mature
Node equivalent — synchronous API, WAL mode, excellent performance. Drizzle ORM optional on top;
start with a thin query layer, introduce Drizzle if migrations/schema complexity grows.

**Location:** `%LOCALAPPDATA%\CodeForge\codeforge.db` (Windows) — cross-platform via `packages/core/paths`.

**Schema:** migrations in `packages/sessions/src/migrations/`, versioned, applied on startup.

---

## 6. Provider Abstraction

**Decision:** CodeForge defines its own narrow `ProviderAdapter` interface. Do NOT depend on Vercel AI SDK
as the core abstraction — CodeForge's routing, ForgeZero enforcement, and free-model discovery require
control that a generic SDK doesn't provide. Provider adapters translate to whatever transport each provider needs.

**Rationale:** CodeForge's routing and zero-cost enforcement are first-class, not afterthoughts. A custom
adapter interface lets ForgeZero sit directly in the path. The adapter interface supports streaming,
tool calling, cost metadata, capability reporting, and cancellation — everything CodeForge needs —
without coupling to a specific SDK's model.

**ForgeZero integration:** Every adapter MUST report cost metadata. ForgeZero verifies before any model
is eligible. Adapters never silently select paid fallbacks.

**Secret storage:** Windows DPAPI via `node-dpapi` or a thin native wrapper; fallback to OS keychain.
Keys never stored unencrypted in project files.

---

## 7. ForgeZero (Zero-Billing Firewall)

**Decision:** Central policy engine at `packages/forge-zero`. Every model record carries a `ModelCostProfile`.
Routing and tool-use gate through ForgeZero. Fail-closed: if free status cannot be verified, the model
is ineligible.

**Verification pipeline:** VERIFY COST → VERIFY FREE STATUS → VERIFY PAID FALLBACK DISABLED →
VERIFY PROVIDER ACCOUNT CONFIG → ALLOW. Any step fails → reject.

**This is the most-tested component.** Paid denial, unknown-cost denial, local-model denial,
paid-fallback denial are mandatory passing tests.

---

## 8. ForgeRouter

**Decision:** Capability-aware, evidence-based routing at `packages/router`. Input: task type,
context size, required capabilities, preferred traits. Output: scored `RoutingDecision` with
explainable reasons and alternatives.

**Scoring:** Bayesian/weighted on operational telemetry (no LLM training). Rolling capability
scores per model: coding, toolCalling, reasoning, vision, longContext, speed.

**Failover:** Bounded (default 3 model fallbacks). On 429/quota/timeout → next eligible model.
Exhaustion → safe stop.

**"Why this model?":** Every decision is explainable and surfaced in the UI.

---

## 9. Agent Roles

**Decision:** Built-in roles as prompt + capability profiles, not separate codebases. One reusable
agent core (`packages/agent`) with role-specific system prompts and tool policies.

Roles: ForgeDirector (orchestrator), Scout, Architect, Builder, Debugger, Tester, Reviewer,
Researcher, UI Forge, GEMS Forge.

**Independence:** Reviewer should be routed to a *different* model than Builder where quota allows.

---

## 10. Tool System

**Decision:** `Tool` = `{ id, description, parameters (Zod), execute(ctx) }`. Lazy initialization.
Observable: every tool call emits structured events. Model-aware filtering (e.g., some models get
`apply_patch`, others `edit`+`write`).

Initial tools: readFile, writeFile, patchFile, searchFiles, glob, grep, listDirectory, shellCommand,
processControl, git*, diagnostics, lsp*, tests, httpResearch, mcpTools.

**Permissions:** allow/ask/deny per tool, scoped by workspace policy.

---

## 11. Security Model

**Decision:** Two distinct systems: Permission Policy + Execution Isolation.

- **Permissions:** rule-based (allow/ask/deny) per tool/command, with user modes (Auto/Guided/Manual).
- **Execution isolation:** workspace boundary (repo + allowed temp paths), command-risk classification
  (not just string matching), secret scanning/redaction before any context reaches a model.
- **Cancellation:** cooperative abort signals cascading to child processes; kill descendants on timeout.
- **Anti-loop:** bounded budgets per task (retry, fallback, test-repair, review-fix). Exhaust → stop.

---

## 12. Git & Worktrees

**Decision:** First-class git via `packages/git` (Node `child_process` wrapping git CLI — no native dep).
Checkpoints before major autonomous changes. Worktree isolation (`packages/worktrees`) for parallel agents.
Ownership graph to prevent conflicting parallel edits. Never destroy uncommitted user work.

---

## 13. Context Engine

**Decision:** Task-specific context assembly, not whole-repo ingestion. Inputs: task, changed files,
imports, LSP relationships, search results, symbol refs, git history, test failures, agent notes.
Maintain task/repo/agent/session context scopes. Designed for million-line repos (ripgrep + LSP +
incremental indexing; ripgrep adapter ready, Node fallback now).

---

## 14. Sessions

**Decision:** Persistent, restart-surviving. SQLite stores user request, plan, decomposition, agent
assignments, model choices, tool calls, edits, git checkpoints, test results, reviewer decisions, result.
Status: idle/busy/retry. SSE streams for live updates.

---

## 15. Event Model

**Decision:** Typed, structured events (`packages/protocol`). Clients subscribe, never scrape logs.
Categories: task, agent, router, provider, tool, file, git, test, review, permission, quota.

---

## 16. GEMS Lane

**Decision:** Architectural lane from day one (`packages/gems`). Stricter than normal CodeForge.
Opt-in only. Protected data never sent to external providers. Fail-closed policy hooks.
No deep GEMS integration until a GEMS repo is explicitly opened.

---

## 17. Plugin System

**Decision:** `CodeForgePlugin { id, activate(ctx) }`. Plugins register tools, classifiers, providers,
hooks, validators, UI contributions. Plugins CANNOT bypass ForgeZero (except dev mode with warning).

---

## 18. MCP & LSP

**Decision:** MCP client support (`packages/mcp`); MCP tools subject to permissions + sandbox.
LSP client (`packages/lsp`) for symbol search, definitions, references, diagnostics, types.
Both are integration layers, not replacements for CodeForge's own context/routing.

---

## 19. Phased Build Order

Prioritized for runtime correctness over UI completeness:

1. Monorepo foundation (build/test/CI)
2. Session + event core
3. Tool runtime
4. ForgeZero + providers
5. ForgeRouter
6. Single-agent loop
7. ForgeDirector
8. Worktrees + multi-agent
9. Desktop MVP
10. VS Code MVP
11. GEMS policy

**UI completeness never beats runtime correctness.**

---

## 20. What CodeForge Does NOT Do (v0.1)

- No local LLM inference (architecturally impossible to route there — enforced)
- No paid model fallback (ForgeZero refuses)
- No brand cloning of OpenCode/Kilo (own name, layout, vocabulary, design system)
- No fake integrations (mock adapters clearly labeled; live verification requires credentials)
- No Effect.ts (too heavy; keep runtime lean and approachable)
- No Rust yet (deferred behind interface; no cargo available)
