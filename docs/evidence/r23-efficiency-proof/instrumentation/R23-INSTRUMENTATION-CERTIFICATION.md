# R23 §16 — Instrumentation certification evidence

Status: **R23_INSTRUMENTATION_NOT_READY** — 7 of 8 criteria proven; the ≥98%
provider-usage criterion is unmet *on the current supply mix* (72.1%). The pilot gate
re-runs the full list; this note is the standing evidence ledger.

Measured on `raw/qualification/runs.jsonl` — 39 runs, 172 calls, all campaigns to
2026-09-21T02:25 UTC.

| §16 criterion | status | evidence |
|---|---|---|
| Σ per-call ledger == run totals | PROVEN | golden `r23-context-pricing-arms.test.ts` "catches token totals that do not equal the ledger"; every live run passes `runRecordInvariantViolations` at write |
| ≥98% calls `usage_source: PROVIDER_REPORTED` | **NOT MET — 72.1%** (124/172) | 48 UNKNOWN calls: Nvidia upstream omits usage on served calls; calls failing before a response can't carry usage. This is a supply property, not an instrumentation gap — UNKNOWN is preserved, never estimated. The pilot must run on a usage-reporting route or this criterion cannot pass. |
| Live counter == served ledger calls | PROVEN (+ lag finding) | Cumulative: `free_model_daily_requests.used` = **124** == 124 PROVIDER_REPORTED ledger calls (read 2026-09-21T02:28:50Z). Caveat discovered: the counter lags served calls by ~1–2 min (read 102 at 02:26:34 while 22 calls were settling). Reconciliation must be taken after a settling window, not mid-campaign. |
| Cached tokens populated when reported, UNKNOWN otherwise | PROVEN | `cachedPromptTokens` populated on all 124 reported calls (incl. genuine 0s); absent on UNKNOWN calls. Golden: recording-provider "never invents missing detail fields". |
| Identity completeness on every run | PROVEN | 0/39 runs missing task_id, pair_id, arm, protocol_digest, model, starting/ending tree hash, environment_fingerprint. |
| Verifier + completion-authority verdicts | PROVEN | 0/39 runs missing `completionAuthority`; verifier verdict present whenever the verifier ran (authority BLOCKED/NOT_RUN recorded when it could not). |
| Forced mid-run crash → complete-or-incomplete records | PROVEN | `r23-harness-e2e.test.ts` restart fixture: abort mid-call → incremental ledger intact, pre-crash workspace hashed, no completion claim. |
| Cost conversion == frozen snapshot | PROVEN | `r23-context-pricing-arms.test.ts` pricing goldens incl. cached-token rate, no-cost fallback, unpriced-listing rejection. |
| Arm-configuration tripwire | PROVEN | `r23-context-pricing-arms.test.ts` "accepts the frozen arms and rejects any other difference"; `armConfigurationDigest` on every run. |

## What this means

- Instrumentation itself is certified-grade on every criterion that doesn't depend on
  provider behavior. The failing criterion is *supply-side*: two of tonight's upstreams
  (Nvidia especially) serve `:free` calls without usage payloads.
- Consequence for pilot: prefer a qualified model whose route reports usage. If the only
  qualified route omits usage, the §16 gate cannot certify — an honest outcome that must be
  reported as `R23_INSTRUMENTATION_NOT_READY`, not relaxed.
- New operational rule recorded: counter reconciliation waits ≥2 min after the last call
  (provider counter settles asynchronously).
