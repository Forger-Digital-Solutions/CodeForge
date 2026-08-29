# Provider & Model Access Research — 2026

> **Purpose.** Authoritative, dated record of provider capabilities, free-access status,
> transport, and metadata sources used to build CodeForge's free-first multi-provider
> platform. Models.dev supplies **raw facts**; CodeForge's ForgeZero verification overlay
> owns **trust**. Nothing here is authoritative for ForgeZero eligibility on its own.
>
> **Checked:** 2026-08-29. Re-verify before shipping — free endpoints and pricing change constantly.

---

## Method

- Live-pulled `https://models.dev/api.json` (4.4 MB) and inspected the real JSON shape.
- Live-pulled `https://openrouter.ai/api/v1/models` (396 models) for the current free set.
- Cross-checked provider transport, auth env vars, and npm SDK packages from the Models.dev catalog.
- Web-verified Gemini free-tier quotas + data-use terms.

Sources are listed per section with the date each was checked.

---

## Models.dev (upstream metadata source)

- **Endpoint:** `https://models.dev/api.json` — single JSON document, HTTP 200, ~4.4 MB (2026-08-29).
- **Top-level shape:** object keyed by `providerId`. 207 providers present.
- **Provider record:**
  ```jsonc
  {
    "id": "openrouter",
    "name": "OpenRouter",
    "env": ["OPENROUTER_API_KEY"],          // credential env var(s)
    "npm": "@openrouter/ai-sdk-provider",    // AI SDK provider package
    "api": "https://openrouter.ai/api/v1",   // base URL (may contain ${VAR} templates)
    "doc": "https://openrouter.ai/models",
    "models": { "<modelId>": { /* model record */ } }
  }
  ```
- **Model record (real example — a free one):**
  ```jsonc
  {
    "id": "nvidia/nemotron-3-super-120b-a12b:free",
    "name": "Nemotron 3 Super (free)",
    "family": "nemotron",
    "attachment": false,            // vision/file attachment support
    "reasoning": true,
    "tool_call": true,
    "structured_output": true,
    "temperature": true,
    "release_date": "2026-03-11",
    "last_updated": "2026-03-11",
    "modalities": { "input": ["text"], "output": ["text"] },
    "open_weights": true,
    "limit": { "context": 262144, "output": 235929 },
    "cost": { "input": 0, "output": 0 }      // USD PER MILLION TOKENS
  }
  ```
- **Pricing unit:** `cost.{input,output,cache_read,cache_write}` is **USD per 1M tokens**
  (verified: `openai/gpt-4o-mini` = `{input:0.15, output:0.6, cache_read:0.075}`).
- **Capability flags:** `tool_call`, `reasoning`, `structured_output`, `attachment` (vision),
  `modalities.input` (contains `"image"`/`"pdf"` for multimodal).
- **Freshness:** records carry `last_updated`; document regenerates frequently (models dated 2026-08-28 present).

**Design consequence.** Models.dev pricing of `0/0` is necessary-but-not-sufficient for
"free": it proves the *unit price* is zero (FREE_NATIVE / FREE_ROUTED candidates), but says
nothing about quota-based free tiers (FREE_ALLOWANCE) or account entitlement. Providers whose
free tier is an *allowance* (Gemini, Groq, Cloudflare) show their **paid** unit price here, so
`cost=0` detection alone will (correctly) not classify them as verified-free.

Sources: [models.dev](https://models.dev/) · `https://models.dev/api.json` (checked 2026-08-29)

---

## OpenRouter

- **Base URL:** `https://openrouter.ai/api/v1` (OpenAI-compatible `/chat/completions`, `/models`).
- **Models endpoint:** `GET /api/v1/models` → `{ data: Model[] }`, 396 models (2026-08-29).
  - Per-model: `id`, `name`, `context_length`, `architecture.{modality,input_modalities,output_modalities}`,
    `pricing.{prompt,completion,input_cache_read,...}` (**strings, USD per TOKEN**),
    `supported_parameters` (`tools`, `tool_choice`, `structured_outputs`, `response_format`),
    `top_provider.{context_length,max_completion_tokens,is_moderated}`.
  - **Free detection:** `pricing.prompt === "0" && pricing.completion === "0"`, conventionally
    surfaced with a `:free` model-id suffix. **21 free models** live (2026-08-29), e.g.
    `z-ai/glm-5.2:free`, `google/gemma-4-26b-a4b-it:free`, `nvidia/nemotron-3-ultra-550b-a55b:free`,
    `minimax/minimax-m3:free`, `cohere/north-mini-code:free`.
  - **Unit note:** OpenRouter prices are per-*token* strings; multiply by 1e6 for per-million.
- **Free access class:** FREE_ROUTED (gateway exposes a verified $0 route; subject to OpenRouter's
  own free rate limits). A free GLM via `z-ai/glm-5.2:free` is *routed*, distinct from Z.AI direct.
- **OAuth PKCE (preferred connect):**
  - Authorize: open system browser to `https://openrouter.ai/auth?callback_url=<uri>&code_challenge=<S256>&code_challenge_method=S256`.
  - `code_verifier`: cryptographically-random string; `code_challenge` = base64url(SHA-256(verifier)).
  - Callback returns `?code=...`; desktop uses `http://localhost:<port>/callback`.
  - Exchange: `POST https://openrouter.ai/api/v1/auth/keys` with `{ code, code_verifier, code_challenge_method }`
    → returns a user-controlled API key.
- **Rate limits / errors:** 401 → auth; 402 → payment required; 429 → rate limited (retryable);
  5xx → retryable. `HTTP-Referer` + `X-Title` headers identify the app.

Sources: [OAuth PKCE](https://openrouter.ai/docs/use-cases/oauth-pkce) · `https://openrouter.ai/api/v1/models` (checked 2026-08-29)

---

## Z.AI (direct — first independent free capacity)

- **Provider id (Models.dev):** `zai`. **Base URL:** `https://api.z.ai/api/paas/v4` (OpenAI-compatible).
- **SDK style:** `@ai-sdk/openai-compatible`. **Env:** `ZHIPU_API_KEY`.
- **Models (16):** `glm-4.6`, `glm-4.7`, `glm-4.7-flash`, `glm-4.5-flash`, `glm-5v-turbo`, `glm-4.5v`, `glm-4.7-flashx`, …
  - **FREE_NATIVE ($0/$0):** `glm-4.5-flash`, `glm-4.7-flash` — reasoning + coding + agent capable.
  - **Coding (paid):** `glm-4.7` = `{input:0.6, output:2.2}` per 1M, `tool_call:true`, `reasoning:true`,
    context 204,800 / output 131,072.
- **Access classes:** FREE_NATIVE (glm-*-flash), PAID (glm-4.6/4.7/…). Any "coding plan" trial → TRIAL.
- **Transport:** OpenAI-compatible chat completions; streaming SSE; tools supported. Reuses the shared
  OpenAI-compatible adapter with `baseUrl=https://api.z.ai/api/paas/v4`, `Authorization: Bearer <key>`.

**Distinction preserved:** Z.AI-direct free (`zai::glm-4.5-flash`, FREE_NATIVE) ≠ OpenRouter free GLM
(`openrouter::z-ai/glm-5.2:free`, FREE_ROUTED). Different providerId, different access class.

Sources: Models.dev `zai` provider record (checked 2026-08-29) · https://docs.z.ai

---

## Google Gemini

- **Provider id (Models.dev):** `google`. **Env:** `GEMINI_API_KEY` (also `GOOGLE_API_KEY`). **SDK:** `@ai-sdk/google`.
- **OpenAI-compatible endpoint:** `https://generativelanguage.googleapis.com/v1beta/openai/` — same
  API key, change base URL + model name; usable via the shared OpenAI-compatible adapter.
- **Free tier:** genuine ongoing **allowance** (no card required), quota-limited per model
  (e.g. Flash tiers ~5–15 RPM, 250k–1M TPM, ~100–1500 req/day). Models.dev lists **paid** unit prices,
  so `cost=0` detection will not mark Gemini free — correct.
- **Access class:** FREE_ALLOWANCE. **Cannot** be awarded VERIFIED FREE from pricing alone; requires
  account/quota verification (and once billing is enabled on a project, free tier disappears → every call billable).
- **Privacy (critical routing input):** on the **free tier, prompts may be used to improve Google
  products** (training/retention). → **excluded under PRIVACY STRICT**; allowed under STANDARD/MAXIMUM_FREE with disclosure.
- **Auth mode:** API_KEY (user OAuth is not appropriate for third-party desktop inference).

Sources: [Gemini free tier 2026](https://tokenmix.ai/blog/gemini-api-free-tier-limits) · [rate limits](https://aipromptshub.co/limits/gemini-rate-limits-2026) · [billing trap](https://usagebox.com/articles/gemini-api-billing-free-tier-confusion) (checked 2026-08-29)

---

## Groq

- **Provider id (Models.dev):** `groq`. **Env:** `GROQ_API_KEY`. **SDK:** `@ai-sdk/groq`. **Base:** `https://api.groq.com/openai/v1` (OpenAI-compatible).
- **Models (15):** `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `openai/gpt-oss-120b`, `allam-2-7b` (0/0), whisper (audio), …
- **Free access class:** FREE_ALLOWANCE — free developer tier with per-model RPM/RPD/TPM limits (paid unit prices listed on Models.dev).
- **Transport:** OpenAI-compatible; tools supported on the instruct models. Deferred behind Z.AI/OpenRouter/Gemini in priority.

Sources: Models.dev `groq` record (checked 2026-08-29) · https://console.groq.com/docs

---

## Cloudflare Workers AI

- **Provider id (Models.dev):** `cloudflare-workers-ai`. **Env:** `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_KEY`.
- **Base URL (templated):** `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1` (OpenAI-compatible).
- **Models (27):** `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, `@cf/google/gemma-4-26b-a4b-it`, `@cf/nvidia/nemotron-3-120b-a12b`, …
- **Free access class:** FREE_ALLOWANCE — daily neuron allocation (no `0/0` unit price listed). Requires account id + token.
- **Transport:** OpenAI-compatible; needs `${CLOUDFLARE_ACCOUNT_ID}` interpolation in base URL. Deferred (added without registry rewrite).

Sources: Models.dev `cloudflare-workers-ai` record (checked 2026-08-29) · https://developers.cloudflare.com/workers-ai/

---

## OpenAI (paid / optional)

- **Provider id (Models.dev):** `openai`. **Env:** `OPENAI_API_KEY`. **SDK:** `@ai-sdk/openai`. **Base:** `https://api.openai.com/v1` (native OpenAI Chat Completions).
- **Models (47):** `gpt-5.3-chat-latest`, `gpt-5-nano`, `gpt-4o`, `gpt-4o-mini`, `gpt-3.5-turbo`, image/audio, …
- **Free API status:** **NONE.** 0 models at `0/0`. ChatGPT-Free is a consumer product, **not** API-free — never classified free.
- **Cheapest useful coding (paid, per 1M):** `gpt-4o-mini` `{0.15/0.6}`, `gpt-5-nano` (nano tier). Surface these first under OPENAI › PAID.
- **Access class:** PAID only. Requires explicit paid-model confirmation; never in Auto free routing.

Sources: Models.dev `openai` record (checked 2026-08-29) · https://platform.openai.com/docs/pricing

---

## Anthropic (paid / trial)

- **Provider id (Models.dev):** `anthropic`. **Env:** `ANTHROPIC_API_KEY`. **SDK:** `@ai-sdk/anthropic`. **Base:** `https://api.anthropic.com/v1` (**Messages API — not OpenAI-compatible**).
- **Models (13):** `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-sonnet-4-5-20250929`, …
- **Free API status:** **NONE ongoing.** 0 models at `0/0`. Trial credits only → classify **TRIAL** when verified for the current account; drop from free eligibility when exhausted. Claude consumer Free ≠ API access.
- **Transport (dedicated adapter):** `POST /v1/messages`, headers `x-api-key: <key>` + `anthropic-version: 2023-06-01`;
  `system` is a top-level field (not a message); content blocks; `tool_use`/`tool_result` blocks; SSE streaming with
  `message_start` / `content_block_delta` / `message_delta` / `message_stop` events.

Sources: Models.dev `anthropic` record (checked 2026-08-29) · https://docs.anthropic.com/en/api/messages · [claude-api skill reference]

---

## AI SDK / transport strategy

- Models.dev names an AI-SDK provider package per provider (`@ai-sdk/openai`, `@ai-sdk/anthropic`,
  `@ai-sdk/google`, `@ai-sdk/groq`, `@ai-sdk/openai-compatible`, `@openrouter/ai-sdk-provider`).
- **Decision:** keep CodeForge's existing native-TypeScript `ProviderAdapter` transport (already proven by
  `OpenRouterAdapter`) rather than adding the AI SDK runtime dependency. A single **`OpenAICompatibleAdapter`**
  base serves OpenRouter, Z.AI, Groq, Cloudflare, Gemini (OpenAI-compat endpoint), and OpenAI; **Anthropic**
  gets a dedicated Messages adapter. This matches "AI SDK-style / OpenAI-compatible adapter" without a mandatory
  Python LiteLLM daemon or hosted gateway hop.
- **LiteLLM:** deferred to CodeForge Cloud/Teams (virtual keys, budgets, org routing). Not a desktop dependency.

---

## Access-class taxonomy (derived)

| Class | Meaning | Examples (2026-08-29) |
|---|---|---|
| `FREE_NATIVE` | Provider charges $0 for the model itself | Z.AI `glm-4.5-flash`, `glm-4.7-flash` |
| `FREE_ROUTED` | Gateway exposes a verified $0 route | OpenRouter `*:free` (glm-5.2, gemma-4, nemotron, minimax-m3) |
| `FREE_ALLOWANCE` | Recurring free quota / account allowance | Gemini free tier, Groq free tier, Cloudflare neurons |
| `FREE_PROMO` | Temporary promotional free access | (provider-announced, time-boxed) |
| `TRIAL` | Time/token-limited trial credits | Anthropic trial credits, Z.AI coding-plan trial |
| `PAID` | May incur monetary charge | OpenAI (all), Anthropic (all), Z.AI `glm-4.7`, OpenRouter paid |
| `UNAVAILABLE` | Not currently usable | deprecated / offline / no route |

## Auth-mode taxonomy (derived)

`NONE` · `OAUTH_PKCE` (OpenRouter) · `API_KEY` (Z.AI, Gemini, Groq, OpenAI, Anthropic) · `ACCOUNT_CONNECT` (Cloudflare: account id + token) · `HOSTED_RELAY` (future CodeForge Cloud).

## Privacy classes (derived, routing input)

`STRICT` (no provider training/retention beyond serving; excludes Gemini free) · `STANDARD` (standard provider retention) · `MAXIMUM_FREE` (allow weaker-retention free endpoints **with disclosure**).
