# R13 Paid Auto / 16-Bit candidate catalog

Captured: 2026-09-18 from a read-only, zero-spend `GET https://openrouter.ai/api/v1/models` catalog request. The catalog confirms the initial four canonical roster slugs, their advertised context capacities, and `tools`/`tool_choice` support. Catalog discovery is not qualification and does not activate a route.

| Canonical ID | Exact OpenRouter model ID | Published base USD / million tokens (input / output) | Cache pricing | Context / special price | Capability evidence | R13 status |
| --- | --- | ---: | --- | --- | --- | --- |
| `gpt-5.6-luna` | `openai/gpt-5.6-luna` | $0.20 / $1.20 | read $0.02; write $0.25 | 1,050,000; input >=272,000 changes to $0.40 / $1.80 | `tools`, `tool_choice`, structured outputs | candidate; no paid request |
| `glm-5.3-flash` | `z-ai/glm-5.3-flash` | $0.09 / $0.30 | read $0.018 | 1,310,720 | `tools`, `tool_choice`, structured outputs | candidate; no paid request |
| `qwen3.8-flash` | `qwen/qwen3.8-flash` | $0.15 / $0.47 | read $0.016; write $0.20 | 1,000,000 | `tools`, `tool_choice`, structured outputs | candidate; no paid request |
| `deepseek-v4.1-flash` | `deepseek/deepseek-v4.1-flash` | $0.15 / $0.60 | read $0.003 | 1,048,576; weekday 01:00–04:00 and 06:00–10:00 UTC are $0.30 / $1.20 | `tools`, `tool_choice`, structured outputs | candidate; no paid request |

The catalog also exposes `deepseek/deepseek-v4-flash-0731:free`. It is a separately identified free candidate, not a paid evaluation fallback and not proof that it may be routed by ForgeAuto without 8-Bit free qualification.

The R13 `PriceCard` contract now supports cache read/write, context tiers, reasoning, tool, media, gateway fee, region, and service-tier fields where provider evidence exposes them. A card with unknown or low-confidence pricing cannot reserve live R13 paid evaluation spend.

## No hidden gateway routing

R13 paid evaluation uses the exact model ID above, with no `models` fallback list and never `openrouter/auto`. The evaluation runner checks that OpenRouter reports the same served model ID before accepting output. It records an estimated/actual charge, usage when reported, source provenance, and reconciliation state in a sanitized receipt. Provider infrastructure may only be constrained after its public endpoint evidence is collected; a model slug alone is not treated as independent provider diversity.

## Next paid stage (not yet executed)

The first staged probe may use no more than a $1.00 campaign sub-budget and must be a bounded compatibility smoke (explicit `maxTokens`, no repository source) after durable ledger state is available. The owner-authorized aggregate ceiling remains $15.00. R13 has committed **$0.00** and reserved **$0.00** as of this catalog record.
