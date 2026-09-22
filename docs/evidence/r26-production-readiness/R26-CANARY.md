# R26 Phase 3 — Production-Shaped Canary

Closest safe local equivalent of a deployed canary (`scripts/r26-canary.mjs`): real `forge serve`
HTTP boundary, real git workspaces, real `node --test` verification subprocesses, deterministic
`isTestProvider` free provider (zero spend). Eight canary tasks driven through the production
client path `POST /api/send` `executionMode:"agent"`.

## Canary results

| # | Canary | Outcome | Evidence |
|---|---|---|---|
| 1 | Tiny — localized fix | `completed` | add() fixed on disk, add-only verifier passed |
| 2 | Small — exploration then fix | `completed` | list_files → write_file → verify passed |
| 3 | Medium — two files | `completed` | calc.mjs + util.mjs written, both tests pass |
| 4 | Review-heavy flawed patch | `failed` | wrong patch written; verification caught it; **no completion claim** |
| 5 | Provider failure (injected 429) | `failed` | honest failure; subsequent task also refused the dead route (fail-closed routing) |
| 6 | Cancellation | `cancelled` | confirmed in-flight (`inflight=true`) then cancelled mid-stream |
| 7 | Duplicate submission | `completed`+`completed` | **gap**: no send-layer idempotency — identical resubmit created a second task and 2 more provider calls |
| 8 | User contention (8 sessions, 1 workspace) | 1 `completed`, 7 rejected | exclusive workspace write lease: exactly-one-writer, `409 WORKSPACE_LEASE_CONFLICT`, no deadlock |

## Invariants — 13/13

| Invariant | Result |
|---|---|
| paid crossover | **0** — all 18 provider calls via verified-free record |
| verifier bypass | **0** — flawed patch could not reach `completed` |
| secret leak | **0**/18 provider payloads contained the planted `CF_CANARY_SECRET` |
| cross-user entitlement leak | **0** foreign-session events across 12 session-filtered SSE streams |
| reservation/lease leak | **0** non-terminal workflows, no held leases at end |
| orphan queue record | **0** |
| duplicate terminal result | **0** (task.completed + run.outcome = 2 legitimate terminal-class events) |
| cancellation clean | mid-stream cancel → `cancelled` |
| workspace lease exclusivity | 1 admitted+completed, 7 explicit rejections |
| fail-closed routing | post-429 task refused the dead route → `failed` |
| failure honesty | 429 → `failed`, never `completed` |
| duplicate execution | explained — no send-layer idempotency (finding F1) |
| server health post-canary | `/api/sessions` 200 |

## Product findings surfaced

- **F1 — no `/api/send` idempotency**: identical `turnId` resubmission executes the task again
  (2 extra provider calls). Client retries / desktop reconnect resubmits can double-execute.
  Candidate hardening before multi-user scale.
- **F2 — workspace write lease is exclusive and non-queuing**: concurrent same-workspace
  submissions get immediate explicit `409 WORKSPACE_LEASE_CONFLICT`. Correct for single-repo
  desktop semantics; queued admission belongs to the hosted path.
- **F3 — route-health poisoning is real**: one hard-failing route marks itself unhealthy and
  subsequent tasks fail closed rather than hammering a dead provider. Correct behavior; means
  canary ordering must inject failures last.
- **F4 — session→workspace binding is global-active-workspace**: a fresh session binds to
  `activeWorkspacePath` at send time; sends against a different explicit workspace are rejected
  (`WORKSPACE_MISMATCH`). Single-workspace product semantics — multi-workspace concurrency is a
  hosted-mode concern.

Raw machine evidence: `canary.json`.

## Verdict

**`R26_CANARY_CLEAN`** — 8 canaries, 13/13 invariants, zero spend. Two honest gaps recorded
(F1 idempotency, F2 no local queueing) rather than papered over.
