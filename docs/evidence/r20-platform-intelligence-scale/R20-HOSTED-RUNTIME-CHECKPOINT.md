# R20 Hosted Runtime Checkpoint

Recorded: 2026-09-20
Commit before changes: `de4f65d4366dc4bb7da5aff82eb39158adcf0a83`
Spend: `$0`
Environment: local WSL Ubuntu PostgreSQL 16, dedicated `codeforge_test_db`, test-only user `codeforge_test`; no production or Supabase access

## PostgreSQL Environment

The repository's own `postgres-test-harness.mjs` started and verified the isolated PostgreSQL endpoint at `127.0.0.1:5432/codeforge_test_db`. The reused test database initially failed closed on an immutable migration-008 checksum mismatch. With explicit owner approval, only that test database was dropped and recreated. The mismatched database was not silently rewritten.

Fresh migration, reconnect, account erasure, migration namespace, two-client authority, adversarial concurrency, workflow restart, evidence persistence, and 8-Bit PostgreSQL suites then executed against real PostgreSQL.

Final certification run: **13 files passed, 85 tests passed, 0 failed, 0 skipped, 0 unhandled errors**.

## Migration Proof

Fresh PostgreSQL initialized every cloud migration through migration 011. Migration 010 remains unchanged. Migration 011 adds the partial fair-queue head index used by the optimized PostgreSQL query. Existing migration namespace and legacy adoption tests passed.

A stale test assertion claiming sessions had one migration was corrected to compare against `SESSIONS_MIGRATIONS.length`; sessions currently has three immutable migrations.

## Query Plans

`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` was captured in `03-managed-free/results/postgres-admission-benchmark.json`.

Before optimization, the 10k fair claim plan executed in **402.782 ms**. It scanned 10,000 queued rows and repeatedly checked each user's queue head. The other authority queries were already inexpensive:

- idempotency lookup: 0.125 ms
- stale lease scan: 0.030 ms
- receipt lookup: 0.114 ms
- active route count: 0.079 ms

The per-user-head CTE plus migration-011 partial index reduced fair-claim plan execution to **29.827 ms**, a **92.6% reduction**. The optimized peripheral queries remained between 0.024 and 0.090 ms.

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

The existing `/v1/hosted/inference` endpoint still dispatches directly through `GatewayService`. Durable queue HTTP submission, persisted request payloads/results, and stream reconnection are not implemented. Therefore HTTP durable admission remains NOT CERTIFIED.

## Queue Worker

`HostedQueueWorker` now bridges durable claim, dispatch transition, execution callback, heartbeat, terminal completion, failure release, and local cancellation propagation. Deterministic tests prove completed execution, queued cancellation with zero provider calls, running cancellation preservation, and provider failure release.

The worker is a production package component, not benchmark code. It is not yet composed into `CodeForgeCloudServer`, so the runtime gate remains partial.

## Idempotency

Database enqueue and completion idempotency remain certified locally and passed real PostgreSQL reconnect tests. Cross-user idempotency reuse remains rejected. End-to-end HTTP retry proof remains outstanding.

## Cancellation

Covered through the queue worker:

- queued cancellation: no claim and zero provider calls
- running cancellation: active abort signal propagated; durable terminal state remains cancelled
- provider failure: one failed transition and capacity release

Not covered: remote worker cancellation notification, retry-backoff cancellation, provider-specific cancellation receipts, or subagent child propagation.

## Subagent Reconciliation

No new hosted parent/child queue linkage was added. Subagent child reconciliation remains NOT CERTIFIED.

## Lease Recovery

Real PostgreSQL proves idempotent enqueue across reconnect, expired pre-dispatch reclaim, and dispatched ambiguity moving to `recovery_pending`. The queue worker heartbeats while active. Multi-process abrupt-kill recovery remains to be exercised with the worker component.

## Process Recovery

Existing real PostgreSQL CF-17 spawned-process restart proof passed. R20's separate 20-process admission race passed. A full kill/restart of the new queue worker during execution is still missing.

## DB Failure

Admission fails closed if PostgreSQL claim/enqueue fails, and no in-memory admission fallback exists. Real DB-down-during-enqueue/claim/completion campaigns and bounded transaction retry metrics remain missing.

## Chaos

New real PostgreSQL coverage includes migration integrity failure, connection/pool concurrency, 100-claimer route race, reconnect recovery, stale lease ambiguity, and separate-process contention. Provider+DB combined chaos remains partial.

## Performance

Real PostgreSQL measurements include network, transaction, lock, lease, receipt and completion work:

| Queue | Claim median | Claim p95 |
|---:|---:|---:|
| 10 | 35.320 ms | 45.465 ms |
| 100 | 23.379 ms | 30.899 ms |
| 1,000 | 27.901 ms | 36.150 ms |
| 10,000 | 47.659 ms | 87.657 ms |

Before the fair-head optimization, the 10k median/p95 were 278.268/395.382 ms. The optimized p95 is **77.8% lower**. PostgreSQL remains slower than in-memory SQLite, as expected, but the 10k query no longer has the original 400 ms plan bottleneck.

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
| POSTGRESQL MIGRATION | CERTIFIED locally through migration 011 |
| DURABLE CAPACITY LEDGER | CERTIFIED on isolated PostgreSQL |
| DB-BACKED RESERVATIONS | CERTIFIED on isolated PostgreSQL |
| MULTI-PROCESS ADMISSION | CERTIFIED locally: 20 processes |
| PROVIDER CAPACITY CEILING | CERTIFIED: 4/4, zero oversubscription after P1 fix |
| PER-USER FAIRNESS | CERTIFIED on real PostgreSQL |
| HTTP DURABLE ADMISSION | NOT CERTIFIED |
| QUEUE WORKER | PARTIAL |
| IDEMPOTENCY | CERTIFIED at DB/worker layer; HTTP pending |
| CANCELLATION RECONCILIATION | PARTIAL |
| SUBAGENT CHILD RECONCILIATION | NOT CERTIFIED |
| STALE LEASE RECOVERY | CERTIFIED on real PostgreSQL |
| PROCESS RESTART RECOVERY | PARTIAL |
| DB FAILURE SAFETY | NOT CERTIFIED |
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

Persist bounded encrypted hosted request payloads/results in a new immutable migration, compose `HostedQueueWorker` into the cloud server, add authenticated enqueue/status/cancel transport, and prove HTTP retry/cancellation and abrupt worker-kill recovery before any live Managed Free recertification.
