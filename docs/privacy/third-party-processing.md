# Third-Party Processing

Which third parties process CodeForge user data, in which route family, and what CodeForge
can and cannot say about their retention. Detailed per-provider terms analysis lives in the legal
registers (`docs/legal/third-party-services-register.md`, `provider-terms-register.md`); this
page is the privacy-facing summary. The formal sub-processor list is
[`docs/legal/subprocessor-list.md`](../legal/subprocessor-list.md).

## Production infrastructure (processes data for every Cloud account)

| Party | Role | Data | Location | CodeForge's control |
| --- | --- | --- | --- | --- |
| Render | Hosts the CodeForge Cloud API container; terminates TLS; stores stdout logs | All Cloud API traffic in transit; redacted logs; publication bundles on disk transiently | US (region chosen at deployment) | Env secrets, deployment; no CodeForge encryption of Render's disk (OA-09) |
| Supabase **or** Neon (one is chosen at deployment) | Managed PostgreSQL | Everything in the Cloud database (identity, sessions as hashes, sealed verifiers, usage, billing metadata, audit) | US (region chosen at deployment) | TLS with certificate validation; application-layer sealing of the PKCE verifier; provider-managed disk/backup encryption — REQUIRES THIRD-PARTY VERIFICATION |
| GitHub | Identity provider (OAuth App); publication target (GitHub App) | GitHub profile at sign-in; commits/PRs you publish | GitHub's regions | Minimal scopes; per-repository tokens |
| Stripe | Payment processor (TEST mode today) | Customer id, checkout/subscription state, card data (Stripe-hosted pages only) | Stripe's regions | Restricted keys; signed webhooks; CodeForge never sees card data |

## Model providers (process prompts and code context)

Which provider receives a request depends on the route family and, for ForgeAuto, on the
ForgeZero-verified pool and your **privacy routing mode**:

| Mode | Effect |
| --- | --- |
| STRICT | Excludes endpoints whose free tier permits training on or retention of prompts (e.g. Gemini unpaid) |
| STANDARD (default) | Normal provider retention; excludes tiers with known training-on-input terms only where policy marks them |
| MAXIMUM_FREE | Allows weaker-retention free endpoints |

| Provider (route family) | Receives | Under whose account | Retention / training statement |
| --- | --- | --- | --- |
| OpenRouter (Hosted Free via CodeForge's key; BYOK via yours) | Prompt, code context, tool results | CodeForge's (hosted) or yours (BYOK) | Forwarded to the downstream model host under OpenRouter's policy; per-model training terms are not independently evidenced by CodeForge — treated as UNKNOWN, not "no retention" |
| Groq | same | same | Standard developer API terms; no human review claimed; not verified by CodeForge |
| Google Gemini (unpaid tier) | same | same | Google states unpaid-tier prompts/outputs may be used for training and reviewed by humans — excluded under STRICT; do not send confidential code on the unpaid tier |
| Google Gemini (paid/Cloud) | same | yours (BYOK) | Not used for training per Google Cloud terms (Google's statement, not CodeForge's verification) |
| Z.AI / Zhipu GLM | same | same | Subject to Chinese data-governance rules and Zhipu's policy |
| Cloudflare Workers AI | same | same | Cloudflare's policy; request telemetry if gateway logging enabled |
| OpenAI, Anthropic, Mistral, Cerebras, SambaNova, NVIDIA, Hugging Face, Together, Fireworks, Nebius, Novita, Hyperbolic, Friendli, Baseten, Moonshot, DeepSeek, Poolside (BYOK / direct only) | same | yours | Each provider's API terms; CodeForge relays and does not verify |
| Ollama Cloud (user-connected candidate, rollout-gated) | same | yours | Ollama's policy |

CodeForge sends only the request content (prompt, selected context, tool results, generation
parameters). It never sends your CodeForge identity, GitHub identity, or other keys to a provider.

## What CodeForge does not do with third parties

- No selling or sharing of personal data for advertising; no ad networks, data brokers, or analytics processors exist in the product.
- No training of CodeForge models on user content (CodeForge trains no models).
- No "zero retention" promise on behalf of any provider: retention is each provider's own commitment, and CodeForge's documentation only quotes what a provider states.

## User choices

- Route family: BYOK/direct keeps the Cloud out of the path; Hosted Free routes through CodeForge's keys.
- Privacy routing mode (Settings › Data & Privacy).
- Per-provider connect/disconnect (Settings › Providers).
- Decline Cloud sign-in entirely: the desktop works with BYOK/direct providers without an account.
