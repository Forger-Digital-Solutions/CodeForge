# R47 Phase B — 16-Bit Spend Controls & Decision Surface

Phase B substrate verification and completion. No live paid calls have been made from this
document's state; every paid path below is gated, and the first spend requires explicit
campaign authorization.

## What already existed (verified, not rebuilt)

- `DurablePaidEvaluationBudgetLedger` — transactional campaign ledger: reserve-before-dispatch,
  reconcile/release exactly once, `PAID_EVALUATION_BUDGET_EXHAUSTED` hard stop, identity-mismatch
  release, sanitized receipts (no prompts/response bodies persisted).
- `PaidAutoOpenRouterEvaluationRunner` — exact-route chat runner on the ledger.
- `rank16Bit` — expected-completion-cost ranker (retries, failed-attempt cost, verification,
  escalation, tool reliability, role fit). Non-authorizing by contract.
- `observeSixteenBitShadow` — shadow recommendation records, MOCK-provenance default.
- `PaidAutoService` — direct→fallback execution with circuit breakers, kill switch
  (`paidExecutionEnabled`), and per-route qualification gates (READY + verified dims + CERTIFIED).

## Gaps found and fixed

1. **Service/adapter spend ungated.** `PaidAutoService.chat` enforces qualification and circuits
   but had no budget-ledger hook — only the evaluation runner did. Any dispatch surface other
   than the runner (runtime missions, corpus harnesses) could spend unreserved.
   **Fix:** `BudgetGatedProviderAdapter` (`packages/paid-auto/src/budget-gated-adapter.ts`) wraps
   any route-level `ProviderAdapter`. Every `chat`/`streamChat` resolves `(providerId,
   providerModelId)` to a registered route + exact CURRENT PriceCard, reserves the conservative
   bound, then settles once: ACTUAL with reported usage, ESTIMATED_ONLY at the bound when a
   completed call is unmeasured, RELEASED only for provably-unbilled failure (transport error,
   served-model mismatch, mid-stream abort, consumer abandonment).

2. **Durable/in-memory ledger divergence on unmeasured completion.** The in-memory ledger
   committed the estimate (`ESTIMATED_ONLY`) when a call completed without usage telemetry; the
   durable ledger reconciled the same case to $0 — under-recording real spend.
   **Fix:** durable `settle` now commits the reserved bound for completed-but-unmeasured calls
   and emits `ESTIMATED_ONLY` receipts, matching the in-memory contract. RELEASED remains only
   for provably-unbilled paths.

3. **Ranker priced the wrong route.** `rank16Bit` priced candidates on `model.direct.pricing`
   only — but with zai/alibaba/deepseek credentials absent, execution would ride OpenRouter
   fallbacks at different prices, and deepseek was excluded as PRICE_UNKNOWN despite a live
   fallback price.
   **Fix:** `SixteenBitRankOptions.priceOverrides` lets the caller price the route that would
   actually execute; candidates gain a `ROUTE_PRICED:<source>` reason code. Registry behavior
   unchanged when no override is supplied.

## Evidence artifacts

- `R47-16BIT-PRICING.json` — live OpenRouter catalog verification (GET, no spend). All four
  fallback routes found, tool-capable, with CURRENT HIGH-confidence price cards:
  gpt-5.6-luna $0.20/$1.20, glm-5.3-flash $0.04/$0.50, qwen3.8-flash $0.15/$0.47,
  deepseek-v4.1-flash $0.035/$0.29 per M tokens. Regenerate: `node scripts/r47-16bit-refresh-pricing.mjs`.
- `R47-16BIT-ROSTER.json` — roster + credential map. Executable today: all four `:openrouter`
  routes (OPENROUTER_API_KEY) plus `gpt-5.6-luna:direct` (OPENAI_API_KEY). Not executable:
  zai/alibaba/deepseek directs (credentials absent).
- `R47-16BIT-ROUTER-SHADOW.json` — deterministic `rank16Bit` rankings over EXPLORER/PLANNER/
  CODER/REVIEWER/MISSION_ROLLUP profiles priced on the live OpenRouter cards, unmeasured
  evidence (defaults). On price alone deepseek-v4.1-flash selects for every role (~$0.004–0.025
  expected completion cost); that is a pre-qualification price ranking, not a quality claim.
  Regenerate: `node scripts/r47-16bit-shadow.mjs`.

## Campaign harness

`scripts/r47-16bit-campaign.mjs` — env-gated (`CODEFORGE_16BIT_CAMPAIGN=1`), finite `--cap`
ceiling on a durable ledger (`R47_PAID_DB`, default tempdir), exact-card admission, receipt
collection, evidence JSON per run.

- `probe --model <id>` — one ~8-token chat: verifies the route is live + billable + identity-
  matched before any qualification spend.
- `qualify --model <id>` — full `runRoleAwareQualification` through the gated adapter; every
  probe request reserves/reconciles on the campaign ledger.

Fail-closed verified: without the env flag the script exits before any network call.

## Test evidence

- `packages/paid-auto/test/budget-gated-adapter.test.ts` — 10 tests: reserve-before-dispatch,
  served-model mismatch release, unknown-route/no-card pre-dispatch rejection (upstream never
  called), campaign exhaustion propagation, stream ACTUAL/ESTIMATED_ONLY/RELEASED settlement,
  consumer-abandonment release, durable ESTIMATED_ONLY parity.
- `packages/paid-auto` suite: 48/48 green after the durable-ledger alignment.
- Full repo build: clean.

## Remaining Phase B gates (all require real spend)

1. Capability probe of candidate routes (~$0.001/call each).
2. Role qualification per candidate (bounded, ~$0.01–0.05/model at current prices).
3. First live 16-Bit mission through the runtime — requires the service path to dispatch through
   budget-gated adapters and explicit authorization per §49.
