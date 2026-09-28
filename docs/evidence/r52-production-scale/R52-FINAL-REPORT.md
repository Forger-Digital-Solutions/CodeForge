# R52 — Production-Scale Inventory, Reliability & Capacity Closure

Round objective: turn the R51 capacity fix into production-scale proof — live provider/domain
inventory, storm-controlled demand measurement, no false waiting across large route pools,
restart recovery, qualification-staleness lifecycle, honest mission outcomes, and a clean
provider matrix — all on free supply only ($0).

## Verdict

| Objective | Result |
|---|---|
| Live free-supply inventory | `R52-LIVE-FREE-SUPPLY-INVENTORY.json` — 64 catalog models, 244 capacity routes, 142 pools, 20 eligible routes |
| ≥3 independent managed free domains | **met** — groq + mistral + openrouter, 18 independent pools (`R52-FREE-DOMAIN-MATRIX.md`) |
| No false waiting (large pools) | 8-scenario suite + 4,796-decision sim, `ALL_INVARIANTS_HELD` |
| Probe storm control | in-flight coalescing + 60s/domain cooldown + ≤4 probes/decision — 9/9 tests |
| Cold-start/restart | durable receipts restore; quota re-measured on demand — never parked |
| Stale receipts | age/suite-stale → `STALE` → reopens qualification, never quarantines — 3/3 |
| Real missions | **4/5 completed, 1 honest block**, all $0, every served route ForgeAuto-eligible |
| Paid boundary | paid-auto 71/71, cloud-billing 3/3 — free logic cannot reach paid paths |

## Provider/domain matrix (final)

| Provider | Classification | Evidence |
|---|---|---|
| groq | `VERIFIED_USABLE_FREE` | 14 routes, 6 eligible, live missions served |
| mistral | `VERIFIED_USABLE_FREE` | 120 routes, 10 eligible, live missions served |
| openrouter | `VERIFIED_USABLE_FREE` | 36 routes, 4 eligible, live missions served |
| cloudflare-workers-ai | `VERIFIED_FREE_BUT_TELEMETRY_BLOCKED` | inference HTTP 200; `aiInferenceAdaptiveGroups` + `workersInvocationsAdaptive` authz-denied on env token — guard correctly fails closed (`R52_CLOUDFLARE_TELEMETRY_BLOCKED`) |
| google | `VERIFIED_FREE_BUT_TELEMETRY_BLOCKED` | API key suspended (403 PERMISSION_DENIED) at provider; free-policy gate unmet |
| cerebras | `NOT_PROVEN` | `PROMOTIONAL_CREDIT` — $5/30-day trial, not recurring free |
| github-models | `VERIFIED_FREE_BUT_POLICY_EXCLUDED` | no production adapter path; legal review required |
| openai, anthropic | `PAID_ONLY` | forbidden to 8-Bit |

Cloudflare was re-probed exactly per the round plan (production GraphQL fields,
`date_geq`/`date_leq`, `viewer.accounts`, REST `/accounts/{id}`): inference works but both
analytics datasets deny authorization on the environment token — the guard stays closed
and the domain is honestly reported as blocked, not usable.

## No-false-waiting proofs

Deterministic suite (`r52-capacity-scenarios.test.ts`, 8 tests):

1. 20 candidates, top 5 rate-limited → candidate 6 serves, no global wait.
2. Provider fully exhausted → healthy provider still serves (`CAPACITY_DENIED` +
   `PROVIDER_QUOTA_EXHAUSTED` reported honestly).
3. 12 unmeasured domains → honest `DENIED_NO_SUPPLY`, never queued; after a bounded
   4-candidate measurement pass the probed subset admits.
4. Mixed exclusion axes (unmeasured/cooling/wrong-role/policy/demoted) → the one
   legitimate healthy route wins.
5. All candidates truly exhausted → truthful `QUEUED_FOR_CAPACITY` with provider-stated
   `nextAvailableAt`.
6. Capacity recovers → exhausted route admits without restart.
7. New free model discovered mid-run → enters selection without restart.
8. Explanation contract — every candidate carries route/pool/provider/status/reason codes;
   unreached unmeasured candidates report `CAPACITY_UNMEASURED`, never generic `STANDBY`;
   no credential material in receipts.

Long-horizon sim (`R52-FORGEGREEN-LONG-HORIZON.json`, seed `0x52cc`): **4,796 decisions,
3,000 ticks, 41 users** — 4,685 admitted, 51 measured-queue waits, 60 honest denials, 21
demand probes, **0 invariant violations**. Calm phase 1,116/1,116 admitted; per-user
admissions floor 72 / ceiling 136; zero starvation; zero leaked leases; quality/capacity
channels never conflated (8 invariants including unmeasured-never-admits and
queued-requires-measured-evidence).

## Production changes

- `free-cloud-service.ts` — in-flight coalescing map for `probeRouteCapacity`: concurrent
  demand for the same quota domain coalesces onto one probe; entries removed on completion
  including failure paths. With the existing 60s/domain cooldown and ≤4 probes/decision,
  storm control is complete.
- `free-fabric.ts` — unreached candidates whose effective windows are empty now report
  `CAPACITY_UNMEASURED` instead of `STANDBY` (mirrors the ledger's pool-wins rule; keeps
  `measureUnmeasuredFreeCapacity` honest); `HEALTH_EXCLUDED` reports now carry
  `capacityPoolId` like every other candidate report.

## Mission receipts (`R52-LIVE-MISSION-*.json`)

| Mission | Outcome | Proof |
|---|---|---|
| unmeasured | **completed** (102.9s) | pre-decide denied all roles → demand probes measured → all roles served; gate `completed`, treeEqual, $0 |
| healthy | **blocked — honest** | explorer errored turn 2; reviewer `REVIEWER_BUDGET_EXHAUSTED` (10 turns, nemotron); gate refused completion — "unfinished work is not complete" |
| provider-outage | **completed** (113.6s) | 10 mistral routes rate-limited → fleet absorbed outage at admission (groq+openrouter); gate `completed`, treeEqual |
| reviewer-scarcity | **completed** (171.1s) | 13 reviewer routes rate-limited → pre-decide denied → demand probe recovered openrouter reviewer route; explorer on PROBATION fallback |
| multi-step | **completed** (312.0s) | **real mid-run failovers**: coder nemotron-lightning→groq on TIMEOUT (7 calls), explorer nemotron-super→groq on TEMPORARY_CAPACITY; reviewer on independent pool; post-integration **4/4 tests pass** (format, multiply, median odd/even) |

Every receipt: `paidSpendUsd: 0`, `allServedRoutesForgeAutoEligible: true`,
`treeEquality.equal: true`, secrets scan clean.

The healthy-mission block is evidence the gate works — nemotron burned its turn budget and
the run correctly terminated `blocked` rather than claiming partial work. It also flags a
qualification-fitness signal worth a future round (reviewer turn-efficiency on nemotron),
not a gate defect.

## Test deltas vs R51 baseline

| Suite | R51 | R52 |
|---|---|---|
| model-registry | 138 | **145** (+probe coalescing ×3, cold-start, stale-receipt ×3) |
| eight-bit | 332+2sk | **347+2sk** (+scenarios ×8, multi-user fairness ×7) |
| server | 896 + 2 baseline failures | **902 + 3sk, 0 failures** — `agent-certification-r` and `fg3-model-aware-budget` both fixed (stale fixture/expectations, not weakened contracts) |
| paid-auto | 71 | 71 |
| cloud-billing | 3 | 3 |

Note: `npx vitest` must run from the repo root — the 30s `testTimeout` lives in the root
`vitest.config.mts`; package-local runs inherit the 5s default and falsely time out on
bounded-wait tests (observed mid-round, root-caused, re-run clean).

## Known limitations

- Cloudflare Workers AI remains telemetry-blocked on the environment token; usable-free
  classification requires the full authoritative chain (analytics + neuron guard + billing
  boundary + recovery), per the round plan.
- Google key suspended at provider — excluded from usable supply until re-issued.
- Reviewer independence is preference-based: when only one pool holds a role-qualified
  measured route, the reviewer serves same-pool with `SAME_POOL_FALLBACK` evidence
  (missions 1, 4; independent in 3, 5).
- `reviewerIndependent` and qualification fitness flagged for the nemotron family: two of
  five missions showed converged_failed/turn-exhaustion on that model — route-quality
  feedback recorded (`healthAfterRun: CAPABILITY_LIMITED`) but role-level requalification
  thresholds are a future-round candidate.
