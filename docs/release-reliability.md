# Release reliability and recovery

## Lifecycle ownership

`WorkflowService` owns active workflow registrations, cancellation controllers, timeout timers, and the server-side `ApprovalService`. `WorkflowEngine` owns the task phase and only permits the first terminal transition (`completed`, `failed`, or `cancelled`). `AgentRuntime` remains the sole execution path for real model turns; it resolves model eligibility through ForgeZero and executes consequential tools through its tool registry and approval gate.

The session database is task history and reconstruction data, not an authorization source. Session records retain canonical provider and model fields when supplied by the runtime. A persisted model record is never used to approve a later inference; runtime selection re-enters the normal AgentRuntime and ForgeZero path.

## Persistence and reconstruction

SQLite persistence uses WAL. Sessions, turns, work items, and persisted server events are redacted at the persistence boundary in addition to the existing runtime and event-adapter redaction. This protects task requests, safe errors, evidence, checkpoint metadata, approval descriptions, and SSE replay data from known secret patterns.

The server exposes persisted session, turn, work-item, event, and pending-approval state for renderer/SSE reconstruction. An SSE reconnect or renderer reload reads state; it does not start a new workflow. Active in-memory controllers and runtimes do not survive a server process restart.

## Restart and interruption semantics

On service construction, sessions and turns persisted as running, paused, or awaiting approval are marked failed with a recovery-required message. This is intentionally non-resumptive: a restarted server does not retry a potentially ambiguous tool, verification command, or repair attempt. Pending in-memory approvals do not become approved after restart.

Cancellation cancels the workflow controller and approvals associated with the workflow turn. The workflow service now supplies its turn ID to the engine, so these controls address the same approval record. Completion, cancellation, or a late callback cannot replace an established terminal phase or emit a second terminal phase transition.

Verification is successful only when its command exits successfully with no parsed failures. A failed verification ends in `failed`, never a `completed` phase. Repair-attempt accounting advances before each repair begins, so an interrupted started attempt cannot be mistaken for unused budget; the configured limit remains three.

## Approval boundary

The real AgentRuntime workflow path never resolves its own pending approvals. It remains waiting until an explicit UI/API decision reaches the authoritative `ApprovalService`. If a plan requires approval and no approval handler exists, the engine fails closed before implementation.

The in-process heuristic executor is deterministic test support; production WorkflowService always supplies its approval handler and real runtime execution is guarded by AgentRuntime.

## File, workspace, and checkpoint safety

Agent edits continue to use expected content hashes and atomic temporary-file rename. A stale hash produces a failed edit instead of overwriting a human change. Workspace resolution uses canonical real paths. The checkpoint service creates Git refs but is not a safe destructive rollback mechanism: its restore path checks out a ref and must remain user-initiated and reviewed; CodeForge must not run reset-hard, clean, or automatic restore on recovery.

## Free Mode and known limitations

Free Mode remains verified-free only: ForgeZero determines eligibility, no paid fallback is permitted, and a missing verified-free model is reported as `NO_FREE_PROVIDER`. Provider/model identity remains `providerId::modelId`; UI labels and persisted metadata do not authorize routing.

This is not an OS sandbox. Environment filtering and pattern-based secret redaction are defence in depth and cannot detect every possible secret format. Windows shell process-tree termination can also be best effort. Packaged executable launch and live-provider checks require an environment with a working Electron packaging toolchain and user credentials; they are not implied by configuration validation.