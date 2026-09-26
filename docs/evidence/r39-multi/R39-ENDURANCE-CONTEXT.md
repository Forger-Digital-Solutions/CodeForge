# R39 — Capacity Endurance, Context Limits, Estimator Calibration, Scale

## Endurance — naturally observed capacity events during the campaign (~2h)

Evidence class: **LIVE_FREE_PROVIDER**. No artificial abuse; events arose from bounded probing.

| Route | Event | Persistence | Fabric response |
|---|---|---|---|
| mistral `mistral-small-latest` | RATE_LIMITED | persistent >20 min (tier gating, not transient) | groq alternate served in 413ms failover |
| mistral `mistral-medium-*` | RATE_LIMITED | persistent across window | never admitted to running tasks |
| mistral `mistral-large-latest` | AUTH_ERROR | catalog-vs-runtime divergence | excluded; logged as confidence evidence |
| groq `openai/gpt-oss-20b` | RATE_LIMITED → PROVIDER_ERROR | depletion during probe | quota-domain exhaustion observed live |
| groq `openai/gpt-oss-120b` | PROVIDER_ERROR ×2 | persistent | model quota domain independent but also exhausted |
| openrouter `google/gemma-4-31b-it:free` | RATE_LIMITED | window | other :free routes kept serving |
| cerebras `gpt-oss-120b` | PAYMENT_REQUIRED | account terminal (credit exhausted) | correctly never entered verified inventory |

**False waits: 0** across ~260 live calls and 13 orchestrator runs — every dispatch either served or failed over to an eligible route.

**Catalog drift**: 3 refreshes over ~1h — zero models appeared/disappeared (21/21 openrouter, 6/6 groq, 37/37 mistral stable). Re-entry remains covered by deterministic lifecycle tests, not live churn.

## Long-context / scarcity (Gate F)

- **Largest live-served context**: `mistral/ministral-8b-latest` at **41,789 billed input tokens** (300KB prompt, 2.4s). `codestral-latest` served 15,815; `cohere/north-mini-code:free` 13,704.
- `mistral-medium-2604` claims 262,144 ctx but was RATE_LIMITED at every attempt — **unproven**, and it failed on quota, never on context rejection.
- Right-fit routing proven deterministically (`free-fabric.test.ts` R37 AH suite, 30/30 green this run): small task prefers tight-fitting pool, large task reaches large-context route, oversized admission beats waiting.

## Estimator calibration (Gate E) — `estimator-calibration.json`

Estimator under test: `estimateTokens = ceil(bytes/2.5) + ceil(lines/8)`. n=11 successful receipts.

| Provider/model | n | ratio actual/est |
|---|---:|---:|
| openrouter cohere/north-mini-code | 4 | 0.43 |
| groq gpt-oss-20b | 2 | 0.43–0.46 |
| mistral codestral-latest | 4 | 0.49 |
| mistral ministral-8b (130KB/300KB) | 2 | ~0.36–0.35 |

**Systematic over-estimation ~2–2.8× on synthetic repetitive content.** Caveat: filler lines tokenize unusually efficiently; real code compresses less. Recommendation: keep raw estimates, do NOT apply a global correction on this corpus — the bias magnitude is content-dependent. Per-model ratios are tightly clustered per model (good for per-model calibration if real-code receipts confirm).

## Scale (Gate K) — `scale-sweep.json`, simulated

3-provider route topology (2 openrouter models + groq + mistral quota domains, two 429 fault windows):

| Users | Tasks | Completed | Starved | Fair | Rate-limit events absorbed |
|---:|---:|---:|---:|---|---:|
| 1 | 2 | 2 | 0 | ✓ | 0 |
| 10 | 20 | 20 | 0 | ✓ | 0 |
| 50 | 100 | 100 | 0 | ✓ | 0 |
| 100 | 200 | 200 | 0 | ✓ | 0 |
| **373** | 746 | 746 | 0 | ✓ | 50 |

373-DAU profile: all tasks complete, zero starvation, zero lease leaks, zero ledger divergences; 50 rate-limit events absorbed by quota-domain failover.
