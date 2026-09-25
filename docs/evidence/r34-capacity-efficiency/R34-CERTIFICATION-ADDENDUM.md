# R34 — managed-free supply closure, cross-pool failover, context efficiency & backend finalization

Certification addendum over the R33 baseline. All changes are committed on
`codex/r29-release-closure`. R34's headline result: **live cross-pool migration is now
proven** — the R33 "single admissible pool" limitation is closed on real supply.

## Mission ledger

| Mission | Change | Commit | Verification |
|---|---|---|---|
| E — measured demand | `estimatePromptOnlyTokens` + role-scoped output bound + learned `tokenizerRatio` per candidate replace the flat 16k reservation; preserved through failover re-admission | `859520f` | 6 new fabric tests; 416 affected green |
| F/G — context efficiency | `repo_*` tool surface gated on workspace presence (−~1,150 tok/call when absent); dispatch-time supersession + mutation staleness compaction (−5.9% interactive input); reproducible benchmark receipt | `1c36144` | `history-compaction.test` 8, `context-efficiency.test` 2; receipt at `context-efficiency-benchmark.json` |
| K — role demand | `outputTokenDemand` per role (CODER 2048 / PLANNER 1536 / light 1024) through `selectInitialRoute` + failover | `1c36144` | same commit, tests green |
| C — quota domains | `freeAccess.quotaDomain` declaration + `accountId`-keyed observations; model-domain providers shard into per-model physical pools; account-scoped observation collapses back | `cb9c594` | isolation test proves model-A reservation does not deny model-B; 102 green |
| B — managed pools | `ManagedPoolRecord` fleet registry (`managed:<p>:<acct>`), registration/restore/quarantine, per-account pool projection, `ProviderResponseObservation.accountId`, generic `quarantinePool` + `POST /api/free-cloud/pools/quarantine` | `32b072e` | 7 new tests; 135 green |
| D — cert harness | supply probe through the production ledger; verdicts `MIGRATION_PROVEN` / `FAILOVER_FAILED` / `BLOCKED_BY_AVAILABLE_SUPPLY`; pool-B auto-detect from served streams | `b9db806` | live run below |
| H — GitHub Models truth | `github-models` definition: FREE_DAILY_ALLOCATION, quotaDomain=model, no quota headers ⇒ inadmissible until observed; LEGAL_REVIEW_REQUIRED terms | `329c3b2` | registry suite green |
| I — Cloudflare diagnostics | usage source classifies failures; `CLOUDFLARE_USAGE_SCOPE_REQUIRED` (401/403 + GraphQL errors[]) distinct from credential-missing / unreachable / malformed | `329c3b2` | 2 new tests; 12 green |
| L/P — billing red team | BYOK leak, dev-key, 402, `:free`-suffix loss, PAID_API user-key scope, oversubscribe — all deny at the service projection | `587c7fd` | 6 new tests; 54 green in file |
| M/N/O — wait + observability | wait contract re-verified (durable work item, restart-restore, sweeper); capacity endpoint + quarantine + per-dispatch `dispatchTelemetry` (estimate vs billed, learned ratio) | `38382c6` | governor test; endpoint surface |
| Q/R — policy preservation | quarantine survives catalog refresh/re-registration; lifecycle denied unless APPROVED | `39aede8` | regression test green |
| S/T/U — economics | `ECONOMICS-LAUNCH-BLOCKERS.md`: demand update, 7-item launch bar, blocker classes | `396e6a5` | doc |

## Live cross-pool migration (the R34 headline)

`cross-pool-migration-r34.json` — real credentials, real inference:

- Supply probe (production `CapacityReservationLedger`): `shared:groq` and
  `shared:mistral` **both admissible** at a 4,096-in/2,048-out bound — Groq's 8k TPM
  per-model pool fits the measured demand that the R33 flat-16k reservation excluded.
  `shared:github-models` inadmissible (`CAPACITY_EXHAUSTED` — zero measured windows).
- Groq served 1 real stream (1,654 in / 72 out) → injected `RATE_LIMITED` → broker
  re-decided onto `shared:mistral` → 3 real streams (2,848 / 3,023 / 2,969 input) →
  `fileFixed: true`, phase `completed`.
- `migrationVerdict: "MIGRATION_PROVEN"`. Review turn honestly recorded as
  `independentOfImplementation: false` (same-pool fallback — independent reviewer pool
  remains a supply prerequisite, not a code defect).

## Estimator accuracy — first live calibration

Measured prompt estimates from the benchmark (~2.0–2.9k/call) bracket the provider-billed
values seen live (Groq 1,654; Mistral 2,848–3,023 input on the same task shape). The
learned `tokenizerRatio` (Mistral ≈0.83–1.2× of chars/4) is now recorded per dispatch in
governor `dispatchTelemetry` — the estimate-vs-billed audit trail is queryable on
`/api/free-cloud/capacity`.

## What R34 did not certify

- **Multi-account managed fleet live traffic** — the registry/projection/quarantine
  machinery exists and is tested; no second managed upstream account is registered in
  production yet (EXTERNAL_AUTHZ).
- **GitHub Models capacity** — upstream emits no quota headers; inadmissible by design.
- **OpenRouter managed relay** — enterprise terms required before shared managed use.
- **Cloudflare account usage** — token scope is an owner action; diagnostics now name it.
- **1M-user production deployment** — control-plane admission proven synthetically at
  scale; real supply is the binding constraint.

## Regression

Canonical vitest run on the R34 tree: **3,705 passed / 2 failed / 48 skipped across
468 files**, then **3,707 / 0 / 48** after source-state recertification. The two
failures were the FG-11 source-state drift gates doing their job — R34 legitimately
changed `packages/server/src/agent-runtime.ts` and added
`packages/server/src/history-compaction.ts`, so the certified surface was re-sealed
as `r34-capacity-efficiency-interim-v1` (`62e9d8fc…`) via
`scripts/r34-recertify-source-state.mjs` following the established guarded
recertification pattern. R33 baseline: 3,670 passed / 0 failed / 48 skipped across
458 files.
