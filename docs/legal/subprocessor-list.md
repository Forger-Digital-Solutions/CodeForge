# CodeForge Sub-processor and Service-Provider List

<!-- DRAFT — generated from the deployed architecture on 2026-09-18; publish only after owner review -->

This list names the third parties that process personal data or user content on behalf of
CodeForge / Forger Digital Solutions. It is generated from the actual code and deployment
blueprint (`render.yaml`, `apps/cloud-api/src/config.ts`, `packages/model-registry`), not from
vendors that were merely evaluated. Three tiers are kept apart because they carry different
privacy consequences.

## Tier 1 — Production infrastructure (processes data for every CodeForge Cloud account)

| Sub-processor | Service | Data processed | Location | Notes |
| --- | --- | --- | --- | --- |
| Render Services, Inc. | Hosting of the CodeForge Cloud API (Docker), TLS termination, log storage | All API traffic; redacted logs; publication bundles transiently on disk | United States (region set at deployment) | Blueprint: `render.yaml` |
| Supabase, Inc. **or** Neon, Inc. | Managed PostgreSQL | All Cloud database contents (identity, hashed sessions, sealed OAuth verifiers, usage, billing metadata, audit trail) | United States (region set at deployment) | Exactly one is used per deployment — `[OWNER INPUT: which provider and region is live]` |
| GitHub, Inc. (Microsoft) | Identity provider (OAuth App, `read:user user:email`); repository publication (GitHub App) | GitHub profile at sign-in; commits and pull requests you publish | GitHub's regions | Also the source-code host for CodeForge itself |
| Stripe, Inc. | Payment processing (TEST mode only today) | Customer and subscription identifiers, payment state; card details on Stripe-hosted pages only | Stripe's regions | Live mode not enabled |

## Tier 2 — Model providers used by Hosted Free / Paid routes (CodeForge's own credentials)

Only providers whose credential is configured on the Cloud are used; today's blueprint lists
OpenRouter and Groq, with Gemini, Z.AI, and Cloudflare Workers AI supported when keys are
present. Prompts and code context are transmitted to whichever provider serves the route.

| Provider | Data processed | Notes |
| --- | --- | --- |
| OpenRouter, Inc. | Prompt, code context, tool results | Forwards to downstream model hosts under its policy |
| Groq, Inc. | same | — |
| Google LLC (Gemini API) | same | Unpaid tier permits training/human review — excluded under the STRICT privacy mode |
| Zhipu AI (Z.AI) | same | Subject to Chinese data-governance rules |
| Cloudflare, Inc. (Workers AI) | same | — |

`[OWNER INPUT: confirm the exact provider keys configured on the live deployment]`

## Tier 3 — Optional destinations under the user's own account (BYOK / direct; not CodeForge sub-processors)

When a user connects their own provider account, the user — not CodeForge — has the contractual
relationship with that provider, and CodeForge Cloud is not in the request path. Listed for
transparency: OpenRouter, Google Gemini, Groq, Cloudflare AI Gateway / Workers AI, OpenAI,
Anthropic, Z.AI, Cerebras, SambaNova, Mistral, NVIDIA, Poolside, DeepSeek, Hugging Face,
Together AI, Fireworks AI, Nebius, Novita, Hyperbolic, Friendli, Baseten, Moonshot, Ollama Cloud
(rollout-gated candidate). Details: `docs/legal/third-party-services-register.md`.

## Not used

No analytics, advertising, session-replay, crash-reporting, email-marketing, or customer-support
SaaS processes CodeForge user data (verified in `docs/privacy/cookies-and-tracking.md`).
`[OWNER INPUT: name the mailbox provider used for the security/privacy contact once created]`

## Change process

Additions to Tier 1 or Tier 2 require: an update to this list, `docs/privacy/third-party-processing.md`,
the Privacy Policy, and — for EEA/UK personal data — a DPA with the vendor (REQUIRES LEGAL
COUNSEL). Users are informed of material changes per the Privacy Policy's change clause.
