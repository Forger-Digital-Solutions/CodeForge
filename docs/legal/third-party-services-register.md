# CodeForge Third-Party Services Register

**Audit Date**: September 12, 2026 (R1 Free Cloud Platform update; original Pass 1 audit September 10, 2026)
**Auditor**: Primary Audit Agent (Pass 1)
**Scope**: All external network services, APIs, and cloud providers integrated into CodeForge Desktop, CLI, and Cloud API.

---

## 1. Third-Party Service Registry

| Provider / Service | Operating Entity | Primary Endpoints & Protocol | Integration Mechanism | Data Transmitted | Zero-Cost Tier Availability | Telemetry / Privacy Classification |
|---|---|---|---|---|---|---|
| **OpenRouter** | OpenRouter, Inc. | `https://openrouter.ai/api/v1/chat/completions`<br>`https://openrouter.ai/auth` | **Desktop BYOK** via OAuth PKCE (`openrouter-oauth-flow.ts`) or user-pasted API key. | Bearer API token, chat prompts, repository code context, system instructions, generation parameters. | Models with `:free` slug (e.g., `meta-llama/llama-3.3-70b-instruct:free`). | Dependent on underlying model host; OpenRouter logs request metadata according to privacy policy. |
| **Google Gemini API** | Google LLC / Alphabet Inc. | `https://generativelanguage.googleapis.com/v1beta/models/*` | **BYOK** direct API key (`GEMINI_API_KEY`). | Bearer API key, prompt text, code snippets, tool definitions. | Free quota tier (e.g., Gemini 1.5 Flash, Gemini 2.0 Flash) within regional limits. | **Permissive (Unpaid Tier)**: Prompts/responses may be reviewed by human reviewers and used to train Google products. |
| **Groq** | Groq, Inc. | `https://api.groq.com/openai/v1/chat/completions` | **BYOK** direct API key (`GROQ_API_KEY`). | API key, prompt text, code snippets. | Free developer tier with strict RPM/TPM rate limits. | Standard developer API; no human review claimed for enterprise/standard API tiers. |
| **Cloudflare AI Gateway** | Cloudflare, Inc. | `https://gateway.ai.cloudflare.com/v1/*` | **BYOK** / Configurable proxy endpoint. | API tokens, prompt text, cache keys. | Free tier for gateway routing and logging; Workers AI free allocations. | Cloudflare logs request telemetry, status codes, and latency if caching/logging enabled. |
| **OpenAI** | OpenAI, LLC / OpenAI OpCo LLC | `https://api.openai.com/v1/chat/completions` | **BYOK** direct API key (`OPENAI_API_KEY`). | API key, prompt text, code context. | Occasional trial grants; generally paid tier (blocked by ForgeZero unless verified zero-cost grant). | API data excluded from training by default for paid enterprise/standard API. |
| **Anthropic** | Anthropic PBC | `https://api.anthropic.com/v1/messages` | **BYOK** direct API key (`ANTHROPIC_API_KEY`). | `x-api-key`, system prompts, messages, tool schemas. | Occasional developer credits; generally paid (blocked by ForgeZero unless zero-cost grant). | API inputs/outputs not used for training per Commercial Terms. |
| **Z.AI (Zhipu GLM)** | Zhipu AI (Beijing Zhipu Huazhang Tech) | `https://open.bigmodel.cn/api/paas/v4/chat/completions` | **BYOK** direct API key (`ZHIPU_API_KEY`). | API key (JWT token), prompt text. | Free developer quota tiers for selected GLM models. | Subject to Chinese data governance regulations and Zhipu API privacy policy. |
| **Cerebras Inference** | Cerebras Systems, Inc. | `https://api.cerebras.ai/v1/chat/completions` | **BYOK** direct API key (`CEREBRAS_API_KEY`) or detected environment credential. | API key, prompt text, code snippets, tool schemas. | **Free Trial only** ($5 credits expiring 30 days after grant, per `inference-docs.cerebras.ai/support/rate-limits`, checked 2026-09-12). Classified `PROMOTIONAL_CREDIT` — excluded from ForgeAuto/Free. | Standard developer API terms; no CodeForge partnership or endorsement. |
| **SambaNova Cloud** | SambaNova Systems, Inc. | `https://api.sambanova.ai/v1/chat/completions` | **BYOK** direct API key (`SAMBANOVA_API_KEY`) or detected environment credential. | API key, prompt text, code snippets. | Free Tier while no payment method is linked; Developer Tier bills. Classified `FREE_ACCOUNT_ENTITLEMENT`, admitted only after the user confirms the account is on the free plan. | Standard developer API terms. |
| **Mistral La Plateforme** | Mistral AI SAS | `https://api.mistral.ai/v1/chat/completions` | **BYOK** direct API key (`MISTRAL_API_KEY`) or detected environment credential. | API key, prompt text, code snippets. | Experiment plan (free, phone-verified). Classified `FREE_MONTHLY_ALLOWANCE`; admitted only after free-plan confirmation. | **Permissive (Experiment plan)**: free tier requires opting in to data training. ForgeZero STRICT excludes it. |
| **Cloudflare Workers AI** | Cloudflare, Inc. | `https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1/chat/completions` | **BYOK** API token + account id (`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID`) or detected environment credentials. | API token, account id, prompt text. | Workers Free: 10,000 Neurons/day, hard stop; Kimi/GLM 5.x/DeepSeek v4 require Workers Paid. Classified `FREE_DAILY_ALLOCATION` with an explicit free-plan model allowlist. | Cloudflare request telemetry per its privacy policy. |
| **NVIDIA API Catalog** | NVIDIA Corporation | `https://integrate.api.nvidia.com/v1/chat/completions` | **BYOK** direct API key (`NVIDIA_API_KEY`) or detected environment credential. | API key, prompt text. | Trial API credits for prototyping. Classified `FREE_DEV_ENDPOINT` / terms `DEVELOPMENT_ONLY` — excluded from default ForgeAuto/Free. | Standard developer API terms. |
| **Poolside** | Poolside AI | `https://inference.poolside.ai/v1/chat/completions` | **BYOK** direct API key (`POOLSIDE_API_KEY`). Laguna models are ALSO served as `:free` routes on OpenRouter, which is the admitted path. | API key, prompt text. | Direct platform is free-in-preview with no public rate card. Classified `FREE_DEV_ENDPOINT` / `LEGAL_REVIEW_REQUIRED` for direct use. | Unpublished third-party terms; direct route excluded from default routing. |
| **DeepSeek (direct)** | Hangzhou DeepSeek AI | `https://api.deepseek.com/chat/completions` | **BYOK** direct API key (`DEEPSEEK_API_KEY`). | API key, prompt text. | **Paid API** (pay-as-you-go). DeepSeek models reach ForgeAuto/Free only via legitimately free hosts (e.g. Cloudflare Free-plan models where eligible). | Subject to DeepSeek privacy policy. |
| **Hugging Face Inference Providers** | Hugging Face, Inc. | `https://router.huggingface.co/v1/chat/completions` | **BYOK** token (`HF_TOKEN`). | Token, prompt text. | Small monthly credits; PAYG beyond. Classified `PROMOTIONAL_CREDIT`. | Routed to third-party inference providers per HF policy. |
| **Together AI / Fireworks AI / Nebius / Novita / Hyperbolic / Friendli / Baseten / Moonshot** | respective operators | OpenAI-compatible chat endpoints (see `packages/model-registry/src/provider-definitions.ts`). | **BYOK** direct API key via the generic OpenAI-compatible adapter. | API key, prompt text. | Signup credits or paid only (`PROMOTIONAL_CREDIT` / `PAID_API`). Never in ForgeAuto/Free. | Respective provider policies. |
| **Kilo Gateway / ZenMux** | Kilo Code / ZenMux | Gateway endpoints listed on Models.dev. | **Not implemented.** Listed for transparency: Models.dev advertises `$0` routes, but third-party-client/redistribution terms are unverified. | None. | `LEGAL_REVIEW_REQUIRED`. | Not integrated. |
| **GitHub Copilot** | GitHub, Inc. / Microsoft Corp. | `https://api.githubcopilot.com` | **Not integrated.** No supported third-party inference API for Copilot Free; CodeForge does not read Copilot tokens. | None. | `NOT_ALLOWED`. | Not integrated. |
| **Models.dev** | Models.dev (MIT-licensed metadata project) | `https://models.dev/api.json` | Unauthenticated metadata fetch (`packages/model-registry/src/models-dev.ts`), cached with bundled snapshot fallback. | None (anonymous GET). | Discovery signal only — never a free-status authority. | Public metadata; no user data transmitted. |
| **Cognition / Devin / Windsurf SWE** | Cognition AI, Inc. | Devin management API: `https://api.devin.ai/v3/*` | No CodeForge adapter. Official API manages metered Devin sessions; it is not a public SWE model-inference endpoint. | None. | **No verified zero-cost API route.** SWE-1.7 is a free Devin Desktop product entitlement, not a transferable CodeForge API entitlement. | Excluded from ForgeAuto/Free; see `docs/cognition-swe-route-discovery.md`. |
| **Stripe** | Stripe, Inc. | `https://api.stripe.com/v1/*` | **Cloud Backend Service** (`packages/cloud-billing`). Key restricted to `sk_test_` / `rk_test_`. | Customer ID, email, subscription metadata, test payment tokens. | Free sandbox / developer test mode. | Financial payment processor; PCI-DSS compliant. Live mode currently locked. |
| **GitHub OAuth** | GitHub, Inc. / Microsoft Corp. | `https://github.com/login/oauth/authorize`<br>`https://github.com/login/oauth/access_token` | **Desktop PKCE** loopback flow (`cloud-auth-flow.ts`). | OAuth client ID, code challenge, redirected authorization code. | Standard free GitHub Developer Application. | GitHub authentication and identity logs. |

---

## 2. Desktop Endpoint Containment & Security Controls

To ensure strict network containment and prevent unauthorized telemetry, CodeForge Desktop enforces build-time endpoint declarations documented in `apps/desktop/cloud-endpoints.json`.

```json
{
  "productionAuthOrigin": "https://api.codeforge.dev",
  "stagingAuthOrigin": "https://staging-api.codeforge.dev",
  "allowedAuthOrigins": [
    "https://api.codeforge.dev",
    "https://staging-api.codeforge.dev",
    "http://127.0.0.1:*"
  ],
  "openRouterAuthOrigin": "https://openrouter.ai"
}
```

### Security Verifications
1. **Loopback Binding Security**: The internal HTTP server binds strictly to `127.0.0.1`. The packaged app audit (`apps/desktop/scripts/audit-packaged-auth-endpoint.mjs`) verifies that no unapproved remote origin can intercept loopback authentication tokens.
2. **Secret Redaction Pipeline**: `packages/secrets/src/redaction.ts` actively masks all third-party API keys before they are rendered in UI turn components, logged to local disk, or included in outgoing diagnostic dumps.
3. **No Hidden Telemetry**: Audits of `apps/desktop/release/win-unpacked/resources/app.asar` verify the total absence of Google Analytics, PostHog, Segment, Datadog, or Sentry SDKs.

---

## 3. Allowance Probing & Automated Activity

CodeForge includes automated probing mechanisms:
- `apps/desktop/src/main.ts` (`discoverProviderFree`)
- `packages/eight-bit/src/qualification/runner.ts`

### Operational Characteristics
- Sends minimal synthetic prompts (e.g., `"Respond with OK"`) to test model availability, token latency, and zero-cost allowance status.
- **R1 rule (§99):** allowance probes for providers whose free tier depends on the account's plan (Groq, Gemini, Cloudflare, Mistral, SambaNova) run only after the user confirms in Settings that the account is on the free plan. Without that confirmation no probe is sent and the routes stay out of ForgeAuto/Free.
- **8-Bit compact qualification** (`packages/eight-bit/src/qualification/compact.ts`): three bounded probes per newly verified route (tool call, exact edit, JSON output), at most 3 routes per cycle; receipts persist for 30 days so restarts never re-spend free quota.
- Designed to run at low frequency (startup or model picker initialization).
- **Compliance Rule**: Probing routines must strictly respect HTTP 429 rate-limit headers and backoff policies to avoid violating provider acceptable use policies regarding automated abuse or denial of service.
