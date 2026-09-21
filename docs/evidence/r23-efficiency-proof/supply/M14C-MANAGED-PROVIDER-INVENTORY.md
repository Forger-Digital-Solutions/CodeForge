# M14C — Managed Free provider inventory (authoritative, from live code)

Status: inventory complete. Source: `PROVIDER_DEFINITIONS` @ `74fcfea` →
`supply/provider-inventory-raw.json` (31 providers, regenerated from dist, not transcribed).

## Tier 1 — zero-cash class + CLEARED terms + implemented (admissible candidates)

| provider | freeAccess | spillover | quota evidence (definition) | tonight's reality |
|---|---|---|---|---|
| codeforge-cloud | FREE_ACCOUNT_ENTITLEMENT | NONE | first-party gateway | managed pool root; upstreams are the entries below |
| openrouter | FREE_API | NONE | `:free` catalog, 1000 req/day observed live | 19 tool-capable `:free` models; upstream saturated; nemotron 2/9 qualified attempts |
| zai | FREE_API | NONE | free API class | no live qualification evidence yet |
| google | FREE_ACCOUNT_ENTITLEMENT | ACCOUNT_DEPENDENT | Gemini free tier per-account | env key present; 403 observed earlier — account gate |
| groq | FREE_DAILY_ALLOCATION | ACCOUNT_DEPENDENT | daily allocation | env key present; ~8K TPM noted in R22 |
| sambanova | FREE_ACCOUNT_ENTITLEMENT | ACCOUNT_DEPENDENT | per-account free | no credential present |
| mistral | FREE_MONTHLY_ALLOWANCE | ACCOUNT_DEPENDENT | monthly allowance | env key present; untested |
| cloudflare-workers-ai | FREE_DAILY_ALLOCATION | ACCOUNT_DEPENDENT | daily neurons | `CLOUDFLARE_ACCOUNT_ID` present; API token absent |
| opencode | FREE_API | NONE | free API | untested tonight |
| codeforge (bundled) | FREE_PRODUCT_ONLY | NONE | internal smoke records | test-only |

## Tier 2 — real capacity, wrong legal/contract class for managed Free today

| provider | class | blocker |
|---|---|---|
| nvidia | FREE_DEV_ENDPOINT | `DEVELOPMENT_ONLY` terms — the very upstreams behind tonight's `:free` routes; dev endpoints are benchmark supply, not product supply |
| poolside | FREE_DEV_ENDPOINT | `LEGAL_REVIEW_REQUIRED` |
| github-copilot | FREE_ACCOUNT_ENTITLEMENT | `LEGAL_REVIEW_REQUIRED` + user-entitlement only (M14A) |
| ollama-cloud | PROMOTIONAL_CREDIT | `LEGAL_REVIEW_REQUIRED` managed; user-connected profile exists (M14B) |
| siliconflow | LEGAL_REVIEW_REQUIRED | unreviewed |
| kilo, zenmux | LEGAL_REVIEW_REQUIRED | not implemented |

## Tier 3 — promotional credit (temporary supply; never baseline Free)

cerebras (NONE spillover — $5 trial noted), huggingface, togetherai, fireworks-ai, nebius,
novita-ai, hyperbolic, friendli, baseten — all `SILENT_CHARGES` except cerebras/huggingface
(ACCOUNT_DEPENDENT). Usable for qualification/benchmarks under `PROMOTIONAL_FREE` accounting;
must auto-retire at expiry (`on_exhaustion: ROTATE_THEN_RETIRE` in the M14 ledger).

## Tier 4 — paid-only (never Free)

alibaba, deepseek, moonshotai, anthropic (has trial), openai.

## Answers to the brief's questions (current state)

- **Which managed Free providers actually work?** OpenRouter `:free` — proven live tonight
  (87+ served calls, real receipts); everything else is definition-level, unqualified.
- **Production/multi-tenant capable?** CLEARED terms + implemented + zero-cash class:
  codeforge-cloud, openrouter, zai, groq, google, mistral, cloudflare-workers-ai, sambanova,
  opencode — pending per-route qualification and `managedMultiUserAllowed` per route.
- **Legally uncertain?** nvidia (dev-only), poolside, github-copilot, ollama-cloud,
  siliconflow, kilo, zenmux.
- **Env credentials present (owner-dev supply, never pooled):** OPENROUTER, GROQ, CEREBRAS,
  GEMINI, MISTRAL keys; CLOUDFLARE_ACCOUNT_ID without token; OPENAI (paid — never used).
  Per `supplyClassFor`, env credentials classify `OWNER_DEV_FREE` — developer supply for
  benchmarks like tonight's, not user-facing managed capacity.
- **Quota snapshots:** OpenRouter `used 102/1000` at 02:26 UTC (resets 00:00 UTC). Others
  untested — no fabricated numbers.

## Gaps → M14D/M14E

- Live quota windows (`period`, `expiresAt`, `remaining`) exist only for OpenRouter tonight;
  each provider needs a quota probe adapter before the ledger is fully OBSERVED.
- `managedMultiUserAllowed` per-route truth requires the terms determination per provider×model.
- ForgeAuto aggregation of Tier-1 + user entitlements is unbuilt (ledger projection is ready).
