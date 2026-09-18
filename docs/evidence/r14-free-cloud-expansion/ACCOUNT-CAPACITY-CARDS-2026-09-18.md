# R14 Account Capacity Cards — 2026-09-18

## Method

All account figures below were read from the provider's authenticated limits, subscription, usage,
or plan view on 2026-09-18. No credentials, account IDs, browser captures, or user identifiers
were retained. Public documentation is linked only to explain terms or data handling; it does not
replace the live-account observations.

These are qualification inputs, not provider certifications. Any route without a confirmed
commercial/intermediary right, privacy profile, runtime proof, and exact-model pin remains outside
ForgeAuto/Free.

## Cerebras Direct

- Live status: the account shows a $5 trial balance. The dashboard prices `gpt-oss-120b` and
  `qwen-3.8-27b` above $0 per million input and output tokens.
- Observed limits: `gpt-oss-120b` has 5 RPM, 2,400 RPD, 90,000 TPM, and 3,000,000 TPD;
  `qwen-3.8-27b` has 450 RPM, 648,000 RPD, 450,000 TPM, and 648,000,000 TPD.
- Classification: `TRIAL_CREDIT`, not `PURE_MANAGED_FREE`.
- Verdict: `CEREBRAS_MANAGED_FREE_CERTIFIED = NO`. Do not create a new key or run a live probe
  until a narrowly scoped credential creation is approved and a non-credit recurring-free plan is
  proven.

## Groq

- Live organization limits for `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, and
  `qwen/qwen3.8-27b`: 30 RPM, 1,000 RPD, 8,000 TPM, and 200,000 TPD per listed model.
- The selected project has no custom model limits; it inherits the organization limits. The
  dashboard does not prove whether listed model allowances are independent token pools, so R14
  models them as unconfirmed until response-header probes establish the real shared boundaries.
- Privacy/terms: Groq documents no default retention of inference customer data, subject to
  reliability/abuse exceptions and configurable data controls. Its service agreement prohibits
  resale or distribution unless expressly approved, so using one owner key for public managed
  traffic is not cleared. [Data controls](https://console.groq.com/docs/your-data) and the
  [Services Agreement](https://console.groq.com/docs/legal/services-agreement) are the governing
  public sources reviewed.
- Candidate classification: `PURE_MANAGED_FREE` only after account-plan, model-pool, and managed
  intermediary terms are positively verified. Current lifecycle: `POLICY_REVIEW`.

## Kilo Gateway

- Account subscription: no active subscription or purchased credit balance was present. Kilo Pass
  "free credits" are purchase-dependent bonus credits, so they are not a Free Cloud pool.
- Kilo's official gateway documentation states that exact `:free` models have $0 pricing and that
  anonymous and authenticated free-model traffic is limited to 200 requests/hour/IP. It also says
  the live model endpoint is unauthenticated. The authenticated Kilo profile observed the current
  exact-free pool on 2026-09-18 as `poolside/laguna-s-2.1:free`,
  `cohere/north-mini-code:free`, `dots-studio/dots-3-note-preview:free`, and
  `stepfun/step-3.7-flash:free`; `tencent/hy3:free` was marked unavailable. `openrouter/free`
  remains an auto-router and is excluded.
- Kilo explicitly warns that Auto Free can send content to providers that log or improve from
  prompts. Auto routing is therefore prohibited; only future exact-model records can qualify.
  See [models and providers](https://kilo.ai/docs/gateway/models-and-providers) and
  [usage and billing](https://kilo.ai/docs/gateway/usage-and-billing).
- Candidate classification: `DISTRIBUTED_USER_FREE` with a `PER_USER_POOL`, pending exact-model,
  privacy, commercial-use, and client-execution review. Current lifecycle: `POLICY_REVIEW`;
  `KILO_DISTRIBUTED_FREE_CERTIFIED = NO`.

## Gemini Developer API

- Live project tier: Tier 1. The current table includes, among others: Gemini 2 Flash at 2,000
  RPM / 4M TPM / unlimited RPD; Gemini 2.5 Flash Lite at 4,000 RPM / 4M TPM / unlimited RPD;
  Gemini 2.5 Pro at 150 RPM / 2M TPM / 1,000 RPD; and Gemini 3.1 Flash Lite at 4,000 RPM / 4M
  TPM / 150,000 RPD. These are model-specific dashboard limits, not a claim of independent pools.
- The project’s unpaid-versus-paid service state was not established during the quota read, so the
  figures cannot be promoted into Free capacity yet.
- Google states that content sent to Gemini API unpaid services may be used to improve products
  and may receive human review; it expressly says not to submit sensitive or confidential data.
  This makes the unpaid route `PUBLIC_CODE_ONLY` for R14 pending a different, applicable data
  processing basis. See the [Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms).
- Candidate classification: `PURE_MANAGED_FREE` only if the selected project is proved to use
  unpaid quota. Current lifecycle: `POLICY_REVIEW`; `GEMINI_FREE_CERTIFIED = NO`.

## Mistral

- Live subscription: `Free` plan with a $10 included monthly API/Studio allowance. It resets on
  the first day of the calendar month. Pay-as-you-go is disabled, so consumption stops instead of
  billing after the allowance is exhausted.
- The same account shows per-model ceilings, including `codestral-2508` at 625,000 TPM / 2.08 RPS,
  `mistral-large-2512` at 250,000 TPM / 1 RPS, and `ministral-3b-2512` at 1,300,000 TPM / 12.5
  RPS. These are ceilings, not evidence that every listed model is no-cost within the allowance.
- Current account privacy setting permits API calls to be used for model training. R14 therefore
  treats this account as `USER_CONSENT_REQUIRED`, not private-code eligible. The setting was not
  changed; changing provider privacy controls is outside this automated campaign.
- Mistral documents that Free-mode usage is shared across Studio, API, and Vibe Code and that
  pay-as-you-go must be enabled to use beyond the allowance. See
  [Subscriptions](https://docs.mistral.ai/admin/billing-usage/subscriptions).
- Candidate classification: `PURE_MANAGED_FREE`, pending exact-model zero-cost, commercial
  intermediary, data-policy, credential, and runtime qualification. Current lifecycle:
  `COMPATIBILITY_TEST`; `MISTRAL_FREE_CERTIFIED = NO`.

## Cloudflare Workers AI

- Live subscription: Workers Paid is active. The Workers AI usage page reports a daily reset at
  00:00 UTC and current neuron consumption, but no hard account-level stop was configured in the
  inspected route.
- Cloudflare documents a 10,000-neuron/day free allocation on both Workers Free and Workers Paid;
  usage above that allocation on Workers Paid is billable. The account must therefore be modeled
  as `PAID` for ForgeAuto/Free until a hard, verified non-billing cap exists. The allocation may
  still be used only as an owner-controlled continuity experiment.
  [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) is the
  public source reviewed.
- Verdict: `CLOUDFLARE_MANAGED_FREE_CERTIFIED = NO` for the current account configuration.

## OpenRouter

- The authenticated credit view shows `$25.00` available Pay-as-you-go balance and two existing
  transactions (`$10.00` on 2026-09-15 and `$15.00` on 2026-09-17). No new credit was added by
  R14. This is account evidence for the documented higher exact-`:free` allowance, not permission
  to consume the deposit or to route paid models. R14 classifies the higher tier as
  `DEPOSIT_UNLOCKED_FREE` and keeps it outside default Managed Free until runtime allowance and
  intermediary policy are reconciled.
- Existing provider policy records document low no-deposit `:free` allowance and a higher allowance
  unlocked by an existing qualifying balance. This must be reconfirmed against the live account and
  runtime headers before any capacity is counted. Every future route must exact-pin a `:free` model
  and disable paid fallback.
- Candidate classification: low no-deposit reserve `PURE_MANAGED_FREE` only after live allowance,
  exact-model privacy, and current terms are verified; higher balance-unlocked tier is
  `DEPOSIT_UNLOCKED_FREE`. Current lifecycle: `CAPACITY_PROBE`.

## Ollama Cloud

- Official Cloud API material establishes a direct, authenticated `https://ollama.com/v1` API and
  a separate local Ollama API. Only the Cloud endpoint is in scope; CodeForge must not use local
  Ollama inference.
- The published Free plan provides a monthly starter amount for a limited starter-model set and
  one concurrent Cloud request. Published Cloud model prices are non-zero. Included usage is
  consumed first, then any purchased usage-credit balance; this is not proof of recurring exact
  $0 managed inference or a hard no-charge fallback.
- Ollama publishes a zero-data-retention / no-training claim for Cloud prompts and responses, but
  that does not establish permission for CodeForge to relay one owner account to other users.
- The authenticated Usage page observed on 2026-09-18 shows the Free plan's six eligible cloud
  models (`gemma4:31b`, `gpt-oss:120b`, `gpt-oss:20b`, `nemotron-3-nano:30b`,
  `nemotron-3-super`, and `nemotron-3-ultra`), `0%` free usage used, a provider-displayed reset
  horizon of five days, `$0` usage-credit balance, and Auto-reload `Off`. The account page does
  not expose the monthly token-credit amount or an exact API hard-stop receipt, so token capacity
  remains unknown. The Terms page (last updated May 2026) prohibits automated access without
  permission and does not clear a CodeForge-managed multi-user relay. R14 therefore records an
  `OWNER_DEV_FREE` candidate with one observed concurrent Cloud request, excludes it from
  ForgeAuto/Free, and does not create or use a key.
- Sources: [Ollama pricing](https://ollama.com/pricing), [Cloud API authentication](https://github.com/ollama/ollama/blob/main/docs/api/authentication.mdx), and [Cloud API documentation](https://github.com/ollama/ollama/blob/main/docs/cloud.mdx).

## Aggregate R14 Status

There are currently **zero production-approved Managed Free pools** added by R14. There is one
bounded, owner-only `OWNER_DEV_FREE` candidate (Ollama Cloud) with unknown token-credit capacity;
it is not product capacity. This is the
correct fail-closed result: account dashboards revealed trial, paid-spillover, privacy, plan, and
terms constraints that cannot be represented as safe user capacity. The capacity model and
evidence now preserve those constraints for the next qualification passes.
