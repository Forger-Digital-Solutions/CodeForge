# R35 Missions E/F/G — tool authority, idempotency, permission adversarial

## Canonical tool-authority registry (Mission F)

`packages/tools/src/index.ts` — `BUILT_IN_TOOL_DEFINITIONS` is the single registry.
Every entry declares the authority triple:

- `requiredPermission: keyof AgentPermissions` — permission gate
- `readOnly: boolean` — read-only-role ceiling
- `executionClass: "read" | "write" | "command" | "repo" | "checkpoint" | "network"` — drives durable-ledger recovery classification

Enforcement is defense-in-depth:

1. `ToolRegistry.getForRole(role, permissions)` filters the advertised schema —
   explorer/reviewer/planner/mission-planner/replanner never see mutating tools.
2. `ToolBroker.executeTool` re-checks at dispatch (TOOLS cannot be invoked by name
   alone): unknown → `TOOL_UNKNOWN`, bad args → `TOOL_ARGUMENT_INVALID`,
   read-only role + mutating tool → `TOOL_PERMISSION_DENIED`, missing permission
   → `TOOL_PERMISSION_DENIED`, sensitive path → `TOOL_SENSITIVE_PATH_DENIED`.

New invariant test `packages/tools/test/registry-authority.test.ts` (5 tests):
authority-triple completeness, readOnly↔executionClass agreement, deny-all with
zero permissions, deny-mutating for every read-only role even with full
permissions, and advertised-set ≡ executable-set.

## Permission adversarial (Mission G)

| Edge | Proof |
|---|---|
| Read-only role dispatch-denied even with broad permissions | `role-boundary.test.ts`, `registry-authority.test.ts` |
| Path traversal out of workspace | `agent-security.test.ts` (`TOOL_PATH_ESCAPE`) |
| Sensitive env never leaks into children | `agent-security.test.ts`, `getSanitizedEnvForChild` |
| Denied command produces no durable record / no side effect | `r21-autonomous-command-gate.test.ts` |
| Parallel worktrees confined; reviewer roles stay read-only | `parallel-security.test.ts` |
| Child permissions ⊆ parent permissions (intersection) | `subagent-manager.ts:302-308`, `subagents.test.ts` |
| Depth limit `SUBAGENT_DEPTH_EXCEEDED` | `subagents.test.ts` |
| Cancellation propagates parent→child | `subagents.test.ts`, `parallel-cancellation.test.ts` |
| Approval records are turn-scoped; `cancelForTurn` only touches the owning turn | `approval-service.ts`, `codex-approval-bridge.test.ts` |
| Decision persisted before the resolver unblocks the tool continuation | `agent-runtime.ts` `resolveApproval` — durable before resolve |

## Side-effect idempotency (Mission E)

Durable tool ledger (`agent_tool_execution` work items) writes `requested` →
`started` *before dispatch* → `completed|failed` → `observation_recorded`.
`classifyToolRecovery` maps interrupted state×class to dispositions:
`requested`→`safe_to_retry`, `started`+read→`safe_to_retry`,
`started`+write→`requires_revalidation`, `started`+command→`unknown_side_effect`,
`observation_recorded`→`already_completed`. Recovery reclassifies and requires a
fresh plan (`replan_required`); it never replays a tool continuation.

Duplicate dispatch inside a live run is separately guarded by
`DuplicateActionSupervisor` + `replayIds` dedupe in the agent loop
(`agent-runtime.ts:1785-1868` — replayed/duplicate calls reuse the recorded
result instead of re-executing).
