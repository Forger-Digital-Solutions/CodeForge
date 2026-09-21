# R23 §16 — Instrumentation certification evidence

Status: **R23_INSTRUMENTATION_NOT_READY** — awaiting pilot data. Under protocol **v1.0.5**
all eight criteria are *proven on existing evidence* (8/8), but §16 certifies the measuring
equipment **on the pilot run** — certification attaches to pilot telemetry, and no pilot has
run yet (no qualified model). This note is the standing evidence ledger.

Measured on `raw/qualification/runs.jsonl` — all campaigns to 2026-09-21T04:15 UTC
(48 live runs, 335 calls: 245 live served + 73 unserved + 40 scripted dry-run excluded below).

| §16 criterion | status | evidence |
|---|---|---|
| Σ per-call ledger == run totals | PROVEN | golden `r23-context-pricing-arms.test.ts` "catches token totals that do not equal the ledger"; every live run passes `runRecordInvariantViolations` at write |
| ≥98% served calls `usage_source: PROVIDER_REPORTED` (v1.0.5 denominator) | **PROVEN — 100.0%** (245/245 live served calls) | v1.0.5 counts *served* calls (any provider HTTP response). Live served: openrouter 183/183, groq 62/62 — every `outcome: ok` call carried provider usage. All 90 UNKNOWN calls were unserved errors (502/429/stream-cut) which §2.2 already counts as reliability failures. **Transparency: the all-calls figure is 73.1% (245/335)** — kept visible so the denominator change cannot hide the supply-side failure rate. Counterpart finding: the earlier claim "Nvidia omits usage on served calls" was wrong — recomputation shows every served call reported; only unserved calls lacked usage. |
| Live counter == served ledger calls | PROVEN (+ lag finding) | Cumulative: `free_model_daily_requests.used` = **124** == 124 PROVIDER_REPORTED ledger calls (read 2026-09-21T02:28:50Z). Caveat: counter lags ~1–2 min; reconcile after settlement, not mid-campaign. Substitute routes without a request counter (groq) satisfy this clause via per-response `x-ratelimit` capture in the call ledger (v1.0.5). |
| Cached tokens populated when reported, UNKNOWN otherwise | PROVEN | `cachedPromptTokens` populated on all reported calls (incl. genuine 0s); absent on UNKNOWN calls. Golden: recording-provider "never invents missing detail fields". |
| Identity completeness on every run | PROVEN | 0/48 runs missing task_id, pair_id, arm, protocol_digest, model, starting/ending tree hash, environment_fingerprint. |
| Verifier + completion-authority verdicts | PROVEN | 0/48 runs missing `completionAuthority`; verifier verdict present whenever the verifier ran (authority BLOCKED/NOT_RUN recorded when it could not). |
| Forced mid-run crash → complete-or-incomplete records | PROVEN | `r23-harness-e2e.test.ts` restart fixture: abort mid-call → incremental ledger intact, pre-crash workspace hashed, no completion claim. |
| Cost conversion == frozen snapshot | PROVEN | `r23-context-pricing-arms.test.ts` pricing goldens incl. cached-token rate, no-cost fallback, unpriced-listing rejection. v1.0.4 adds substitute-route equivalents (`groq::*` → same model's paid OR listing) — additive entries, arithmetic unchanged. |
| Arm-configuration tripwire | PROVEN | `r23-context-pricing-arms.test.ts` "accepts the frozen arms and rejects any other difference"; `armConfigurationDigest` on every run. |

## What this means

- Instrumentation is certified-grade on all eight criteria **on existing evidence**, including
  the provider-usage criterion under the corrected served-calls denominator (100%).
- The remaining step is procedural: run the pilot on a qualified model and re-verify this
  table on pilot telemetry. If the pilot's route degrades (e.g., Groq stream interrupts recur
  on >2% of served calls — interrupted calls are unserved and excluded from the denominator,
  but *served* calls that drop usage would fail it), certification fails honestly.
- New operational rule recorded: counter reconciliation waits ≥2 min after the last call
  (provider counter settles asynchronously); substitute routes reconcile via quota headers.
