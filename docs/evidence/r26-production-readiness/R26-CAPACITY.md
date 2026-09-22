# R26 capacity / 373-DAU model

**Date:** 2026-09-22 · engine: `simulateScale` (forge-zero capacity-simulator, current contract)
**Demand:** measured R26 pilot — 11 calls, 29880 tokens per task (vs R4's synthetic 4 calls / 2,100 tokens)
**Fleet:** the 6 R26-qualified live routes only — Groq gpt-oss-120b / gpt-oss-20b / qwen3.8-27b (per-model daily buckets) + one shared OpenRouter :free account pool (1,000 req/day, policy-modeled).

> **Stale-tooling finding:** `scripts/r4-scale-sim.mjs` predates the current `CapacityRoute`
> contract — re-run at HEAD it produces zero capacity on every scenario (its legacy
> `capacityClass`/`economicSource` fields are ignored by `isFreeRouteEligible`). This model
> replaces it for R26; the R4 script should not be cited again.

## Posture 1 — productPosture (production admission today)

Owner-pool routes carry `managedMultiUserAllowed=false` — every route is ineligible, matching
quota-forecast-r26.json's productPosture (`MANAGED_MULTI_USER_TERMS_NOT_CLEARED`). Product-admissible
multi-user capacity is **0 task-units/day** until terms are cleared or users connect their own accounts.

## Posture 2 — termsClearedCeiling (raw physical quota)

| Scenario | Demand (tasks) | Counted capacity | Normal success | Blocks | p95 wait (min) |
|---|---:|---:|---:|---:|---:|
| registered-1 | 1 | 196 | 100.0% | 0 | 0 |
| registered-50 | 50 | 196 | 100.0% | 0 | 0 |
| registered-100 | 100 | 196 | 100.0% | 0 | 0 |
| registered-200 | 200 | 196 | 88.4% | 23 | 8 |
| registered-373 | 373 | 196 | 47.3% | 196 | 60 |
| registered-500 | 500 | 196 | 35.3% | 323 | 99 |
| registered-1000 | 1000 | 196 | 17.6% | 823 | 252 |
| registered-373-dau-75 | 150 | 196 | 100.0% | 5 | 2 |
| registered-373-dau-150 | 300 | 196 | 64.0% | 104 | 32 |
| registered-373-dau-373 | 746 | 196 | 24.4% | 550 | 169 |
| top-provider-outage | 150 | 90 | 64.8% | 60 | 40 |
| gateway-outage | 150 | 106 | 76.0% | 44 | 25 |
| 50-huge-vs-50-normal | 450 | 42 | 8.2% | 413 | 590 |

## Posture 3 — userConnected (each user's own :free account, PER_USER_POOL)

| Scenario | Demand (tasks) | Counted capacity | Normal success | Blocks | p95 wait (min) |
|---|---:|---:|---:|---:|---:|
| registered-1 | 1 | 196 | 100.0% | 0 | 0 |
| registered-50 | 50 | 9800 | 100.0% | 0 | 0 |
| registered-100 | 100 | 19600 | 100.0% | 0 | 0 |
| registered-200 | 200 | 39200 | 100.0% | 0 | 0 |
| registered-373 | 373 | 73108 | 100.0% | 0 | 0 |
| registered-500 | 500 | 98000 | 100.0% | 0 | 0 |
| registered-1000 | 1000 | 196000 | 100.0% | 0 | 0 |
| registered-373-dau-75 | 150 | 14700 | 100.0% | 0 | 0 |
| registered-373-dau-150 | 300 | 29400 | 100.0% | 0 | 0 |
| registered-373-dau-373 | 746 | 73108 | 100.0% | 0 | 0 |
| top-provider-outage | 150 | 6750 | 100.0% | 0 | 0 |
| gateway-outage | 150 | 7950 | 100.0% | 0 | 0 |
| 50-huge-vs-50-normal | 450 | 19600 | 100.0% | 0 | 0 |

## Reading

- The binding constraint is **tokens, not requests**: each Groq pool yields ~⌊200k/22.4k⌋ = 8
  tasks/day at measured demand; the requests-only pools (qwen, OpenRouter account) yield ~90 each.
- Physical ceiling ≈ **196 task-units/day** — 373 registered users at 1 task/day
  is borderline; the honest product-entitlement ceiling is lower once fairness/concentration apply.
- The architectural scaling path is Posture 3: user-connected :free accounts scale capacity
  linearly with DAU, which is why Phase 6 fairness work matters more than raw fleet size.
- Caveats: qwen's 1k OTPM cap makes it unusable for production-shaped (4,096-token) calls — it
  serves planner/reviewer-sized calls only; gpt-oss-20b's 8k TPM window saturates under burst load.
