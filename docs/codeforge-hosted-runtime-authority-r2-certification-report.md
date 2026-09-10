# CodeForge hosted runtime authority R2 report

Generated: 2026-09-09

## 1. Verdict

`CODEFORGE_HOSTED_RUNTIME_AUTHORITY_R2_NOT_CERTIFIED_DURABLE_AGENT_CONTINUATION_NOT_IMPLEMENTED`

`CODEFORGE_GCP_CLOUD_BUILD_EXTERNAL_AUTHORIZATION_BLOCKED`

R2's required result-to-real-`AgentRuntime`/`WorkflowService` continuation is not implemented.
The precise gap is that `AgentRuntime.runAgentLoop` holds model conversation, pending tool calls,
duplicate-supervisor state, and the recursive next-loop continuation in process memory while it
awaits direct local tool execution. A worker result can be durably accepted, but no serializable
agent-loop continuation exists to hydrate it into the pending tool observation and resume the same
runtime after a server restart. Claiming an R2 hosted multi-turn runtime would be false.

## 2. Starting state

- Repository: `G:\CodeForge`
- Branch and starting/ending HEAD: `feat/codeforge-cloud` / `9b40dc26c4b4baf9863da558163af756a8817f0f`
- The worktree contained substantial inherited tracked and untracked changes; they were preserved.
- No commit was created and no secret was read, printed, or committed.

## 3. Authority trace

- `packages/server/src/workflow-service.ts`: `startWorkflow` builds the real workflow engine;
  `createAgentExecutor` starts and waits for `AgentRuntime` turns; it persists ForgeVerify records
  and invokes the real workflow completion path.
- `packages/server/src/agent-runtime.ts`: `simulateAgentWork` and `runAgentLoop` own streamed model
  turns, tool-call interpretation, steering boundaries, approvals, tool observations, duplicate
  suppression, and ForgeGreen ledger collection. `executeTool` performs guarded local actions.
- `packages/workflow/src/workflow-engine.ts`: invokes ForgeVerify and `evaluateCompletion`; it is
  the authoritative workflow/completion path.
- `packages/server/src/approval-service.ts` and `user-intent-hold.ts`: own approval and durable
  steering semantics.
- `packages/sessions/src/desktop-worker-bridge.ts`: owns durable action/result idempotency and
  worker binding. `apps/cloud-api/src/hosted-workflow-authority.ts` owns owner/workflow binding.

The shared workflow/agent/verification authority remains local-runtime code; Cloud API does not
duplicate it.

## 4. Hosted execution adapter and durable continuation

Not implemented, deliberately. Introducing an adapter that simply returns a successful placeholder
would let the model continue without actual tool evidence. Holding an HTTP promise open would not
survive a process restart. R2 needs a narrow refactor in `AgentRuntime` that serializes the pending
tool call, message history, loop iteration, duplicate/FG state needed at the boundary, and a
continuation identity before dispatching a desktop action.

## 5. Worker transport and result ingestion

R2 adds authenticated desktop transport endpoints without exposing action creation:

- `GET /v1/worker/actions?workerId=...` returns only existing queued actions that belong to the
  bearer-token owner and the bound worker.
- `POST /v1/worker/actions/result` accepts only a schema-validated result for an existing action;
  `HostedWorkflowAuthority` checks owner, workflow/session, worker, state and replay semantics.

The endpoints cannot create commands, file mutations, or arbitrary worker actions. A wrong worker
is rejected; a duplicate terminal result is replayed; a cancelled workflow rejects an unrecorded
result. Result acceptance does not currently wake `AgentRuntime`, which is the R2 blocker above.

## 6. Approval, steering, ForgeVerify, ForgeGreen and completion

The existing local authority is retained and covered by focused tests, but it is not yet connected
to a hosted suspended tool turn. Therefore there is no truthful hosted approval/restart/steering
proof, no hosted ForgeVerify evidence ingestion, no hosted ForgeGreen recovery proof, and no hosted
completion-gate proof. Cloud API has no endpoint capable of client-forging completion.

## 7. Cookie audit

The prior Cloud API failure was a stale expectation. `AuthService` intentionally chooses
`__Host-codeforge-session` for HTTPS public URLs. The test now asserts the host-only cookie name,
`Secure`, `Path=/`, `HttpOnly`, `SameSite=Lax`, and absence of a `Domain` attribute. The hardened
behavior was retained; the Cloud API test passed.

## 8. Tests

Focused command passed with 9 files / 64 tests:

- Cloud API lifecycle/cookie: 11 passed.
- Hosted authority/worker transport: 4 passed.
- Shared desktop worker bridge: 2 passed.
- Approval lifecycle: 14 passed.
- Steering: 6 passed.
- AgentRuntime tool loop: 4 passed.
- Workflow ↔ AgentRuntime integration: 3 passed.
- Completion gate: 18 passed.
- ForgeVerify evidence: 6 passed.

Targeted TypeScript build for protocol, sessions, server and Cloud API passed. `git diff --check`
passed. The steering suite logged an existing best-effort event-persistence warning after a SQLite
statement was finalized; all tests passed and this increment did not touch that event lifecycle.

## 9. PostgreSQL, E2E and recovery

No real PostgreSQL hosted-runtime recovery test or hosted AgentRuntime E2E was run because the
durable continuation state required for correctness does not yet exist. SQLite-only worker bridge
tests do not certify PostgreSQL or R2 recovery.

## 10. Cloud state and repository state

Cloud SQL staging remains PostgreSQL 16 on `db-f1-micro`, 10 GB zonal SSD, no auto-growth,
deletion protection, isolated database/user and seven daily backups. Cloud Run remains undeployed.
Cloud Build remains externally permission-denied and was not retried. Production, Render,
production DNS, database, secrets and routing were untouched.

## 11. Files changed in this R2 increment

- `apps/cloud-api/src/server.ts` — owner-authenticated worker poll/result transport.
- `apps/cloud-api/test/hosted-workflow-authority.test.ts` — worker transport isolation and replay
  proof.
- `apps/cloud-api/test/cloud-api.test.ts` — stale cookie assertion replaced by host-cookie security
  assertions.
- `docs/codeforge-hosted-runtime-authority-r2-certification-report.md`
- `docs/codeforge-hosted-runtime-authority-r2-certification.json`

## 12. Smallest next implementation

Refactor the real `AgentRuntime` tool boundary into a serializable suspended-execution contract,
then have a hosted adapter mint the existing worker action and persist the continuation. On result,
rehydrate that continuation into the real tool-result observation path, not a Cloud API completion
route. Only after that can the workflow service, approval/steer flow, ForgeVerify, ForgeGreen and
completion gate be proved in a real hosted multi-action/PostgreSQL restart E2E.
