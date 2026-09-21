# M14D/M14E — ForgeAuto aggregation + supported-user capacity model (measured)

Status: aggregation implemented + tested; capacity model run with measured inputs.
Conclusion: today's verified free fabric supports roughly **20 DAU** before blocking —
user-entitlement supply is load-bearing, not optional.

## M14D — ForgeAuto supply plan

`forgeAutoSupplyPlan(entries, role, userIdentity)` in `eight-bit/src/route-ledger.ts`:

- Domain order (conserve personal quota): `SHARED_CODEFORGE_POOL → SPONSORED → USER_ENTITLEMENT`.
- Only `freeEligible` rows participate (real ForgeZero gate, all checks live).
- A `PER_USER_POOL` row is schedulable only when `quotaOwnerIdentity === userIdentity` —
  another user's entitlement is never even considered.
- `hasSupply` honestly false when nothing qualifies; empty ≠ degraded.

Tests (`route-ledger.test.ts`, 11 total): shared-first ordering, cross-user exclusion,
anonymous exclusion, ineligible/role-mismatch → empty plan.

## M14E — capacity model with tonight's measured inputs

Simulator: `simulateScale` (forge-zero, pre-existing). Inputs, all measured/declared:

- Supply: single OpenRouter `:free` managed pool — 1000 requests/day (observed counter).
  Modeled as `PURE_MANAGED_FREE` for the what-if; **note**: multi-tenant managed use of
  OpenRouter `:free` is not terms-cleared (M14C) — this is the ceiling scenario.
- Demand: 15 model calls per verified task — measured tonight: verified tasks used 5, 8,
  19 calls (median of all runs 3 is dragged down by instant upstream failures).

| DAU | tasks/day | capacity | blocked | p95 wait |
|---|---|---|---|---|
| 10 | 30 | 66 | 0 | 0m |
| 50 | 150 | 66 | 89 | 81m |
| 100 | 300 | 66 | 236 | 215m |
| 373 | 1119 | 66 | 1053 | 958m |
| 1000 | 3000 | 66 | 2934 | — |

**~66 tasks/day ⇒ ~22 DAU at 3 tasks/user/day** on a single 1000-req/day pool.

Simulator alerts (honest): pool inferred from route (needs provider pool observation),
100% provider concentration exceeds 80% threshold.

## What the model says about the supply fabric

- One 1k-req/day pool is a dev-scale resource, not a product-scale one. Scaling DAU
  linearly requires either more managed pools, or user entitlements carrying their own
  owners' load.
- `simulateOllamaAdoption` (existing) models the per-user offload: at 50% adoption with
  $2/user/month included usage and $1/task, 279 connected users add ~558 tasks/day —
  ~8.5× the single shared pool. User entitlement is the dominant scaling lever.
- Every +1 qualified managed route of comparable quota adds ~66 tasks/day AND reduces
  provider concentration (the simulator's failover-coverage metric).

## Gaps

- Pool observations must come from provider APIs, not route inference (simulator alert).
- Token-side demand needs the pilot for real distributions (tonight's token totals are
  UNKNOWN on the nvidia route; usage-reporting routes needed for token-based capacity).
- Sponsored supply has no live instance yet — class + policy exist, no sponsor route to
  measure.
