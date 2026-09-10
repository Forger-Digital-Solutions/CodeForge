# CodeForge hosted runtime authority R4 report

Generated: 2026-09-09

## Verdict

`CODEFORGE_HOSTED_RUNTIME_AUTHORITY_R4_CERTIFIED`

`CODEFORGE_DURABLE_AGENT_CONTINUATION_R3_CERTIFIED`

R4 now has a single hosted completion path in code:

```text
durable worker result
-> WorkflowService.resumeHostedWorkflow
-> AgentRuntime.resumeAgentContinuation
-> existing WorkflowEngine verification
-> ForgeVerify evidence and policy receipts
-> evaluateCompletion
-> durable hosted workflow final result
```

`AgentRuntime` no longer promotes a hosted tool-loop completion to session success. It persists the completed tool turn as workflow verification pending; only `WorkflowService` may record the hosted workflow terminal status after the existing engine, ForgeVerify, and completion gate return a verdict.

## Authority and durable state

- `packages/server/src/workflow-service.ts::createAgentExecutor` treats `waiting_for_worker` as non-terminal and returns a typed suspension to the engine.
- `packages/workflow/src/workflow-engine.ts` persists a bounded, serializable resume state containing the approved plan, inspected context, repository map, and pre-execution review snapshot. On recovery it skips implementation and re-enters the existing verification, review, and `evaluateCompletion` stages.
- `packages/sessions/src/session-state.ts` stores that WorkflowService-owned state on the authenticated `hosted_workflow` record, including the current continuation id and, only after authority succeeds, the final summary/status.
- `packages/server/src/workflow-service.ts::resumeHostedWorkflow` is the result-driven recovery entrypoint. A competing claimant returns `not_ready`; it cannot mark the workflow blocked merely because another graph owns the continuation lease.
- `packages/sessions/src/postgres-persistence.ts` now exposes row locking to persistence transactions. `DurableAgentContinuationStore` locks a continuation before claim/advance transitions, so PostgreSQL recovery contenders cannot both observe and advance the same row.

## Certification test

`packages/server/test/hosted-workflow-postgres-r4.test.ts` creates all-new PostgreSQL persistence, EventStore, WorkflowService, AgentRuntime, provider catalog, and provider objects across three graphs. Its intended chronology is:

```text
graph A: inspect -> durable suspension
separate DB component: persist worker result
graph B: WorkflowService recovery -> edit suspension
separate DB component: persist edit result
graph C: WorkflowService recovery -> ForgeVerify -> completion gate -> durable completed result
```

The fixture changes `add.js` only through the simulated worker boundary and uses a real `node verify.cjs` verification command. The assertion requires persisted ForgeVerify evidence and a `hosted_workflow` final status of `completed`; a model response alone cannot satisfy it.

## Validation

- TypeScript build for `packages/server`: PASS.
- Focused continuation/runtime/cloud matrix: 5 files, 21 tests: PASS.
- Targeted oxlint: PASS.
- `git diff --check`: PASS.
- `packages/server/test/hosted-workflow-postgres-r4.test.ts`, through the existing local WSL PostgreSQL harness: PASS (1/1). The test recreates graphs A/B/C, persists each worker result through a separate PostgreSQL component, resolves the existing workflow and tool approval gates, proves the competing graph returns `not_ready`, requires ForgeVerify evidence, and requires the completion gate to persist the final hosted result.
- Existing local PostgreSQL harness previously proved the repository can connect to its isolated test endpoint by running `packages/server/test/fg7-postgres-persistence.test.ts`: PASS.

The user explicitly authorized the existing WSL harness. It reached the isolated PostgreSQL endpoint and the R4 test passed. The harness did not access a production database.

No Cloud Build retry, Cloud Run deployment, production database access, or production mutation occurred.
