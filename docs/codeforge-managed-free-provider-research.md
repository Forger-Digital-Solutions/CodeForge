# Managed Free Provider Research

Status: `RESEARCH_ONLY` — not a route enablement record.

CodeForge may expose a provider to a user through Direct or BYOK when the user brings their own
account. A **managed Free** route is different: CodeForge would hold the provider account and serve
unrelated downstream users. It requires explicit provider authorization, a zero-cost capacity
commitment, a technical qualification, and a policy record. A catalog price of `$0` is not enough.

| Provider | Official finding | Managed Free result |
| --- | --- | --- |
| Cloudflare Workers AI | The free allocation belongs to a Workers account; overage requires the paid plan. | `BLOCKED_PER_ACCOUNT_ALLOWANCE` |
| Cerebras | The public free offer is a $5 trial credit; preview models are evaluation-only. | `BLOCKED_TRIAL_CREDIT` |
| Groq | Free plan limits are organization-scoped; services and credits are customer-account terms. | `BLOCKED_ORGANIZATION_ALLOWANCE` |
| Google Gemini API | Free access is project/tier scoped and model dependent; paid tiers are linked to billing. | `BLOCKED_PROJECT_ALLOWANCE` |
| Mistral | The advertised Free plan concerns product access; API pricing is token-priced. | `BLOCKED_NO_MANAGED_FREE_COMMITMENT` |
| NVIDIA API Catalog | Trial terms restrict API credits to limited, non-production evaluation. | `BLOCKED_TRIAL_NON_PRODUCTION` |
| Z.ai | Public API pricing includes limited-time prices but no recorded managed-downstream grant. | `PENDING_PROVIDER_AUTHORIZATION` |
| OpenRouter | Free models have account-level daily limits; this is not a standing CodeForge capacity grant. | `BLOCKED_ACCOUNT_ALLOWANCE` |

## Consequence

No provider in this table is eligible for CodeForge-managed Free capacity today. The local
`devpool` route is a deterministic fixture and remains excluded from this table. A provider may
move from `PENDING`/`BLOCKED` only after CodeForge stores an explicit authorization and an operator
records the applicable plan, quota, attribution, privacy, region, and suspension terms.

## Official sources reviewed

- [Cloudflare Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Cerebras pricing](https://www.cerebras.ai/pricing)
- [Groq Services Agreement](https://console.groq.com/docs/legal/services-agreement)
- [Groq rate limits](https://console.groq.com/docs/rate-limits)
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- [Mistral pricing](https://mistral.ai/pricing/)
- [Z.ai developer pricing](https://docs.z.ai/guides/overview/pricing)
- [NVIDIA API Trial Terms](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf)
- [OpenRouter FAQ](https://openrouter.ai/docs/faq)

