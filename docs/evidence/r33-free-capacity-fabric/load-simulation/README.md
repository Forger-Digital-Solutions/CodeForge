# R33 synthetic control-plane scale run

This lane extends the R20 synthetic admission concepts with compact indexed task state. It models one outstanding task per user, two tasks per user, two synthetic free routes, leases, quota windows, 429 checkpoint and retry, route migration, and idempotent task-key replay. It does not call a provider or the production server.

**Every admission and release passes through the production `CapacityReservationLedger`** (`packages/forge-zero/src/capacity-reservations.ts`) — the same code path a real turn consults — while the compact counters remain an independent model. A ledger denial where the model still had a slot, a failed release, or a non-empty ledger after settle is counted as a cross-validation divergence; the script fails the run if any occur.

## Reproduce

From the repository root after building `@codeforge/benchmark`:

```powershell
node node_modules/typescript/bin/tsc -b packages/benchmark
node node_modules/vitest/vitest.mjs run packages/benchmark/test/r33-control-plane-scale.test.ts
node scripts/r33-control-plane-scale.mjs
```

The script fails if any user is starved at the configured horizon, any duplicate task is admitted, an in-flight or completed replay bypasses the state guard, leases leak, route accounting disagrees, the production ledger diverges from the independent model, or the first-admission wave violates strict round robin. [results.json](./results.json) records the scenario inputs, counters, source hash, Node version, and observed run times.

## Measured local run

| Virtual users | Synthetic tasks | Modeled ticks | Wall time | Post-run process RSS | 429s / migrations | Result |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 100 | 200 | 1 | 7 ms | 53 MiB | 0 / 0 | Pass |
| 1,000 | 2,000 | 1 | 26 ms | 61 MiB | 0 / 0 | Pass |
| 10,000 | 20,000 | 6 | 232 ms | 91 MiB | 2,048 / 2,048 | Pass |
| 100,000 | 200,000 | 90 | 1,759 ms | 249 MiB | 2,048 / 2,048 | Pass |
| 1,000,000 | 2,000,000 | 990 | 19,134 ms | 908 MiB | 2,048 / 2,048 | Pass |

The 100 and 1,000 user cases finish before the injected fault at modeled tick 2. The larger cases exercise that fault. Quota resets and quota-denied slots occur at 100,000 and 1,000,000 users. All five runs reported zero duplicate admissions, zero leaked leases, zero accounting errors, zero ledger divergences (2,002,048 production `reserve()` calls at the 1M scale), zero starved users, and exact task completion. The 1,000,000 case completed 2,000,000 task-key replays after terminal state and rejected 2,002,048 in-flight/retry replays.

## Reservation ledger scalability

Before the indexed rewrite, `reserve()` scanned every live reservation twice per call (user-cap scan plus `recoverExpired()`), making admission O(active reservations) — measured ~0.79 ms at 1,200 actives and ~5.9 ms at 10,200 actives (`scripts/r33-ledger-scale-probe.mjs`), a quadratic wall that made filling a 1M-reservation table take hours. The ledger now maintains per-user counts, per-pool and per-user-pool demand aggregates, and a sorted expiry index, keeping `reserve()` at ~0.006 ms with 1,000,003 live reservations. The same-index `reservationId` replace semantics, per-user caps, first-run reserve, pool identity checks, and expiry behavior are pinned by `packages/forge-zero/test/capacity-ledger-index.test.ts` and the existing `capacity-r4.test.ts` suite.

These values are measurements of this in-process simulation on one Windows Node.js process. The route concurrency (2,048 each) and quota (20,000 calls per 20 modeled ticks each) are **invented test parameters**, not observed free-provider capacity. A tick is a logical admission batch, not elapsed provider latency. Post-run RSS is a snapshot, not peak memory. This run does not exercise network requests, durable storage, real distributed races, live inference, or a million real connected clients. It therefore establishes bounded model behavior plus production-ledger correctness and admission cost at scale; it is not evidence of one million production-user readiness or available inference supply.
