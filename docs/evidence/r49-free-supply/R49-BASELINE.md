# R49 Baseline — Verified 2026-09-27

Provenance labels used here:

- **deterministic** — repository/code/test inspection.
- **durable replay** — committed R48 evidence or persisted qualification DB.
- **live zero-cost metadata** — provider catalog/account-status endpoint; no inference spend.
- **live zero-cost probe** — one bounded request on a verified free allowance.
- **unproven** — the required durable evidence does not exist.

## Repository identity

- Branch: `codex/r29-release-closure`
- HEAD: `c107fb5f9f093a62363bad9496d09ce807e58953`
- Required R48 commits present: `b6cc77c3`, `790181a1`, `c107fb5f`
- Certified surface: `r48-role-aware-runtime-v1`
- Certified source state:
  `9012e79edc1ae0dfd626a0eb44ab9c2ba352b739f50fa3758efd5b2e4097a709`
- Working tree before R49: exactly one intentional modification,
  `docs/evidence/r34-capacity-efficiency/context-efficiency-benchmark.json`
- No R49 runtime source was changed before this baseline.

## R48 evidence accepted

- E3 paid role mission: committed evidence says Coder and independent Reviewer
  completed, ForgeVerify passed 1/1, the completion gate returned `completed`,
  and the integrated tree equals the verified tree.
- E2 free mission: no single live run completed
  Explorer→Coder→Reviewer→Verification→Integration. Separate runs proved
  Explorer and Coder execution; every incomplete run stayed blocked.
- Durable E2 artifacts:
  `r48-free-mission.json`, `r48-free-mission-final.json`, and
  `R48-LIVE-EVIDENCE.md`.
- The R48 mission used default in-memory session persistence. Its route-health,
  capacity-observation, and decision records did not survive process exit.
  Only the committed mission JSON/journals and console-history capture are
  durable. Missing per-attempt facts must remain **unproven**, not inferred.

## Persisted qualification state

Source: `%TEMP%/r46-qualification.db` (**durable replay**).

- Receipts: 10
- Age policy: all 10 are currently valid under the canonical seven-day TTL.
- Providers represented: Groq (4), Mistral (5), OpenRouter (1).
- Persisted route state/health/decision/observation rows in this DB: 0 for each
  canonical eight-bit work-item kind.

| Provider/model | Explorer | Planner | Coder | Reviewer | Tool Agent | Analyst |
|---|---|---|---|---|---|---|
| groq/openai/gpt-oss-20b | QUALIFIED | QUALIFIED | QUALIFIED | NOT_TESTED | QUALIFIED | QUALIFIED |
| groq/openai/gpt-oss-120b | PROBATION | QUALIFIED | QUALIFIED | NOT_TESTED | PROBATION | NOT_QUALIFIED |
| groq/qwen/qwen3.8-27b | NOT_TESTED | QUALIFIED | QUALIFIED | QUALIFIED | QUALIFIED | QUALIFIED |
| groq/allam-2-7b | NOT_TESTED | NOT_TESTED | HARD_FAILURE | NOT_TESTED | HARD_FAILURE | NOT_QUALIFIED |
| mistral/codestral-latest | NOT_QUALIFIED | QUALIFIED | QUALIFIED | PROBATION | QUALIFIED | QUALIFIED |
| mistral/codestral-2508 | NOT_QUALIFIED | QUALIFIED | QUALIFIED | PROBATION | QUALIFIED | QUALIFIED |
| mistral/mistral-code-latest | NOT_QUALIFIED | QUALIFIED | QUALIFIED | PROBATION | QUALIFIED | QUALIFIED |
| mistral/ministral-3b-latest | NOT_QUALIFIED | HARD_FAILURE | QUALIFIED | QUALIFIED | QUALIFIED | QUALIFIED |
| mistral/ministral-8b-latest | NOT_QUALIFIED | HARD_FAILURE | QUALIFIED | QUALIFIED | QUALIFIED | QUALIFIED |
| openrouter/nvidia/nemotron-3.5-lightning:free | NOT_QUALIFIED | HARD_FAILURE | QUALIFIED | HARD_FAILURE | PROBATION | NOT_QUALIFIED |

## Current configured supply

Credential presence only; no values were printed:

| Provider/domain | Credential state | Account/pool interpretation |
|---|---|---|
| Groq | present | one configured credential domain; managed account label used by R48: `live-acct-groq` |
| Mistral | present | one configured credential domain; managed private-code routes require user data-sharing consent |
| OpenRouter | present | one account-wide free-model request envelope; all OpenRouter free models are correlated through it |
| Cloudflare Workers AI | account ID and API token present | fail-closed: token cannot read account neuron usage (`CLOUDFLARE_USAGE_SCOPE_REQUIRED`), so the budget guard cannot admit inference |
| Google Gemini | API key present | free tier is permissive/training-possible and requires user policy acceptance; not silent managed-private-code supply |
| Cerebras | API key present | promotional/trial credit; excluded from managed Free |
| GitHub Models | token present | legal review required for production managed multi-user use; excluded |
| OpenAI / Anthropic | keys present | paid-only; forbidden to 8-Bit |

Configured account count is not usable-path redundancy. At baseline:

- Explorer-qualified independent pools: Groq only.
- Reviewer-qualified pools: Groq; Mistral has qualifications but private-code
  admission is consent-gated; the sole qualified OpenRouter receipt is
  `HARD_FAILURE`.
- Therefore the full free role path is effectively dependent on one Groq
  credential domain.

## Fresh catalog/account observations

Catalog reads are **live zero-cost metadata** and issued no inference request:

| Provider | Live models | Explicit current zero-unit entries |
|---|---:|---:|
| Groq | 11 | 0 (allowance provider; catalog prices are not free proof) |
| Mistral | 44 | 0 (allowance/provider-policy path) |
| OpenRouter | 458 | 21 |

OpenRouter `/api/v1/key` at baseline:

- `free_model_daily_requests`: used 36, limit 1000, remaining 964.
- The limit is account-wide; 21 free model names do not represent 21
  independent capacity pools.
- Current zero-unit inventory includes new plausible role candidates such as
  `qwen/qwen3.8-27b:free`, `cohere/north-mini-code:free`, multiple Nemotron
  variants, Gemma variants, and Poolside variants. None inherits qualification
  from another provider route.

One bounded Groq allowance probe (**live zero-cost probe**) used
`openai/gpt-oss-20b`, `maxTokens=4`:

- HTTP 200; 75 input tokens, 4 output tokens (2 reasoning), no usable final
  content because the deliberately tiny output cap ended with `length`.
- Response headers: request limit 1000 / remaining 999; token limit 8000 /
  remaining 7921; request reset `1m26.4s`; token reset `592ms`.
- This proves the configured Groq account was reachable at observation time.
  It does not by itself prove which named limit is daily versus rolling; R49
  must preserve the raw header evidence and classify scope conservatively.

## Capacity/health persistence finding

The R48 free mission attached response observers and projected quota into the
in-process Free Fabric, but used `createSessionPersistence()` with its default
`:memory:` database. Consequently:

- current persisted route-health authority rows: 0;
- current persisted route observations: 0;
- current persisted decision receipts: 0;
- exact historical cooldown/health state for most E2 attempts: **unproven**.

R49 must not fabricate those missing facts. It should make future live mission
evidence durable enough to reconstruct provider/account/model capacity and
failover decisions.

## Pre-change regression

- Targeted baseline: 81 passed / 1 failed / 0 skipped across role routing,
  paid role routing, Free Fabric, and completion gate.
- The failure is the R48 near-term queued-capacity progress-event assertion.
  The run still completed, dispatched, and re-decided exactly twice; setup
  consumed the test's 1.25-second event-emission margin, so no progress event
  was emitted. The same source bytes passed earlier at R48. Treat as a
  wall-clock-sensitive baseline failure unless R49 changes its signature.
- Builds pass: server, eight-bit, model-registry, providers, workflow.

## Baseline conclusion

R48 routing architecture is intact. The immediate free-supply bottlenecks are:

1. full-path qualification is concentrated in one Groq credential domain;
2. OpenRouter currently has broad zero-unit inventory and 964 account-level
   requests remaining, but almost all candidates are unqualified;
3. Mistral role coverage is not product-admissible without the required user
   data-policy consent;
4. Cloudflare cannot execute because the present token lacks analytics-read
   scope; without trustworthy daily-neuron usage the cost guard fails closed;
5. E2 health/capacity evidence was process-local, limiting exact replay;
6. catalog refresh exposes a suspicious configuration gap:
   `maxAllowanceProbes` is stored but not consumed by allowance verification,
   so a caller requesting zero probes may still issue one representative
   inference request per allowance provider. This requires deterministic
   confirmation before any fix.
