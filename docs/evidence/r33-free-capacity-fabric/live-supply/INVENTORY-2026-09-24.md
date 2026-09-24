# R33 Live Supply Inventory — 2026-09-24

Source: `scripts/r33-live-supply-probe.mjs` + targeted follow-up probes (same session).
Raw probe artifact: `live-supply-2026-09-24.json` (credentials redacted; Google echoed the
submitted key inside its own error body — scrubbed).

Every status below is measured against a real credential in this environment, not copied
from marketing pages. "Model exists in catalog" is never counted as capacity.

## Quota domains (physical pools)

| # | Provider / pool | Status | Measured window(s) | Evidence |
|---|---|---|---|---|
| 1 | **Groq org — per-model pools** | `LIVE_VERIFIED` | 1,000 req + 8,000 TPM per model (first call on each of gpt-oss-120b, gpt-oss-20b, qwen3.8-27b all reported `remaining=999`) | JSON `groq.inferenceProbe.headers`; reset `1m26.4s` req / `630ms` tok |
| 2 | **Mistral org — codestral** | `LIVE_VERIFIED` | 125 req/min + 625,000 tok/min on `codestral-latest` | terminal probe, headers `x-ratelimit-*-req-minute` / `*-tokens-minute` (previously unparsed — parser gap fixed this commit) |
| 3 | **Mistral org — devstral/mistral-small** | `OUT_OF_CAPACITY` | `x-ratelimit-limit-req-minute: 0`, `remaining: 0` | JSON `mistral.inferenceProbe` (HTTP 429) |
| 4 | **Cloudflare account — neuron pool** | `LIVE_VERIFIED` | 10,000 neurons/day account-wide (docs); measured per-call cost: glm-4.7-flash 0.35n, llama-3.3-70b 1.48n | JSON `cloudflare-workers-ai`; header `cf-ai-neurons` |
| 5 | **GitHub Models account** | `LIVE_VERIFIED` (unquantified) | inference 200 on `openai/gpt-4.1-mini`; **no quota headers returned**; catalog endpoint gone | JSON `github-models` |
| 6 | **OpenRouter account — free-model pool** | `POLICY_BLOCKED` | 1,000 req/day account-wide; 282 remaining at measurement; 21 `:free` models share it | JSON `openrouter.keyReceipt` |
| 7 | **Cerebras org — $5/30d trial** | `EXHAUSTED` | HTTP 402 `payment_required_error` on `gpt-oss-120b` | follow-up probe (first 404 was a model-name miss; corrected probe shows the real state) |
| 8 | **Google project (Gemini)** | `AUTH_OR_POLICY_BLOCKED` | `CONSUMER_SUSPENDED` — project `247254299611` suspended; both configured keys hit the same project | JSON `google.inferenceProbe` |

## What this means for managed Free supply

Counted as **current usable managed-free request supply** (shared owner pool, verified-free
route, working credential, measured quota):

- Groq: ≥3 confirmed per-model request pools @ 1,000 req + 8,000 TPM each — org-scoped
  accounting needs care: per-model headers do not prove the pools are independent; Groq
  documents org-level daily token caps too. Treat each model pool as a route-level window
  inside ONE org quota domain.
- Mistral codestral: 125 RPM / 625k TPM — the single largest measured token pool.
- Cloudflare: 10k neurons/day (CodeForge ceiling 8k) across all free-plan models.
- GitHub Models: verified serving but unquantified — no quota headers, no registry adapter,
  no published free-tier contract measured. `UNKNOWN`, never zero, never assumed.

Not counted: OpenRouter (282 remaining but `POLICY_BLOCKED` pending hosted-use agreement),
Cerebras (trial dead), Gemini (project suspended), Mistral non-codestral models (limit 0).

## Provider-side blockers found while measuring

- **GraphQL `aiInferenceAdaptiveGroups`** exists and exposes `sum.totalNeurons` — the
  account-level neuron oracle the budget guard needs. This token lacks analytics scope
  (`not authorized for that account`). With a scoped token the guard unlocks; without it the
  shipping adapter now fails closed with `CLOUDFLARE_USAGE_UNKNOWN` instead of silently
  bypassing the budget — see `GraphqlCloudflareUsageSource`.
- **Shipping Cloudflare adapter was dead code**: nothing ever injected a `usageSource`, so
  every request threw `CLOUDFLARE_USAGE_UNKNOWN`. Fixed in `apps/desktop/src/main.ts`
  (GraphQL source + `FileCloudflareNeuronBudgetStore` under userData).
- Mistral per-minute header aliases were invisible to both quota parsers — measured values
  (124/125 RPM, 624,990/625,000 TPM) were being discarded. Fixed in `quota.ts` +
  `route-health-authority.ts`.
- `quotaWindows`/`capacityRoutingAdvice`/`quotaRemaining` reported stale `remaining: 0`
  forever after a declared reset elapsed (no traffic → no fresh headers → permanent
  stranding). `effectiveQuota` now refills to the provider-declared limit — the reset is
  the provider's own contract, not an invented number.

## Honesty notes

- Groq "per-model pools" are reported by headers per model; Groq also enforces org-level
  daily token budgets. Until org-level measurement distinguishes them, the inventory
  records ONE org domain with per-model route windows — never summed as independent pools.
- `github-models` has no `PROVIDER_DEFINITIONS` entry; it is a candidate domain only.
- Cerebras `404` on `llama-3.3-70b` was a model-access miss; the corrected `gpt-oss-120b`
  probe returned `402 payment_required` — trial credit exhausted, not recurring supply.
