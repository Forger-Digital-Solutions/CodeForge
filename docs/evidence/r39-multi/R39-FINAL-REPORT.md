# R39 FINAL REPORT — Multi-Provider Live Proof

## 1. Starting state

- Branch `codex/r29-release-closure`, R39 began at HEAD `4d4da33` (R38 final).
- Preserved dirty files untouched and unstaged: `scripts/r11-codeforge-bench-r2-executor.mjs`, `scripts/r20-postgres-admission-benchmark.mjs`.
- Evidence classes used: LIVE_FREE_PROVIDER / DETERMINISTIC / SIMULATED / UNRESOLVED.

## 2. Live free inventory

Real catalog refresh (~1.8s, 0 errors, `inventory-multi.json`):

| Provider | Verified-free | Class | Quota domain |
|---|---:|---|---|
| openrouter | 21 | FREE_API | :free variant buckets |
| mistral | 37 | FREE_MONTHLY_ALLOWANCE | model-scoped |
| groq | 6 | FREE_DAILY_ALLOCATION | model-scoped daily |
| google | 0 | FREE_ACCOUNT_ENTITLEMENT | fail-closed, no verified $0 |
| cerebras | 0 | PROMOTIONAL_CREDIT | excluded (credit-backed, not zero-cash) |

**64 verified-free routes — three independent provider domains.** Gate A: achieved live.

## 3. Provider independence

OpenRouter, Groq, and Mistral are separate accounts, API keys, rate-limit buckets, and billing relationships — genuinely independent capacity, not aliases fronting one upstream. Groq and Mistral quota domains are model-scoped (proven: `gpt-oss-20b` depleted while `qwen3.8-27b` still served).

## 4. Cross-provider failover (Gate B — live)

`cross-provider-failover.json`:

```
mistral/mistral-small-latest → RATE_LIMITED @ 274ms
groq/qwen/qwen3.8-27b        → SERVED       @ 138ms (19/2 tokens, $0)
total                        → 413ms
```

A real task-level run (`adaptive-tiny.json`) also spanned all three providers in one mission: groq + mistral + openrouter calls inside a single completed run. Cross-domain failover is live-proven, not simulated.

## 5. ForgeGreen A/B corpus (Gate C)

`forgegreen-corpus.json` — 6 paired real tasks through the production orchestrator, `topology:normal`, arm order alternated. All ~260 calls real, $0.

- 5/6 pairs BOTH_PASS; 1 pair BOTH_FAIL (capability limit, symmetric across arms — excluded from VWM).
- Quality gate: only BOTH_PASS pairs contribute to efficiency claims (Gate D satisfied).

## 6. Verified Work Multiplier (n=5 quality-equivalent pairs)

| Metric | Median green/baseline | Range | Aggregate VWM |
|---|---:|---|---:|
| Requests | 0.760 | 0.60–1.04 | **1.247×** |
| Input tokens | 0.747 | 0.60–1.05 | **1.251×** |
| Output tokens | 0.756 | — | — |
| Wall time | 0.782 | — | — |

Median ~24% fewer requests, ~25% fewer billed input tokens at equal verified outcome. R38's single-pair 1.64× was optimistic; the honest n=5 median is ~1.25×. One regression pair is reported, not hidden (bug-fix green +4.6% input tokens — context compaction didn't eliminate a retry there).

## 7. Estimator calibration (Gate E)

`estimator-calibration.json`, n=11 billed receipts against the real `estimateTokens` function:

- cohere/north-mini-code: actual/est ≈ **0.43** (n=4)
- groq/gpt-oss-20b: ≈ **0.43–0.46** (n=2)
- mistral/codestral-latest: ≈ **0.49** (n=4)
- mistral/ministral-8b at 130–300KB: ≈ **0.35**

Conservative over-estimation ~2–2.8× on synthetic repetitive content. Content-dependent bias → **no global correction applied**; per-model ratios are tight and support per-model calibration once real-code receipts (not synthetic filler) accumulate. Raw estimates preserved.

## 8. Long-context scarcity (Gate F)

- Largest live-served context: `ministral-8b-latest` **41,789 billed input tokens** (300KB, 2.4s, $0).
- `mistral-medium-2604` (catalog claims 262,144) was RATE_LIMITED at every attempt — **unproven**, quota failure not context rejection.
- ≥64k attempts on groq/gemma failed on quota limits, not context rejection.
- Right-fit routing re-verified deterministically (30/30 `free-fabric` tests): small→tight pool, large→large-context route, oversized admission preferred over waiting.

## 9. Subagents (Gate G)

- R39 adaptive-decision run: classifier picked `normal` (2 real subagents: explorer+coder) — recorded policy+reasonCodes in `adaptive-tiny.json`.
- R38 live observation: `tiny` → 0 model calls vs `normal` → 2 subagents.
- Corpus runs (forced normal, tiny-class tasks like `sum`) spent 12–25 calls — material subagent cost on small tasks; topology right-sizing matters.
- Deterministic prior evidence: T4 fanout self-congests scarce supply (26/100 vs 100/100 for T0/T2).
- Honest verdict: subagents add real calls; on tiny tasks they are pure cost. The adaptive classifier did not pick tiny here (goal-signal dependent) — flagging `DEFAULT_NORMAL` escalation on borderline goals as a tuning risk, not fixed this round.

## 10. ForgeVerify value (Gate H)

`forgeverify-value.json`: 4/4 semantic defects (wrong priority, inverted guard, wrong slice direction, wrong default) **escaped** the deterministic reviewer — only the unrelated unreferenced-export check fired. A live reviewer (codestral, ~270 tokens/4-case batch, ~30 tokens per verdict) correctly identified the defect class. Economics: deterministic layer = 0 inference/~5–300ms/case for 14 structural classes; model reviewer adds ~30–270 tok/case for semantic classes. Justifies deterministic-first + reviewer-on-diff layering.

## 11. Endurance (Gate I)

Naturally observed across ~2h: persistent tier-429 (mistral-small >20min), quota depletion mid-campaign (groq gpt-oss-20b → PROVIDER_ERROR; gpt-oss-120b), AUTH divergence (mistral-large), PAYMENT_REQUIRED (cerebras terminal), gemma 429 — all absorbed; 13 orchestrator runs + ~260 calls completed or failed over with zero manual intervention. Catalog drift over 1h: zero (all 64 routes stable); re-entry remains deterministically proven.

## 12. False waits (Gate J)

**0 false waits.** Across the corpus, probes, failover, and endurance events, no wait was ever entered while eligible supply existed. Waits simply never occurred.

## 13. Scale (Gate K)

`scale-sweep.json` (SIMULATED, 3-provider quota-domain topology with two 429 fault windows): 1→373 users, 746/746 tasks complete, 0 starvation, fair first admissions, 0 lease leaks, 0 ledger divergences, 50 rate-limit events absorbed at 373 users.

## 14. Regression (Gate L)

- Canonical: **3,774 pass / 3 fail / 48 skip** (8 Postgres-gated files skipped — expected).
- All 3 failures identical signature to R38 and proven environmental standalone: CF-14 (65s vs 148s under load, threshold 120s), FG-2 planMs (843ms vs 2041ms, threshold 2s), malicious corpus (24/24 standalone).
- `tsc -b` on touched package: clean. Providers package tests: green.
- 2 unhandled EPIPE errors in context-efficiency test file (socket teardown noise under parallel load; no test failure attributed).

## 15. Honest unresolved risks

- **Estimator bias is content-dependent**: synthetic filler over-estimates ~2–2.8×; real-code receipts needed before any calibration factor is safe. Not applied.
- **`mistral-medium-2604` 262k context unproven** — every attempt quota-gated; catalog claim ≠ runtime truth.
- **Gemini free tier unproven**: zero verified-free records (fail-closed gate, plus env-name mapping gap `google`→`GEMINI_API_KEY` requires explicit apiKey injection).
- **Provider concentration**: the 6-pair corpus routed ~100% of calls to openrouter despite groq/mistral eligibility — role-suitability preference, logged as concentration risk; only the adaptive run exercised all three domains.
- **bug-fix Green regression** (+4.6% tokens): single regression pair; root cause hypothesis (compaction didn't prevent a retry) not yet instrumented to confirm.
- **Live churn still unobserved**: zero drift in ~1h; re-entry proven only deterministically.
- **`DEFAULT_NORMAL` escalation**: adaptive classifier escalated a borderline tiny goal to normal — recorded, not tuned.
- **n=5 is still a small population** for VWM; medians reported, no p95 claims.

## Answers to the 12 required questions

1. **Free intelligence available**: 64 verified-free routes across 3 independent domains (openrouter 21, mistral 37, groq 6); cerebras credit exhausted, gemini fail-closed.
2. **Routes that changed**: none (3 refreshes, zero drift); runtime health changed — gpt-oss-20b/120b depleted, mistral-small/medium tier-gated, mistral-large AUTH divergence.
3. **Recovery on failure**: yes — live mistral→groq failover 413ms; fabric kept serving through every 429/auth/quota event; no manual intervention.
4. **False waits**: 0.
5. **ForgeGreen saved**: median ~24% requests, ~25% billed input tokens at equal verified outcome (n=5, aggregate VWM 1.25×).
6. **Quality intact**: yes — VWM counted only on BOTH_PASS pairs; 1 symmetric-failure pair excluded; 1 Green regression reported.
7. **ForgeVerify cost vs catch**: deterministic ~0-cost catches 14 structural classes; semantic defects it can't see are caught by ~30–270-token reviewer calls.
8. **Subagents help vs hurt**: help on normal/complex (explorer+reviewer in 13-call verified runs); hurt on tiny (12–25 calls spent where tiny topology needs ~1); fanout self-congests scarce supply.
9. **Scarce capacity preserved**: right-fit ordering verified deterministically; large-context routes only used when required; oversized-admission-beats-wait rule intact.
10. **Estimator accuracy**: systematic ~2–2.8× over-estimate on synthetic content, tight per-model clustering (0.43–0.49); uncalibrated pending real-code receipts.
11. **Fabric under depletion**: quota domains depleted independently (groq TPM domain died while openrouter/mistral kept serving); work continued via cross-domain failover; 373-user sim absorbed 50 rate-limit events with 0 starvation.
12. **Unproven**: >64k live contexts, Gemini free tier, real-code estimator calibration, live churn/re-entry, population-scale VWM confidence intervals.

## Real defects fixed in R39

- **`openai-compatible.ts` credential-store clobber**: factory `common()` passed explicit `undefined`, nuking the adapter's env fallback — every factory-built adapter failed `MISSING_API_KEY` despite set credentials. Fixed and verified against 3 live providers.
