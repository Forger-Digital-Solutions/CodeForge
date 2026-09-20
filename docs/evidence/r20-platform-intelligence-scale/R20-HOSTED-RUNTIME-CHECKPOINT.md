# R20 Hosted Runtime Checkpoint

Recorded: 2026-09-20 (updated same day after durable HTTP runtime certification work)
Commit before changes: `de4f65d4366dc4bb7da5aff82eb39158adcf0a83`
Spend: `$0`
Environment: local WSL Ubuntu PostgreSQL 16, dedicated `codeforge_test_db`, test-only user `codeforge_test`; no production or Supabase access

## PostgreSQL Environment

The repository's own `postgres-test-harness.mjs` started and verified the isolated PostgreSQL endpoint at `127.0.0.1:5432/codeforge_test_db`. The reused test database initially failed closed on an immutable migration-008 checksum mismatch. With explicit owner approval, only that test database was dropped and recreated. The mismatched database was not silently rewritten.

Fresh migration, reconnect, account erasure, migration namespace, two-client authority, adversarial concurrency, workflow restart, evidence persistence, and 8-Bit PostgreSQL suites then executed against real PostgreSQL.

Final certification run: **13 files passed, 87 tests passed, 0 failed, 0 skipped, 0 unhandled errors** after provider-scoped claiming and adversarial fixture uniquification.

## Migration Proof

Fresh PostgreSQL initialized every cloud migration through migration 012. Migration 010 remains unchanged. Migration 011 adds the partial fair-queue head index. Migration 012 adds persisted request/result payloads, terminal error, dispatch/terminal timestamps, parent/root execution linkage, and the lease fencing token. Existing migration namespace and legacy adoption tests passed.

A stale test assertion claiming sessions had one migration was corrected to compare against `SESSIONS_MIGRATIONS.length`; sessions currently has three immutable migrations.

## Query Plans

`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` was captured in `03-managed-free/results/postgres-admission-benchmark.json`.

Before optimization, the 10k fair claim plan executed in **402.782 ms**. It scanned 10,000 queued rows and repeatedly checked each user's queue head. The other authority queries were already inexpensive:

- idempotency lookup: 0.125 ms
- stale lease scan: 0.030 ms
- receipt lookup: 0.114 ms
- active route count: 0.079 ms

The per-user-head CTE plus migration-011 partial index reduced fair-claim plan execution to **29.827 ms**, a **92.6% reduction**. The optimized peripheral queries remained between 0.024 and 0.090 ms.

After capability-scoped claiming (`providerIds` filter inside the fair-head CTE) and migration-012 payload columns, the same plan measures **112.89 ms** at a ~10.4k-row queue on the accumulated shared test database (≈23k total rows). The scope filter is applied inside `user_heads` so an unclaimable queued head cannot hide a user's claimable work. Absolute claim latency remains sub-second per admission; no paid capacity was added.

## Multi-Process Admission

Twenty independent Node.js worker processes, each with its own PostgreSQL pool and worker identity, raced over 100 queued executions. Provider capacity was four.

- route claims: 4
- distinct executions: 4
- observed oversubscription: 0
- verdict: PASS

Evidence: `03-managed-free/results/postgres-multiprocess-admission.json`.

## Capacity Ceiling

The first real PostgreSQL 100-claimer test exposed a P1 race: five leases were admitted against capacity four. PostgreSQL evaluated the correlated count before waiting on the provider row lock and did not re-evaluate it afterward.

The fix adds a route-scoped transaction advisory lock, locks the provider-capacity row, and rechecks route and user active leases inside the serialized critical section. The retained 100-claimer regression now admits exactly four current-route leases.

## Fairness

Real PostgreSQL used independent connections and the durable fair-user cursor. User A queued 50 tasks and Users B-T queued one each. The first 20 completed admissions served 20 distinct users. No normal user was starved before User A's second turn.

## HTTP Integration

`/v1/hosted/inference` now durably persists the normalized request payload, resolves and freezes the ForgeZero-approved route, seeds a route capacity row only when none exists (`ensureHostedProviderCapacity` never overwrites operator ceilings), and admits through the database authority. No provider call happens in the request handler.

Wire contract is preserved: SSE clients receive a replay of the persisted event stream after terminalization, and disconnect cancels the execution. `Accept: application/json` returns an async handle for polling. Owner-scoped endpoints added:

- `GET /v1/hosted/executions` — owner list
- `GET /v1/hosted/executions/:id` — status with `resultError`
- `GET /v1/hosted/executions/:id/result` — result payload/error, `409` while nonterminal
- `POST /v1/hosted/executions/:id/cancel` — cancel with cascade report
- `POST /v1/hosted/executions/:id/children` and `GET /v1/hosted/executions/:id/children` — parent/child fan-out

`requestId` is the HTTP idempotency key; a retried submit returns the same durable execution.

Evidence: `apps/cloud-api/test/hosted-executions.test.ts`, 13 tests passing — durable enqueue/result, idempotent replay, cross-user isolation, queued and dispatching cancellation, capacity ceiling under HTTP burst, enqueue/completion/heartbeat DB-failure injection, restart recovery, hard-stop quarantine recovery, parent/child fan-out with root inheritance and cross-user fencing, and cascading parent cancellation.

## Queue Worker

`HostedQueueWorker` is composed into `CodeForgeCloudServer` via `HostedRuntime`. It claims, fences dispatch with the claim's lease token, heartbeats, executes through `GatewayService.executePersisted` (which re-validates the persisted request against the live ForgeZero catalog), terminalizes exactly once, and aborts in-flight work on cancellation or shutdown.

Claims are capability-scoped: the worker passes its provider catalog IDs, so a server cannot claim — and wrongly terminalize — an execution for a route it cannot execute. This was a real defect found by the shared-database adversarial run: unscoped workers claimed foreign test executions and failed 419 of them. After the fix, the full real-PostgreSQL suite is green with zero cross-catalog terminalization.

## Idempotency

Database enqueue and completion idempotency remain certified locally and passed real PostgreSQL reconnect tests. Cross-user idempotency reuse remains rejected. HTTP retry proof now exists: a repeated `POST /v1/hosted/inference` with the same `requestId` returns the same execution (`created: false`), and idempotent child enqueue under a parent suppresses duplicates.

## Cancellation

Covered end-to-end:

- queued cancellation over HTTP: no claim and zero provider calls
- running cancellation: active abort signal propagated; durable terminal state remains cancelled
- provider failure: one failed transition and capacity release
- client disconnect on an SSE stream cancels the execution
- parent cancellation cascades to all nonterminal descendants; queued children never invoke a provider
- cross-user cancellation returns owner-isolated not-found

Not covered: remote worker cancellation notification across separate OS processes (same-database cancellation is honored on the next worker tick), provider-specific cancellation receipts.

## Subagent Reconciliation

Parent/child linkage is durable (`parent_execution_id`, `root_execution_id` via migration 012) and reachable over HTTP. Proven: child enqueue under an authenticated nonterminal parent, child idempotency, root inheritance across a three-level tree, cross-user parent fencing (404), terminal-parent rejection (409), and cascading cancellation of queued children without provider calls. Per-task fan-out budgets are not yet enforced.

## Lease Recovery

Real PostgreSQL proves idempotent enqueue across reconnect, expired pre-dispatch reclaim, and dispatched ambiguity moving to `recovery_pending`. The queue worker heartbeats while active. Completion and heartbeat are both fenced by the claim's lease token: a stale worker cannot dispatch, renew, or terminalize after its lease was reclaimed.

## Process Recovery

Proven at HTTP level: a queued execution survives a full `CodeForgeCloudServer` restart and is claimed and completed by the second process. A hard stop during dispatch quarantines the execution to `recovery_pending`; a restarted runtime terminalizes it exactly once with an honest ambiguity error and never re-invokes the provider.

## DB Failure

Proven by injection: durable enqueue failure produces no execution and no provider call; a completion-write failure quarantines/recovers the work without re-execution; a heartbeat-write failure aborts the in-flight dispatch, fences the dead lease, and recovery terminalizes once. The repo-level outage test confirms a cloud whose database is unavailable rejects hosted inference, invokes no provider, and leaves Direct/BYOK paths working.

## Chaos

Real PostgreSQL coverage includes migration integrity failure, connection/pool concurrency, 100-claimer route race, reconnect recovery, stale lease ambiguity, and separate-process contention. HTTP-level coverage adds enqueue/completion/heartbeat write failure, server restart, hard stop mid-dispatch, and shared-database cross-catalog contention (fixed by capability-scoped claiming). Provider+DB combined chaos and clock skew across hosts remain partial.

## Performance

Real PostgreSQL measurements include network, transaction, lock, lease, receipt and completion work:

| Queue | Claim median | Claim p95 |
|---:|---:|---:|
| 10 | 22.055 ms | 39.336 ms |
| 100 | 44.494 ms | 59.283 ms |
| 1,000 | 45.819 ms | 61.703 ms |
| 10,000 | 131.322 ms | 148.190 ms |

Before the fair-head optimization, the 10k median/p95 were 278.268/395.382 ms. The current numbers are measured with the capability-scope filter active on the accumulated shared test database (≈23k rows, ~10.4k queued during the 10k sample); they are higher than the previous clean-table run (47.659/87.657 ms) but remain well below the pre-optimization baseline and are per-admission costs amortized over multi-second provider calls.

## Security

- SQL paths remain parameterized.
- Queue identifiers are bounded to schema-sized printable values before insertion.
- Cross-user execution, cancellation, receipt, and idempotency tests remain green.
- Account erasure passed against real PostgreSQL.
- Capacity mutation has no public user endpoint.
- Metrics contain fixture IDs, not prompts or source code.

## Metadata Growth Forecast

Expected 373-DAU assumptions produce about 746 tasks/day and a 1.35 request multiplier, or roughly 1,007 execution attempts/day. At one queue row, one lease, approximately four receipts, and one usage event per attempt, this is approximately 7,049 metadata rows/day, 211,000 rows/30 days, and 2.57 million rows/year before retries and subagent-heavy variance. This is an order-of-magnitude planning estimate, not a storage-byte claim. Terminal-row and receipt retention policy remains required.

## ForgeGreen Hosted A/B

Not run through the real durable worker path. Verdict remains NOT CERTIFIED.

## Subagent Topology

No hosted T0-T5 campaign was run. The inherited negative team baseline remains authoritative. Verdict remains IMPROVED, not certified.

## 8-Bit Shadow

The prior 8/8 rule baseline remains valid, but no production mutation is enabled. Hosted PostgreSQL metrics are not yet converted into 8-Bit shadow recommendations. Verdict remains PARTIAL.

## Managed Free Candidate Status

Public Managed Free routes certified: **0**. PostgreSQL and scheduler certification do not certify provider supply.

## Browser

No dedicated Browser surface was added. Verdict: NOT CERTIFIED.

## Signing

No production certificate was acquired or used. Pipeline work remains partial. Production signed release: OWNER ACTION REQUIRED.

## Spend

`$0`. No paid inference, deployment, production database, production secret, certificate purchase, credit deposit, or push occurred.

## Verdicts

| Gate | Verdict |
|---|---|
| POSTGRESQL MIGRATION | CERTIFIED locally through migration 012 |
| DURABLE CAPACITY LEDGER | CERTIFIED on isolated PostgreSQL |
| DB-BACKED RESERVATIONS | CERTIFIED on isolated PostgreSQL |
| MULTI-PROCESS ADMISSION | CERTIFIED locally: 20 processes |
| PROVIDER CAPACITY CEILING | CERTIFIED: 4/4, zero oversubscription after P1 fix |
| PER-USER FAIRNESS | CERTIFIED on real PostgreSQL |
| HTTP DURABLE ADMISSION | CERTIFIED locally: durable enqueue + SSE/JSON + owner isolation |
| QUEUE WORKER | CERTIFIED locally: composed, capability-scoped, fenced |
| IDEMPOTENCY | CERTIFIED: DB, worker, and HTTP retry replay |
| CANCELLATION RECONCILIATION | CERTIFIED locally incl. parent cascade; cross-process remote signal PARTIAL |
| SUBAGENT CHILD RECONCILIATION | CERTIFIED locally over HTTP: fan-out, idempotency, fencing, cascade; fan-out budgets pending |
| STALE LEASE RECOVERY | CERTIFIED on real PostgreSQL |
| PROCESS RESTART RECOVERY | CERTIFIED locally: queued restart + hard-stop quarantine |
| DB FAILURE SAFETY | CERTIFIED locally: enqueue/completion/heartbeat injection + outage suite |
| HOSTED CHAOS | PARTIAL |
| FORGEGREEN HOSTED A/B | NOT CERTIFIED |
| SUBAGENT TOPOLOGY INTELLIGENCE | IMPROVED |
| 8-BIT HOSTED SHADOW | PARTIAL |
| PUBLIC MANAGED FREE ROUTES | 0 |
| BROWSER | NOT CERTIFIED |
| SIGNING PIPELINE | PARTIAL |
| PRODUCTION SIGNED RELEASE | OWNER ACTION REQUIRED |
| R20 SPEND | $0 |

## Next Step

The durable hosted path is now proven end-to-end on real PostgreSQL with process restart, hard-stop quarantine, DB-failure injection, capability-scoped claiming, and parent/child fan-out. Remaining before any live Managed Free recertification: per-task fan-out budgets, cross-process remote cancellation signalling, provider+DB combined chaos, clock-skew tolerance, terminal-row/receipt retention policy, and the deferred workstreams (ForgeGreen hosted A/B, 8-Bit shadow on hosted metrics, T0–T5 topology campaigns, browser surface, signing). None of those may be certified without evidence.
