# R56 accounting trace — three source classes under real execution

Each row is backed by a captured artifact; nothing here is reconstructed.

## MANAGED_FREE (roster runs on the operator's free lanes: Groq + OpenRouter `:free`)

Artifacts: `roster-live-run*.json` (several honest outcomes — `roster-live-run-nemotron-or.json`
completed end-to-end on `openrouter/nvidia/nemotron-3-super-120b-a12b:free`; the rest
`blocked`/`cancelled` where capacity did not allow completion).

- Real model calls produced `shilling_entry` work items with `providerId: groq` and
  `providerId: openrouter` (the completed run: 17 entries on the nemotron route, 3 on
  `gpt-oss-120b` across the reviewer's failover chain),
  real `rawUsage` tokens, `rawUnit: TOKENS`.
- `conversion.confidence: UNKNOWN` is recorded honestly — the ledger never coerces an
  unknown conversion into zero or an invented cost.
- `managedSpendUsd: null`, `userProviderSpendUsd: null` — a free route carries no spend
  figure rather than a fabricated one.
- Decision receipts persist per selection/failover (`forgeauto_decision_receipt`) with
  ownerUserId + role + route fields only — no prompts, bodies, or credentials.
- Route allowance on every worker (`rosterAllowance.freeRoutes`) shows exactly which
  routes each role was authorized to use; the CODER pin contains only the pinned model.

Note on source classification: harnesses run on an operator-held Groq key declared as
`ENVIRONMENT` supply. Under the fabric's honest taxonomy that is `OWNER_DEV_FREE`
capacity — it must never present as managed product capacity — so ledger rows fall in
the user-provider domain (`USER_API` class, null spend) or `UNKNOWN` when no freeCloud
projection exists in the harness. The roster decision receipts still record the owner's
MANAGED_FREE authorization; the supply ledger separately records which capacity actually
served the call. These are different, both true, facts.

## MANAGED_PAID (live 16-Bit probe)

Artifact: `paid-live-probe.json` (copy of `docs/evidence/r47-16bit/R47-16BIT-PROBE-deepseek-v4.1-flash.json`).

- Route: `deepseek-v4.1-flash:openrouter` through `PaidAutoOpenRouterAdapter` +
  `BudgetGatedProviderAdapter` — no reserve, no dispatch.
- Hard gates observed live: `CODEFORGE_16BIT_CAMPAIGN=1` required, `--cap 0.05` ceiling,
  exact live-catalog PriceCard match required (`PAID_EVALUATION_PRICE_UNKNOWN` otherwise).
- Reservation `88273e5f` estimated $0.000014 → dispatch → served-model identity verified
  (`deepseek/deepseek-v4.1-flash` == requested; a mismatch would release + fail closed).
- Reconciled `ACTUAL`: provider-reported `costUsd: 0.000007638`, ledger-committed
  $0.000005 (price-card rate applied to reported usage — conservative floor against the
  provider's own figure), reservation status `RECONCILED`, `availableUsd` correctly reduced.
- The receipt is durable: written to a real SQLite ledger (`r56-16bit-ledger.db`).

## USER_API (owner-scoped BYOK, real wire)

Artifact: `user-api-live.json`.

- Real HTTPS endpoint (`api.openai.com`) authenticated — `/models` returned 200 with a
  126-model catalog; the configured model's chat endpoint answered a real request.
- The provider's real 429 "no credits remaining" was classified `PROVIDER_REJECTED_QUOTA`
  and surfaced honestly — no managed-free fallback, no fabricated success.
- Dispatch guards verified live: `UNQUALIFIED` → `USER_SOURCE_NOT_EXECUTABLE`;
  `SUSPENDED` re-put invalidates the registered adapter mid-life; missing credential →
  `USER_CREDENTIAL_UNAVAILABLE` before any network.
- Owner isolation: owner B cannot list/get the source, cannot resolve the credential
  reference, gets zero roster candidates.
- Endpoint policy: loopback, private IPv4, path traversal, and non-HTTPS literals all
  rejected `USER_SOURCE_ENDPOINT_INVALID` without network.
- Persistence: the source record + derived providerId + credential ref survive a real
  store reopen; roster candidates never carry `credentialRef`.

## Boundary summary

| Boundary | Evidence | Verdict |
|---|---|---|
| Free route never fabricates cost | roster-live-run*.json `confidence: UNKNOWN`, null spend | PASS |
| Paid spend never runs without reserve+pricecard+cap | paid-live-probe.json | PASS |
| Paid call settles once, ACTUAL, identity-checked | paid-live-probe.json receipt | PASS |
| USER_API never falls back to managed free | user-api-live.json dispatch | PASS |
| USER_API credential never leaves the resolver | user-api-live.json isolation+projection | PASS |
| Wrong owner sees nothing | user-api-live.json ownerIsolation | PASS |
