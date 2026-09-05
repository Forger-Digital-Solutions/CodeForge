# CODEFORGE CF-17 CERTIFICATION REPORT
# — FORGEGREEN STEER-AWARE EXECUTION, USER-INTENT HOLDS & INTERACTIVE WORK-AVOIDANCE

## 1. Executive verdict

`CF17_BLOCKED`

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
