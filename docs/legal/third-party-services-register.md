# CodeForge Third-Party Services Register

**Audit Date**: September 10, 2026
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
- Designed to run at low frequency (startup or model picker initialization).
- **Compliance Rule**: Probing routines must strictly respect HTTP 429 rate-limit headers and backoff policies to avoid violating provider acceptable use policies regarding automated abuse or denial of service.
