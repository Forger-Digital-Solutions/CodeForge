# CodeForge Provider Connections — R1

**Scope:** the provider registry, connection schemas, auth classes, free-access classification and
the ZCode-style manual connection flow shipped in the Free Cloud Platform R1 pass (2026-09-12).

Source of truth: `packages/model-registry/src/provider-definitions.ts`. Every provider CodeForge
can talk to is one `ProviderDefinition` — transport, connection fields, environment aliases,
discovery sources, free-access profile with evidence, privacy and terms. The desktop Settings UI,
environment-credential discovery, the provider factory and the 8-Bit admission pipeline all read
this table. There is no provider `switch` in React.

## Auth classes (friction order)

| Class | Meaning | R1 providers |
|---|---|---|
| `ZERO_TOUCH` | no user action; legitimate anonymous use or an authorized FDS gateway | CodeForge Free (hosted, `codeforge-cloud`) — server-owned keys, catalog browsable signed-out, execution after account sign-in |
| `OAUTH_PKCE` | one-click browser authorization, loopback callback | OpenRouter |
| `OAUTH_NATIVE` | first-party account sign-in | CodeForge Cloud account |
| `DEVICE_CODE` | device login | none in R1 (no provider offers a supported device flow for third-party clients) |
| `ENVIRONMENT_CREDENTIAL` | already-present env var, enabled by the user in Settings | every implemented provider with documented env vars |
| `ASSISTED_KEY` | paste one key once through the connection UI | every implemented key-based provider |
| `UNSUPPORTED` | no legitimate third-party connection | GitHub Copilot |

## Free-access classes

`FREE_API` · `FREE_DAILY_ALLOCATION` · `FREE_MONTHLY_ALLOWANCE` · `FREE_ACCOUNT_ENTITLEMENT` are
zero-cash and may be admitted. `PROMOTIONAL_CREDIT`, `FREE_DEV_ENDPOINT`, `FREE_PRODUCT_ONLY`,
`PAID_API`, `LEGAL_REVIEW_REQUIRED`, `UNAVAILABLE` never enter ForgeAuto/Free. The coarse ForgeZero
class is derived from these: a `$0` unit price on a promotional / dev-only / unreviewed provider
becomes `TRIAL`, never `FREE_*` (see `deriveAccessClass`).

Payment spillover: `NONE` (hard stop or $0 listing), `ACCOUNT_DEPENDENT` (free only while the
account has no paid plan — CodeForge requires a one-time free-plan confirmation in Settings before
probing or admitting), `SILENT_CHARGES` (never admitted).

## Provider inventory (investigated 2026-09-12, official sources)

| Provider | Adapter | Auth classes | Env variables | Free class | Spillover | Terms | ForgeAuto/Free default | Notes |
|---|---|---|---|---|---|---|---|---|
| CodeForge Free (hosted) | hosted | ZERO_TOUCH, OAUTH_NATIVE | — | FREE_ACCOUNT_ENTITLEMENT | NONE | CLEARED | yes | FDS gateway; upstream keys stay server-side |
| OpenRouter | openrouter | OAUTH_PKCE, ENV, ASSISTED_KEY | `OPENROUTER_API_KEY` | FREE_API (`:free`, 20 RPM, 50 RPD <10 credits) | NONE | CLEARED | yes | live pricing = 0/0 verified per refresh |
| Z.AI | openai-compatible | ENV, ASSISTED_KEY | `ZAI_API_KEY`, `ZHIPU_API_KEY` | FREE_API (GLM-4.5/4.7-Flash, GLM-4.6V-Flash $0) | NONE | CLEARED | yes | live `/models` + fresh Models.dev 0/0 |
| Groq | openai-compatible | ENV, ASSISTED_KEY | `GROQ_API_KEY` | FREE_DAILY_ALLOCATION (30 RPM/1K RPD/…) | ACCOUNT_DEPENDENT | CLEARED | after free-plan confirmation | Developer (paid) plan shares key shape |
| Google Gemini | openai-compatible | ENV, ASSISTED_KEY | `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` | FREE_ACCOUNT_ENTITLEMENT | ACCOUNT_DEPENDENT | CLEARED | after free-plan confirmation | free tier trains on content → privacy `permissive` |
| Cerebras | openai-compatible | ENV, ASSISTED_KEY | `CEREBRAS_API_KEY` | **PROMOTIONAL_CREDIT** ($5/30-day trial) | NONE | CLEARED | **no** | was a recurring free tier; now a trial |
| SambaNova | openai-compatible | ENV, ASSISTED_KEY | `SAMBANOVA_API_KEY` | FREE_ACCOUNT_ENTITLEMENT | ACCOUNT_DEPENDENT | CLEARED | after free-plan confirmation | free while no payment method |
| Mistral | openai-compatible | ENV, ASSISTED_KEY | `MISTRAL_API_KEY` | FREE_MONTHLY_ALLOWANCE (Experiment) | ACCOUNT_DEPENDENT | CLEARED | after free-plan confirmation | Experiment plan opts into training → `permissive` |
| Cloudflare Workers AI | openai-compatible (account id + token) | ENV, ASSISTED_KEY | `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` | FREE_DAILY_ALLOCATION (10k neurons/day, allowlist) | ACCOUNT_DEPENDENT | CLEARED | after free-plan confirmation | Kimi/GLM 5.x/DeepSeek v4 = Workers Paid |
| NVIDIA API Catalog | openai-compatible | ENV, ASSISTED_KEY | `NVIDIA_API_KEY` | FREE_DEV_ENDPOINT | NONE | DEVELOPMENT_ONLY | no | 99 `$0` Models.dev listings are trial credits |
| DeepSeek (direct) | openai-compatible | ENV, ASSISTED_KEY | `DEEPSEEK_API_KEY` | PAID_API | SILENT_CHARGES | CLEARED | no (BYOK) | |
| Poolside (direct) | openai-compatible | ENV, ASSISTED_KEY | `POOLSIDE_API_KEY` | FREE_DEV_ENDPOINT | NONE | LEGAL_REVIEW_REQUIRED | no | Laguna reaches Free via OpenRouter `:free` |
| Hugging Face | openai-compatible | ENV, ASSISTED_KEY | `HF_TOKEN`, `HUGGINGFACE_API_KEY` | PROMOTIONAL_CREDIT | ACCOUNT_DEPENDENT | CLEARED | no | |
| Together / Fireworks / Nebius / Novita / Hyperbolic / Friendli / Baseten | openai-compatible | ENV, ASSISTED_KEY | per definition | PROMOTIONAL_CREDIT | SILENT_CHARGES | CLEARED | no (BYOK) | |
| SiliconFlow | openai-compatible | ENV, ASSISTED_KEY | `SILICONFLOW_API_KEY` | LEGAL_REVIEW_REQUIRED | ACCOUNT_DEPENDENT | LEGAL_REVIEW_REQUIRED | no | |
| Moonshot (Kimi) direct | openai-compatible | ENV, ASSISTED_KEY | `MOONSHOT_API_KEY` | PAID_API | SILENT_CHARGES | CLEARED | no (BYOK) | |
| OpenCode Zen | opencode | ENV, ASSISTED_KEY | `OPENCODE_API_KEY` | FREE_API (`*-free`) | NONE | CLEARED | yes (7-day re-verify) | routes rotate/deprecate quickly |
| Kilo Gateway | — | — | `KILO_API_KEY` | LEGAL_REVIEW_REQUIRED | NONE | LEGAL_REVIEW_REQUIRED | no | not implemented |
| ZenMux | — | — | `ZENMUX_API_KEY` | LEGAL_REVIEW_REQUIRED | NONE | LEGAL_REVIEW_REQUIRED | no | not implemented |
| GitHub Copilot | — | UNSUPPORTED | — | FREE_PRODUCT_ONLY | NONE | NOT_ALLOWED | no | no supported third-party inference API |
| Anthropic | anthropic-messages | ENV, ASSISTED_KEY | `ANTHROPIC_API_KEY` | PAID_API | SILENT_CHARGES | CLEARED | no (BYOK) | `NO_SUPPORTED_ZERO_COST_ANTHROPIC_ROUTE` |
| OpenAI | openai-compatible | ENV, ASSISTED_KEY | `OPENAI_API_KEY` | PAID_API | SILENT_CHARGES | CLEARED | no (BYOK) | ChatGPT/Codex subscriptions are not API entitlements |

Models.dev provider metadata (213 providers on 2026-09-12) is merged at runtime
(`mergeModelsDevProviderHints`): known providers gain documented env aliases; unknown
OpenAI-compatible providers become `discovered` definitions that are connectable as BYOK through
the generic adapter and are **never** free-admitted until curated.

## Connection schema → UI

`ProviderConnectionSchema.fields[]` drives the renderer. Cloudflare declares two fields (API
token + account id); everyone else one. Non-secret fields are stored under `providerId:fieldId`
in the encrypted store and resolve `${ENV_NAME}` templates in the base URL.

## ZCode-style manual flow (`apps/desktop/src/renderer/AddProviderFlow.tsx`)

1. Provider ▾ (recommended free providers first)
2. Fields rendered from the schema; secrets masked; nothing persisted yet
3. **Validate** → trusted process builds a throwaway adapter over the typed values and calls the
   provider's `/models` (never a billable completion) → returns the classified catalog
4. Model ▾ populated from that catalog (free / paid / no-tools labels); optional per-model enable
5. **Save & connect** → values submitted once over IPC, encrypted with `safeStorage`, fields
   cleared, adapter registered, free discovery + 8-Bit qualification start, picker refreshes

No restart; no model id typing; no environment variable editing.

## Credential precedence and sources

`explicit secure connection (OAuth / manual) > enabled environment credential > none`.
The source is recorded (`OAUTH`, `MANUAL_BYOK`, `SECURE_STORAGE`, `ENVIRONMENT`, `FDS_GATEWAY`)
and shown on the provider card as *Credential source: …*. CodeForge never silently switches
sources; disconnecting a secure credential falls back to an enabled environment credential only
if one is enabled.

## Error normalization (§100-§101)

`packages/eight-bit/src/health.ts::classifyFailure` maps provider failures to
`AUTH_FAILURE | RATE_LIMITED | QUOTA_EXHAUSTED | TEMPORARY_CAPACITY | MODEL_NOT_FOUND |
MODEL_RETIRED | PROVIDER_OUTAGE | CONTEXT_LIMIT | BAD_REQUEST | SAFETY_REJECTION |
PAID_PLAN_REQUIRED | FREE_TIER_NOT_AVAILABLE | TRANSIENT_NETWORK | TIMEOUT | UNKNOWN` with a
policy per class (bounded retry, cooldown + rotate, remove + refresh, surface) and product-safe
wording in `FAILURE_USER_MESSAGE`. Raw provider text stays in diagnostics.
