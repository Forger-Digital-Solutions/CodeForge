# R21 Paid / GEMS / Plugins Checkpoint (M11–M13)

Recorded: 2026-09-20
Branch: `forger-digital-solutions-forgegreen-certified`
Nature: verification audit — no production changes.

## M11 — 16-Bit / Paid (paid-auto)

`packages/paid-auto` is a real 650-line service: PAID_AUTO_MODELS registry, OpenRouter
fallback modeling, `billing_required` classification, evaluation-budget package (721
lines), shadow mode.

Boundary proof points:

- `paidExecutionEnabled` defaults `false`; only `CODEFORGE_PAID_EXECUTION_ENABLED === "true"`
  or an explicit server option enables it (`server/src/index.ts:249`, desktop `main.ts:1194`).
- Paid routes are reachable **only** via explicit `paid-auto` model selection
  (`resolveTurnModel`) — never a fallback target of the free path; `no_eligible_route`
  still fails closed.
- `gems_paid` tier records return only on explicit selection.
- Tests: **20/20 green** (paid-auto 12, evaluation-budget 7, shadow 1).

Label: **VERIFIED — gated paid path, default-off, never auto-routed.**

## M12 — GEMS

`packages/gems` contains only `auto-framework.ts` (81 lines): `planGemsAutoScenario`
returns a `mode: "simulation_only"` plan, excludes `unfinished` lifecycle profiles,
fails closed with `NO_ELIGIBLE_NONPRODUCTION_PROFILE` /
`INSUFFICIENT_CAPABILITY_PROFILE`. There is no provider adapter and no execution path —
the code's own docstring states it cannot make a GEMS executable.

Tests: 2/2 green.

Label: **UNCERTIFIED for execution — verified as simulation-only planner.** GEMS remains
a planning construct, consistent with prior campaign labeling.

## M13 — MCP / Plugins

- `packages/mcp` remains a stub per M7 audit: `McpClient` constructor no-ops,
  `listTools()` returns `[]`. **UNCERTIFIED.**
- `packages/plugins` is real: manifest schema, host, manager, permission grants.
  **25/25 green** including sandbox isolation (a top-level infinite loop killed by the
  evaluation timeout — a real process-boundary proof, not a stub test).

Label: plugins runtime **VERIFIED (scoped to extension loading/isolation)**;
MCP **UNCERTIFIED — stub only**.
