# R84 provider eligibility

Current research uses official documentation, checked 2026-10-11. Historical registry quotas are inventory metadata and are not refreshed entitlements.

- [Kilo gateway documentation](https://kilo.ai/docs/gateway/models-and-providers) and [terms](https://kilo.ai/terms) allow third-party Gateway API service subject to applicable upstream conditions. Anonymous Free has a source-IP allowance, variable model availability and public-code consent requirements.
- [NVIDIA trial terms](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf) limit trial access to internal testing/evaluation; production generated content/services require a separate subscription. Known Kilo nvidia/ routes are DEVELOPMENT_ONLY. kilo-auto/ is LEGAL_REVIEW_REQUIRED because the selection may use trial endpoints. This extends the existing TERMS_ALLOWED gate and blocks both automatic and executable projection. It does not exempt production from ForgeZero.
- [OpenRouter limits](https://openrouter.ai/docs/api_reference/limits) require account-level live entitlement; separate keys/model names do not prove independence. [Sanctioned PKCE](https://openrouter.ai/docs/use-cases/oauth-pkce) is optional user authorization, not included supply. No user key was read or used.
- [Groq rate limits](https://console.groq.com/docs/rate-limits) are organization/model limits; keys in one organization are not separate supply. No operator entitlement was measured.
- [Cloudflare Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) distinguishes Free hard stops from paid overage and paid-plan model access. The existing plan/neurons guard remains; no owned account allocation was provisioned.
- [BlockRun terms](https://blockrun.ai/terms) and [limits](https://blockrun.ai/docs/rate-limits) remain subject to upstream conditions. Its two live calls were internal public evaluation; Coder quality and cross-gateway independence were not proved.
- [AI Horde definitions](https://raw.githubusercontent.com/Haidra-Org/haidra-assets/main/docs/definitions.md) and [FAQ](https://raw.githubusercontent.com/Haidra-Org/AI-Horde/main/FAQ.md) describe anonymous shared community capacity. Worker visibility, low priority and give-back requirements limit its use; no new Coder qualification was obtained.
- [OpenCode Zen](https://opencode.ai/docs/zen/) sanctioned account/API flows remain optional. Promotions, credentials and logging policies cannot establish zero-touch operator capacity.

Regional availability, all upstream commercial licenses and remaining operator capacity are not universally verified. Do not interpret provider termsStatus CLEARED as independent managed supply or a capacity guarantee.
