# R35 — error taxonomy, retry/timeout policy, config validation, flags

## Error taxonomy (Mission AF)

`packages/server/src/run-failure.ts` is the single classifier. `describeRunFailure`
maps every `ERROR_CODES` entry and provider error shape to a `RunFailure` =
`{ code, ownership, retryable, message }`:

- paid refusal codes (`REQUIRES_SUBSCRIPTION`, `NOT_ENTITLED`, `FORGE_ZERO_VIOLATION`,
  `UNKNOWN_COST_REJECTED`, `PAID_FALLBACK_REJECTED`) → `paid_plan_required`,
  `ownership: "paid"`, **never retryable** — the failure says "did not run", not "retry".
- transient provider codes → `provider_outage` / `model_unavailable` /
  `provider_rate_limited` / `provider_capacity`, retryable.
- agent governance (`AGENT_NO_PROGRESS_DETECTED`, `AGENT_TOOL_LOOP_DETECTED`,
  `AGENT_CONTEXT_BUDGET_EXCEEDED`, `AGENT_MODEL_TURN_LIMIT`, `AGENT_TOOL_LIMIT`)
  → honest user-facing messages ("the work is unfinished", never success).
- workspace/safety codes (`TOOL_WORKSPACE_ESCAPE`, `TOOL_PATH_ESCAPE`,
  `TOOL_PERMISSION_DENIED`, `TOOL_SENSITIVE_PATH_DENIED`) → non-retryable refusals.
- cancel → `ownership: "user"`, "Stopped by you".

The `run.outcome` event carries this structure; `run-failure.test.ts` +
`describeWorkflowOutcome` cover classification edges (capacity waits, timeouts,
budget exhaustion, stale revision).

## Retry policy (Mission AG)

Retries are capacity decisions, not blind loops:

- Model-turn failures feed the route-health authority
  (`recordRouteFailure(providerId, modelId, reason, retryAfterMs)`) — the
  provider's own `Retry-After`/`x-ratelimit-reset` sets the cooldown TTL, never a
  synthetic guess (`route-health-wiring.test.ts`).
- 8-Bit escalation is bounded: `retry_same` (capped) → `rotate` → `surface`;
  exact-pinned routes never silently substitute (`eight-bit-restart-and-
  exact-pin.test.ts`).
- Duplicate dispatch inside a live run is suppressed by
  `DuplicateActionSupervisor` + `replayIds` — a re-emitted tool call reuses the
  recorded result.
- Crash recovery never blind-retries a side-effecting tool: `started`+command
  → `unknown_side_effect`, `started`+write → `requires_revalidation` — the
  replan sees the disposition and re-decides from durable facts
  (`run-recovery.test.ts`: RESUME/REPLAN/CANCELLATION/LEASE rows).

## Timeout policy (Mission AI)

| Layer | Timeout |
|---|---|
| approvals | `DEFAULT_APPROVAL_TIMEOUT_MS` (runtime), 5 min (workflow service) |
| workflow working budget | `workingBudgetMs` re-armed per phase |
| commands | executor timeout → exit 124, tree-kill, 10× no-EPERM proven |
| capacity wait | poll interval `capacityWaitPollMs`, cancellable |
| tool | `timeoutMs` in tool defs (60 s command, 8 s read) |
| abort | `AbortSignal` threads every dispatch; pre-aborted signals never spawn |

## Config validation (Mission AO)

- `host`/`CODEFORGE_BIND_HOST`: non-loopback without `controlPlaneToken` →
  `start()` throws (new in R35, test in release-status.test.ts).
- `port`: bind errors surface as start() rejection (no Electron dialog).
- `dbPath`/`databaseUrl`/`databaseDriver`: postgres vs sqlite driver selection;
  `:memory:` supported for tests.
- `controlPlaneToken`: when set, required on every route except `/api/health`;
  compared via `crypto.timingSafeEqual`.

## Flags (Mission AN)

- `CODEFORGE_PAID_EXECUTION_ENABLED` — gates only the PaidAuto *execution*
  switch; the free-only server still 409s paid model selection
  (`PAID_AUTO_BLOCKED_BY_FREE_ONLY_POLICY`), and a route needs all four
  qualifications CERTIFIED plus a closed circuit before `routeCanExecute`.
  Flag ≠ bypass.
- `CODEFORGE_OPENROUTER_FALLBACK_ENABLED` — same layered qualification.
- `CODEFORGE_SUBAGENTS_R1`, `CODEFORGE_REAL_RUNTIME`, `CODEFORGE_FORGREEN`,
  `CODEFORGE_REPOSITORY_INDEX_ROOT`, `CODEFORGE_CLOUD_API_URL`,
  `CODEFORGE_CLOUD_TOKEN` — all boolean/URL toggles; none weaken ForgeZero,
  the completion gate, or permission checks.

## Dead paths (Mission AM)

- `waiting_for_question` — declared TurnStatus, restored by recovery, exited by
  `resolveQuestion`, counted by `getActiveTurns`; no live creation path exists
  today. Kept deliberately: persisted records may carry it and removal would
  strand restorable state. Documented in R35-TASK-STATE-MACHINE.md.
- `waiting_for_worker` — consumed by hosted-worker dispatch + recovery.
- Reserved-but-unemitted TaskStatuses (`decomposition`, `routing`,
  `waiting_for_free_model`, `quota_exhausted`) are API vocabulary, not dead
  state — they're in `RESERVED_TASK_STATUSES` so a future emitter must map to
  them rather than invent new names.
