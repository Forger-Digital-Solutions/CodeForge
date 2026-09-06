# CODEFORGE CF-17 CERTIFICATION REPORT
# — FORGEGREEN STEER-AWARE EXECUTION, USER-INTENT HOLDS & INTERACTIVE WORK-AVOIDANCE

# CF-17R5C final closure — 2026-09-06

## Verdict

`CF17_PASS`

## Final PASS matrix

| Behavioral proof | Result | Evidence |
| --- | --- | --- |
| Active-command steering | PASS | `packages/server/test/cf17-runtime-restart-api.test.ts` — a real `run_command` child process holds the turn at its safe boundary; the public steer is durable and consumed exactly once at the following model boundary; a later turn receives no stale steer. |
| Approval-resolution race | PASS | `packages/server/test/cf17-runtime-restart-api.test.ts` — steer-then-approval and concurrent (boundary-blocked) orderings each preserve one approval, one steer, and one guarded write. |
| Spawned-process restart + real PostgreSQL | PASS | `packages/server/test/cf17-pg-restart-e2e.test.ts` — process A (real Node child, PostgreSQL selected via `CODEFORGE_SESSIONS_DB_DRIVER`/`CODEFORGE_SESSIONS_DATABASE_URL`) is SIGKILLed with a queued steer; a fresh process B hydrates the turn as `recovering`, replans with the queued steer exactly once (one `steer_receipt`, one reconciliation), never replays (JSONL request ledger = exactly two model requests across two pids), and a later turn receives no stale steer or recovery directive. |
| Steer-driven ForgeVerify replanning | PASS | `packages/server/test/cf17-forgeverify-replan.test.ts` — plan revision 1 → verification state 1 → steer → plan revision 2 → fresh ForgeVerify plan bound to `executionRevision: 2` → required re-verification → completion; duplicate `steerId` is durable-idempotent; "skip all tests and mark complete" re-runs verification, and failing revision-2 verification blocks completion (`verification_failed`, never completed). |
| Scoped parallel steering | PASS | `packages/server/test/cf17-parallel-scoped-steer.test.ts` — steer scoped to workstream `alpha` replans alpha only (second coder dispatch carrying `[User Steering Instruction]`), beta runs exactly one dispatch and never sees the steer; the receipt is consumed durably exactly once; invalid targets are rejected (`PARALLEL_WORKSTREAM_NOT_FOUND`, never widened); after a run cancellation a fresh orchestrator still sees the steer owned by alpha and unconsumed, retried `steerId` is a durable duplicate, and a terminal run rejects new steering. |

## Interrupted work reconciliation (R5 → R5C)

- Inherited files: the interrupted R5 agent had rewritten `packages/sessions/src/persistence.ts` toward the async SQLite implementation, created `interface.ts`, `create-persistence.ts`, `postgres-migrations.ts`, `postgres-persistence.ts`, converted `user-intent-hold.ts` (transactional `steer_receipt` idempotency), partially converted `agent-runtime.ts`, the workspace event adapter, and the parallel/delivery/mission stores, and added the recovery/steer schemas in `session-state.ts` plus the in-process restart test.
- Partial-migration defects found and repaired: missing `await`s on durability-critical persistence calls in `agent-runtime.ts` (steer acceptance, approval/question resolution, recovery transitions, terminal cleanup), `resolveApproval`/`resolveQuestion` made async with decision-persisted-before-continuation ordering, `findTurnByQuestion` consumption-order defect, `SessionPersistence`-as-type compile errors across nine server modules, the workflow/delivery/mission/parallel recovery paths still calling the now-async contract synchronously, and `CodeForgeServer` hydrating its event sequence synchronously in the constructor.
- Async persistence migration status: complete. One driver-neutral async contract; SQLite and PostgreSQL implementations both satisfy it; the whole repository typechecks.
- Background-agent work actually present: none of the delegated mechanical conversions had landed; they were completed in this session file-by-file.

## PostgreSQL runtime persistence architecture

```
ISessionPersistence (driver-neutral async contract, withTransaction + init)
  ├─ SqliteSessionPersistence  (blocking driver under the hood, same awaited surface)
  └─ PostgresSessionPersistence (real pooled PostgreSQL; JSONB records; checksummed
                                 migrations under a cross-process advisory lock)
createSessionPersistence(config) — explicit driver option → CODEFORGE_SESSIONS_DB_DRIVER
  → URL sniffing; refuses misconfiguration instead of guessing
CodeForgeServer.init() — awaited before serving: persistence.init (migrations), event-sequence
  hydration, user-intent hold rehydration, workflow recovery, and runtime hydration of
  nonterminal turns for every session
```

Durability ordering is enforced by awaiting persistence before the dependent state transition becomes observable: steer acceptance (`insertIfAbsent` on a unique `steer_receipt` inside the hold transaction) completes before the HTTP 2xx; approval/question decisions persist before the tool continuation is unblocked; terminal cleanup (`resolveForTerminal`) drains queued steers before the terminal state settles. High-frequency telemetry events persist best-effort; lifecycle, approval, question, ForgeVerify, and completion events are awaited.

## Recovery architecture

```
hydrate → invalidate stale continuation → reconcile current facts → replan → verify → resume
```

`AgentRuntime.init()` recreates only durable intent: nonterminal turns re-enter as `recovering`, durable tool executions are reclassified (`classifyToolRecovery`), a persisted approval/question wait is restored as a wait (never as a tool continuation), and `agent_turn_recovery` records (`generation`, `state`, `staleExecutionCount`) make every phase explicit and durable. A resumed run carries a recovery directive that forbids replaying any interrupted operation. This is the R3 semantic, now running on PostgreSQL across real process boundaries.

## ForgeVerify revision architecture

```
material steer → execution plan revision (WorkflowPlan.revision)
  → ForgeVerify reconciliation (new verification plan bound to executionRevision)
  → required re-verification for the authoritative revision
  → completion gate binds verification revision ≡ plan revision (verification_not_current blocks otherwise)
```

Steer wording has no authority over verification or completion; the `workflow.plan_revised` event and the durable ForgeVerify records make each revision inspectable.

## Parallel steering architecture

```
targeted steer (turnId + steerId + targetWorkstreamId) → durable scoped receipt
  → only the targeted workstream holds/replans (extra bounded coder round with the steer)
  → exactly-once scoped consumption (durable consumedAt, scope-keyed lookup)
```

The scope binding survives API retry, persistence, restart, and hydration; invalid targets fail closed.

## Defects found and fixed during R5C

- `CodeForgeServer` session-snapshot/list/events endpoints serialized `Promise` objects into HTTP responses after the async migration; they are now awaited.
- `executeAgentRun` skipped session creation (`!getSession` was always false on a Promise), which violated the `work_items` foreign key and silently dropped tool-execution records; fixed and covered by the CF-10C traversal certification.
- Mission crash-on-write semantics were silently swallowed by a fire-and-forget write chain; mission saves are now awaited so a dying store still aborts the mission honestly.
- `remote-publication-service` read deliveries through a synchronous callback that received a Promise (`DELIVERY_NOT_LOCAL_READY` for every publication); the callback is now async end-to-end.
- The CF-17 PG restart E2E initially posted its resume as GET (route helper default) and hit the session-snapshot route; the E2E now POSTs explicitly. Test-side only.
- Full-suite flakiness under a 26-minute serial run traced to the WSL2 VM idle-shutdown between PostgreSQL touchpoints plus the 10s hook default for spawned-process fixtures; mitigated by a WSL keepalive during the gate and `hookTimeout: 60_000` (assertions unchanged).

## Certification evidence (all fresh, this session)

- Focused CF-17 behavioral E2Es: 4 files, 8 tests, 0 failed, 0 skipped (`cf17-runtime-restart-api`, `cf17-pg-restart-e2e`, `cf17-forgeverify-replan`, `cf17-parallel-scoped-steer`).
- Real PostgreSQL focused gate: 5 files, 63 tests, 0 failed, 0 skipped (`cloud-db` postgres/parity/publication-lease, `tests/cloud-postgres-adversarial`, `tests/two-client-authority`).
- Full serial PostgreSQL-enabled suite (`vitest run --no-file-parallelism`): 177 files, 1,356 tests, 0 failed, 0 skipped, 992.51s. PostgreSQL selected via `CODEFORGE_TEST_POSTGRES_URL` (WSL2 Ubuntu PostgreSQL 16.15, `codeforge_test`/`codeforge_test_db`); the spawned-process E2E ran against its own disposable `cf17_restart_e2e` database, dropped after the run.
- Typecheck: `npm run typecheck` — PASS.
- Production build: `npm run build` — PASS.
- `git diff --check` — PASS.

## Repository state

- Branch: `feat/codeforge-cloud`
- Initial HEAD (start of R5): `2ca10c83037ed9f60ee45c87b8f27766a0a35c1e`
- Worktree: all accumulated CF-17 R/R2/R3/R4/R5/R5C work, one local commit
- Remote operations: NONE

---

## 1. Executive verdict (superseded by the CF-17R5C closure above)

`CF17_BLOCKED`

---

# CF-17R4 closure attempt — 2026-09-05

## Verdict

`CF17_BLOCKED`

## R4 behavioral evidence

| Mandatory proof | Result | Evidence |
| --- | --- | --- |
| Active-command steering | PASS | `packages/server/test/cf17-runtime-restart-api.test.ts` — real `run_command` child process is held and released by workspace barrier files; the public steer path is durable and consumed once at the following model boundary. |
| Approval-resolution race | PASS | `packages/server/test/cf17-runtime-restart-api.test.ts` — steer-then-approval and concurrent HTTP ordering both preserve one approval, one steer, and one guarded write. |
| Live spawned-process restart with queued steer + real PostgreSQL | BLOCKED | The production `CodeForgeServer` durable session store is SQLite-only (`createSessionPersistence({ dbPath })`); it has no PostgreSQL persistence adapter or server configuration path. The current restart test remains an in-process SQLite server lifecycle test, so it cannot truthfully certify this requirement. |
| Steer-driven ForgeVerify replanning | BLOCKED | No production link exists between chat-turn steering and a ForgeVerify plan revision/evidence receipt. Adding one would be new workflow architecture, not an E2E-only repair. |
| Scoped parallel steering | BLOCKED | `UserIntentHoldController` is session-scoped while `ParallelAutonomousRunOrchestrator` has no targeted steer/hold API. A scope-isolated steer E2E cannot be built against a production semantic that does not exist. |

## R4 defects fixed

- The public `/api/send` steer route dropped `steerId` and incorrectly passed `turnId` as the idempotency key. `SendRequestSchema` now admits `steerId`, and the route passes it to `AgentRuntime.steerTurn`.
- An approval decision could resume a synchronous guarded tool and terminalize its turn before a concurrently received steer reached the HTTP handler. `gateWithApproval` now yields once at the post-approval execution boundary, letting already-arrived steers become durable without changing approval, permission, verification, or completion authority.

## R4 executed evidence

- Focused server recovery/steering test: `packages/server/test/cf17-runtime-restart-api.test.ts`, 3 tests passed, 0 skipped.
- Typecheck: `node node_modules/typescript/bin/tsc -b --force`, passed.
- Production build: `C:\Program Files\nodejs\npm.cmd run build`, passed.
- `git diff --check`: passed.
- The configured shell did not expose a PostgreSQL connection string, and no R4 PostgreSQL or full serial gate is claimed. This is not a claim that PostgreSQL is unavailable; it is an absence of the required configuration in this execution context.

## R4 conclusion

R4 closes the active-command and approval-race proofs and repairs the defects they exposed. CF-17 remains blocked because the three remaining mandatory proofs require production capabilities not present in the current server: PostgreSQL-backed session persistence across separate server processes, steer-driven ForgeVerify replanning, and scope-targeted parallel steering. No commit or remote operation was performed.

---

# CF-17R certification closure audit — 2026-09-05

## Repository state

- Root: `G:\CodeForge`
- Branch: `feat/codeforge-cloud`
- Starting HEAD: `2ca10c83037ed9f60ee45c87b8f27766a0a35c1e`
- Starting worktree: clean.
- Ending worktree: CF-17R changes are present locally and uncommitted because the mandatory E2E matrix remains incomplete; no remote operation occurred.

## PostgreSQL audit and root cause

The previous CF-17 PostgreSQL blocker was **environment available but not detected**. The ordinary shell could not enumerate WSL (`Wsl/EnumerateDistros/Service/E_ACCESSDENIED`) and did not contain `CODEFORGE_TEST_POSTGRES_URL`; Docker was also unavailable and no Windows listener was visible from that restricted context. An elevated read-only audit found the WSL service and Ubuntu running, PostgreSQL accepting connections on port 5432, and the CF-16 test database accessible. The existing CF-16 WSL infrastructure was reused unchanged. Credentials and connection strings were not printed.

The real PostgreSQL focused gate passed: 5 files, 63 tests, 0 failures, 0 skips (`postgres`, parity, publication-lease, adversarial concurrency, and two-client authority). The full serial PostgreSQL-enabled suite passed with 173 files, 1,344 tests, 0 failures, and 0 skips.

## CF-17R defect fixed

Terminal turns previously left their session-scoped queued-steer state behind. A later turn in the same session could observe that stale steer and repeatedly re-enter its model loop. `resolveForTerminal` now clears only the terminal turn's queued steers, releases waiting dispatch boundaries, persists the terminal release, and emits an explicit `terminal` release reason. A regression test proves the old steer cannot affect a later turn.

An unrelated CF-10 delivery determinism test also had a demonstrably insufficient 30-second per-test deadline: its three real delivery cycles took 38.5 seconds under the audited environment. Its timeout is now 60 seconds; all assertions are unchanged.

## E2E evidence and remaining gap

| Scenario | Result | Evidence |
| --- | --- | --- |
| Planning / pre-tool steer | PASS | `steering.test.ts`, `agent-runtime.test.ts` safe model boundary coverage |
| Multiple steers / replay | PASS | ordered, idempotent queue tests in `steering.test.ts` and `user-intent-hold.test.ts` |
| Persistence / hydration | PASS | durable hold reconstruction, hold API, SSE replay/hydration regressions |
| Cancellation terminality | PASS | CF-17R terminal queue regression plus existing cancellation suites |
| PostgreSQL concurrency | PASS | 63-test focused real PostgreSQL gate and serial full suite |
| Active command steer | NOT CERTIFIED | no dedicated CF-17 long-running command-boundary E2E |
| Approval-resolution race | NOT CERTIFIED | no dedicated CF-17 hold-and-approval race E2E |
| Full live restart with queued Agent steer | NOT CERTIFIED | controller reconstruction exists, but no server-process restart E2E |
| ForgeVerify mutation/replan after steer | NOT CERTIFIED | canonical ForgeVerify coverage exists, but no CF-17 steer-driven verifier E2E |
| Parallel affected-scope steer | NOT CERTIFIED | related parallel tests exist, but no CF-17 scoped-hold E2E |

Typing remains intentionally distinct from submitted steering: the composer sends bounded hold/release transitions without draft content, and a submitted steer is the only durable user message. The quiet-grace and stale-lease tests cover abandoned drafts. ForgeGreen remains advisory only; its existing verification and completion independence tests passed in the serial suite.

## Test evidence

- Focused CF-17: 4 files / 16 tests, PASS.
- Real PostgreSQL focused gate: 5 files / 63 tests, PASS, 0 skips.
- Typecheck: PASS.
- Production build: PASS.
- Full serial PostgreSQL-enabled suite: 173 files / 1,344 tests, PASS, 0 skips.
- `git diff --check`: pending final documentation edit check.

The apparent count change from CF-17's historical 1,306 passed / 21 skipped is reconciled: PostgreSQL enables 21 skipped cases and 16 dynamic PostgreSQL variants; CF-17R adds one terminal-state regression. `1,306 + 21 + 16 + 1 = 1,344`.

## CF-17R verdict

`CF17_BLOCKED`

PostgreSQL certification is complete. The literal remaining blockers are the dedicated behavioral E2Es marked NOT CERTIFIED above; adjacent unit, integration, and full-suite results are not substituted for them.

## CF-17R2 partial behavioral audit

The public steer endpoint had a concrete approval-wait defect: `AgentRuntime.getActiveTurns()` omitted `waiting_for_approval` and `waiting_for_question`, so `/api/send` could reject a submitted steer with `NO_ACTIVE_TURN` during a valid approval wait. Both waiting states are now included in the public active-turn projection. The HTTP regression starts a real runtime turn, waits for a real approval request, submits a steer through `/api/send`, and proves the steer is accepted before the approval settles.

The required live restart E2E cannot yet be implemented safely: `CodeForgeServer` creates a new `AgentRuntime` after restart, and `AgentRuntime` has no persisted-turn hydration or safe replan-resume protocol. Its active-turn map is empty after restart even though the session store can reconstruct the queued hold record. Blindly replaying the original turn would violate CF-17's no-stale-work invariant. This is a product recovery gap, not a PostgreSQL or test-environment limitation. The remaining active-command, approval-race, ForgeVerify-replan, and parallel-scope dedicated E2Es are consequently still outstanding.

## CF-17R3 recovery implementation audit

R3 closes the specific runtime-hydration gap identified by R2. A fresh `AgentRuntime` now inspects only durable nonterminal turns and enters an explicit `recovering` state where it cannot be mistaken for ordinary `running` work. It retains durable task intent, accepted steer identities and payloads, approval/question records, and completed evidence; it does not recreate promises, streams, child-process handles, model continuations, or tool callbacks.

Recovery is `hydrate → classify → invalidate stale execution → reconcile → replan → resume`. Interrupted durable tool records are reclassified without execution. In particular, a `run_command` that was started without an observation receipt is recorded as `unknown_side_effect`; the new model attempt receives a recovery directive to inspect current workspace facts and make a fresh plan. A pre-restart approval can be restored as a wait boundary, but resolving it only moves the turn to recovery replanning—it never executes the old guarded tool call. Terminal turns remain absent from the recovered active map.

The implementation adds a durable `agent_turn_recovery` record, an ordered `turn.recovery` event, recovery generations, and restart-aware pause/resume routing. Queued steers are rehydrated from the existing `UserIntentHoldController` record with their durable identities; they are placed into the next new planning request and reconciled through the existing exactly-once queue removal path. The original task text is no longer overwritten while queuing a steer.

Focused evidence currently passes: six files and 28 tests covering runtime hydration, terminal non-resurrection, pending-approval recovery, conservative command classification, existing steer/hold behavior, ordinary server restart behavior, and the production server's persisted-session restart path. The targeted restart test starts server A, durably queues a steer, stops it before its first model attempt completes, starts a fresh server B against the same session database, calls the production resume endpoint, and verifies one recovery-directed model request contains the steer.

This is **not** a CF-17R3 PASS. The targeted lifecycle regression is an in-process server test using the session database, not the mandatory spawned-child-process proof against real PostgreSQL. Dedicated active-command, approval-race, ForgeVerify-replan, and scoped-parallel behavioral E2Es also remain unimplemented. No final PostgreSQL or serial-suite rerun has been claimed for R3.

| Mandatory proof | R3 status |
| --- | --- |
| Active-command steering | BLOCKED — dedicated command-boundary E2E absent |
| Approval-resolution race | BLOCKED — public approval-steer regression passes, race matrix absent |
| Live restart + queued steer | PARTIAL — production server lifecycle regression passes; required child-process/real-PostgreSQL proof absent |
| Steer-driven ForgeVerify replan | BLOCKED — dedicated ForgeVerify scope-change E2E absent |
| Scoped parallel steering | BLOCKED — dedicated scope-isolation E2E absent |

## Historical CF-17 report

The sections below are the original CF-17 record retained for traceability. Their PostgreSQL availability and test-count statements are superseded by the CF-17R audit above.

The implementation and all new focused tests pass. The mandatory complete-suite PostgreSQL gate cannot be claimed in this shell because the real PostgreSQL URL is not configured and the local PostgreSQL probe is unavailable. The full local suite therefore contains inherited PostgreSQL-gated skips. The requested rules prohibit a qualified PASS.

## 2. Takeover repository state

- Root: `G:\CodeForge`
- Branch: `feat/codeforge-cloud`
- Baseline HEAD: `27e3b6491af5e8caa44675ff9fbc754c25217cb5`
- Node: `v24.19.0`
- Package manager: `npm.cmd 11.17.0`
- Baseline worktree: clean; inherited CF-14–CF-16 work preserved.
- No reset, clean, checkout, force push, or remote write was used.

## 3. Existing scheduling architecture

`Composer` routes Enter to ordinary send or steer while preserving Shift+Enter and IME guards. `WorkspaceApp` uses `useWorkspaceSSE`; `/api/send` routes submitted steers to the existing `AgentRuntime`. `AgentRuntime` owns the model/tool loop, approvals, cancellation, turn persistence, and events. Workflow implementation/repair delegates into that runtime; `WorkflowEngine` owns ForgeVerify dispatch and Completion Gate.

## 4. CF-17 architecture

`UserIntentHoldController` is a server timing barrier, not permission, verification, completion, delivery, publication, or cancellation authority. It persists one hold record and ordered submitted steers through existing session work items and SSE storage.

## 5. Dispatch barrier

The barrier is consulted before new model/tool execution in `AgentRuntime` and before new workflow verifier dispatch. Existing provider streams, child processes, file writes, database work, persistence, and evidence callbacks are not aborted.

## 6. Composer event design

The local composer emits only empty-to-nonempty hold entry and a debounced release candidate. The centralized quiet grace is `USER_INTENT_HOLD_QUIET_GRACE_MS = 1500`; no per-character server event is emitted.

## 7. Unsent-draft privacy

Hold requests contain only session/run/turn identity, action, and optional generation. Draft content is not sent or persisted. Submitted steer text enters normal history only after Enter.

## 8. Hold state model

Persisted scheduling states are `running`, `user_intent_hold`, `steer_queued`, and `reconciling_steer`; they are not terminal turn states.

## 9. Hold generation/token semantics

Each new hold increments a persisted generation. Releases with an old generation are rejected.

## 10. Priority steer queue

Steers are inserted ahead of autonomous continuation, retained in submission order, and deduplicated by client identity.

## 11. Checkpoint model

The hold item supports run/turn identity, current plan step, completed/pending steps, active execution, workspace generation/state hash, entered time, and the fixed `user_intent_hold` reason.

## 12. Reconciliation behavior

Queued steer text is consumed at the next safe model boundary. A steer arriving while a model response proposes stale tools bypasses those tools and starts a fresh reconciliation turn.

## 13. Resume behavior

Release or completed reconciliation resolves waiting boundaries and continues from existing state.

## 14. In-flight command behavior

The barrier is not consulted after a command has started; its output and durable state complete normally.

## 15. Model-call behavior

An already-sent provider stream may finish. A model request not yet sent waits at the barrier.

## 16. Tool behavior

Tool dispatch waits at the barrier. A submitted steer can prevent a stale streamed tool proposal from dispatching.

## 17. Subagent behavior

The barrier exposes a subagent dispatch class; existing subagents are not killed by typing.

## 18. ForgeVerify behavior

`WorkflowEngine` waits before `runVerification`; an attempt already running is untouched. CF-16 plan, attempt, evidence, and Completion Gate authority remains unchanged.

## 19. Stale evidence after steer

Workspace changes do not preserve green evidence; existing ForgeVerify state hashing determines staleness.

## 20. Explicit cancellation

The existing `/cancel` and `AgentRuntime.cancelTurn` path is unchanged. Typing and ordinary steering do not call it.

## 21. Draft-clear behavior

Deleting a draft schedules the centralized quiet-grace release and does not cancel or restart the run.

## 22. Abandoned-draft policy

The default is `Expensive actions only`; local quiet grace resumes after inactivity and server stale-lease recovery is bounded. `Always` and `Off` are available in the existing settings modal.

## 23. Rapid steer handling

Rapid steers remain separate durable entries and are consumed in order. Duplicate identities do not add a second steer.

## 24. New steer during reconciliation

Newer steers remain in the priority queue; reconciliation removes only identities it consumed.

## 25. Anti-livelock

Reconciliation is bounded by the existing model-turn budget and does not start a loop per keystroke.

## 26. Multi-run behavior

The current runtime permits one active turn/workflow per session; unrelated sessions remain independent. Hold records still carry explicit run/turn identity.

## 27. Multi-client behavior

Generation-checked release prevents an old client from releasing a newer hold; stale holds without submitted intent are recoverable.

## 28. Restart/recovery

Hold records and submitted steers reload from `SessionPersistence`. Unsent draft text is not needed for durable recovery; reconnect can reassert the hold.

## 29. SSE

Entered, released, queued, reconciliation-started, and reconciliation-completed events use the existing persisted event stream.

## 30. Replay

Existing session sequence and replay deduplication apply; hydrated hold work-item state is used for projection recovery.

## 31. Run projection

The UI projects `executionState`, `holdReason`, and `steerQueued` without draft text.

## 32. Desktop UX

The composer displays `Waiting for your steer…`, distinct from pause/cancel/failure.

## 33. Settings

The existing Settings modal exposes `Pause Agent while typing`: `Expensive actions only` (default), `Always`, and `Off`.

## 34. ForgeGreen metrics

Interactive receipts can include hold count, duration, and dispatch-class avoidance metrics; the advisor remains non-authoritative.

## 35. Work avoided

Avoidance is counted only when an eligible dispatch reaches a held barrier.

## 36. No-fake-savings proof

The no-pending-work test reports zero avoided dispatches; duration alone never increments a counter.

## 37. Privacy adversarial tests

Focused UI and HTTP tests verify `PASSWORD=secret`, `sk-`, and `ghp_` values are absent from hold requests and returned session state when never submitted.

## 38. Race matrix

Focused coverage proves stale-generation rejection, idempotent hold/steer transitions, ordered queueing, and durable reconstruction. Existing CF-16/CF-08/CF-09 race suites remain green.

## 39. Real-command E2E

The runtime test proves a real Agent model boundary waits until release. The requested long-running shell-command E2E is not yet present.

## 40. ForgeVerify E2E

Pre-existing real ForgeVerify tests pass. The requested mutation-after-steer verifier E2E is not yet present.

## 41. Restart E2E

Controller restart reconstruction passes for persisted hold/steer state. A full live server-process restart with queued Agent steer is not yet present.

## 42. Explicit cancel E2E

Existing cancellation suites pass; a dedicated hold-then-explicit-cancel E2E remains outstanding.

## 43. Rapid-steer E2E

Ordered/idempotent controller coverage passes; a full provider-backed rapid-steer E2E remains outstanding.

## 44. PostgreSQL parity

CF-17 adds no cloud PostgreSQL schema or migration; its hold record uses existing local session persistence. The inherited real PostgreSQL gate was not rerun because no PostgreSQL URL is configured.

## 45. Previous-phase regression matrix

Focused ForgeVerify, Completion Gate, AgentRuntime, execution-mode, ForgeGreen, parallel-security, SSE, workflow, and UI regressions pass. Every executed file in the sequential full suite passed.

## 46. Full test results

Sequential full local command: `172 passed files`, `1 skipped file`; `1,306 passed tests`, `21 skipped tests`, `0 failed`. The skips are inherited PostgreSQL-gated tests, so this is not a CF-17 certification gate.

## 47. Typecheck

`npm.cmd run typecheck`: PASS.

## 48. Production build

`npm.cmd run build`: PASS for all workspaces, desktop main/renderer, and web Vite output.

## 49. `git diff --check`

`git diff --check`: PASS (exit code 0).

## 50. Final Git state

The implementation and report are committed locally only. No remote operation is authorized or performed. The final local commit is reported with the final repository state.

## 51. Remaining limitations

Real PostgreSQL-enabled full-suite evidence, the complete long-running command/ForgeVerify/restart/cancel CF-17 E2Es, and final post-documentation build/diff evidence remain outstanding.

## 52. Final verdict

`CF17_BLOCKED`
