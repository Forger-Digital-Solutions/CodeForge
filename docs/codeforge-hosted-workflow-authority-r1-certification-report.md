# CodeForge hosted workflow authority R1 report

Generated: 2026-09-09

## Verdict

`CODEFORGE_HOSTED_WORKFLOW_AUTHORITY_R1_PARTIAL_DURABLE_CORE_AND_AUTHENTICATED_LIFECYCLE_IMPLEMENTED`

`CODEFORGE_GCP_CLOUD_BUILD_EXTERNAL_AUTHORIZATION_BLOCKED`

R1 is not certified. The cloud API now owns durable, authenticated hosted-workflow lifecycle state
on the same PostgreSQL-capable session-persistence contract as the worker bridge. It does not yet
compose `AgentRuntime` and `WorkflowService` into a hosted, multi-turn execution controller, so it
cannot truthfully claim hosted approval, steering, ForgeVerify, ForgeGreen, completion-gate, or
end-to-end completion parity.

## Starting repository state

- Repository: `G:\CodeForge`
- Branch and starting/ending HEAD: `feat/codeforge-cloud` / `9b40dc26c4b4baf9863da558163af756a8817f0f`
- The worktree was already materially dirty, with broad inherited tracked and untracked changes.
- Nothing was committed, and unrelated changes were preserved.

## Authority architecture

Before R1, `apps/cloud-api` owned hosted identity, account, usage, billing, inference and
publication state. The mature local chain remained separate: `CodeForgeServer` and
`WorkflowService` orchestrate sessions, `AgentRuntime` owns model/tool iterations,
`ApprovalService` and `UserIntentHoldController` own durable approvals/steering,
`ForgeVerify`/FG authority own verification evidence, and `evaluateCompletion` is the sole
completion authority.

After this increment, the desktop-worker protocol and bridge live in `@codeforge/sessions`; the
cloud service composes a `HostedWorkflowAuthority` over that same `ISessionPersistence` contract.
`CodeForgeCloudServer` initializes it before accepting traffic and closes server-owned persistence
on shutdown. This is intentionally an adapter around existing durable primitives, not a second
agent or completion engine.

## Hosted persistence and API

`hosted_workflow` records persist workflow/session identity, authenticated owner, worker and
workspace binding, monotonic revision, timestamps, terminal/blocked/cancelled state and failure
reason. The task title is persisted in the existing session record. `desktop_worker_action` records
persist immutable action identity, turn/session/workflow/worker binding, idempotency key, scoped
arguments, optional workspace revision/cancellation ID, and bounded terminal result.

Authenticated endpoints now support `POST/GET /v1/workflows`, `GET /v1/workflows/:id`, and
`POST /v1/workflows/:id/cancel`. User identity comes only from the verified bearer token; the API
does not trust a supplied owner ID. Cross-owner reads return 404. Cancellation increments the durable
workflow revision and prevents a non-terminal worker result from being accepted.

There is deliberately no public endpoint for clients to fabricate `RUN_COMMAND`, file-write or
other worker actions. Such actions must be minted by the real shared agent/workflow authority.

## Worker transport and replay safety

`DesktopWorkerBridge` is a shared durable queue, not in-memory transport. It inserts an action only
once by durable action ID, pins the request to the worker ID, returns only queued actions for that
worker, and rejects a result for a different worker. `DesktopWorkerExecutor` writes the terminal
result before returning it, so a transport loss replays the saved result rather than rerunning the
side effect. A duplicate terminal result remains a replay after the workflow returns to active;
an unrecorded result after cancellation/non-awaiting state is rejected.

There is no lease/heartbeat transport endpoint or desktop polling client installed in R1 yet. The
bridge is durable and PostgreSQL-capable, but worker authentication is currently enforced by the
owner-authenticated server composition, not a separately registered device credential.

## Workflow, approval, steering, verification and FG

Not certified for hosted execution. Returned worker results do not yet feed an `AgentRuntime` tool
observation and therefore cannot trigger another model iteration, replan, approval flow, steer,
ForgeVerify evidence, FG receipt recovery, or `evaluateCompletion`. The pre-existing local tests
continue to demonstrate those authorities locally; they are not evidence of a hosted replacement.

## PostgreSQL, recovery and hosted E2E

Not run. The authority selects `PostgresSessionPersistence` whenever Cloud API configuration uses a
PostgreSQL URL, but no secret was read or emitted and no Cloud SQL integration connection was made in
this increment. No hosted coding-agent E2E, process-restart recovery proof, or Cloud Run deployment
is claimed.

## Cloud staging status

Cloud SQL staging remains provisioned as PostgreSQL 16 (`db-f1-micro`, 10 GB SSD, zonal,
auto-growth disabled, deletion protection, isolated `codeforge` database/user, seven daily backups).
The database URL and JWT are only in Secret Manager. Cloud Run remains undeployed. The known one-off
Cloud Build submission failed with `PERMISSION_DENIED` despite the selected account appearing to have
project-owner access; it was not retried in this increment.

Production DNS, database, routing, Render, and production infrastructure were not modified.

## Tests

- `packages/server/test/desktop-worker-bridge.test.ts`: 2 passed.
- `apps/cloud-api/test/hosted-workflow-authority.test.ts`: 2 passed.
- Targeted TypeScript build for protocol, sessions and cloud API: passed.
- `git diff --check`: passed.
- Broader focused run: 34 passed, 1 inherited failure. The failure is the pre-existing
  `apps/cloud-api/test/cloud-api.test.ts` assertion expecting `codeforge-session`; the server emits
  the hardened `__Host-codeforge-session`. This increment did not modify cookie handling.

## Files changed for this increment

- `apps/cloud-api/src/hosted-workflow-authority.ts`
- `apps/cloud-api/src/server.ts`
- `apps/cloud-api/test/hosted-workflow-authority.test.ts`
- `apps/cloud-api/tsconfig.json`
- shared protocol/session bridge and state files already introduced earlier in this R1 worktree

## Smallest remaining architecture blocker

Compose `HostedWorkflowAuthority` with the existing `AgentRuntime`/`WorkflowService` through a
cloud-safe tool adapter: mint worker actions from agent tool calls, ingest durable worker results as
tool observations, and reuse the existing approval, steering, ForgeVerify, FG and completion
authorities. Then add separately authenticated desktop polling/lease semantics and a real
PostgreSQL restart/replay E2E. Cloud Build authorization is a separate live-deployment blocker.
