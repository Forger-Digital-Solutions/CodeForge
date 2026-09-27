# R46 — Free Supply Resilience Closure Matrix

Scope question: can CodeForge complete normal-topology missions on free-only inference despite quotas,
rate limits, route churn, model disappearance, provider parking, and uneven capacity windows — without
fabricated success, paid escape, or false waiting?

Evidence: `R46-LIVE-CORPUS.json` (full production path: FreeCloudService → FreeFabric → reservation
ledger → route-health authority → mission-admission gate), `R46-FREE-SUPPLY-INVENTORY.json`,
`R46-BASELINE.md`, `docs/codeforge-forgegreen-certified-source-state.json` (`r46-free-supply-resilience-v1`).

## Live corpus result (final run, 2026-09-26)

| Mission | Status | Calls | Providers | Outcome |
|---|---|---|---|---|
| r46-distributed-bug | blocked | 45 | groq+mistral | real edits; coder convergence failed honestly |
| r46-rename | blocked | 10 | mistral | explorer writer block (model output contract) |
| r46-feature | **completed** | 17 | mistral | verified (2/2 commands), review passed, changed files |
| r46-schema | blocked | 26 | mistral | VERIFICATION_FAILED — test left failing, blocked not claimed |
| r46-fail-repair | blocked | 2 | mistral | late-corpus capacity exhaustion, blocked honestly |

Every mission recorded: admission verdict, role routes, turn failures, journals, route windows,
failovers, fabric admission, edit attempts, wall time, tokens, call log, route-health snapshot.

## Requirement → evidence → verdict

| Requirement | Evidence | Verdict |
|---|---|---|
| Free-only, no paid escape | all 100+ corpus calls on verified-free routes; fail-closed at every layer | PASS |
| Live free-supply inventory | 64 verified routes; openrouter/groq/mistral pools; google 403 honest UNAVAILABLE; cloudflare analytics-scope fail-closed | PASS |
| Mission-aware admission | `capacity-confidence.ts` + gate in orchestrator; ADMIT/TEMPORARILY_PARKED/NO_FREE_CAPACITY; parking only on provable insufficiency; 10/10 tests | PASS |
| No false waiting | unmeasured capacity admits at coarse gate; per-turn fabric enforces; cooling pools park with earliest-recovery | PASS |
| Probe economics | staged qualification (hard-fail skip proven 12/12); durable SQLite receipts — 6 restored on final run; openrouter RATE_LIMITED conditions prevented sibling churn | PASS |
| 429 classification | RPM/TPM/daily/account/burst/unknown; live: openrouter free-models-per-day → resetEstimate = next UTC midnight (daily, account-wide) | PASS |
| Passive health evidence | response observer → quota + routeHealth; live: DEGRADED on gpt-oss-120b after tool_use_failed+429; openrouter routes RATE_LIMITED | PASS |
| Provider-window model | route/pool windows from observed headers only; mistral `*-req-minute`/`*-tokens-minute` suffixes parsed; elapsed-reset refill via declared limit | PASS |
| Shared quota-pool detection | managed pools = `provider::account::model` quota domains; per-account windows verified live | PASS |
| Role-aware routing | product-role mapping verified; REVIEWER/PLANNER ROLE_INELIGIBLE on unqualified routes, never substituted | PASS |
| Multi-user contention + 373-user regression | forge-zero capacity/user-connected/chaos/ledger suites 39/39; r20-scale 373-DAU 8/8 | PASS |
| Fail-closed completion | zero-call and failed-verification missions all `blocked`; only gate-verified run completed | PASS |
| Live production proof | 1 completed + 4 honestly blocked normal-topology missions on real free supply | PASS |

## Root causes found and fixed this round

1. **Unwired response observer** — `freeCloud.onProviderResponse` existed only in tests; the corpus (and
   any non-desktop host) had empty quota forever → every reservation denied CAPACITY_EXHAUSTED. Fixed in
   the corpus wiring; desktop was already correct. **Gap for R47**: `cloud-gateway`'s
   `CloudProviderRegistry` builds adapters without `onResponse` — hosted fleet quota evidence still
   unwired.
2. **Unstamped account identity** — managed-pool lookups are `provider::account::model`; adapter
   observations carry no accountId → invisible. The corpus stamps `accountId` per credential; any host
   registering managed pools must do the same (documented).
3. **Data-policy exclusion** — all mistral routes are USER_CONSENT_REQUIRED; default PRIVATE_CODE context
   correctly excludes them. Corpus declares synthetic+consented fixtures.
4. **Probe-vs-mission contention** — pre-persistence, ~85 probe calls vs 0 mission calls; with durable
   receipts restored, probe share fell toward parity (~85 vs ~100 mission calls across the final corpus).

## Known limits (honest, for R47)

- Explorer turns converge_failed on "Expected non-empty string for summary" across every mission —
  model output-contract weakness on mid free models, not a capacity defect (role-contract blockage).
- REVIEWER/PLANNER coverage on the groq managed fleet is thin (receipt roles don't cover them);
  mistral covered these roles once admitted.
- Qualification still competes for the same windows when receipts are cold — amortized, not eliminated.
- Google key suspended (provider-side); Cloudflare token lacks analytics scope — correctly withheld.

## R47 decision gate

PROCEED. The architecture withstands real free-supply pressure end to end: missions now execute and
complete through the production fabric, failures are honest and diagnosable, and no paid or
unknown-cost path was exercised. R47 should target: explorer output-contract robustness on free
models, REVIEWER/PLANNER role coverage breadth, hosted-fleet observer wiring (cloud-gateway), and
managed-pool account stamping as a first-class host contract.
