# R4 provider and capacity research — 2026-09-15

This is a dated research record for routing policy, not a promise that any provider has unlimited
capacity. Exact runtime limits remain header- and account-authoritative.

## OpenRouter account check

Read-only live checks were performed with the configured account key; the key value was never
printed and no inference request was made.

| Check | Observed result | Decision |
|---|---|---|
| `GET /api/v1/credits` | HTTP 200; `total_credits=10`; `total_usage=0` | The account has crossed the documented credit threshold. |
| `GET /api/v1/key` | HTTP 200; `is_free_tier=false`; key rate-limit field `-1` per `10s`; no daily free counter | Do not treat the key rate-limit field as the `:free` daily allowance. |
| `:free` daily allowance | OpenRouter's FAQ documents 50/day below $10 purchased credits and 1,000/day at or above $10 | Model 1,000 daily `:free` requests as account-qualified, but reconcile actual remaining capacity from response headers. |

Sources: [OpenRouter FAQ](https://openrouter.ai/docs/faq), [credits API](https://openrouter.ai/docs/api/api-reference/credits/get-credits), [current-key API](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key), and the [live public model catalog](https://openrouter.ai/api/v1/models).

The $10 credit balance authorizes the documented free-model allowance; it does not authorize paid
fallback. ForgeZero keeps `PAID` ineligible and treats OpenRouter model ids with `:free` as free
only after their explicit zero price and current availability are verified.

## Provider evidence matrix

| Provider | Current evidence | R4 treatment |
|---|---|---|
| OpenRouter | Account-qualified 1,000/day `:free` policy; exact remaining counter not exposed | Enabled as an account-scoped request window; runtime headers are authoritative. |
| Groq | Official limits are organization/model-specific and published in response headers | Recurring free route; do not hard-code account-specific limits. |
| Cloudflare Workers AI | Official free allocation is 10,000 neurons/day; some newer models require Workers Paid | Count only explicitly free models and neurons; paid-only models stay blocked. |
| Cerebras | Official limits are organization/model-specific with RPM/TPM/daily examples and headers | Candidate recurring route; qualify account and model before promotion. |
| Kilo | Anonymous `:free` routes are IP-scoped and availability/data treatment changes | Catalogued, disabled in the R4 baseline until terms/privacy qualification. |
| Gemini | Per-project RPM/TPM/RPD limits; daily reset is provider-defined | User-scaled candidate; no universal quota asserted. |
| Mistral | Plan and Admin usage/limits define current allowance | Research candidate; no unverified free capacity asserted. |
| Hugging Face | Free inference-provider credit is small and subject to change; extra use requires purchase | Not a durable default backend. |
| Z.AI | Existing curated definition remains the source of truth until live qualification | No new capacity claim in this window. |

Primary sources: [Groq limits](https://console.groq.com/docs/rate-limits), [Cloudflare pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [Cloudflare limits](https://developers.cloudflare.com/workers-ai/platform/limits/), [Cloudflare paid-model notice](https://developers.cloudflare.com/changelog/post/2026-07-28-models-require-workers-paid/), [Cerebras limits](https://inference-docs.cerebras.ai/support/rate-limits), [Cerebras pricing](https://inference-docs.cerebras.ai/support/pricing), [Kilo free usage](https://kilo.ai/docs/getting-started/using-kilo-for-free), [Kilo authentication](https://kilo.ai/docs/gateway/authentication), [Gemini limits](https://ai.google.dev/gemini-api/docs/rate-limits), [Mistral limits](https://docs.mistral.ai/admin/billing-usage/usage-limits), and [Hugging Face pricing](https://huggingface.co/docs/inference-providers/pricing).

Models.dev remains discovery-only. An entry can suggest a model or provider for research, but it
cannot make a route ForgeAuto-eligible, change privacy classification, or authorize paid spillover.
