# R20 Hosted Admission Checkpoint

Recorded: 2026-09-20
Source anchor: `8bce13c87c888fefa2f52ecf3c2117afced45c63` plus uncommitted R20 changes
Spend: `$0`
Environment: local in-memory SQLite plus deterministic tests; PostgreSQL implementation compiled but live PostgreSQL tests were environment-skipped

## Architecture

R20 adds a durable hosted admission authority to the existing cloud database and gateway packages. The benchmark scheduler remains evaluation-only. ForgeZero remains the Free cost-eligibility authority; hosted admission allocates only a route already selected and approved by the caller.

The authority uses at-least-once queue delivery with database idempotency, durable leases and transition receipts. It does not claim distributed exactly-once provider execution. A request that was dispatched before its lease was lost moves to `recovery_pending` and is not automatically dispatched again.

## DB Schema / Authority

Immutable cloud migration 010 adds:

- `hosted_executions`: durable queue item, user/task/route ownership, idempotency key, status, eligibility time, attempt and lease projection.
- `hosted_provider_capacity`: authoritative route concurrency ceiling.
- `hosted_capacity_leases`: provider/user execution slots with worker ownership, expiry and release state.
- `hosted_user_admission_state`: durable fair-rotation cursor per user.
- `hosted_admission_receipts`: append-only lifecycle receipts without prompt/code content.

Indexes cover idempotency, fair queue selection, user/status lookup, lease expiry, active route leases, active user leases and receipt history.

SQLite executes claims inside one immediate local transaction. PostgreSQL uses transactions, row locks and `FOR UPDATE ... SKIP LOCKED`; the provider-capacity row is locked with the selected execution so concurrent workers cannot independently admit above the same route ceiling.

## Multi-Instance Behavior

Three `HostedAdmissionAuthority` instances sharing one database claimed three distinct executions under a route ceiling of three. A 100-worker local race against route capacity four produced exactly four active leases and never exceeded four.

This proves database-mediated coordination in local SQLite tests. Real multi-process PostgreSQL proof remains blocked because no disposable PostgreSQL environment was available; PostgreSQL-specific suites were skipped rather than represented as passed.

## Idempotency

`idempotency_key` has a database unique constraint. Duplicate enqueue returns the authoritative existing execution and writes `DUPLICATE_SUPPRESSED`. Reuse by a different authenticated user is rejected. Completion and lease release are idempotent: only the first terminal transition releases the active slot.

Usage accounting retains the pre-existing independent `request_id` uniqueness and atomic reserve/settle behavior. The affected cloud usage suites passed.

## Reservations

Provider and user capacity are reserved in the same transaction that claims an execution. Each lease records execution, user, route, worker, expiry, state and release reason. Active execution leases have a partial unique index. Capacity reductions affect new claims while existing leases are allowed to finish.

## Cancellation

Cancellation is owner-scoped. Queued, claimed and dispatching work transitions to `cancelled`, active leases are released, and `CANCEL_REQUESTED` plus `CANCELLED` receipts are recorded. Cancellation reports whether dispatch may already have started. Cross-user cancellation and receipt reads fail securely.

Propagation to an actual active provider transport and subagent children is not yet wired, so full cancellation reconciliation is not certified.

## Stale Lease Recovery

An expired pre-dispatch `claimed` execution returns to `queued`. An expired `dispatching` execution moves to `recovery_pending`, releases capacity, records `LEASE_EXPIRED`, and is excluded from automatic claims to prevent ambiguous duplicate provider calls. Heartbeats renew both the active lease and execution projection for the owning worker only.

## Queue Recovery

Queue rows and fair-user rotation are database durable. Tests prove a lost pre-dispatch worker lease can be reclaimed by another worker and ambiguous dispatched work is retained without duplicate dispatch.

Actual process-kill/restart and PostgreSQL reconnect tests remain outstanding.

## Fairness

The durable claim query considers only each user's oldest highest-priority eligible head item and orders users by their last admitted time. In the local heavy-user test, User A queued 50 tasks and 19 users queued one task each; the first 20 completed admissions served 20 distinct users before returning to User A's backlog.

## DB Failure

The authority fails closed when enqueue/claim transactions throw; dispatch cannot begin without a committed lease. No production fallback to in-memory admission exists. Fault-injected unavailable/slow/serialization PostgreSQL evidence is not yet available.

## Chaos

Covered locally:

- duplicate enqueue response replay
- 100 claimers against capacity four
- worker loss before dispatch
- worker loss after dispatch
- lease expiry
- cancellation after dispatch start
- capacity reduction while active
- three competing worker authorities

Not covered yet: real process kill, DB disconnect, transaction serialization injection, clock skew across hosts and full API restart.

## Performance

Local SQLite in-memory results include enqueue, transactional selection, lease insert, receipt writes and completion/release:

| Queue | Enqueue total | Claim/complete total | Throughput | Selection median | Selection p95 |
|---:|---:|---:|---:|---:|---:|
| 10 | 2.94 ms | 10.75 ms | 930/s | 0.507 ms | 1.084 ms |
| 100 | 27.06 ms | 101.08 ms | 989/s | 0.551 ms | 0.947 ms |
| 1,000 | 202.15 ms | 1,688.72 ms | 592/s | 1.221 ms | 2.380 ms |
| 10,000 | 2,251.75 ms | 82,927.29 ms | 121/s | 7.881 ms | 14.866 ms |

The 10,000-row queue is practical but materially slower than the in-memory synthetic scheduler. PostgreSQL query-plan and latency evidence is still required before production certification.

## Security

- User ownership is required for reads, cancellation, completion and receipt access.
- Caller-supplied user identity is not accepted by the authority independently of its authenticated caller integration.
- Idempotency keys cannot be claimed across users.
- Provider-capacity mutation remains an internal database method; no user HTTP endpoint was added.
- Receipts contain IDs and safe metadata, never prompt/code content.
- Account erasure now explicitly removes hosted queue, lease, fair-state and receipt rows.
- Unknown/paid route eligibility remains outside this authority and under ForgeZero.

## 8-Bit Integration

The measured-health rule baseline was evaluated on eight labeled synthetic conditions: healthy, degraded, rate-limited, offline, healthy-but-full, cost-unknown, policy-unknown and quality-bad.

- Accuracy: 100% (8/8)
- Demotion precision: 100%
- Demotion recall: 100%
- Unsafe acceptance: 0%

A healthy saturated route remains healthy with capacity score zero. Unknown cost/policy and quality below floor quarantine. The current labeled set does not justify training; decision: `DO_NOT_TRAIN_RULE_BASELINE_PERFECT_ON_CURRENT_LABELED_SET`.

The database metrics-to-8-Bit production receipt adapter remains partial.

## ForgeGreen Hosted A/B

The matched A/B harness is implemented, but no execution has traversed the durable hosted queue with ForgeGreen OFF/ON. Verdict remains partial.

## Subagent Topology Results

The topology harness accounts for fan-out, but durable parent/child cancellation and per-task fan-out budgets are not integrated into hosted admission. The inherited negative team baseline remains authoritative.

## Spend

`$0`. No paid inference, provider credit, deployment, push, production database, certificate purchase or production mutation occurred.

## Remaining Blockers

1. Disposable PostgreSQL environment for real multi-process, locking, reconnect, query-plan and serialization-failure tests.
2. API endpoint and worker-loop integration; the current production HTTP inference path still dispatches directly.
3. Provider transport cancellation and subagent-child reconciliation.
4. Durable accounting receipt connection between admission completion and usage settlement.
5. Fault-injected DB outage/latency and process-kill harness.
6. ForgeGreen hosted OFF/ON and matched T0–T5 real task campaigns.
7. Public Managed Free supply remains zero certified routes.

## Verdicts

| Gate | Verdict |
|---|---|
| DURABLE CAPACITY LEDGER | NOT CERTIFIED — local implementation proven, PostgreSQL/runtime integration incomplete |
| DB-BACKED RESERVATIONS | NOT CERTIFIED — local certified, live PostgreSQL unproven |
| MULTI-INSTANCE ADMISSION | NOT CERTIFIED — three logical instances pass locally, multi-process PostgreSQL unproven |
| PER-USER FAIRNESS | CERTIFIED for local durable authority |
| IDEMPOTENCY | CERTIFIED for enqueue and terminal transitions locally |
| CANCELLATION RECONCILIATION | NOT CERTIFIED |
| STALE LEASE RECOVERY | CERTIFIED locally |
| QUEUE RECOVERY | PARTIAL |
| DB FAILURE SAFETY | NOT CERTIFIED |
| HOSTED CHAOS | PARTIAL |
| 8-BIT MEASURED HEALTH | PARTIAL |
| FORGEGREEN HOSTED A/B | NOT CERTIFIED |
| SUBAGENT TOPOLOGY INTELLIGENCE | IMPROVED |
| MANAGED FREE PUBLIC ROUTES | 0 CERTIFIED |
| R20 SPEND | $0 |

Synthetic and local database results do not establish 373-DAU service readiness. With zero certified public Managed Free routes, current public supply remains zero regardless of scheduler capability.
