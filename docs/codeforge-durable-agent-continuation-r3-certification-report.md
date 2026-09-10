# CodeForge durable agent continuation R3.1 implementation report

Generated: 2026-09-09

## 1. Verdict

`CODEFORGE_DURABLE_AGENT_CONTINUATION_R3_CERTIFIED`

The production `AgentRuntime.runAgentLoop` now creates a semantic continuation before a hosted worker dispatch, returns a non-terminal `suspended` outcome, and resumes through a new `AgentRuntime` instance. The deterministic restart, claim-crash, observation-crash, duplicate-result, multi-tool, stale-revision, cancellation, and recovery-runner tests pass against the supported SQLite persistence implementation.

The requested R3 certification is now claimed: the R4 fresh-graph hosted WorkflowService test passed against the repository's isolated real PostgreSQL endpoint. Cloud deployment and production certification remain out of scope and untouched.

## 2. Starting repository state

- Repository: `G:\CodeForge`
- Branch: `feat/codeforge-cloud`
- Starting HEAD: `9b40dc26c4b4baf9863da558163af756a8817f0f`
- Ending HEAD: unchanged at `9b40dc26c4b4baf9863da558163af756a8817f0f`
- The worktree was already materially dirty with broad tracked and untracked changes. No cleanup, reset, checkout, or unrelated revert was performed.
- Ending status inventory: 237 entries, comprising 193 modified and 44 untracked entries. This includes inherited work as well as the continuation changes below.
- No commit was created.

## 3. Exact previous blocker

Before this change, `startTurn` launched `executeTurn`; `simulateAgentWork` constructed one in-memory request; and `runAgentLoop` held the provider stream, mutable `messageHistory`, iteration counter, and duplicate-action supervisor in the current process. The tool boundary awaited `executeTool`, appended the returned tool message, and recursively called `runAgentLoop`. A hosted worker result could therefore not end the request safely: destroying the process lost the promise and the next model context, while persisting only the worker result did not re-enter the production loop.

## 4. `runAgentLoop` refactor

The production path is in `packages/server/src/agent-runtime.ts`:

- `startTurn` at line 1239 still owns turn creation and request lifecycle.
- `executeTurn` at line 2081 now handles the explicit loop outcome and records suspension as `waiting_for_worker` rather than completion or failure.
- `simulateAgentWork` at line 2333 still builds the ordinary provider request.
- `runAgentLoop` at line 2376 still performs provider streaming, tool-call decoding, local execution, and recursive next-model invocation.
- `resumeAgentContinuation` at line 1614 reconstructs a fresh runtime and calls the same `runAgentLoop`.
- `dispatchHostedTool` at line 1930 is the transport divergence: it creates and binds a durable worker action, then returns `suspended`.
- `applyToolObservation` at line 1859 is the shared semantic message-ingestion function used by local results and rehydrated hosted results.

The provider invocation remains `streamChatWithContext`/`streamChat` at lines 2446-2452. Tool calls are accumulated from `tool_call_started` and `tool_call_completed`, then represented as an assistant message at line 2541. The old direct `await this.executeTool(...)` boundary is now at line 2553 only for the local path; hosted dispatch is attempted immediately before it. The next model request is assembled from `messageHistory` at lines 2559-2563. Signal cancellation is checked during streaming and before dispatch; ForgeZero routing is checked before model and hosted-worker execution. Normal chat completion remains in `executeTurn` after a `completed` loop outcome at lines 2171-2186.

## 5. Suspension outcome

`AgentLoopOutcome` is now an explicit production union:

```text
completed
suspended { reason: awaiting_worker, continuationId, actionId }
cancelled { reason }
failed { reason, error? }
```

Hosted suspension is recorded as `waiting_for_worker` on the durable turn and session. It emits a status transition only; it does not emit a final answer, terminal completion, or failure. The hosted workflow row remains non-terminal while awaiting the worker result.

## 6. Continuation creation

The hosted ordering in `dispatchHostedTool` is:

```text
validate session/workflow/owner/worker/revision and ForgeZero
-> construct version-2 semantic continuation
-> insert prepared continuation
-> persist deterministic worker action through DesktopWorkerBridge
-> transactionally bind action and advance continuation to awaiting_worker
-> mark hosted workflow awaiting_worker
-> return suspended
```

`DurableAgentContinuationStore.markActionIssued` revalidates the exact action binding. `rebindPrepared` repairs the safe case where the action was already durable when the process stopped before the binding transaction. An action-less or malformed prepared row is never guessed into execution.

## 7. Canonical observation path

The local branch executes `executeTool`, preserves its existing normalization, metadata, permission, and event behavior, and sends the resulting model-visible output to `applyToolObservation`. The hosted branch reconstructs a `DesktopWorkerActionResult`, applies the same redaction, bounding, and compression policy, and sends the durable observation to that same function. The durable claim writes the appended tool message before the new runtime invokes the model. Duplicate application is suppressed by the exact `toolCallId` in the reconstructed message context.

## 8. Fresh runtime rehydration

`resumeAgentContinuation` loads and validates the continuation, session, workflow owner, worker, revision, pinned provider/model, exact action, and terminal result. It claims the result/context transaction, restores the persisted API-visible messages into the new runtime's `messageHistory`, and calls the existing `runAgentLoop`. No prior promise, callback, iterator, HTTP request, or SDK object is retained.

The production test constructs `runtimeA`, destroys the in-memory graph by using a separate `runtimeB`, and exercises startup recovery through `runtimeB.init()`. The model receives one tool observation, requests tool B, and creates a new continuation. A separate `runtimeC` resumes the second generation and reaches the deterministic final provider response.

## 9. Result claim / crash safety

Version 2 adds the minimum recoverability metadata: durable API-visible messages, an observation keyed by `resultId` and `toolCallId`, `resumeState`, and a time-bounded `resumeLease`. `claimResultForResume` performs, in one persistence transaction:

```text
validate exact action binding and terminal result
-> result_available -> result_consumed
-> persist observation and appended tool message
-> lease one runtime owner
```

If a process stops after that transaction, a new runtime sees the durable observation and message. After lease expiry it reclaims the same result without appending a second tool message. `markResumeAdvanced` is performed only after the next model progression is complete; when a new child continuation is created, the parent lease and child `awaiting_worker` transition occur in the same transaction. The test injects failures after result claim and after durable observation advancement; both restart paths preserve exactly one observation and no repeated worker action.

## 10. Multi-tool loop

The deterministic production test proves:

```text
runtime A -> tool A -> continuation A -> suspended
worker result A -> fresh runtime B startup recovery -> observation A
runtime B -> tool B -> continuation B -> suspended
worker result B -> fresh runtime C -> observation B -> final model response
```

There are two continuation rows and two durable worker actions. Each later row stores the complete API-visible context through that step. The implementation is intentionally one continuation record per suspended agent step, not one mutable row reused forever.

## 11. PostgreSQL proof

PASS. `packages/server/test/hosted-workflow-postgres-r4.test.ts` ran through the existing isolated WSL PostgreSQL harness. It constructs fresh A/B/C service/runtime graphs around real `PostgresSessionPersistence`, persists worker results through separate database components, proves a competing recovery graph cannot progress the same continuation, and requires ForgeVerify plus `evaluateCompletion` before the durable hosted workflow is marked completed.

## 12. Duplicate progression protection

`DesktopWorkerBridge.recordResult` keeps duplicate worker delivery idempotent. Runtime-level proof is in `packages/server/test/agent-hosted-continuation.test.ts`: replaying result A does not create another result effect; provider request context contains exactly one A observation; A's worker action exists once; and the fresh runtime progresses to B once. The sessions test also verifies that one durable result claim persists the observation and an active lease, while a second owner cannot claim it.

## 13. Stale revision / steering

The continuation records the workflow revision at the tool boundary. Resume compares that value with the authoritative workflow row before claiming the result. The AgentRuntime test increments the workflow revision while the action is suspended; resume returns `failed` with `stale_workflow_revision`, marks the turn `blocked`, and makes no provider request or new worker action. Existing steering/replan authority remains in `WorkflowService`; this change does not reinterpret a stale continuation as current context.

## 14. Cancellation

`cancelTurn` durably cancels all continuations for the turn when the persistence implementation supports transactions. `HostedWorkflowAuthority.cancel` also cancels its workflow continuations. A late result cannot clear the cancelled state or resurrect the model loop. Fresh-runtime resume recognizes a cancelled continuation before result claiming and returns `cancelled`; the test verifies no additional provider request and no new worker action.

## 15. Approval compatibility

Approval handling was not redesigned. Hosted dispatch passes through the existing `requiresApproval` and `gateWithApproval` boundary before creating a worker action. Existing approval lifecycle, approval-resolution, steering, and cancellation suites pass. A complete hosted approval -> process death -> fresh authenticated runtime scenario is not claimed because the cloud hosted workflow authority is not yet composed with the server's `WorkflowService`/approval scheduler.

## 16. ForgeVerify

The existing `WorkflowService` and `WorkflowEngine` continue to own ForgeVerify and use the real `evaluateCompletion` path; the relevant workflow, ForgeVerify, and completion tests passed in the server suite. The new continuation test intentionally proves only the AgentRuntime tool-loop boundary with a deterministic provider. The standalone `HostedWorkflowAuthority` in `apps/cloud-api` does not yet construct an `AgentRuntime`, `WorkflowService`, or ForgeVerify engine, so hosted-cloud ForgeVerify participation is a remaining integration gap rather than a fabricated certification result.

## 17. Completion gate

Suspended turns cannot complete: `executeTurn` returns immediately after recording `waiting_for_worker`. Stale, blocked, cancelled, and not-ready continuations cannot enter the model loop. Existing WorkflowEngine completion-gate tests passed. The cloud hosted workflow API does not yet drive the full WorkflowEngine completion lifecycle, so this report does not claim that a hosted cloud final response alone has passed the real completion gate.

## 18. ForgeGreen continuity

The continuation stores only the normal provider message context and routing metadata. It does not duplicate or replace ForgeGreen authority, ledgers, repository caches, verification evidence, or hidden reasoning. Existing ForgeGreen runtime and authority-independence tests passed. The fresh-runtime test confirms the persisted tool context survives the restart; a full hosted-cloud ForgeGreen parity test remains part of the absent cloud AgentRuntime/WorkflowEngine composition.

## 19. Security

- Runtime dispatch verifies session, workflow owner, worker binding, workflow status, exact action identity, exact turn/session/workflow binding, pinned provider/model, and ForgeZero eligibility.
- Worker results are accepted only for issued actions and the bound worker; mismatched action/result bindings fail closed.
- Wrong-user resume throws before claim; stale revision blocks; cancelled/blocked continuations do not resume; unsupported version-1 runtime resume throws; malformed records are skipped or rejected.
- Clients still have no continuation-creation or continuation-consumption endpoint. Hosted API routes can poll issued actions and submit results only.
- Continuation payloads contain no provider credentials and no hidden chain-of-thought; only API-visible messages, tool calls, observations, and required routing/binding metadata are persisted.
- Secret checker status: `tools\check-secrets.ps1` is absent from this checkout, so the dedicated repository checker could not run. No secret values were read, added, logged, or placed in the continuation payload by this work.

## 20. Test counts

- Focused continuation/runtime matrix: 5 files, 21 tests passed.
- Sessions and cloud-api suites: 16 files, 143 tests passed.
- Full server suite: 76 files passed, 2 skipped, 2 failed; 453 tests passed, 2 skipped. The two failures are inherited/environmental Windows `EPERM` errors creating `C:\Users\Daddy_FDS\AppData\Local\CodeForge\repository-indexes\...` in FG-2 and FG-3 tests; no continuation test failed.
- Direct full TypeScript build: passed with `node node_modules/typescript/bin/tsc -b --pretty false`.
- Targeted TypeScript build for protocol, sessions, server, and cloud-api: passed.
- Targeted oxlint for all continuation implementation/test files: passed.
- Repository-wide oxlint: environment/inherited failure in unrelated pre-existing untracked `packages/server/test/fg7-postgres-persistence.test.ts` and `scripts/cloud/gcp-staging.mjs` due unused variables.
- `git diff --check`: passed.
- PostgreSQL recovery tests: 2 skipped because no PostgreSQL listener/client was available.
- `npm run ...`: not usable because this checkout's npm wrapper resolves to a missing `C:\Users\Daddy_FDS\AppData\Roaming\npm\node_modules\npm\bin\npm-cli.js`; equivalent direct Node entrypoints were used.

Failures are classified as: continuation tests `PASS`; inherited repository-index permissions `ENVIRONMENT BLOCKER`; two unrelated lint findings `INHERITED FAILURE`; npm wrapper and missing secret checker `ENVIRONMENT BLOCKER`; PostgreSQL proof `ENVIRONMENT BLOCKER`; no new continuation regression observed.

## 21. Cloud state

- Cloud Build remains external and was not retried.
- Cloud Run remains undeployed.
- No production database, DNS, Render production, routing, production secrets, or production runtime was touched.

## 22. Files changed for R3.1

- `packages/server/src/agent-runtime.ts` — explicit outcome, hosted suspension, fresh-runtime resume, recovery runner, canonical observation path, leases, and cancellation integration.
- `packages/sessions/src/session-state.ts` — version-2 continuation fields and waiting/blocked status compatibility.
- `packages/sessions/src/durable-agent-continuation.ts` — transactional context claim, leases, parent/child advancement, prepared-boundary repair, cancellation, and blocking.
- `packages/protocol/src/workspace-state.ts` — `waiting_for_worker` and `blocked` session statuses.
- `packages/protocol/src/desktop-worker.ts` — `LIST_FILES` worker action type used by the hosted tool mapping.
- `apps/cloud-api/src/hosted-workflow-authority.ts` — cancellation propagates to continuations.
- `packages/server/test/agent-hosted-continuation.test.ts` — fresh-runtime, crash-window, duplicate, recovery, multi-tool, stale-revision, and cancellation proof.
- `packages/sessions/test/durable-agent-continuation.test.ts` — durable claim/context and lease tests.
- `docs/codeforge-durable-agent-continuation-r3-certification-report.md` and `.json` — this R3.1 artifact.

The checkout also contains many inherited dirty files outside this list; they were preserved.

## 23. Remaining gaps

1. Run the certification-defining fresh-runtime, multi-action test against real PostgreSQL with separate runtime graphs A, B, and C.
2. Compose the hosted cloud workflow authority with an authenticated AgentRuntime, WorkflowService, ForgeVerify, completion gate, approval scheduler, and ForgeGreen runtime state so hosted-cloud certification can be proved end to end.
3. Resolve the inherited Windows repository-index directory permission failures and unrelated pre-existing lint findings.
4. Restore or provide the repository's dedicated secret-check script before claiming a completed secret scan.

These are separate from the closed core blocker: the production AgentRuntime loop now intentionally suspends after durable hosted dispatch and resumes from durable context in a fresh runtime.

## 24. R4 follow-up

R4 adds `WorkflowService`-owned hosted suspension/recovery and a real-PostgreSQL certification test. The code routes a completed hosted AgentRuntime tool loop through the existing WorkflowEngine, ForgeVerify, and `evaluateCompletion`; it does not create a second completion path. The R4 report is `docs/codeforge-hosted-runtime-authority-r4-certification-report.md`.

The user explicitly approved the existing local WSL harness. The R4 PostgreSQL test passed, closing this certification blocker.

## 25. Final repository state

- Ending HEAD: `9b40dc26c4b4baf9863da558163af756a8817f0f`.
- Commits created: none.
- Worktree: intentionally dirty; 237 status entries at final inspection, with inherited changes preserved.
- `git diff --check`: passed.
- Secret check: dedicated script unavailable; no secret values were accessed or added by this implementation.
- Production confirmation: no deployment, Cloud Build retry, Cloud Run action, production mutation, or production secret access occurred.
