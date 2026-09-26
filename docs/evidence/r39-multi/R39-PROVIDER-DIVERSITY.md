# R39 Phase 2–3 — Multi-Provider Free-Supply Audit + Live Cross-Provider Failover

Evidence class: **LIVE_FREE_PROVIDER** (all probes are real API calls; receipts in `inventory-multi.json`, `provider-probes.json`, `cross-provider-failover.json`).

## Credential and adapter audit

Environment contained more credentials than R38 used: `GROQ_API_KEY` (gsk_…), `MISTRAL_API_KEY`, `CEREBRAS_API_KEY` (csk-…), `GEMINI_API_KEY` (AIza…), `OPENROUTER_API_KEY`, `GITHUB_MODELS_TOKEN`, `OPENAI_API_KEY`. Presence of a key does not establish free eligibility — each was checked against provider-definition access classes.

## Defect found and fixed (real bug, not cosmetic)

`createProviderAdapterById(id)` always produced adapters that failed with `MISSING_API_KEY` even when `<PROVIDER>_API_KEY` was set. Root cause: the factory's `common()` helper returns `credentialStore: opts.credentialStore` as an own property with value `undefined` when no store is passed; spread order in `OpenAICompatibleAdapter`'s constructor then **overwrote** the `new EnvironmentCredentialStore()` default with `undefined`. The class comment explicitly claimed env fallback — the code contradicted it. Fixed in `packages/providers/src/openai-compatible.ts` by normalizing `cfg.credentialStore ?? new EnvironmentCredentialStore()` after the spread. Verified: groq (11 models), mistral (44), cerebras (2) catalogs list live after fix.

Second mapping gap (not fixed, workaround used): `EnvironmentCredentialStore` resolves `GOOGLE_API_KEY` for provider id `google`, but the configured credential is `GEMINI_API_KEY`. The refresh was run with `apiKey` passed explicitly to the google adapter. Google produced **zero** verified-free records (fail-closed Gemini free-policy gate found no $0 evidence — correct behavior).

## Verified-free inventory (live refresh, ~1.8s, 0 errors)

| Provider | Verified-free models | Access class | Quota domain | Independence |
|---|---:|---|---|---|
| openrouter | 21 | FREE_API (`:free` variants) | provider/model | independent account + key |
| mistral | 37 | FREE_MONTHLY_ALLOWANCE | model-scoped allowance | independent account + key |
| groq | 6 | FREE_DAILY_ALLOCATION | model-scoped daily | independent account + key |
| google | 0 | FREE_ACCOUNT_ENTITLEMENT | — | fail-closed (no verified $0) |
| cerebras | 0 | PROMOTIONAL_CREDIT | credit pool | excluded — not zero-cash class |

**Three genuinely independent free provider domains are live-proven** (separate accounts, keys, RPM/TPM/daily/monthly buckets). Gate A satisfied.

Notable inventory models: `mistral-medium-2604` (catalog claims contextWindow 262,144 — largest legitimate free-context route), `groq openai/gpt-oss-120b`, `openrouter nvidia/nemotron-3-ultra-550b-a55b:free`.

## Live probes (real calls)

| Provider/model | Result | Latency | Billed |
|---|---|---:|---:|
| groq `openai/gpt-oss-20b` | SERVED | 364ms | 78 in / 8 out, $0 |
| mistral `mistral-small-latest` | RATE_LIMITED | 195ms | — |
| mistral `codestral-latest` | SERVED | 329ms | 10/2, $0 |
| mistral `mistral-medium-latest` | RATE_LIMITED | 356ms | — |
| mistral `mistral-large-latest` | AUTH_ERROR | 184ms | — |
| cerebras `gpt-oss-120b` | PAYMENT_REQUIRED | 117ms | — |

## Catalog vs runtime divergence (Phase 14, real evidence)

- `mistral-large-latest` was admitted by allowance verification but runtime returns AUTH_ERROR — free plan does not entitle that model. Confidence-threshold semantics (not one-shot demotion) should apply.
- `cerebras` catalog lists 2 models but the account's $5 trial credit is exhausted → PAYMENT_REQUIRED. Correctly never entered verified-free inventory; PROMOTIONAL_CREDIT is not a zero-cash class.
- `mistral-medium-*` routes RATE_LIMITED on first contact — free-tier model gating, observed as natural capacity events.

## Live cross-provider failover (Gate B — REAL, not simulated)

Natural failure, real alternate dispatch (`cross-provider-failover.json`):

```
mistral/mistral-small-latest  → RATE_LIMITED @ 274ms
groq/qwen/qwen3.8-27b         → SERVED       @ 138ms  (19 in / 2 out, $0)
total end-to-end              → 413ms
```

This is provider-domain failover (different account, key, and quota domain), not same-gateway model-to-model. Combined with R38's intra-provider 710ms trace, both failover classes are now live-proven.

## False-wait check (Gate J, partial)

During the failover probe and the 12-run A/B corpus, zero wait events occurred — every dispatch found eligible supply. No false waits observed.
