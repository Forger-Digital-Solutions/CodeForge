# R50 Third Managed Domain Audit

**Date:** 2026-09-27
**Provenance:** deterministic (provider definitions + live credential probes, $0 spend)
**Scope:** whether a third legitimate CodeForge-managed zero-cost capacity domain exists beyond Groq + OpenRouter, per R50 §15–§17. User-connected, BYOK, trial-credit, and consent-requiring supply are excluded by policy.

## Method

- Enumerated every `implemented: true` provider in `packages/model-registry/src/provider-definitions.ts`.
- Checked each provider's `freeAccess.class`, `free_or_paid_class`, `data_use_class`, `terms.status`, and `recommendedForFreeDefault`.
- Checked environment for managed credentials (presence only, never values).
- Live-probed the strongest candidate's token verify + usage-analytics + inference endpoints at $0.

## Current managed free domains (R49 truth)

| Domain | Credential | Status |
|---|---|---|
| groq | `GROQ_API_KEY` env | production-qualified, 2 roles covered |
| openrouter | `OPENROUTER_API_KEY` env | production-qualified, independent account/pool |

Independent credential domains in production: **2**. Physical capacity pools: **4**.

## Candidate evaluation

| Provider | Free class | Terms | Credential | Verdict |
|---|---|---|---|---|
| **cloudflare-workers-ai** | `FREE_DAILY_ALLOCATION` (10k neurons/day, hard stop) | `CLEARED` | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` present | **LEGITIMATE — blocked on one credential scope** |
| google | `UNPAID_ALLOWANCE` (Gemini free tier) | `CLEARED` | `GEMINI_API_KEY` present | **EXCLUDED** — `user_policy_acceptance_required`, `TRAINING_POSSIBLE` data class, `freePolicyState` gate; free tier trains on prompts → fails `PRIVATE_CODE_ALLOWED` managed profile (§17) |
| mistral | `UNPAID_ALLOWANCE` | `CLEARED` | `MISTRAL_API_KEY` present | **EXCLUDED** — `TRAINING_POSSIBLE`; R49 already observed `DATA_POLICY_USER_CONSENT_REQUIRED` exclusions (§17) |
| zai | `FREE_API` (GLM flash $0) | `CLEARED` | none | Eligible shape (`recommendedForFreeDefault`, `spillover: NONE`, legacy implicit env) but **no credential provisioned** — cannot attest a managed account |
| cerebras | `TRIAL_CREDIT` ($5/30d) | `CLEARED` | `CEREBRAS_API_KEY` present | **EXCLUDED** — time-boxed trial, not recurring managed free |
| sambanova | `FREE_ACCOUNT_ENTITLEMENT` | `CLEARED` | none | Eligible shape but no credential provisioned; free tier is "while no payment method linked" — spillover `ACCOUNT_DEPENDENT` needs attestation |
| nvidia | `FREE_DEV_ENDPOINT` | `DEVELOPMENT_ONLY` | none | **EXCLUDED** — evaluation endpoint, excluded from production free routing |
| ollama-cloud | `PROMOTIONAL_CREDIT` + user-connected | `LEGAL_REVIEW_REQUIRED` | none | **EXCLUDED** — USER_CONNECTED_FREE only; credit-funded starter usage is not a managed $0 route |
| poolside | `FREE_DEV_ENDPOINT` | preview | none | **EXCLUDED** — preview endpoint, no rate card |
| openai / alibaba / deepseek | `PAID_API` | — | — | **EXCLUDED** — paid only |

## Cloudflare Workers AI — detailed finding

The provider is already fully integrated and hardened:

- `createCloudflareAdapter` (`packages/providers/src/provider-factory.ts`) — OpenAI-compatible transport with `${CLOUDFLARE_ACCOUNT_ID}` base-URL resolution.
- `CloudflareNeuronBudgetGuard` (`packages/providers/src/cloudflare-neuron-budget.ts`) — fail-closed application-side cost gate: reserves an estimated neuron budget per request against a **8,000-neuron safe daily ceiling** (10,000 included), settles actual neurons from the response `usage.neurons` field, and *requires* a trustworthy daily-usage observation before any request is constructed.
- `GraphqlCloudflareUsageSource` — reads `aiInferenceAdaptiveGroups.sum.totalNeurons` per UTC day from Cloudflare GraphQL analytics; `CLOUDFLARE_USAGE_SCOPE_REQUIRED` is a distinct non-self-healing failure (operator must mint a new token).
- Free allowlist (`allowanceModels`) includes tool-capable models relevant to reviewer/explorer/coder redundancy: `@cf/openai/gpt-oss-120b`, `@cf/nvidia/nemotron-3-120b-a12b`, `@cf/qwen/qwen2.5-coder-32b-instruct`, `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, `@cf/qwen/qwen3-30b-a3b-fp8`, plus smaller fast models (`gpt-oss-20b`, `glm-4.7-flash`, `gemma-4-26b`, `mistral-small-3.1-24b`, `llama-4-scout`). Paid-plan models (kimi, glm-5.x, deepseek-v4) are declared separately and ineligible.
- No `recommendedForFreeDefault` — `planDetection: "attestation"` requires the account to be attested on the Workers Free plan (hard stop) rather than Workers Paid (bills beyond allocation).

### Live probe results (2026-09-27, $0)

| Probe | Result |
|---|---|
| `user/tokens/verify` | **PASS** — token active (`d2c1f873…`) |
| Inference `@cf/openai/gpt-oss-20b` chat completion | **PASS** — real response, `usage.neurons: 1.6`, inside free allowlist |
| GraphQL `aiInferenceAdaptiveGroups` | **DENIED** — `"not authorized for that account"` (HTTP 200 + authz error → `CLOUDFLARE_USAGE_SCOPE_REQUIRED`) |

### Consequence

`canRoute(modelId)` returns false without a store snapshot; `reserve()` throws `CLOUDFLARE_USAGE_SCOPE_REQUIRED` before any request is constructed. The guard is **correctly failing closed** — CodeForge will not spend against an unmeasurable Cloudflare allocation.

**One operator action unblocks the third domain:** mint/replace `CLOUDFLARE_API_KEY` with a token carrying account-level analytics read (Workers AI usage / Account Analytics). No code change required. Until then the domain is proven legitimate but unadmittable.

## Verdict

- A third **legitimate** managed domain exists: `cloudflare-workers-ai` (true provider + account independence from Groq/OpenRouter, cleared terms, hard-stop free allocation, tool-capable allowlist).
- It is **not yet admittable**: the provisioned token lacks analytics read scope, and the fail-closed neuron guard correctly withholds inference.
- Nothing in the audit justifies weakening policy to reach "three": Google/Mistral free tiers are `TRAINING_POSSIBLE`/consent-gated, Cerebras/NVIDIA/Poolside are trial-or-dev endpoints, Ollama Cloud is user-connected.
- If the operator supplies a properly-scoped token, staged onboarding (connectivity → tool probe → reviewer qualification → production probation) can proceed immediately — the transport, guard, rates, and allowlist already exist.
