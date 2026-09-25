# R35 Missions A/B — control-plane map + canonical task state machine

## Control plane (audited)

```
desktop renderer ──(bearer x-codeforge-control-token, loopback only)──▶ CodeForgeServer (packages/server/src/index.ts)
  ├─ /api/send ──▶ session+turn creation ──▶ AgentRuntime.startTurn ──▶ EightBitRouter/FreeFabric admission
  │      └─▶ runAgentLoop ──▶ gated tool dispatch (TaskAuthority) ──▶ persistence writes ──▶ EventStore (seq)
  ├─ /api/workflows ──▶ WorkflowService ──▶ WorkflowEngine phases ──▶ internal turns via same AgentRuntime
  └─ /api/events (SSE) ◀── sequenced EventStore (persisted + hydrated)
```

Authorities per transition (all backend, none renderer-only):
- admission: `CapacityReservationLedger` / FreeFabric — `eight-bit/free-fabric.ts`
- action authorization: `TaskAuthority` — `packages/permissions` (deterministic tiers, receipts)
- completion: `evaluateCompletion` — `packages/workflow/src/completion-gate.ts` (pure, model output cannot influence)
- turn lifecycle: `AgentRuntime` persisted via `ISessionPersistence` (turns, work items, durable continuation)
- event ordering: `EventStore` seq — `packages/sessions/src/event-store.ts`

## Three status vocabularies reconciled

| Layer | Type | Cardinality | Home |
|---|---|---|---|
| turn execution | `TurnStatus` | 12 | `agent-runtime.ts` |
| workflow engine | `WorkflowPhase` | 16 | `workflow/types.ts` |
| API surface | `TaskStatus` | 19 | `protocol/api.ts` |
| session record | `SessionStatus` | 10 | `protocol/workspace-state.ts` |

`packages/server/src/turn-state-machine.ts` now owns the canonical graph:
`TURN_TRANSITIONS`, `TERMINAL_TURN_STATUSES`, `WAITING_TURN_STATUSES`,
`RESTORABLE_TURN_STATUSES`, and the total `WORKFLOW_PHASE_TO_TASK_STATUS` map
(`taskStatusForPhase` throws on an unmapped phase instead of emitting a raw phase
name as a TaskStatus — a latent contract defect under the old `statusMap[phase] ?? phase`).

Reserved-but-unemitted TaskStatus values (`decomposition`, `routing`,
`waiting_for_free_model`, `quota_exhausted`) are documented API vocabulary.
`waiting_for_question` is a dormant-but-restorable state: no live path creates a
question work item today, but persisted records may carry it and recovery must
keep restoring it — kept deliberately.

## Defect found and fixed

`cancelTurn` mutated `state.status = "cancelled"` *before* reading it for the
transition event, emitting `cancelled → cancelled` (a self-loop), and would
overwrite a terminal `completed`/`failed` turn with `cancelled` on a late Stop.
Now: terminal turns are terminal (late cancel is a no-op after abort/approval
cleanup), and the emitted edge is the true `previousStatus → cancelled`.

## Test

`packages/server/test/turn-state-machine.test.ts` — 7 tests: graph closure,
terminal absorption, cancel reachability, every literal `emitStatusChanged`
call-site legality (agent-runtime, workflow-service, autonomous-orchestrator,
demo-runtime), total phase→status mapping, restorable-set agreement with the
recovery normalizer, and wait-state persistence coverage.
