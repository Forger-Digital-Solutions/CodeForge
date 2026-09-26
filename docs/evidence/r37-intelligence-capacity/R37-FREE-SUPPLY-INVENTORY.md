# R37 — Free Supply Inventory

Audit source: `packages/model-registry/src/provider-definitions.ts` (33 provider definitions),
`free-cloud-registry.ts` (`supplyClassFor`), `free-cloud-service.ts` (`capacityRoutes`/`capacityPools`),
`packages/forge-zero/src/capacity-policy.ts` (`freeRouteExclusionReason`, `supplyClassIsZeroCash`).

Classification is enforced in code, not documentation: every route carries an
`freeAccess.class`, a derived `supplyClass`, and a fail-closed exclusion reason when ineligible.
This document inventories the declared state; live credential presence is **unverified** unless
noted — quota is not consumed merely to re-prove it.

## Provider inventory (declared policy truth)

| Provider | freeAccess.class | spillover | quotaDomain | supplyClass source |
|---|---|---|---|---|
| codeforge-cloud | FREE_ACCOUNT_ENTITLEMENT | NONE | - | PURE_MANAGED_FREE (hosted gateway) |
| openrouter | FREE_API | NONE | - | USER_CONNECTED / OWNER_DEV by credential source; managed use blocked (terms) |
| zai | FREE_API | NONE | - | USER_CONNECTED_FREE |
| alibaba | PAID_API | SILENT_CHARGES | - | PAID — excluded |
| google | FREE_ACCOUNT_ENTITLEMENT | ACCOUNT_DEPENDENT | - | USER_CONNECTED_FREE (free tier account-dependent) |
| groq | FREE_DAILY_ALLOCATION | ACCOUNT_DEPENDENT | **model** | USER_CONNECTED / OWNER_DEV by credential source |
| cerebras | PROMOTIONAL_CREDIT | NONE | - | PROMOTIONAL_FREE — excluded from baseline |
| sambanova | FREE_ACCOUNT_ENTITLEMENT | ACCOUNT_DEPENDENT | - | USER_CONNECTED_FREE |
| mistral | FREE_MONTHLY_ALLOWANCE | ACCOUNT_DEPENDENT | **model** | USER_CONNECTED / OWNER_DEV by credential source |
| ollama-cloud | PROMOTIONAL_CREDIT | ACCOUNT_DEPENDENT | - | USER_CONNECTED_FREE (def declares userConnectedFree) |
| cloudflare-workers-ai | FREE_DAILY_ALLOCATION | ACCOUNT_DEPENDENT | - | USER_CONNECTED / OWNER_DEV; neuron-budget governor |
| nvidia | FREE_DEV_ENDPOINT | NONE | - | OWNER_DEV_FREE — never product free |
| deepseek | PAID_API | SILENT_CHARGES | - | PAID — excluded |
| poolside | FREE_DEV_ENDPOINT | NONE | - | OWNER_DEV_FREE — never product free |
| huggingface | PROMOTIONAL_CREDIT | ACCOUNT_DEPENDENT | - | PROMOTIONAL_FREE — excluded |
| togetherai | PROMOTIONAL_CREDIT | SILENT_CHARGES | - | PROMOTIONAL_FREE — excluded |
| fireworks-ai | PROMOTIONAL_CREDIT | SILENT_CHARGES | - | PROMOTIONAL_FREE — excluded |
| siliconflow | LEGAL_REVIEW_REQUIRED | ACCOUNT_DEPENDENT | - | blocked pending terms |
| nebius | PROMOTIONAL_CREDIT | SILENT_CHARGES | - | PROMOTIONAL_FREE — excluded |
| novita-ai | PROMOTIONAL_CREDIT | SILENT_CHARGES | - | PROMOTIONAL_FREE — excluded |
| hyperbolic | PROMOTIONAL_CREDIT | SILENT_CHARGES | - | PROMOTIONAL_FREE — excluded |
| friendli | PROMOTIONAL_CREDIT | SILENT_CHARGES | - | PROMOTIONAL_FREE — excluded |
| baseten | PROMOTIONAL_CREDIT | SILENT_CHARGES | - | PROMOTIONAL_FREE — excluded |
| moonshotai | PAID_API | SILENT_CHARGES | - | PAID — excluded |
| opencode | FREE_API | NONE | - | USER_CONNECTED_FREE |
| kilo | LEGAL_REVIEW_REQUIRED | NONE | - | blocked pending terms |
| zenmux | LEGAL_REVIEW_REQUIRED | NONE | - | blocked pending terms |
| github-copilot | FREE_ACCOUNT_ENTITLEMENT | ACCOUNT_DEPENDENT | - | USER_CONNECTED_FREE (def declares userConnectedFree) |
| github-models | FREE_DAILY_ALLOCATION | NONE | **model** | USER_CONNECTED / OWNER_DEV |
| anthropic | PAID_API | SILENT_CHARGES | - | PAID — excluded |
| openai | PAID_API | SILENT_CHARGES | - | PAID — excluded |
| codeforge | FREE_PRODUCT_ONLY | NONE | - | PURE_MANAGED_FREE |

## Supply-class derivation (RC-5)

`supplyClassFor` maps connection × definition, not definition alone:

- `userConnectedFree` definitions (ollama-cloud, github-copilot) → USER_CONNECTED_FREE, always per-user pools.
- `FDS_GATEWAY` credential / hosted apiStyle → PURE_MANAGED_FREE regardless of credential shape.
- `ENVIRONMENT` credential source → OWNER_DEV_FREE — a dev's key is never Managed Free.
- Other connected credentials → USER_CONNECTED_FREE.
- `PAID_API` → PAID (hard-excluded); `PROMOTIONAL_CREDIT` → PROMOTIONAL_FREE (excluded from
  baseline: `PROMOTIONAL_FREE_NOT_BASELINE`); `LEGAL_REVIEW_REQUIRED`/`UNAVAILABLE` → undefined.
- `FREE_DEV_ENDPOINT` (nvidia, poolside) → OWNER_DEV_FREE — excluded: `OWNER_DEV_FREE_NOT_PRODUCT_FREE`.
- `FREE_PRODUCT_ONLY` (codeforge) → PURE_MANAGED_FREE.

`supplyClassIsZeroCash` admits: PURE_MANAGED_FREE, USER_CONNECTED_FREE, DISTRIBUTED_USER_FREE,
DEPOSIT_UNLOCKED_FREE, PROMOTIONAL_FREE, OWNER_DEV_FREE — but product *eligibility* separately
gates each class (`capacity-policy.ts:60-84`). SPONSORED_FREE is deliberately not zero-cash
(sponsor pays upstream); it requires `allowSponsoredFree`.

## Quota domains

- `quotaDomain: "model"` on groq, mistral, github-models: `capacityRoutes()` shards pools into
  `shared:<provider>:model:<model>` when no provider-scoped quota observation exists — per-model
  quota domains are preserved, not merged.
- All other account-scoped providers share `shared:<provider>` account pools.
- Per-user pools (`PER_USER_POOL`) carry `capacityIdentity`; the plan verifies ownership
  before any route on them is considered.

## Status vs. the brief's baseline

- Groq per-model quota domains: **implemented** (model-domain sharding + tokenizer-scaled demand).
- Mistral monthly allowance: model-domain sharding present; live quota truth unverified this pass.
- Cloudflare Workers AI: dedicated neuron-budget governor exists
  (`packages/providers/test/cloudflare-neuron-budget.test.ts`); whether the API token exposes
  authoritative usage — unverified, fail-closed behavior preserved.
- GitHub Models: FREE_DAILY_ALLOCATION, model domain, spillover NONE — technically eligible once
  connected; quota visibility gaps are handled by observed-window bookkeeping, not invented limits.
- OpenRouter managed-free: still blocked — `LEGAL_REVIEW_REQUIRED` on kilo/zenmux/siliconflow and
  `USER_CONNECTED`-only path for openrouter. No change this pass (correct: terms unresolved).
- Gemini: credentials suspended historically → ACCOUNT_DEPENDENT spillover classification stands;
  no re-test performed (would consume quota).
- Cerebras/Together/Fireworks/Nebius/Novita/Hyperbolic/Friendli/Baseten: PROMOTIONAL_CREDIT,
  correctly excluded from baseline free supply.

## Machine-readable classification vs the brief

VERIFIED_FREE → `explicitZeroPrice + verifiedFree + admission FORGEAUTO_ELIGIBLE` per route.
VERIFIED_FREE_WITH_LIMIT → same but with observed quota windows constraining supply.
USER_CONNECTED_FREE → `supplyClass === USER_CONNECTED_FREE`, PER_USER_POOL only.
CREDIT_BACKED → `PROMOTIONAL_FREE` / `DEPOSIT_UNLOCKED_FREE` (excluded or policy-gated).
TEMPORARY_PROMO → PROMOTIONAL_CREDIT class rows above.
QUARANTINED → `lifecycle: QUARANTINED` via `quarantineFor(poolId)` in capacityRoutes.
PAID → `PAID_API` class rows.
UNKNOWN → routes whose `freeAccess.class` is UNAVAILABLE or health UNKNOWN.
DEAD → `lifecycle: RETIRED` → `REJECTED` lifecycle in capacity projection.

## Unresolved risks

1. Live credential presence and current measured quota for groq/mistral/cloudflare/github-models
   were not re-probed this pass — classification is code-verified, live numbers are stale until
   an authorized probe runs.
2. OpenRouter FREE_API with spillover NONE could unlock many managed routes, but managed use is
   correctly blocked pending terms — remains the single largest potential supply expansion.
3. Free-provider model rotation is handled by catalog refresh + drift detection
   (`catalog-refresh-health.test.ts` 9 scenarios pass) — no release needed for roster updates.
