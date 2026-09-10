# CodeForge AI coding-agent core assessment

Generated: 2026-09-09

## Verdict

`CODEFORGE_AI_AGENT_CORE_MATERIALLY_ADVANCED_HOSTED_WORKER_WIRING_REMAINS`

`CODEFORGE_HOSTED_WORKFLOW_AUTHORITY_NOT_CERTIFIED`

`CODEFORGE_DISTRIBUTED_AGENT_RECOVERY_NOT_CERTIFIED`

`CODEFORGE_PROVIDER_RESILIENCE_FUNCTIONAL_NEEDS_HOSTED_E2E`

## Authority chain

The local authority chain is coherent: `CodeForgeServer` owns session persistence and route entry,
`AgentRuntime` owns the model/tool loop, `WorkflowService` owns workflow orchestration,
`ForgeVerify` and ForgeGreen provide evidence/coverage, and `evaluateCompletion` is the sole
completion authority. `ApprovalService` and `UserIntentHoldController` provide durable approval and
steering boundaries. The model cannot independently mark a run complete.

## Capability audit

| Area | Current classification | Evidence / remaining gap |
| --- | --- | --- |
| Repository understanding | FUNCTIONAL_NEEDS_HARDENING | Repository intelligence, bounded search, package-aware tests, git status and workspace guards exist. Real large-repository acceptance remains unrun. |
| Planning and replanning | FUNCTIONAL_NEEDS_HARDENING | Agent tool loop, mission supervisor, steering-driven revision, and recovery-to-replan exist. No real-provider acceptance run in this milestone. |
| Files and commands | FUNCTIONAL_NEEDS_HARDENING | Path containment, atomic writes, command classification, bounded output, timeout and process-tree cancellation exist. |
| Approvals and steering | FUNCTIONAL_NEEDS_HARDENING | Approval service, durable queued steering, user-intent hold, and restart recovery are implemented and covered by existing focused tests. |
| Provider runtime | FUNCTIONAL_NEEDS_HARDENING | Provider adapters, ForgeZero, 8-Bit route state, and ForgeAuto selection are separated. Hosted fallback E2E remains. |
| Verification and completion | PRODUCTION_READY | ForgeVerify, FG-7 coverage authority, stale rejection, durable evidence and completion gate are already certified. |
| Desktop-hosted execution | PARTIAL | A durable worker protocol and replay-safe action bridge now exist; Cloud API endpoints and desktop transport wiring remain. |
| Hosted workflow persistence | MISSING | `apps/cloud-api` still does not compose the workflow authority and session persistence. |

## Desktop-worker protocol

`DesktopWorkerActionRequest` carries immutable action/workflow/turn/session/worker identities,
idempotency key, action type, scoped arguments, expected workspace revision, and cancellation ID.
Results carry terminal status, bounded output, exit status, workspace revision, and changed resources.

`DesktopWorkerBridge` persists requests before delivery. An action is pinned to its authenticated
worker and cannot be completed by another worker. `DesktopWorkerExecutor` persists a terminal result
before it is delivered, so a transport disconnect does not re-run a write or command.

## Hosted boundary

The cloud service must own durable workflow, plan, evidence, approval, steering, and action records.
The desktop worker must own local filesystem, shell, local git, and IDE actions. Cloud Run must never
receive an arbitrary local path to execute directly. The new bridge is the shared primitive; it is not
yet exposed by `apps/cloud-api`, so this report does not claim hosted recovery certification.

## Validation

- Desktop-worker bridge: 2 tests passed.
- Agent recovery: 5 tests passed.
- Agent tool loop/recovery: 4 tests passed.
- Focused TypeScript build for protocol, sessions, and server: passed.
- `git diff --check`: passed.

## Next milestone

Compose the existing session/workflow persistence and desktop-worker bridge into a single authenticated
Cloud Run authority API, then add desktop polling/SSE transport and run the real Cloud Run replacement
test against Cloud SQL.
