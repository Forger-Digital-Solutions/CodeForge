# CodeForge Managed-Free Provider Certification Ledger

Status: `IMPLEMENTED_LIVE_ACTIVATION_REQUIRED` (with `Z.AI` quarantined under `HOSTED_POLICY_AUTHORIZATION_REQUIRED`) as of 2026-09-13.
The code-reviewed static inventory is `packages/cloud-gateway/src/managed-free-inventory.ts`. An upstream `/models` listing cannot activate an unapproved route.

CodeForge may expose a provider to a user through Direct or BYOK when the user brings their own account. A **managed Free** route is fundamentally different: CodeForge holds the provider account and serves unrelated downstream users without requiring user keys or payments. This requires explicit provider authorization, a durable zero-cost capacity commitment, technical qualification, zero-billing fail-closed guarantees, and an authorized policy record. A catalog price of `$0` is not enough.

---

## 1. Primary Summary Table

| Provider | Status | Models Admitted | Free Quota / Mechanism | Recurring? | Card Required? | Downstream Multi-Tenant Use |
| --- | --- | --- | --- | --- | --- | --- |
| **Groq** | `IMPLEMENTED_AWAITING_OPERATOR_CREDENTIAL` | `openai/gpt-oss-120b`, `openai/gpt-oss-20b` | 30 RPM, 1K RPD, 8K TPM, 200K TPD per route | Yes (Daily) | No | Yes (via server gateway; global capacity) |
| **Cloudflare Workers AI** | `IMPLEMENTED_RESERVE_AWAITING_OPERATOR_CREDENTIAL` | `@cf/zai-org/glm-4.7-flash` (reserve) | 10,000 Neurons/day | Yes (Daily) | No | Yes (via Cloudflare Workers infrastructure) |
| **Z.AI** | `IMPLEMENTED_POLICY_RECORD_REQUIRED` | `glm-4.7-flash` | Published $0 unit price | Yes (Unit $0) | No | Quarantined pending formal governance record |
| **Google Gemini API** | `CONDITIONAL_NOT_ENABLED` | None | Free tier per-project | Yes | No | BYOK only; trains on unpaid data |
| **OpenRouter** | `BYOK_ONLY` | None | 50 RPD on `:free` variants | Yes | No | BYOK only; pooling prohibited |
| **GitHub Models** | `NOT_APPROVED_EVALUATION_ONLY` | None | Personal GitHub account limits | Yes | No | Prototyping only; no server pooled API |
| **Cerebras** | `BLOCKED_TRIAL_CREDIT` | None | $5 one-time trial credit | No (30-day) | No | No (promotional trial only) |
| **SambaNova Cloud** | `RESEARCHED_NOT_APPROVED` | None | Free tier while no card linked | Yes | No | No (individual developer; potential spillover) |
| **Mistral AI** | `BLOCKED_NO_MANAGED_FREE_COMMITMENT` | None | Experiment plan | Yes | No | No (requires data training opt-in) |
| **NVIDIA API Catalog** | `BLOCKED_TRIAL_NON_PRODUCTION` | None | 1,000 trial credits | No | No | No (terms strictly prohibit production use) |
| **Fireworks AI** | `BLOCKED_TRIAL_CREDIT` | None | $1 sign-up trial credit | No | No | No (one-time trial, PAYG thereafter) |
| **Together AI** | `BLOCKED_TRIAL_CREDIT` | None | $5 promotional credit | No | No | No (one-time promotional credit) |
| **Hugging Face** | `BLOCKED_NO_MANAGED_FREE_COMMITMENT` | None | Throttled community serverless | Yes | No | No (unsuitable latency/cold starts; router paid) |
| **DeepInfra** | `BLOCKED_TRIAL_CREDIT` | None | $1.80 initial trial credit | No | No | No (one-time trial, PAYG thereafter) |
| **Nebius AI Studio** | `BLOCKED_TRIAL_CREDIT` | None | Temporary trial grant | No | No | No (one-time trial, PAYG thereafter) |
| **SiliconFlow** | `LEGAL_REVIEW_REQUIRED` | None | Promotional tokens (phone-gated)| No | No | No (unreviewed multi-tenant terms) |
| **Hyperbolic** | `BLOCKED_TRIAL_CREDIT` | None | $1 signup credit | No | No | No (one-time trial, PAYG marketplace) |
| **Scaleway** | `PAID_API` | None | None | No | Yes | No (paid API from first token) |
| **Clarifai** | `UNSUITABLE_QUOTA` | None | 1,000 operations/month | Yes | No | No (1,000 ops exhausted in minutes) |
| **Replicate** | `BLOCKED_TRIAL_CREDIT` | None | Micro trial run time | No | Yes | No (card required after trial) |
| **Cohere** | `BLOCKED_TRIAL_NON_PRODUCTION` | None | 40 RPM trial key | Yes | No | No (terms explicitly prohibit serving end users) |
| **Ollama Cloud** | `NOT_APPROVED` | None | None | No | No | No (no zero-cost hosted multi-tenant API) |

---

## 2. Detailed Provider Assessments

### Groq
- **Exact Model(s)**: `openai/gpt-oss-120b`, `openai/gpt-oss-20b`
- **Status**: `IMPLEMENTED_AWAITING_OPERATOR_CREDENTIAL`
- **Why**: Published recurring daily developer allowance with hard stop on free plan. Free limits are organization-scoped (shared upstream global capacity).
- **Free Allowance**: 30 RPM, 1,000 RPD, 8,000 TPM, 200,000 TPD per route.
- **Recurring vs One-Time**: Recurring daily.
- **Payment Method Requirement**: None on free plan.
- **Production Use Status**: Permitted within rate limits.
- **Downstream End-User Rights**: Permitted via server-side gateway relay.
- **Data-Use / Privacy Terms**: Standard developer API terms; enterprise standard API inputs/outputs not used for training.
- **Important Restrictions**: Organization-wide quotas must be modeled as global provider capacity, separate from individual user allowances. Requires operator attestation `CODEFORGE_GROQ_FREE_PLAN_ONLY=true` to prevent paid Developer tier charges.
- **Quota Scope**: Organization-wide.
- **Failure Behavior**: HTTP 429 with `Retry-After` header; hard stop on free plan.
- **First-Party Source**: [Groq Rate Limits](https://console.groq.com/docs/rate-limits), [Groq Services Agreement](https://console.groq.com/docs/legal/services-agreement).
- **Source / Effective Date**: 2026-09-13.
- **Verified Date**: 2026-09-13.
- **Re-Review Trigger**: Rate limit adjustments, model deprecations, or terms alterations.

### Cloudflare Workers AI
- **Exact Model(s)**: `@cf/zai-org/glm-4.7-flash` (reserve route)
- **Status**: `IMPLEMENTED_RESERVE_AWAITING_OPERATOR_CREDENTIAL`
- **Why**: Workers Free accounts include 10,000 Neurons/day allowance with zero financial outlay.
- **Free Allowance**: 10,000 Neurons/day.
- **Recurring vs One-Time**: Recurring daily.
- **Payment Method Requirement**: None on Workers Free.
- **Production Use Status**: Permitted on free tier within daily neuron limits.
- **Downstream End-User Rights**: Permitted via Cloudflare Workers architecture.
- **Data-Use / Privacy Terms**: Cloudflare request telemetry and security controls per standard privacy policy.
- **Important Restrictions**: Limited strictly to reviewed `@cf/zai-org/glm-4.7-flash` reserve route; requires operator attestation `CODEFORGE_CLOUDFLARE_FREE_PLAN_ONLY=true`; never enable Workers Paid or unified billing.
- **Quota Scope**: Account-wide.
- **Failure Behavior**: HTTP 429 or daily neuron limit error; hard stop without billing.
- **First-Party Source**: [Cloudflare Workers AI Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).
- **Source / Effective Date**: 2026-08-28.
- **Verified Date**: 2026-09-13.
- **Re-Review Trigger**: Neuron calculation revisions, free allowance changes, or model changes.

### Z.AI
- **Exact Model(s)**: `glm-4.7-flash`
- **Status**: `IMPLEMENTED_POLICY_RECORD_REQUIRED`
- **Why**: Technical adapter and exact inventory allowlist implemented and tested. Published $0 unit price for input, output, and context cache. Quarantined because the repository's policy layer requires a formal reviewed hosted-routing authorization record before multi-tenant user prompts may be relayed to Z.AI.
- **Free Allowance**: Published $0 unit price for tokens.
- **Recurring vs One-Time**: Recurring $0 unit price.
- **Payment Method Requirement**: None for $0 model.
- **Production Use Status**: Permitted on standard API.
- **Downstream End-User Rights**: Pending legal/privacy policy authorization record.
- **Data-Use / Privacy Terms**: Subject to Zhipu AI enterprise privacy policy and hosted routing legal review.
- **Important Restrictions**: Strictly limited to `glm-4.7-flash`; all paid built-in tools (Web Search @ $0.01/call, code interpreter) are disabled. Quarantined from routing execution until policy record approved.
- **Quota Scope**: Account RPM/TPM.
- **Failure Behavior**: HTTP 429 / HTTP 403; fail-closed without paid fallback.
- **First-Party Source**: [Z.ai Pricing](https://docs.z.ai/guides/overview/pricing).
- **Source / Effective Date**: 2026-09-13.
- **Verified Date**: 2026-09-13.
- **Re-Review Trigger**: Unit price changes or completion of formal hosted routing policy review.

### Google Gemini API
- **Exact Model(s)**: None (conditional BYOK only)
- **Status**: `CONDITIONAL_NOT_ENABLED`
- **Why**: Free tier terms allow Google to use prompt and response data for product training and human review. Geography and age restrictions apply. Cannot be used as a silent default for private code repositories.
- **Free Allowance**: Per-project RPM/RPD limits in Google AI Studio.
- **Recurring vs One-Time**: Recurring.
- **Payment Method Requirement**: None on unpaid tier.
- **Production Use Status**: Development and prototyping only.
- **Downstream End-User Rights**: Permissive data classification incompatible with default managed service.
- **Data-Use / Privacy Terms**: Permissive: human review and product training permitted on unpaid tier.
- **Important Restrictions**: Prohibited from default managed pool; retained as optional user BYOK only.
- **Quota Scope**: Google Cloud / AI Studio project.
- **Failure Behavior**: HTTP 429 quota exhaustion.
- **First-Party Source**: [Gemini API Pricing](https://ai.google.dev/gemini-api/docs/pricing).
- **Source / Effective Date**: 2026-09-13.
- **Verified Date**: 2026-09-13.
- **Re-Review Trigger**: Policy changes eliminating human review/training on unpaid API.

### OpenRouter
- **Exact Model(s)**: None (BYOK / OAuth PKCE only)
- **Status**: `BYOK_ONLY`
- **Why**: Free models carry account-wide daily limits (50 RPD for accounts without purchased credits). Upstream terms do not permit pooling single-account free quotas for multi-tenant commercial agent operations.
- **Free Allowance**: 20 RPM, 50 RPD on `:free` variants.
- **Recurring vs One-Time**: Recurring daily.
- **Payment Method Requirement**: None for `:free` models.
- **Production Use Status**: Personal developer use.
- **Downstream End-User Rights**: End-user individual use only.
- **Data-Use / Privacy Terms**: Dependent on underlying upstream model host.
- **Important Restrictions**: Cannot pool capacity across multi-tenant CodeForge Cloud users.
- **Quota Scope**: Account-level.
- **Failure Behavior**: HTTP 429 or HTTP 402.
- **First-Party Source**: [OpenRouter FAQ & Limits](https://openrouter.ai/docs/faq).
- **Source / Effective Date**: 2026-09-12.
- **Verified Date**: 2026-09-13.
- **Re-Review Trigger**: Availability of authorized multi-tenant distributor program.

### Cerebras
- **Exact Model(s)**: None
- **Status**: `BLOCKED_TRIAL_CREDIT`
- **Why**: Public free tier was converted to a one-time $5 trial credit expiring 30 days after grant. No durable recurring zero-cost tier exists.
- **Free Allowance**: $5 trial credits valid for 30 days.
- **Recurring vs One-Time**: One-time trial credit.
- **Payment Method Requirement**: None for initial trial.
- **Production Use Status**: Trial evaluation only.
- **Downstream End-User Rights**: None for pooled managed routing.
- **Data-Use / Privacy Terms**: Standard developer terms.
- **Important Restrictions**: Access hard-stops upon credit exhaustion or 30-day expiration.
- **Quota Scope**: Account.
- **Failure Behavior**: Hard stop upon trial credit expiration.
- **First-Party Source**: [Cerebras Rate Limits](https://inference-docs.cerebras.ai/support/rate-limits).
- **Source / Effective Date**: 2026-09-12.
- **Verified Date**: 2026-09-13.
- **Re-Review Trigger**: Introduction of a permanent recurring free tier.

### SambaNova Cloud
- **Exact Model(s)**: None
- **Status**: `RESEARCHED_NOT_APPROVED`
- **Why**: Free Tier exists for individual developer testing while no payment method is linked. Developer Tier bills if payment method is attached. Terms do not license multi-tenant server-side pooling or resale of free capacity to downstream third-party end users.
- **Free Allowance**: Model-specific RPM/RPD limits on free tier.
- **Recurring vs One-Time**: Recurring developer tier.
- **Payment Method Requirement**: None while on Free Tier.
- **Production Use Status**: Developer evaluation.
- **Downstream End-User Rights**: Individual developer only.
- **Data-Use / Privacy Terms**: Standard developer API terms.
- **Important Restrictions**: Potential spillover risk if payment method is linked; no multi-tenant pooled resale license.
- **Quota Scope**: Account.
- **Failure Behavior**: HTTP 429 or billable spillover if payment method added.
- **First-Party Source**: [SambaNova Rate Limits](https://docs.sambanova.ai/docs/en/models/rate-limits).
- **Source / Effective Date**: 2026-09-12.
- **Verified Date**: 2026-09-13.
- **Re-Review Trigger**: Commercial multi-tenant enterprise managed free partnership or license grant.

### Mistral AI
- **Exact Model(s)**: None
- **Status**: `BLOCKED_NO_MANAGED_FREE_COMMITMENT`
- **Why**: Free 'Experiment' plan requires phone verification and explicitly opts user prompt data into model training. API usage is token-billed. Prohibited from zero-setup managed free infrastructure.
- **Free Allowance**: Rate-limited Experiment plan.
- **Recurring vs One-Time**: Recurring developer plan.
- **Payment Method Requirement**: None for Experiment tier.
- **Production Use Status**: Experimentation only.
- **Downstream End-User Rights**: Personal developer only.
- **Data-Use / Privacy Terms**: Permissive: data training opt-in required.
- **Important Restrictions**: Phone verification required; data used for training; not licensed for multi-tenant backend pooling.
- **Quota Scope**: Workspace.
- **Failure Behavior**: HTTP 429.
- **First-Party Source**: [Mistral La Plateforme Tiers](https://docs.mistral.ai/deployment/laplateforme/tier).
- **Source / Effective Date**: 2026-09-12.
- **Verified Date**: 2026-09-13.
- **Re-Review Trigger**: Strict privacy zero-cost tier without training opt-in.

### NVIDIA API Catalog
- **Exact Model(s)**: None
- **Status**: `BLOCKED_TRIAL_NON_PRODUCTION`
- **Why**: 1,000 evaluation credits are strictly governed by NVIDIA API Trial Terms of Service, which explicitly restrict use to non-commercial, non-production evaluation and prototyping.
- **Free Allowance**: 1,000 one-time trial credits.
- **Recurring vs One-Time**: One-time trial credits.
- **Payment Method Requirement**: None for initial trial.
- **Production Use Status**: Strictly non-production evaluation.
- **Downstream End-User Rights**: None for commercial/production distribution.
- **Data-Use / Privacy Terms**: Standard NVIDIA API trial terms.
- **Important Restrictions**: Production deployment requires self-hosted NIM or enterprise licensing; trial terms prohibit serving production users.
- **Quota Scope**: Account.
- **Failure Behavior**: Hard stop when credits depleted.
- **First-Party Source**: [NVIDIA API Trial Terms](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf).
- **Source / Effective Date**: 2026-09-12.
- **Verified Date**: 2026-09-13.
- **Re-Review Trigger**: Introduction of production-licensed recurring free tier.

### Fireworks AI
- **Exact Model(s)**: None
- **Status**: `BLOCKED_TRIAL_CREDIT`
- **Why**: Pay-as-you-go inference API. Provides only a one-time $1 sign-up credit for initial testing; no recurring zero-cost tier.
- **Free Allowance**: $1 one-time sign-up credit.
- **Recurring vs One-Time**: One-time trial credit.
- **Payment Method Requirement**: None for $1 credit; credit card required thereafter.
- **Production Use Status**: Evaluation only for trial.
- **Downstream End-User Rights**: BYOK only.
- **Data-Use / Privacy Terms**: Enterprise privacy on standard API.
- **Important Restrictions**: Paid billing applies immediately after $1 credit exhaustion.
- **Quota Scope**: Account.
- **Failure Behavior**: HTTP 402 / HTTP 429 when trial balance exhausted.
- **First-Party Source**: [Fireworks AI Pricing](https://fireworks.ai/pricing).
- **Source / Effective Date**: 2026-09-12.
- **Verified Date**: 2026-09-13.
- **Re-Review Trigger**: Establishment of a permanent free tier.

### Together AI
- **Exact Model(s)**: None
- **Status**: `BLOCKED_TRIAL_CREDIT`
- **Why**: Pay-as-you-go inference platform. Provides a one-time $5 promotional credit upon registration; no perpetual zero-cost API allowance.
- **Free Allowance**: $5 one-time promotional credit.
- **Recurring vs One-Time**: One-time trial credit.
- **Payment Method Requirement**: None for $5 credit; credit card required thereafter.
- **Production Use Status**: Trial evaluation.
- **Downstream End-User Rights**: BYOK only.
- **Data-Use / Privacy Terms**: Standard API data privacy policy.
- **Important Restrictions**: Paid billing required after promotional credit spent.
- **Quota Scope**: Account.
- **Failure Behavior**: HTTP 402 payment required.
- **First-Party Source**: [Together AI Pricing](https://www.together.ai/pricing).
- **Source / Effective Date**: 2026-09-12.
- **Verified Date**: 2026-09-13.
- **Re-Review Trigger**: Establishment of a permanent zero-cost tier.

### Hugging Face Inference Providers
- **Exact Model(s)**: None
- **Status**: `BLOCKED_NO_MANAGED_FREE_COMMITMENT`
- **Why**: Free Serverless API is heavily rate-limited and intended for lightweight testing on the Hub. Inference Providers router requires paid PAYG token billing.
- **Free Allowance**: Rate-limited community serverless access.
- **Recurring vs One-Time**: Recurring community throttled.
- **Payment Method Requirement**: None for basic Hub tokens.
- **Production Use Status**: Prototyping community only.
- **Downstream End-User Rights**: Individual Hub users only.
- **Data-Use / Privacy Terms**: Routed to diverse third-party inference providers.
- **Important Restrictions**: Cold starts, low rate limits, unsuitable for autonomous multi-turn agent workloads.
- **Quota Scope**: User token.
- **Failure Behavior**: HTTP 429 / HTTP 503 model loading.
- **First-Party Source**: [Hugging Face Inference Providers Pricing](https://huggingface.co/docs/inference-providers/pricing).
- **Source / Effective Date**: 2026-09-12.
- **Verified Date**: 2026-09-13.
- **Re-Review Trigger**: Dedicated zero-cost multi-tenant agent SLA.

### DeepInfra
- **Exact Model(s)**: None
- **Status**: `BLOCKED_TRIAL_CREDIT`
- **Why**: Provides an initial $1.80 trial credit upon account creation. Pure pay-as-you-go token pricing applies thereafter; no recurring free allocation.
- **Free Allowance**: $1.80 one-time initial credit.
- **Recurring vs One-Time**: One-time trial credit.
- **Payment Method Requirement**: None for initial credit; payment method required thereafter.
- **Production Use Status**: Evaluation only.
- **Downstream End-User Rights**: BYOK only.
- **Data-Use / Privacy Terms**: Standard API privacy terms.
- **Important Restrictions**: Paid usage after trial credit is spent.
- **Quota Scope**: Account.
- **Failure Behavior**: HTTP 402 payment required.
- **First-Party Source**: [DeepInfra Pricing](https://deepinfra.com/pricing).
- **Source / Effective Date**: 2026-09-13.
- **Verified Date**: 2026-09-13.
- **Re-Review Trigger**: Addition of a recurring free tier.

### Nebius AI Studio
- **Exact Model(s)**: None
- **Status**: `BLOCKED_TRIAL_CREDIT`
- **Why**: Pay-as-you-go enterprise AI platform offering temporary trial credits upon registration. No durable zero-dollar API tier.
- **Free Allowance**: One-time trial credit grant.
- **Recurring vs One-Time**: One-time trial credit.
- **Payment Method Requirement**: Credit card required for continued service.
- **Production Use Status**: Evaluation only.
- **Downstream End-User Rights**: None for pooled managed capacity.
- **Data-Use / Privacy Terms**: Enterprise standard API.
- **Important Restrictions**: Requires paid replenishment upon credit exhaustion.
- **Quota Scope**: Account.
- **Failure Behavior**: HTTP 402 / access cut off.
- **First-Party Source**: [Nebius AI Studio](https://nebius.com/studio).
- **Source / Effective Date**: 2026-09-13.
- **Verified Date**: 2026-09-13.
- **Re-Review Trigger**: Release of a perpetual free tier.

### SiliconFlow
- **Exact Model(s)**: None
- **Status**: `LEGAL_REVIEW_REQUIRED`
- **Why**: Promotional token grant requires mainland phone verification. Terms of service for third-party commercial multi-tenant distribution of free models have not been legally reviewed or cleared.
- **Free Allowance**: Promotional initial tokens upon phone verification.
- **Recurring vs One-Time**: One-time promotional grant.
- **Payment Method Requirement**: None initially; phone verification mandatory.
- **Production Use Status**: Unreviewed.
- **Downstream End-User Rights**: Unverified.
- **Data-Use / Privacy Terms**: Subject to mainland Chinese data compliance regulations.
- **Important Restrictions**: Phone verification gate; lack of downstream multi-tenant distribution license.
- **Quota Scope**: Account.
- **Failure Behavior**: HTTP 429 / balance exhaustion.
- **First-Party Source**: [SiliconFlow Pricing](https://siliconflow.cn/pricing).
- **Source / Effective Date**: 2026-09-12.
- **Verified Date**: 2026-09-13.
- **Re-Review Trigger**: Legal clearance and establishment of global multi-tenant API terms.

### Hyperbolic
- **Exact Model(s)**: None
- **Status**: `BLOCKED_TRIAL_CREDIT`
- **Why**: Decentralized GPU inference network offering $1 signup credit. No recurring free allowance; billed by token/GPU-second thereafter.
- **Free Allowance**: $1 signup credit.
- **Recurring vs One-Time**: One-time trial credit.
- **Payment Method Requirement**: None for initial $1; card required thereafter.
- **Production Use Status**: Evaluation only.
- **Downstream End-User Rights**: BYOK only.
- **Data-Use / Privacy Terms**: Decentralized node routing privacy considerations.
- **Important Restrictions**: Paid billing required after $1 trial spent.
- **Quota Scope**: Account.
- **Failure Behavior**: HTTP 402 payment required.
- **First-Party Source**: [Hyperbolic Documentation](https://docs.hyperbolic.xyz/).
- **Source / Effective Date**: 2026-09-13.
- **Verified Date**: 2026-09-13.
- **Re-Review Trigger**: Introduction of recurring zero-cost tier.

### Scaleway Generative APIs
- **Exact Model(s)**: None
- **Status**: `PAID_API`
- **Why**: Managed cloud inference billed strictly per million tokens. Requires Scaleway account, billing profile, and payment method.
- **Free Allowance**: None (trial compute credits do not constitute recurring free LLM inference).
- **Recurring vs One-Time**: None.
- **Payment Method Requirement**: Yes (credit card required at account creation).
- **Production Use Status**: Production paid API.
- **Downstream End-User Rights**: BYOK only.
- **Data-Use / Privacy Terms**: European GDPR-compliant enterprise privacy.
- **Important Restrictions**: Paid API from first token.
- **Quota Scope**: Organization.
- **Failure Behavior**: Immediate billing or HTTP 403 without active payment method.
- **First-Party Source**: [Scaleway Pricing](https://www.scaleway.com/en/pricing/?tags=ai-data).
- **Source / Effective Date**: 2026-09-13.
- **Verified Date**: 2026-09-13.
- **Re-Review Trigger**: Introduction of a free tier.

### Clarifai
- **Exact Model(s)**: None
- **Status**: `UNSUITABLE_QUOTA`
- **Why**: Free Community plan provides 1,000 monthly operations across the platform. LLM context and generation consume operations rapidly, exhausting the quota in a few agent turns. Incompatible with autonomous coding agent workloads.
- **Free Allowance**: 1,000 operations/month platform-wide.
- **Recurring vs One-Time**: Recurring monthly micro-allocation.
- **Payment Method Requirement**: None for Community plan.
- **Production Use Status**: Hobbyist / community testing.
- **Downstream End-User Rights**: Individual account holder only.
- **Data-Use / Privacy Terms**: Standard Clarifai community terms.
- **Important Restrictions**: 1,000 operations/month is exhausted in minutes during software engineering tasks.
- **Quota Scope**: Account.
- **Failure Behavior**: Operation quota exhausted error.
- **First-Party Source**: [Clarifai Pricing](https://www.clarifai.com/pricing).
- **Source / Effective Date**: 2026-09-13.
- **Verified Date**: 2026-09-13.
- **Re-Review Trigger**: Dedicated token-based free tier suitable for coding agents.

### Replicate
- **Exact Model(s)**: None
- **Status**: `BLOCKED_TRIAL_CREDIT`
- **Why**: Provides small temporary trial run-time credits on new accounts. Credit card required to continue execution after trial.
- **Free Allowance**: Micro trial run time ($0.10 - $1.00 promotional).
- **Recurring vs One-Time**: One-time trial credit.
- **Payment Method Requirement**: Credit card required to continue beyond micro-trial.
- **Production Use Status**: Evaluation only.
- **Downstream End-User Rights**: BYOK only.
- **Data-Use / Privacy Terms**: Standard Replicate terms.
- **Important Restrictions**: Card-required paid fallback upon trial expiration.
- **Quota Scope**: Account.
- **Failure Behavior**: HTTP 402 payment required.
- **First-Party Source**: [Replicate Pricing](https://replicate.com/pricing).
- **Source / Effective Date**: 2026-09-13.
- **Verified Date**: 2026-09-13.
- **Re-Review Trigger**: Recurring free tier with hard stops.

### Cohere
- **Exact Model(s)**: None
- **Status**: `BLOCKED_TRIAL_NON_PRODUCTION`
- **Why**: Provides a free Trial API key rate-limited to 40 RPM. However, Cohere Terms of Service strictly prohibit using Trial keys in commercial products, production environments, or to serve end users.
- **Free Allowance**: 40 RPM trial key quota.
- **Recurring vs One-Time**: Recurring trial rate-limited quota.
- **Payment Method Requirement**: None for Trial key.
- **Production Use Status**: Strictly non-production evaluation.
- **Downstream End-User Rights**: Prohibited from serving end users.
- **Data-Use / Privacy Terms**: Trial data may be subject to evaluation telemetry.
- **Important Restrictions**: Terms explicitly state: *"Trial keys are for evaluation and non-production use only. You may not use a Trial key in any production environment, commercial application, or to serve end users."*
- **Quota Scope**: Account.
- **Failure Behavior**: HTTP 429 rate limit exceeded.
- **First-Party Source**: [Cohere Pricing](https://cohere.com/pricing).
- **Source / Effective Date**: 2026-09-13.
- **Verified Date**: 2026-09-13.
- **Re-Review Trigger**: Production license grant for recurring free tier.

### GitHub Models
- **Exact Model(s)**: None
- **Status**: `NOT_APPROVED_EVALUATION_ONLY`
- **Why**: GitHub Models / Azure AI Studio prototyping endpoint is tied to personal GitHub accounts with per-user rate limits. No server-side multi-tenant pooled API agreement exists.
- **Free Allowance**: Per-user personal GitHub account prototyping limits.
- **Recurring vs One-Time**: Recurring user quota.
- **Payment Method Requirement**: None for personal prototyping.
- **Production Use Status**: Playground prototyping only.
- **Downstream End-User Rights**: Personal GitHub user only.
- **Data-Use / Privacy Terms**: GitHub Privacy Statement & Microsoft Azure Cognitive Services terms.
- **Important Restrictions**: Requires personal user authentication; cannot be pooled by server-side multi-tenant proxy.
- **Quota Scope**: User account.
- **Failure Behavior**: HTTP 429.
- **First-Party Source**: [GitHub Marketplace Models](https://github.com/marketplace/models).
- **Source / Effective Date**: 2026-09-13.
- **Verified Date**: 2026-09-13.
- **Re-Review Trigger**: Availability of server-side multi-tenant managed API keys.

### Ollama Cloud
- **Exact Model(s)**: None
- **Status**: `NOT_APPROVED`
- **Why**: No first-party hosted multi-tenant zero-cost cloud inference service provided by Ollama. Local model execution is strictly prohibited in FreeCloud.
- **Free Allowance**: None.
- **Recurring vs One-Time**: None.
- **Payment Method Requirement**: None.
- **Production Use Status**: Local inference only.
- **Downstream End-User Rights**: None.
- **Data-Use / Privacy Terms**: N/A.
- **Important Restrictions**: CodeForge architecture prohibits local LLM inference in FreeCloud.
- **Quota Scope**: None.
- **Failure Behavior**: N/A.
- **First-Party Source**: [Ollama](https://ollama.com).
- **Source / Effective Date**: 2026-09-13.
- **Verified Date**: 2026-09-13.
- **Re-Review Trigger**: Launch of a compliant zero-cost hosted API service.

---

## 3. Fixture Exclusion

- **Deterministic DevPool Fixture**: `EXCLUDED_DETERMINISTIC_FIXTURE`.
  Used exclusively for local CI, unit testing, and deterministically certifying two-user A/B allowance isolation without external network dependencies. It is never registered into production capacity.

