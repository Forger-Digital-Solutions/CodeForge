# R26 Phase 2 — Real `forge serve` HTTP Transport E2E

Closes the gap R25 deliberately left open: the production serving transport proven end-to-end
over a real socket, through the same `createServer` object the `forge serve` CLI boots —
no direct `createAgentRuntime()` substitution.

## Method

`scripts/r26-server-e2e.mjs`:

1. Creates a real temp git workspace with a genuine bug (`add()` returns `a - b`) and a real
   `node --test` verifier.
2. Boots `createServer({ port: 0, dbPath: ":memory:", useRealRuntime: true,
   controlPlaneToken: <random UUID> })` — identical wiring to `forge serve` (`packages/cli/src/index.ts`
   passes `{ port, dbPath, controlPlaneToken }`; only dbPath and token source differ).
3. Injects a deterministic `isTestProvider` scripted provider through `InMemoryProviderCatalog`
   + `ForgeZero` free record — zero spend, zero network, deterministic.
4. Drives the **actual production client path**: `POST /api/send` with `executionMode: "agent"`
   (the same route the desktop composer submits through) → `workflowService.startWorkflow`.
5. Collects SSE from `GET /api/events` and asserts event ordering on the real wire.

## Results — 13/13 checks

| Check | Evidence |
|---|---|
| `auth.required` | No token → 401, wrong token → 401, correct `X-CodeForge-Control-Token` → 200 |
| `workspace.bind` | `POST /api/workspace/set` → 200 |
| `workflow.accepted` | `POST /api/send` agent-mode → 200, `taskId` returned |
| `workflow.terminal` | `GET /api/workflow/list` → phase `completed` |
| `workflow.completed` | Terminal `completed`, 2 provider calls |
| `filesystem.real_change` | `src/calc.mjs` on disk contains `return a + b` — real tool write |
| `sse.tool_activity` | Observed: `execution.requested`, `task.created/started`, `turn.started`, `task.state_changed`, `agent.started`, `router.selection`, `tool.call_started/completed`, `permission.decision`, `tool.execution_started`, verification + terminal events |
| `sse.verification_before_terminal` | Verification evidence at event index 43 strictly precedes terminal at 57 — completion-authority ordering holds on the wire |
| `sse.single_terminal` | 2 terminal-class events (`task.completed` + `run.outcome`), no duplicate finals |
| `sse.reconnect_replay` | Reconnect with `lastSeq=60` replayed 4 missed events — durable event store survives disconnect |
| `workflow.concurrent_rejected` | Second run on same session → **409** |
| `workflow.cancellable` | `POST /api/workflow/{taskId}/cancel` → 200 |
| `server.still_healthy` | `/api/sessions` 200 after full exercise |

Raw machine evidence: `server-e2e.json` (same directory).

## What this proves

- The `forge serve` HTTP boundary — auth, session, workspace, agent dispatch, tool execution,
  verification, terminal response — works as one coherent path, not just as proven subsystems.
- SSE is a real product surface: ordered, sequence-numbered, replayable, session-filtered.
- The completion gate ordering is observable on the wire: verification evidence precedes any
  terminal completion claim.

## Honest limits

- Provider was deterministic (`isTestProvider`), so this proves the *transport and orchestration*,
  not live-model quality — that stays in Phase 4/5.
- No dedicated `/api/health` or `/ready` route exists on `forge serve`; `/api/models` served as
  the readiness probe. Recorded as a candidate release blocker.
- Database was `:memory:` SQLite; durable-Postgres behavior is covered by R25 admission proof and
  Phase 7 chaos work.

## Verdict

**`R26_SERVER_E2E_PROVEN`** — 13/13 checks, single run, zero spend.
