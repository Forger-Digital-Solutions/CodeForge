# R35 Mission AL — UI contract freeze

Everything below is a **frozen backend contract**. The UI campaign may build
against these surfaces without expecting backend churn; additions are
additive-only (new endpoints/events/fields), never renames or removals.

## Transport & auth

- Local control plane: loopback HTTP + SSE. Every route except `GET /api/health`
  requires the bearer header `x-codeforge-control-token` when the server was
  started with `controlPlaneToken` (packaged desktop always is). The token is
  never accepted via query string. Non-loopback bind without a token fails
  closed at `start()`.
- `Host` header must name loopback on a loopback bind (DNS-rebinding guard).
- `GET /api/health` → `{ "status": "ok" }` — liveness only, unauthenticated,
  reveals nothing else.

## Session lifecycle

| Route | Method | Contract |
|---|---|---|
| `/api/send` | POST | `{ sessionId?, message, ... }` → creates/gets session+turn, starts execution. Empty/oversized message → 400. |
| `/api/sessions` | GET | `SessionRecord[]` ordered by `updatedAt` desc. |
| `/api/sessions/:id` | GET | Full session: record + turns + workItems + events + pending approvals/questions. 404 unknown. |
| `/api/sessions/:id/events` | GET | Sequenced `WorkspaceEvent[]` for that session only. |
| `/api/sessions/:id/authority` | POST | Sets permission/plan mode for the session's `TaskAuthority`. |
| `/api/sessions/:sid/turns/:tid/pause` | POST | Pause a running turn. |
| `/api/sessions/:sid/turns/:tid/resume` | POST | Resume a paused/waiting turn. |
| `/api/sessions/:sid/turns/:tid/cancel` | POST | Idempotent cancel — terminal turn → 200 no-op; unknown → 400. |
| `/api/sessions/:sid/turns/:tid/steer` | POST | Queue a steering message consumed at the next safe boundary. |
| `/api/sessions/:sid/intent-hold` | POST | Request/release a dispatch hold (draft-clear semantics). |
| `/api/approvals/:id/resolve` | POST | `{ decision: "allow_once"|"allow_session"|"deny" }`. Settles durably before 200; unknown id → 404; omitted decision → deny. |
| `/api/questions/:id/resolve` | POST | `{ answer: string }`. Settles before 200; unknown → 404. |

## Status vocabulary (the ONLY statuses a session/turn can hold)

`SessionStatus`: `idle running paused waiting_for_approval waiting_for_question
waiting_for_free_capacity recovering completed failed cancelled`.

`TurnStatus` adds `waiting_for_worker`, `blocked`. Terminal = `completed` /
`failed` / `cancelled`. A turn that is `waiting_for_free_capacity` or
`waiting_for_worker` is parked, not dead — resume arrives via a capacity broker
decision, never a fake completion.

`task.state_changed` events carry `TaskStatus` on **both** `from` and `to`;
`status.changed` carries `SessionStatus` on both sides. Neither channel will
ever emit a raw `WorkflowPhase` name.

## Events (SSE + persisted)

`GET /api/events?lastSeq=N&sessionId=S` → `text/event-stream`. `id:` = the
global monotonic `seq`; reconnecting with the last seen `seq` replays exactly
the missed events. Session filter confines the stream. The first frame is
`{"type":"connected"}`.

Terminal semantics: `run.outcome` is the single awaited terminal record for a
run — nothing about that run can arrive after it. `turn.completed` /
`turn.failed` / `turn.cancelled` precede it. `workflow.completion_blocked`
carries the gate's blocker codes.

## Workspace & repository

| Route | Method | Contract |
|---|---|---|
| `/api/workspace/set` | POST | `{ path }` — must exist + be a directory; rebinding clears runtimes. |
| `/api/workspace/tree` | GET | Directory tree for the active workspace. |
| `/api/repository-index/status` | GET | `{ state, enabled, root, indexVersion, ... }`. |
| `/api/repository-index/rebuild` | POST | Force re-index. |
| `/api/repository-index/settings` | GET/POST | Index settings. |
| `/api/repository-index/search?q=` | GET | Symbol/text search over the index. |

## Models & free supply

| Route | Method | Contract |
|---|---|---|
| `/api/models` | GET | Eligible models per ForgeZero (free only). |
| `/api/model-selection` | GET/POST | Get/set the session's model or route lock. Paid targets → `PAID_AUTO_BLOCKED_BY_FREE_ONLY_POLICY` 409. |
| `/api/providers/:id/health` | GET | Provider health snapshot. |
| `/api/free-cloud/registry` | GET | Canonical free-route registry view. |
| `/api/free-cloud/candidates` | GET | Routes pending/ready for ForgeAuto. |
| `/api/free-cloud/capacity` | GET | Pools + routes + reservation ledger + per-dispatch token telemetry. |
| `/api/free-cloud/qualify` | POST | Trigger a bounded qualification cycle. |
| `/api/free-cloud/pools/quarantine` | POST | `{ poolId, release? }` — instant pool quarantine/release. |
| `/api/free-cloud/release-status` | GET | `{ ready, supplyReady, supply{...}, blockers[{code,class,message,action}] }` — the launch-bar surface. |
| `/api/free/top` | GET | Top free candidates for pickers. |

## Workflows / orchestration

| Route | Method | Contract |
|---|---|---|
| `/api/workflow` / `/api/workflow/run` | POST | Start autonomous workflow (one per session; global cap). |
| `/api/workflow/list` | GET | Workflow runs. |
| `/api/missions` | GET | Mission runs (`?sessionId=`). |
| `/api/parallel-runs` | GET | Parallel workstream runs (`?sessionId=`). |
| `/api/orchestrator/list` / `/api/orchestrator/run` | GET/POST | Orchestrator runs. |
| `/api/deliveries` | GET | Delivery records (`?sessionId=`). |
| `/api/activity/overview` | GET | Aggregated activity snapshot (15 s cached). |

## Invariants the UI may rely on

1. **Terminal means terminal** — a `completed`/`failed`/`cancelled` record is
   never rewritten (cancel is idempotent; recovery never resurrects terminal).
2. **No fake completion** — `completed` implies `evaluateCompletion` passed for
   claimed work; verification-not-run lands in `blocked`, never `complete`.
3. **`waiting_*` is resumable** — a parked task carries structured reasons
   (`free_capacity_wait` work item with `reasonCodes`/`nextAvailableAt`) and is
   resumed by the broker without user intervention when supply returns.
4. **Events are replay-safe** — `seq` is global, monotonic, and hydration
   re-sequences deterministically; `afterSeq`/`lastSeq` cursors are correct.
5. **Approvals are durable** — a pending approval survives restart; resolving it
   persists the decision *before* the continuation unblocks.
6. **Paid is refused, not hidden** — there is no code path that silently routes
   to paid inference; selection refuses it, ForgeZero denies it, and the UI
   should surface blockers rather than offer paywalled escape.
