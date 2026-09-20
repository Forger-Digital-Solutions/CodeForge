# R20 Capacity and Fairness Checkpoint

Recorded: 2026-09-20
Source anchor: `8bce13c87c888fefa2f52ecf3c2117afced45c63` plus the uncommitted R20 changeset
Evidence class: synthetic/local emulation only unless explicitly stated
Spend: `$0`

## Architecture Implemented

The reusable `@codeforge/benchmark` R20 layer now models stable users, sessions, tasks, turn executions, topology fan-out, provider routes, per-user queues, expiring reservations, bounded retries, cooldowns, staged recovery, queue events, task outcomes, tokens, latency, utilization, fairness and machine-readable results. It does not certify a route or bypass ForgeZero.

`R20FairScheduler` uses user round-robin admission with configurable per-user concurrency. A topology is expanded into actual provider executions before admission, so a team task cannot count as one request. `R20SyntheticProviderEmulator` supports success, 429, 500, timeout, malformed output, connection reset, offline, latency spike and model removal fault windows.

The existing ForgeZero reservation ledger remains the production eligibility/capacity authority. The R20 scheduler is a measured prototype, not yet wired into the hosted gateway.

## Harness

Command: `npm run r20:scale`

Outputs are under `09-scale/scenarios/`. Every result identifies itself as `simulated`; the harness rejects synthetic results labeled staging, real-provider or production.

Implemented configuration includes users, active concurrency, per-user task overrides, tasks/user, task mix, token sizes, turns, topology, think time, burst mode, retries, backoff, jitter, cancellation rate, queue limit, route mode, route concurrency and fault windows.

Targeted verification:

- Benchmark scale/experiment tests: 13 passed, 0 failed.
- ForgeZero reservation tests included in the campaign run: 16 passed, 0 failed.
- 8-Bit measured health/capacity/existing health tests: 23 passed, 0 failed.
- Paid Auto pricing/budget tests: 19 passed, 0 failed.

## Synthetic Capacity Results

| Scenario | Tasks | Requests | Terminal failures | p95 queue wait | Result |
|---|---:|---:|---:|---:|---|
| 1 user | 2/2 | 2 | 0 | 147 ms | PASS |
| 10 users | 20/20 | 32 | 0 | 5,459 ms | PASS |
| 50 users | 100/100 | 156 | 0 | 9,649 ms | PASS |
| 100-user burst | 200/200 | 302 | 0 | 18,047 ms | PASS |
| 373-DAU expected peak | 112/112 | 179 | 0 | 11,195 ms | PASS |
| Subagent-heavy | 50/50 | 200 | 0 | 20,922 ms | PASS |

These numbers measure CodeForge's synthetic scheduler with two emulated four-slot routes. They are not Managed Free provider capacity claims.

## Fairness Results

The heavy-user scenario queued 50 tasks for User A and one task each for 19 normal users.

- 69/69 tasks completed.
- 0 starvation events.
- Normal-user p95 wait: 2,794 ms.
- Overall p95 wait: 47,002 ms because the heavy user's own backlog waited behind fair turns.
- Jain completion-satisfaction index: 1.0.

Scheduler overhead on this host:

| Queued tasks | Total selection time | Average selection |
|---:|---:|---:|
| 10 | 0.129 ms | 12.90 µs |
| 100 | 0.082 ms | 0.82 µs |
| 1,000 | 0.679 ms | 0.68 µs |
| 10,000 | 8.338 ms | 0.83 µs |

The 10-item average is timer-resolution dominated. The 10,000-item result is the more useful scale signal.

## Chaos Results

| Fault | Provider failures | Retries/failovers | Completed tasks | Terminal failures |
|---|---:|---:|---:|---:|
| One route 429 | 20 | 20 | 100/100 | 0 |
| One route offline | 20 | 20 | 100/100 | 0 |
| Degrade then recover | 7 | 7 | 100/100 | 0 |

Routes enter degraded/cooldown states after bounded thresholds. Recovery requires two healthy probes before the emulated route returns to healthy. All synthetic chaos evidence is deterministic from the scenario seed.

Not yet certified: all-routes-429 terminal UX, DB latency/failure, durable queue-worker restart, API restart, duplicate network delivery and persisted reservation reconciliation.

## 373 DAU Model

The model separates DAU from concurrency and emits LOW, EXPECTED, HIGH and STRESS assumptions in `R20-373-DAU-MODEL.json`.

Expected assumptions:

- 373 DAU.
- 15% active during peak hour: 56 users.
- 2 tasks/user/day: 746 tasks/day.
- 4 turns/task: 2,984 turns/day.
- 2,000 tokens/turn: 5,968,000 tokens/day.
- 10% subagent use, 5% browser use.
- 10-minute average task and 1.5 burst factor.
- 14 representative peak concurrent tasks.
- 1.35 estimated request multiplier from subagents/browser activity.

The expected synthetic run completed 112/112 tasks. This does not establish that current public free supply can serve them; the approved production roster remains zero.

## 8-Bit Integration

`EightBitMeasuredHealthTracker` now accepts measured samples and preserves separate availability, latency, capacity, quality, tool-call, policy-certainty and cost-certainty signals. Unknown cost or policy quarantines a route before health scoring. Capacity exhaustion does not mark a healthy route unhealthy. Recovery from unavailable requires staged probe evidence.

Status: measured-health data model and transitions implemented/tested; adapter from persisted production benchmark receipts is still missing.

## ForgeGreen Harness

`R20MatchedExperimentHarness` supports controlled OFF/ON comparisons with identical topology and records tokens, model calls, provider requests, tools, duplicate reads/searches, commands, wall time, completion and correctness. Promotion is refused when correctness or completion regresses.

Status: harness certified by deterministic tests; broad workload results not yet run.

## Subagent Harness

The same matched harness compares T0–T5 metrics and computes token/request multipliers, wall-time delta, reviewer defect delta and a benefit score. The inherited losing baseline is preserved:

- Wall time: 151 s team vs 96 s single, +57.29%.
- Tokens: 121,594 team vs 30,000 fixture baseline, 4.05×.
- Requests: 4.1× in the fixture.
- Benefit score remains negative when correctness is equal and no defects are found.

Status: topology comparison harness certified; matched real task matrix not yet run.

## 16-Bit Preparation

Paid Auto remains exactly four canonical model families and network execution remains disabled by default. Every registry price now carries source, effective date, last-verified timestamp, exact unit and provider/model identity. Unknown values remain `UNKNOWN`; no price was guessed and no paid call was made.

## Known Bottlenecks

1. The user-aware scheduler is not integrated with the hosted gateway or durable database authority.
2. Reservations in the prototype are process-local; production restart reconciliation remains unproven.
3. Synthetic capacity is not evidence that any public Managed Free route is authorized or available.
4. Subagent fan-out materially increases queue wait: 20,922 ms p95 in the synthetic heavy scenario.
5. 8-Bit measured health is not yet fed from persisted benchmark receipts.
6. Browser remains not certified and Windows artifacts remain unsigned.

## Routes Ready for Live Qualification

None. R14 precedence remains in force. No route has completed the fresh R20 cost, policy, capability, quality, capacity, ForgeZero and load gates.

## Routes Still Quarantined

All historical candidates remain unqualified for `PUBLIC_MANAGED_FREE`. Historical owner/dev evidence is not promoted.

## Spend

`$0`. No paid inference, purchase, deployment, push, production mutation or signing-certificate action occurred.

## Owner Actions

None required for continued local engineering. Live public-route qualification will eventually require current provider authorization/terms evidence and owner-controlled credentials, but those are not requested or changed at this checkpoint.

## Checkpoint Verdicts

| Gate | Verdict |
|---|---|
| LOAD HARNESS | CERTIFIED for synthetic/local emulation |
| CAPACITY LEDGER | NOT CERTIFIED for production durability |
| RESERVATIONS | PARTIAL — lifecycle proven in-process; restart authority missing |
| PER-USER FAIRNESS | CERTIFIED in deterministic synthetic scenarios |
| QUEUE RECOVERY | NOT CERTIFIED |
| CHAOS HARNESS | PARTIAL — provider faults certified; DB/worker restart missing |
| 373 DAU MODEL | COMPLETE |
| 8-BIT HEALTH INPUTS | PARTIAL |
| FORGEGREEN A/B HARNESS | CERTIFIED |
| SUBAGENT TOPOLOGY HARNESS | CERTIFIED |
| MANAGED FREE LIVE ROUTES | 0 CERTIFIED |
| R20 SPEND | $0 |

## Next Phase

Integrate durable user-aware admission with the hosted gateway and database reservation authority; test idempotency, cancellation, stale lease recovery, DB failure and process restart; feed persisted run metrics into 8-Bit; then run the ForgeGreen and topology task matrices before any fresh zero-cost live route qualification.
