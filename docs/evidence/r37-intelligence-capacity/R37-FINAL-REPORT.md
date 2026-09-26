# R37 — Free Intelligence Fabric: Final Report

Branch `codex/r29-release-closure`. Commits `8587695` → `1460c07` (12 commits).
All evidence is local, deterministic, or simulated. No paid inference was consumed.
No deployment, no push, no secret or provider-billing changes.

## 1. Executive result

R37 converted the free-intelligence fabric from "routes exist, queue if the first one
fails" into an evidence-backed supply engine: every route is classified, role-qualified
with an explicit probation fallback tier, quota-domain-aware, and scored for scarcity.
Waiting is now an exhaustion ledger, not a guess — every parked task carries per-candidate
negative evidence (which quota domain ran out, which route was unhealthy, which capability
was missing). Two genuine premature-wait defects were found and fixed. ForgeVerify gained
a real semantic hardening (focused-test detection). ForgeGreen gained the missing headline
metric (Verified Work Multiplier, quality-gated). 16-Bit gained a pure expected-cost
chooser over the frozen four-model roster. Topology benchmarking showed fanout under
scarce supply *reduces* verified completions — smallest effective topology is the
correct default, and the codebase already enforces it.

## 2. Verified architecture changes

| Change | Where | Commit |
|---|---|---|
| Estimator accuracy: p50/p95/under-/over-estimate ratios from provider-billed truth | `providers/src/capacity-governor.ts` | `8587695` |
| `contextWindow` plumbed free-cloud-service → CapacityRoute → RouteLedgerEntry → FreeFabric; bounded `rightFitPenalty` | model-registry, eight-bit | `8587695` |
| Probation-tier role fallback: per-role `QualificationState` propagated through registry → route → fabric → reservation ledger; qualified tier ranks before fallback tier regardless of score | model-registry, eight-bit, forge-zero | `a3cdedb` |
| Same-provider model-domain independence proof | eight-bit test | `a2bba63` |
| Verified Work Multiplier (only under equal verified outcome) | benchmark r20-experiments | `9646c0d` |
| `rank16Bit` expected-completion-cost ranker (pure, explainable, fail-closed) | paid-auto | `5537bce` |
| Focused-test detection (`.only`/`fit`/`fdescribe`) as blocking semantic findings | workflow semantic-diff-review | `855f178` |
| Quota-domain-qualified denial codes (MODEL/PROVIDER/USER) + retained raw reason | eight-bit free-fabric | `e11fa56`, `1460c07` |
| ForgeGreen certified source-state re-issued (one material file hardened) | docs/certified-source-state.json | `1460c07` |

## 3. Premature-wait defects

**Probation role fallback** (`a3cdedb`). Root cause: qualification receipts already
recorded per-role `PROBATION` verdicts, but only `QUALIFIED` roles were propagated into
hard route eligibility — a measured "good enough" fallback became fully role-ineligible,
so a task could park with usable supply on the table. Reproduced: qualified tier absent,
probation route present → `QUEUED_FOR_CAPACITY`. Fix: explicit suitability tier;
`QUALIFIED` always outranks `PROBATION` even at lower numeric score. Regression tests:
qualified route admits; probation admits when no qualified route exists; probation never
outranks qualified.

**Aggregated wait code loss** (`1460c07`). The domain-qualified taxonomy initially
dropped the raw `CAPACITY_EXHAUSTED` code from the aggregated queued explanation
(caught by r24 multi-pool tests). Fixed: aggregate now carries both domain reason and
raw reason — the domain code refines, it does not replace.

## 4. 8-Bit state

- **Role qualification**: per-role `QualificationState` (QUALIFIED/PROBATION/…)
  flows end-to-end; `eightBitRoleForAgentRole` maps product roles onto fabric roles.
- **Fallback tiers**: qualified tier strictly precedes probation tier; probation is
  usable, never silently discarded, never promoted above qualified supply.
- **Free-supply inventory**: 33-provider classification audit
  (`R37-FREE-SUPPLY-INVENTORY.md`); classification is code-enforced and fail-closed.
  `UNKNOWN` is never free.
- **Scarcity preservation**: bounded logarithmic `rightFitPenalty` right-sizes near-ties
  within a domain; never denies admission, never crosses domain ordering.
- **Quota domains**: model/provider/user/account domains are distinct; an exhausted
  model pool does not suppress a sibling model's independent quota (a2bba63).
- **Wait-state proof**: `QUEUED_FOR_CAPACITY` carries a per-candidate explanation
  ledger (HEALTH_EXCLUDED, ROLE_INELIGIBLE, MODEL/PROVIDER_QUOTA_EXHAUSTED,
  USER_CONCURRENCY_LIMIT, …). A true wait = every candidate carries negative evidence.

## 5. ForgeGreen

- Verified Work Multiplier implemented on the matched-experiment harness:
  `baselineTokens/optimizedTokens`, reported **only** when correctness and completion
  deltas are zero and both arms verified (`9646c0d`). A cheaper wrong answer reports
  no multiplier.
- Existing machinery audited and confirmed: caching, ledger awareness, waste taxonomy,
  topology advice, verification policy, duplicate read/search suppression,
  state-version invalidation, no-progress escalation.
- **Live A/B corpus**: not executed — no live free-provider traffic was authorized for
  this campaign. Status: UNRESOLVED (see §11). The matched harness, quality gate, and
  metric are in place; what is missing is observed provider runs.
- Subagent supply simulation (R20 scale harness, `evidenceClass: "simulated"`):
  on one 2-concurrency route T4 fanout failed 74/100 tasks via self-congestion while
  T0/T2 completed all; on eight routes all topologies complete but T4 costs 4× requests
  and ~4.6× aggregate queue wait. Fanout is only justified by genuine work parallelism
  with supply to absorb it (`R37-SUBAGENT-TOPOLOGY.md`).

## 6. ForgeVerify

- **Found defect**: `.skip`/`.todo` were detected, but `.only`/`fit`/`fdescribe`
  focused-test markers were not — a diff narrowing the suite produced green output that
  evaded semantic review. Fixed and tested (`855f178`), including a false-positive
  control for helper functions named `fit`.
- Existing semantic surface audited: assertion removal, strict→loose matcher weakening,
  swallowed errors, environment-gated production behavior, dead branches, hardcoded
  test-input special cases, unreferenced exports — all already blocking.
- Deterministic-first ordering is intact: semantic-diff review runs without a model;
  the completion gate (`evaluateCompletion`) remains the only `completed` authority.
- Verification efficiency: deterministic review precedes any reviewer-model pass;
  state-version reuse in duplicate-suppression already applies to verification reads.
- Reviewer/verifier independence: delivery reviewer runs read-only; task-graph
  `assignedRole` is validated; deterministic diff review runs *even without* an
  independent reviewer (r21 wiring tests).

## 7. 16-Bit

- `rank16Bit` (`paid-auto/src/expected-cost.ts`) ranks the frozen roster — GPT-5.6 Luna,
  GLM-5.3-Flash, Qwen3.8-Flash, DeepSeek V4.1 Flash — by expected successful-completion
  cost: attempt cost × expected attempts (success rate, retry probability, tool
  reliability) + verification + bounded escalation.
- Exclusions are hard: `CONTEXT_TOO_SMALL`, `TOOL_UNSUPPORTED`, `PRICE_UNKNOWN`
  (null price never reads as $0). Unmeasured candidates are labeled, not assumed
  competent (default successRate 0.5, floored 0.05).
- 12 deterministic tests: cheap-raw vs higher-completion, verification cost changes
  ordering, reliability degradation re-ranks, trivial tasks never reach premium models,
  all-unmeasured falls back to cheapest honest default labeled `UNMEASURED_EVIDENCE`.
- No paid activation was added; Paid Auto remains the executor, rank16Bit the chooser.
- UNRESOLVED: live measured success-rate economics — the ranker consumes evidence that
  only real paid dispatch can produce.

## 8. Subagents

- Topology benchmark evidence in `R37-SUBAGENT-TOPOLOGY.md` (simulated): fanout
  multiplies supply consumption; under scarce capacity it *reduces* completions.
- Smallest-effective-topology is already enforced: R21 adaptive wiring — tiny goal →
  coder + ForgeVerify only; explicit topology requests win but are recorded;
  ForgeGreen capacity advice can shrink a parallel plan under constrained capacity
  (r21 adaptive-topology-wiring tests, 10/10 green in the canonical run).
- Per-role demand differentiation (`outputDemandForRole`) prevents writer-sized
  reservations on reviewer turns — a real capacity-reachability fix from R34.
- Duplicate suppression is tool-level (read/search dedupe keyed on stable identities +
  state version); independent verification reasoning is deliberately *not* deduplicated.
- UNRESOLVED: live reviewer/verifier catch-rate deltas across real tasks; the synthetic
  harness cannot model semantic reviewer value.

## 9. Capacity ops

- Error taxonomy (`R37-CAPACITY-ERROR-TAXONOMY.md`): every brief-required class maps to
  an existing vocabulary entry — no duplicate enums added. Cancellation is a task
  lifecycle event (`AGENT_CANCELLED`/`TASK_CANCELLED`/`USER_CANCELLED`), correctly not a
  route failure.
- Quota-domain-qualified denial codes added: `CAPACITY_EXHAUSTED` alone could not
  distinguish model-domain from provider-domain exhaustion; the fabric now emits
  `MODEL_QUOTA_EXHAUSTED` / `PROVIDER_QUOTA_EXHAUSTED` / `USER_QUOTA_EXHAUSTED`
  (pool-identity driven) alongside the raw ledger reason.
- Failover semantics verified by test: provider A rate-limited → provider B admits;
  same-provider sibling model admits on independent model quota; probation admits when
  qualified is absent; small-context insufficiency does not block the large-context
  route; all-routes-exhausted legitimately waits with per-candidate evidence.
- UNRESOLVED: live failover latency, catalog-cache staleness behavior, and long-duration
  provider health evidence — these require real provider traffic.

## 10. Regression

- Canonical suite (`npm test`, vitest run, whole workspace), run 1: **3,765 passed /
  4 failed / 48 skipped**. All 4 failures root-caused to R37: 2× aggregated
  reason-code loss (fixed `1460c07`), 2× certified-source-state drift (recertified
  same commit). Affected files re-verified green (42 + 8 tests).
- Canonical suite, run 2 (post-fix): **3,767 passed / 2 failed / 48 skipped**.
  Both remaining failures proven environmental, not R37:
  - `r21-forgeverify-malicious-corpus` `[shell-wrapper-hides-silent-failure]`:
    flaky under parallel load — **24/24 pass** when run standalone.
  - `cf14-large-repo-benchmark`: wall-clock anti-pathology bound (120s) —
    passed run 1 at 67s, hit 141s in run 2 under heavier load. Timing bound,
    not a correctness gate.
- Expected skips (8 files / 48 tests): Postgres-environment suites —
  `migration-namespace-collision`, `fg1-postgres-ledger`, `hosted-admission-postgres`,
  `cf17-pg-restart-e2e`, `cloud-postgres-adversarial`, `eight-bit/postgres`,
  `fg7-postgres-persistence`, `hosted-workflow-postgres-r4`. Environment-gated, not
  product skips; they are not live-provider proof either.
- Typecheck/build: packages touched by R37 all compile clean (tsc per package during
  development; forge-zero rebuilt to refresh declarations).

## 11. Evidence classes

- **VERIFIED (tests + code)**: role-tier routing, probation fallback, model-domain
  quota independence, right-fit scarcity scoring, estimator accuracy reporting,
  focused-test blocking, VWM computation + quality gate, rank16Bit expected-cost
  logic, denial taxonomy, wait-state explanation ledger, source-state recertification.
- **SIMULATED**: subagent topology fanout economics (R20 scale harness, synthetic
  evidence class), capacity self-congestion behavior.
- **LIVE-PROVIDER VERIFIED**: nothing new this campaign — no live traffic authorized.
- **PARTIALLY VERIFIED**: ForgeGreen efficiency claim — metric and gate implemented,
  live A/B corpus unrun.
- **UNRESOLVED**: live ForgeGreen A/B corpus; live failover latency / catalog-cache
  staleness; live subagent catch-rate economics; measured 16-Bit success-rate inputs;
  DAU-scale capacity behavior.
- **BLOCKED**: none.
- **PLANNED**: GEMS routing (explicitly out of scope); live-provider qualification
  refresh cadence.

## 12. Remaining risks

- Free inventory churn: the 33-provider audit is a snapshot; provider free tiers and
  limits change without notice. Qualification refresh is the mitigation, not a snapshot.
- Simulated topology economics assume equal task-share splits — an optimistic model;
  real fanout benefit depends on planner independence quality.
- rank16Bit defaults (successRate 0.5, escalation = one attempt) are floors/lower-bounds;
  real dispatch evidence may reorder the roster.
- Long-duration provider-health and quota-window behavior is untested beyond window
  boundaries in simulation.
- The ForgeGreen live A/B gate (E) is the campaign's largest honest hole: the machinery
  is built and quality-gated, but the efficiency number it would produce is unknown.
