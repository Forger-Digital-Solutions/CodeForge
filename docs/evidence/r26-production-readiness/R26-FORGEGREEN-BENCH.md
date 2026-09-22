# R26 Phase 5 — Live ForgeGreen Paired Benchmark

**Date:** 2026-09-22
**Route:** `groq::openai/gpt-oss-20b` (ForgeZero `FREE_ALLOWANCE`, owner free plan, live rate-limit headers)
**Harness:** `scripts/r25-live-bench.mjs pilot` — probe gate + capacity gate, no `--force-gate`
**Campaign record:** `docs/evidence/r25-live-reality/bench/raw/pilot/campaign-pilot-2026-09-22T00-51-55-782Z.json`
**Commit under test:** `60616c6` (clean tree)

## Route selection under quota

`groq::openai/gpt-oss-120b` (R25's primary route) was correctly refused by the
capacity gate: modelled daily bucket ≈84k tokens < the 99k safety floor
(`tokensNeeded + 15% of daily cap`). The gate was **not** forced.

`groq::qwen/qwen3.8-27b` was probed and the gate CLOSED — its `on_demand` tier
caps output at 1,000 OTPM, structurally below the 4,096-token production-shaped
request. Recorded in `supply/probe-gates.jsonl`.

`groq::openai/gpt-oss-20b`: probe gate OPEN (2/2 served, tool calls emitted).

## Results — 2 pairs, 1 valid

### Pair 1 — `r25-tiny-js-adult-check` (valid, verified both arms)

| Arm | Calls | Tokens | Wall | Outcome |
|---|---|---|---|---|
| optimized | 19 | 40,907 | 277s | verified_complete |
| control | 14 | 32,590 | 235s | verified_complete |

**Paired delta: optimized arm was +25% tokens, +36% calls, +18% wall-clock.**
On a tiny task the ForgeGreen/orchestration overhead is pure cost — the
optimized topology pays off only above a task-size threshold. This is a real
paired measurement, not a regression: it bounds where ForgeGreen helps.

### Pair 2 — `r25-tiny-ts-status-label` (void, honest)

| Arm | Calls | Tokens | Outcome |
|---|---|---|---|
| control | 3 | 4,833 | `COMPLETION_GATE_BLOCKED` / `no_effective_change` — model emitted tool calls but never wrote the file; verifier ran (exit 1); gate refused completion |
| optimized | 6 | n/a | `REVIEWER_FAILED` — provider rate-limited mid-review after work began; run blocked, not completed |

Pair voided: sibling arms failed for different reasons. The completion gate
behaved correctly in both cases — nothing reached `completed` unverified.

## Quota accounting (live headers)

| | Requests | Daily tokens (modelled bucket) |
|---|---|---|
| At start | 997/1000 | 200,000 |
| At end | 956/1000 | 118,831 |

- Total spend this campaign: 41 requests, ~82.5k tokens — all on a verified
  free route. Zero billing exposure.
- One further pair does **not** fit: after one more arm the modelled bucket
  would drop below the 99k gate floor, voiding the second arm mid-pair.

## Verdict

`R26_FORGEGREEN_PARTIAL` — one valid paired delta on a live free route;
ForgeGreen's overhead is measurable and not free on tiny tasks. A broader
paired campaign needs either a daily-quota reset on `gpt-oss-120b` or an
additional OTPM-unconstrained free route.

## Findings carried to release review

- **F-R26-B1:** Live paired benchmarking is quota-bound on single-owner free
  accounts; ~2–3 pairs/day maximum per Groq model route.
- **F-R26-B2:** `qwen3.8-27b` OTPM=1000 makes it unusable for production-shaped
  requests despite Planner qualification — qualification evidence must record
  per-tier output caps, not just role probes.
- **F-R26-B3:** `gpt-oss-20b` fails the `tiny-ts` task class (no effective
  change in control arm) — 20b-class models are coder-capable but fragile on
  TS tasks under orchestration.
