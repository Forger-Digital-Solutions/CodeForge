# R49 Free Supply Matrix

Generated: `2026-09-27T13:54:35.790Z`

Provenance:

- catalog/model facts: **live zero-cost metadata**;
- Groq allowance: **live zero-cost probe**;
- OpenRouter roles: **live zero-cost qualification**;
- older role receipts: **durable replay**, current under canonical TTL;
- policy exclusions: **deterministic**;
- unobserved route health: **unknown**, never assumed healthy.

## Inventory summary

| Measure | Current value |
|---|---:|
| Groq live catalog models | 11 |
| Mistral live catalog models | 44 |
| OpenRouter live catalog models | 458 |
| OpenRouter explicit zero-unit models | 21 |
| Proven zero-cost candidate routes considered | 27 |
| Production-qualified routes | 5 |
| Production-admissible providers | 2 |
| Independent credential/account domains | 2 |
| Physical capacity pools represented by qualified routes | 4 |
| Freshly healthy qualified routes | 2 |
| Freshly degraded qualified routes | 0 |
| Freshly exhausted qualified routes | 0 |

OpenRouter account evidence at inventory time: 939/1000 free-model daily
requests remained. All 21 OpenRouter model names share that one account
envelope; they are not independent supply.

## Account-level role coverage

| Independent credential domain | Explorer | Planner | Coder | Reviewer | Tool Agent | Analyst | Available now |
|---|---|---|---|---|---|---|---|
| OpenRouter `live-acct-openrouter` | QUALIFIED | QUALIFIED | QUALIFIED | QUALIFIED | QUALIFIED | QUALIFIED | yes, via Nemotron Super |
| Groq `live-acct-groq` | QUALIFIED | QUALIFIED | QUALIFIED | QUALIFIED | QUALIFIED | QUALIFIED | partial: fresh health only on gpt-oss-20b; qualified Reviewer is Qwen with unknown current health |

The Groq row aggregates three model-scoped physical windows behind one
credential. It demonstrates role coverage, not account redundancy.

## Physical qualified pools

| Pool | Health | Explorer | Planner | Coder | Reviewer | Tool Agent | Analyst |
|---|---|---|---|---|---|---|---|
| `managed:openrouter:live-acct-openrouter` (Nemotron Super route) | HEALTHY | Q | Q | Q | Q | Q | Q |
| `managed:groq:live-acct-groq:model:openai/gpt-oss-20b` | HEALTHY | Q | Q | Q | NOT_TESTED | Q | Q |
| `managed:groq:live-acct-groq:model:openai/gpt-oss-120b` | UNKNOWN | PROBATION | Q | Q | NOT_TESTED | PROBATION | NOT_QUALIFIED |
| `managed:groq:live-acct-groq:model:qwen/qwen3.8-27b` | UNKNOWN | NOT_TESTED | Q | Q | Q | Q | Q |

`Q` means `QUALIFIED`. UNKNOWN health is not counted as available-now.

## R49 OpenRouter qualification result

Target:
`openrouter/nvidia/nemotron-3-super-120b-a12b:free`

| Role | Verdict |
|---|---|
| Explorer | QUALIFIED |
| Planner | QUALIFIED |
| Coder | QUALIFIED |
| Reviewer | QUALIFIED |
| Tool Agent | QUALIFIED |
| Analyst | QUALIFIED |

- Current catalog price: explicit zero input/output units.
- Provider-reported staged-probe cost: `$0`.
- Staged preflight: valid `read_file({"path":"package.json"})`.
- Qualification: 27 observed HTTP responses; the account's eventually
  observed free-request counter moved from 963 to 947 during the immediate run
  and later to 939.
- Two in-band upstream `503 temporarily overloaded` cases were treated as
  transient/inconclusive; they did not become capability failures.
- This creates the first account-independent Explorer and Reviewer path outside
  Groq.

## Excluded configured providers

| Provider | Economic class | Current exclusion |
|---|---|---|
| Mistral | LIMITED_FREE_ALLOWANCE | `DATA_POLICY_USER_CONSENT_REQUIRED` |
| Cloudflare Workers AI | INCLUDED_FREE | `CLOUDFLARE_USAGE_SCOPE_REQUIRED`; token cannot read account neuron usage, so cost guard fails closed |
| Google Gemini | LIMITED_FREE_ALLOWANCE | user policy acceptance required; free tier may train on content |
| Cerebras | TRIAL_CREDIT | promotional/trial credit is not managed Free |
| GitHub Models | LIMITED_FREE_ALLOWANCE | production managed-use legal review required |
| OpenAI | PAID | forbidden to 8-Bit |
| Anthropic | PAID | forbidden to 8-Bit |

No exclusion was relaxed to inflate supply.

## Redundancy truth

- Independent Explorer redundancy: **2 credential domains**.
- Independent Coder redundancy: **2 credential domains**.
- Independent Reviewer qualification redundancy: **2 credential domains**.
- Independent Reviewer available-now redundancy: **1 credential domain**.
- Complete-role-path qualified redundancy: **2 credential domains**.
- Complete-role-path available-now redundancy: **1 credential domain**.

The immediate R49 live mission can now use OpenRouter and Groq without crossing
the free/paid boundary. It must still record actual per-role route selection,
capacity, failover, verification, and integration before R49 can close.
