# R35 — Backend Finalization: Final Report

Branch: `codex/r29-release-closure`
Base (recovered): `1543f1e` (R34 tail)
Head: `5826311`
Source state: `r35-backend-finalization-interim-v1` (`81cef21f`)

## Scope

R35 finalized the backend contract for the CodeForge Free Capacity Fabric:
canonical state vocabulary, completion authority, crash/restart semantics,
tool/permission authority, session isolation, event ordering, endurance,
release readiness, API/UI contract freeze, packaged verification, and
recertification — without weakening the free-first fail-closed posture.

## Commits

| Commit | Content |
|---|---|
| `8a78175` | Canonical turn/task state machine + cancel/status contract fixes |
| `9712617` | Tool-authority invariants, session isolation, resolve hardening, release-status |
| `26c4f69` | Fail-closed bind, isolation+endurance tests, `idx_work_items_kind` |
| `4f471ae` | Bind-hardening regression assertions, honest completion wording, retry/timeout/flag audit |
| `bab34cd` | Security + secret-scrubbing + lifecycle evidence |
| `6ce88c7` | UI contract freeze evidence + benchmark refresh |
| `5826311` | R35 interim source-state recertification (35 material files) |

## Defects found and fixed in R35

1. **Cancel self-loop**: `cancelTurn` mutated `state.status` before emitting —
   every cancel emitted `cancelled → cancelled`. Now captures `previousStatus`
   and emits the real transition; terminal turns return early and are never
   rewritten. (`agent-runtime.ts`, regression test in `agent-recovery.test.ts`)
2. **Phase/status fall-through**: `statusMap[phase] ?? phase` would emit raw
   phase names as `TaskStatus`. Replaced by `taskStatusForPhase`, which throws
   on unmapped phases. (`workflow-service.ts`)
3. **Mixed vocabularies**: `task.state_changed.from` carried raw
   `WorkflowPhase`, `status.changed` carried phases instead of session
   statuses, and `persistPhaseStatus` wrote `TaskStatus` values into the
   `SessionStatus` column via a cast. All three channels now use their own
   vocabulary via total maps. (`workflow-service.ts`, `turn-state-machine.ts`)
4. **Stale `from` on terminal task events**: terminal `task.state_changed`
   hardcoded `from: "implementing"`; now uses the tracked prior task status.
5. **Unawaited resolve handlers**: `resolveApproval`/`resolveQuestion` resolved
   before the HTTP 200 — a rejected promise would be an unhandled rejection and
   a false success. Now awaited.
6. **Routable bind without token**: `CODEFORGE_BIND_HOST=0.0.0.0` previously
   exposed the unauthenticated control plane to the LAN. `start()` now refuses
   a non-loopback bind without `controlPlaneToken`.
   (`index.ts`, `network-exposure.test.ts`, `release-status.test.ts`)
7. **Missing SQLite index**: `getWorkItemsByKind` recovery scans had no
   `work_items(kind)` index in SQLite (Postgres had it). Added
   `idx_work_items_kind`; schemas now symmetric.
8. **Overclaiming completion fallback**: the interactive-turn fallback
   persisted `"Completed the requested work and verification."` — claiming
   verification the runtime did not perform. Now `"Completed the requested
   work."` (`agent-runtime.ts`, boundary test updated)

## Audited-and-hardened areas (no defect found)

- **Completion authority**: `evaluateCompletion` remains the sole path to
  `completed`; evidence snapshot immutable at the boundary; `run.outcome`
  emitted last; ~30 adversarial gate tests already cover missing/failed/stale
  verification, empty diffs, budget exhaustion, approval/question blockers.
- **Recovery**: `requested → started → completed/failed → observation_recorded`
  durable chain; `started`+write → `requires_revalidation`, `started`+command →
  `unknown_side_effect`; interrupted turns replan from durable facts, never
  replay; terminal turns never resurrect; recovery lease prevents duplicate
  recovery.
- **Tool authority**: `BUILT_IN_TOOL_DEFINITIONS` carries permission +
  `readOnly` + `executionClass` for every tool; schema filtering and
  dispatch-time authorization are independent; read-only roles cannot mutate.
- **Permissions**: child = def ∩ parent; depth limits; cancellation
  propagation; read-only actor caps.
- **Subagent orchestration**: synthesis conflicts fail closed
  (`SYNTHESIS_CONFLICT_UNRESOLVED`); scoped steers stay owned across restart.
- **Session isolation**: session-scoped reads verified end-to-end;
  cross-session approval/question resolution rejected.
- **Events**: process-wide sequence, ordered replay, session-scoped SSE with
  `lastSeq` cursor; terminal events awaited, best-effort events
  fire-and-forget; nothing emits after terminal.
- **Retry**: provider `Retry-After` honored via route-health authority;
  8-Bit bounded retry → rotate → surface; exact-pin never substitutes;
  `DuplicateActionSupervisor` suppresses in-run duplicate dispatch.
- **Timeouts**: per-request model deadlines, bounded command execution (tree
  kill, exit 124), 5-min approval defaults, re-armed workflow budget,
  cancellable capacity polling — no unbounded await in the turn loop.
- **Shutdown**: `closeAllConnections` drains SSE/keep-alive, timers cleared or
  `unref`'d, index aborted, stores closed.
- **Secret scrubbing**: `redactSecrets` at every persistence/event/cache/hash/
  display boundary (163 sites); credential round-trip encrypted;
  `credential_plaintext_absent=PASS` in packaged smoke.

## Known limitations (honest)

- `waiting_for_question` is a declared/restorable `TurnStatus` with no live
  creation path. Retained deliberately: persisted records may carry it.
  Documented in `R35-TASK-STATE-MACHINE.md`.
- No global retention/TTL policy for events/work items across sessions —
  session-scoped deletion exists; growth is linear with user activity.
- `CODEFORGE_PAID_EXECUTION_ENABLED` remains an execution switch for the
  PaidAuto surface, but is defense-in-depth only: it additionally requires
  READY state, all four qualifications CERTIFIED, a closed circuit, and the
  free-only server still 409s paid model selection
  (`PAID_AUTO_BLOCKED_BY_FREE_ONLY_POLICY`).
- `shared:github-models` remains `CAPACITY_EXHAUSTED` — an external supply
  fact, honestly reported, not a software defect.

## Verification

- Targeted suites: turn-state-machine (9), agent-recovery (7),
  workflow-capacity-wait (2), registry-authority (5), release-status (4+),
  session-isolation, network-exposure (13), agent-turn-boundary,
  r35-endurance (50 turns) — all green.
- Packaged Windows (`release/win-unpacked`, commit `4f471ae`):
  - `audit:internal-deps` PASS (28 internal packages)
  - `audit:runtime-deps` PASS (357 modules, 18 external)
  - `audit:auth-endpoint` PASS (development channel, loopback endpoint)
  - `audit:browser-security` PASS (sandbox, no nodeIntegration,
    contextIsolation, webSecurity, bearer injection main-only)
  - `audit:build-identity` PASS (`4f471ae`)
  - packaged smoke `full` PASS (startup, ForgeGreen/8-Bit/cloud-db runtimes,
    renderer lifecycle ×5 reloads, zero-prompt workflow, failure repair,
    repository index 258 files, workspace escape blocked, control-plane trust
    boundary, extension host, updater guarded, credentials encrypted,
    `calc.ts` fixed `a + b`)
  - packaged smoke `interrupt` PASS (exit 73, interruption armed)
  - packaged smoke `recover` PASS (failed safely, no approval replay,
    credential round-trips, fresh task)
- Source-state recertification: `fg11` + `fg12e` green; new interim ID
  `81cef21f` over 35 material files (`turn-state-machine.ts` added).
- Canonical regression: recorded below.

## Canonical regression

`npm test` at `5826311` (post-recertification working tree):

- **Test files: 465 passed | 8 skipped (473 total)**
- **Tests: 3730 passed | 0 failed | 48 skipped (3778 total)**
- Duration ~548 s

One unhandled `EPIPE` ("socket ended by the other party") was observed during
the `context-efficiency.test.ts` teardown window under full parallel load —
a transient socket-write race after test completion, not a test failure
(0 failed). The file passes cleanly standalone (2/2, 9.35 s).

R34 baseline was 3707 passed / 0 failed / 48 skipped; R35 adds 23 net green
tests (state machine, cancel semantics, registry invariants, isolation,
endurance, release-status, bind-hardening) with zero regressions.
