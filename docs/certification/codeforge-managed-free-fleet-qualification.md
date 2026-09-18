# CodeForge Managed-Free Fleet Qualification — 2026-09-15

## 1. Verdict

The campaign produced a truthful five-model canonical managed-free roster without padding to thirteen slots. Three Groq routes have fresh successful live certification; Cloudflare contributes real free backends but is currently at its documented daily hard stop; OpenRouter contributes one historically qualified exact `:free` route whose current remaining counter is unknown; Z.AI direct access is awaiting an operator credential.

The R4 verdict is unchanged and remains:

`CODEFORGE_R4_CAPACITY_LIMITED_EXTERNAL_EVIDENCE_PENDING`

R4.6 is not certified. The campaign did not create paid spillover, use local inference, disclose secrets, or treat a catalog listing as runtime qualification.

## 2. Starting Repository State

- Checkout: `forger-digital-solutions-forgegreen-certified`
- Starting commit: `7ed7e6604c8eff2f4f929274d438cc7a2b6e733d`
- Worktree was clean before this campaign.
- Existing R4 truth, historical evidence, and newer ForgeGreen work were preserved.
- Existing R4 scale evidence models 520 normal task units per reset window and blocks the 373-DAU and heavy-user cases. See [the R4 report](../r4-campaign-report.md).

## 3. Providers Audited

Groq, Cloudflare Workers AI, OpenRouter, Z.AI, Google Gemini, Cerebras, SambaNova, Mistral, Ollama Cloud/user-connected access, NVIDIA API Catalog, Hugging Face Inference Providers, Together AI, Fireworks AI, Poolside, SiliconFlow, DeepSeek, Kilo, and OpenCode/Zen-style preview routes were reviewed against the current provider-definition registry and current official documentation.

Important current facts:

- Groq documents free-plan limits and response headers for request/token remaining and reset windows. [Groq rate limits](https://console.groq.com/docs/rate-limits)
- Cloudflare documents 10,000 Neurons/day on the Free plan and a hard stop when the allocation is exceeded. [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- OpenRouter documents 50 free requests/day below the qualifying credit threshold and 1,000/day at or above it; the runtime headers remain authoritative for the current counter. [OpenRouter FAQ](https://openrouter.ai/docs/faq), [OpenRouter limits](https://openrouter.ai/docs/api_reference/limits)
- Gemini free-tier usage is project/account dependent and the unpaid service documents content use for product improvement. [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), [Gemini terms](https://ai.google.dev/gemini-api/terms)
- Cerebras currently documents a $5 Free Trial that expires after 30 days; this is promotional credit, not a recurring free tier. [Cerebras rate limits](https://inference-docs.cerebras.ai/support/rate-limits)
- SambaNova documents a free tier, but no connected account attestation or qualification receipt was available in this checkout. [SambaNova rate limits](https://docs.sambanova.ai/docs/en/models/rate-limits)
- Mistral documents Free mode plus account-admin usage limits; plan, usage, and PAYG state must be attested before managed routing. [Mistral subscriptions](https://docs.mistral.ai/admin/billing-usage/subscriptions), [Mistral usage limits](https://docs.mistral.ai/admin/billing-usage/usage-limits)
- Ollama’s cloud offering is user-connected/consumer access with starter usage and paid credits/plans; there is no managed Ollama Cloud adapter in this repository. [Ollama pricing](https://ollama.com/pricing)

## 4. Qualified Providers

| Provider | Campaign state | What is actually qualified |
|---|---|---|
| Groq | `MANAGED_FREE_QUALIFIED` | Three exact models with fresh bounded live certification and runtime rate headers. Account plan still requires attestation. |
| Cloudflare Workers AI | `MANAGED_FREE_LIMITED` | Free allowlisted routes and earlier qualification receipts; latest probes returned the documented 10,000-neuron daily-capacity 429. |
| OpenRouter | `MANAGED_FREE_LIMITED` | Exact `nvidia/nemotron-3-super-120b-a12b:free` route qualified in R5; current daily capacity is not re-observable from the stored account evidence. |

## 5. Rejected / Pending Providers

- `AUTH_PENDING`: Z.AI, because `ZAI_API_KEY` was absent; no call was attempted.
- `POLICY_PENDING`: Gemini, Mistral, Poolside, SiliconFlow, Kilo, and preview OpenCode routes.
- `PROMOTIONAL_ONLY`: Cerebras, NVIDIA evaluation access, Hugging Face credits, Together AI, and Fireworks AI.
- `USER_CONNECTED_FREE`: Ollama Cloud; it is not a centrally managed CodeForge entitlement and has no repository adapter.
- `PAID_ONLY`: DeepSeek direct API.
- SambaNova remains `AUTH_PENDING` rather than being promoted from documentation to runtime qualification.

## 6. Qualified Models

The canonical roster is five entries, with provider routes deduplicated by canonical model identity. The exact route, provider state, role state, and proof age remain visible; a qualified historical route is not silently presented as currently executable.

1. `openai/gpt-oss-120b`
2. `openai/gpt-oss-20b`
3. `qwen/qwen3.8-27b`
4. `nvidia/nemotron-3-super-120b-a12b`
5. `zai/glm-4.7-flash`
The OpenRouter exact route for `nvidia/nemotron-3-super-120b-a12b` is represented as a backend of item 4, not a sixth model. The machine-readable evidence retains the route record inside item 4.

## 7. Final User-Facing Free Roster

```text
FORGEAUTO / FREE
Adaptive managed-free routing

01. GPT-OSS 120B
    backends: Groq (fresh active proof), Cloudflare Workers AI (free, quota exhausted)
    roles: primary coding qualified; subagent probation; search/summarizer not qualified
    context: 131,072
    tools: tool/edit loop proven; structured output probationary
    capacity: account-dependent free daily allocation
    live proof: Groq certified 2026-09-15; Cloudflare 429 at daily cap
    policy: cleared, with Groq free-plan attestation

02. GPT-OSS 20B
    backends: Groq (fresh active proof), Cloudflare Workers AI (free, quota exhausted)
    roles: primary coding, subagent, search, summarizer qualified
    context: 131,072
    tools: tool, edit, and structured-output probes passed on Groq
    capacity: account-dependent free daily allocation
    live proof: Groq certified 2026-09-15; Cloudflare 429 at daily cap
    policy: cleared, with Groq free-plan attestation

03. Qwen 3.8 27B
    backends: Groq (fresh active proof), Cloudflare Workers AI (free, quota exhausted)
    roles: primary coding, subagent, search, summarizer qualified
    context: 262,144 catalog value; Groq route metadata is separately retained
    tools: tool, edit, and structured-output probes passed on Groq
    capacity: account-dependent free daily allocation
    live proof: Groq certified 2026-09-15; Cloudflare 429 at daily cap
    policy: cleared, with Groq free-plan attestation

04. Nemotron 3 Super 120B A12B
    backends: OpenRouter exact :free route (qualified but stale capacity), Cloudflare alternate (quota exhausted)
    roles: primary coding, subagent, search, summarizer qualified on the OpenRouter receipt
    context: 262,144
    tools: tool and structured-output capability recorded
    capacity: OpenRouter account counter unknown; Cloudflare daily hard stop
    live proof: OpenRouter R5 qualification; no fresh current-capacity receipt
    policy: cleared only for the exact free route; no silent substitution

05. GLM-4.7 Flash
    backends: Cloudflare exact free allowlist route (stale capacity), Z.AI direct route (auth pending)
    roles: primary coding qualified; subagent probation; search/summarizer not qualified
    context: 131,072 on Cloudflare route
    tools: earlier coder proof; tool-agent evidence probationary
    capacity: Cloudflare 10,000-neuron/day hard stop
    live proof: previous Cloudflare qualification; current probe blocked by 429
    policy: Cloudflare free allowlist cleared; Z.AI direct auth pending

```

Slots 06–13 are intentionally empty. No additional candidate passed all of free-economics, policy, exact-model, role, and runtime-proof gates in this campaign.

## 8. Provider Backend Matrix

| Provider | Free class | State | Managed-Free use |
|---|---|---|---|
| Groq | Free daily allocation | `MANAGED_FREE_QUALIFIED` | Exact GPT-OSS 120B, GPT-OSS 20B, and Qwen 3.8 27B routes. |
| Cloudflare Workers AI | 10,000 neurons/day | `MANAGED_FREE_LIMITED` | Allowlisted free routes; quota exhaustion is a capacity state, not a capability failure. Paid-only Kimi/GLM 5.x/DeepSeek V4 routes are excluded. |
| OpenRouter | Exact `:free` API | `MANAGED_FREE_LIMITED` | Exact Nemotron route only after the stored qualification receipt; `openrouter/free` remains a discovery/router candidate, not a qualified model slot. |
| Z.AI | Listed free Flash models | `AUTH_PENDING` | Direct adapter exists; no operator key, no live qualification. |
| Gemini | Project free tier | `POLICY_PENDING` | No managed route until privacy and account spillover attestation are explicit. |
| Cerebras | Expiring trial credit | `PROMOTIONAL_ONLY` | Excluded from Managed-Free. |
| SambaNova | Account free tier | `AUTH_PENDING` | Documentation reviewed; connection and role proof missing. |
| Mistral | Free mode/monthly allowance | `POLICY_PENDING` | Plan, usage, PAYG, and data-policy attestation missing. |
| Ollama Cloud | User starter usage | `USER_CONNECTED_FREE` | No managed adapter; never interpreted as local inference or central fleet capacity. |
| NVIDIA | Evaluation access | `PROMOTIONAL_ONLY` | Not a durable production free entitlement. |
| Hugging Face | Small promotional credits | `PROMOTIONAL_ONLY` | Excluded because PAYG spillover is possible. |
| Together AI | Signup credits | `PROMOTIONAL_ONLY` | Excluded. |
| Fireworks AI | Signup credits | `PROMOTIONAL_ONLY` | Excluded. |
| Poolside | Preview/free listing | `POLICY_PENDING` | Legal and capacity evidence incomplete. |
| SiliconFlow | Unreviewed free program | `POLICY_PENDING` | No independent terms evidence. |
| DeepSeek | Paid API | `PAID_ONLY` | Never eligible for Managed-Free. |
| Kilo / OpenCode preview | External preview | `POLICY_PENDING` | Legal/privacy and current capacity review incomplete. |

## 9. Role Qualification

8-Bit role names are mapped into product roles at the registry boundary. A model is not made generally qualified by one passing task: role receipts remain per exact provider/model route.

| Canonical model | Primary coding | Subagent / tool agent | Search / analyst | Summarizer |
|---|---|---|---|---|
| GPT-OSS 120B | Qualified on Groq | Probation | Not qualified | Not qualified |
| GPT-OSS 20B | Qualified on Groq | Qualified | Qualified | Qualified |
| Qwen 3.8 27B | Qualified on Groq | Qualified | Qualified | Qualified |
| Nemotron 3 Super | Qualified on OpenRouter receipt | Qualified | Qualified | Qualified |
| GLM-4.7 Flash | Qualified on earlier Cloudflare receipt | Probation | Not qualified | Not qualified |

## 10. Tool/Agent Compatibility

Tool use is a hard gate for agent roles. GPT-OSS 20B and Qwen 3.8 27B passed compact tool, edit, and structured-output probes on Groq. GPT-OSS 120B passed tool/edit probes but failed the structured probe in the latest receipt, so its tool-agent role remains probationary. Nemotron’s OpenRouter receipt recorded tool and structured-output support. GLM-4.7 Flash has earlier coder evidence but is not promoted to a general tool-agent role.

## 11. Capacity Evidence

Evidence provenance now travels with route metadata as `DOCUMENTED`, `OBSERVED`, `DERIVED`, or `UNKNOWN`. The campaign records the following without pretending that documentation is a live account counter:

- Groq: documented 30 RPM, 1,000 RPD, 8,000 TPM, and 200,000 TPD for the relevant free models; live response headers observed remaining requests/tokens and rolling reset values on 2026-09-15. [Official limits](https://console.groq.com/docs/rate-limits)
- Cloudflare: documented 10,000 Neurons/day Free allocation, fixed daily reset, and hard stop. The current live evidence returned HTTP 429 with the daily allocation exhausted. [Official pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- OpenRouter: documented 20 RPM and 50/1,000 daily `:free` allowance based on qualifying purchased-credit history; the current remaining daily value was not observed in stored evidence. [Official limits](https://openrouter.ai/docs/api_reference/limits)
- Context windows come from route/model catalog evidence and are not used as capacity proof.
- No provider is allowed to silently convert a free route into a paid route after capacity exhaustion.

## 12. 8-Bit Fleet Maintenance Status

Implemented and preserved:

- Provider/model discovery remains in the model-registry/8-Bit boundary.
- Admission remains ordered: discovery → terms → auth → connection → free verification → capability → CodeForge qualification → health → ForgeAuto eligibility.
- Qualification version, role suitability, capacity evidence, lifecycle, replacement candidate, and last successful runtime proof now bridge from the normalized overlay into ForgeZero records.
- Lifecycle values support `ACTIVE`, `DEGRADED`, `DEPRECATED`, `RETIRED`, and `REPLACEMENT_PENDING`.
- A route with `AUTH_REQUIRED` or `QUOTA_EXHAUSTED` is no longer reported as executable. This closes a truthfulness gap in the snapshot projection without changing the economic policy.
- Exact pinned selection remains exact; no fallback silently substitutes a different model.

## 13. ForgeAuto/Free Integration Status

ForgeAuto/Free consumes only the post-admission route view. Groq’s three currently qualified routes can be eligible when account attestation and health are present. Cloudflare routes move to a temporary unavailable/quota state when the 10,000-neuron allocation is exhausted. OpenRouter’s exact route remains disabled until its current capacity is freshly reconciled. Direct Z.AI is disabled while auth is missing.

ForgeAuto does not consume Models.dev pricing alone, does not route to local Ollama, and does not use paid or trial routes as hidden fallback.

## 14. R4 Scale Reassessment

The scale model was not rerun because the campaign did not introduce a fresh route with materially evidenced capacity. The runtime truthfulness fix prevents false executability; it does not add capacity. The deterministic baseline therefore remains 520 normal task units, with the existing 373-DAU and heavy-user blocks.

R4 remains `CODEFORGE_R4_CAPACITY_LIMITED_EXTERNAL_EVIDENCE_PENDING`. The campaign does not promote 8-Bit or certify R4.6.

## 15. Subscription Decision

No provider subscription is warranted now. Purchases would either violate the campaign’s managed-free boundary or change the economic class being measured:

| Provider | Paid action considered | Decision |
|---|---|---|
| Cloudflare | $5/month Workers Paid plan and overage | Not needed; it would introduce paid overage. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| OpenRouter | Additional purchased credits | Not needed for this campaign; it would change the account allowance basis and still would not prove current remaining capacity. |
| Groq | Developer/paid plan | Not needed; current free routes are live-qualified and paid capacity is out of scope. |
| Cerebras | Paid/continued access | Not needed; current Free Trial is promotional. |
| Mistral / SambaNova / Gemini | Billing or paid-tier activation | Not needed; it would change spillover and/or privacy assumptions. |
| Ollama | Pro/Max or additional credits | Not needed; user-connected consumer access is not managed fleet capacity. |

## 16. Tests / Build

- `npm.cmd run typecheck --workspace=@codeforge/forge-zero` — passed.
- `npm.cmd run typecheck --workspace=@codeforge/model-registry` — passed.
- `npm.cmd test -- packages/model-registry/test/free-cloud-registry.test.ts` — passed, 24 tests.
- The new regression test covers quota-exhausted routes being non-executable and not ForgeAuto eligible.
- `npm.cmd run build` — passed across the workspaces, desktop bundle, and web bundle. Vite emitted only existing chunk-size warnings.
- `npm.cmd test` — 333 files passed, 7 skipped, 1 intentionally red archived R3 smoke fixture; 2,499 tests passed and 36 skipped. The preserved failure is `tests/evidence/r3/corpus-runs/campaign-1/smoke-archive/S-001-wrapper-eval/attempt-1/run-worktrees/S-001-a1/wt-49ce0b72/test/math.test.ts`, where the archived fixture expects `divide(6, 0)` to return `0` but the implementation returns `Infinity`.
- The full suite’s live catalog check discovered 23 current OpenRouter zero-unit candidates. Discovery is not qualification, so those candidates remain outside the user-facing roster until exact role receipts exist.

## 17. Live Evidence

The latest bounded live certification evidence is [managed-free-live-certification.json](../evidence/managed-free-live-certification.json): Groq certified three models, Cloudflare returned quota exhaustion, and Z.AI was not called because operator auth was absent. The full-suite catalog refresh independently observed 23 current OpenRouter zero-unit candidates, but did not qualify them. Prior fleet evidence is [managed-free-r2-fleet-qualification.json](../evidence/managed-free-r2-fleet-qualification.json); the OpenRouter exact-route proof is retained there.

No new inference calls were made solely to manufacture a larger roster during this packaging pass.

## 18. Evidence Files

- [Machine-readable campaign evidence](../evidence/managed-free-fleet-qualification-2026-09-15.json)
- [Prior live certification](../evidence/managed-free-live-certification.json)
- [Prior R2 fleet qualification](../evidence/managed-free-r2-fleet-qualification.json)
- [Prior exact-route fleet evidence](../evidence/managed-free-r2-fleet-qualification.json)
- [R4 capacity report](../../tests/evidence/r4-scale/scale-report.json)
- [Provider research](../research/r4-provider-research-2026-09-15.md)

No secret values, tokens, or raw credentials are present in these files.

## 19. Commits

No commit or push was created. The working tree contains only the scoped registry/test changes and these campaign evidence files; existing user work was preserved.

## 20. Remaining Blocks

- Fresh Groq free-plan attestation at runtime.
- Fresh OpenRouter `X-RateLimit-*` and account-counter observation for the exact Nemotron route.
- Cloudflare daily reset followed by a bounded requalification run.
- Z.AI operator credential and direct-route live qualification.
- SambaNova connection plus free-plan attestation and role qualification.
- Mistral privacy/plan/PAYG attestation.
- Real early-access evidence for R4.5 and sufficient capacity evidence for R4.6.

## 21. Recommended Next Campaign

Run one bounded, no-purchase recertification after the next provider reset window: attest Groq’s plan, observe OpenRouter headers, requalify Cloudflare only after its UTC reset, and qualify Z.AI/SambaNova only if the operator supplies credentials. Then refresh the route lifecycle and replacement receipts, rerun the R4 scale model only if a route’s proven capacity changes materially, and retain the R4 verdict until the external 373-user evidence exists.
