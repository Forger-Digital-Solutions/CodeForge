# R52 — Free Provider/Domain Matrix

Source: `R52-LIVE-FREE-SUPPLY-INVENTORY.json` — live catalog refresh through
`FreeCloudService` (64 models registered, 244 capacity routes, 142 pools). A catalog
route is **not** counted as supply until eligibility + qualification + capacity
evidence exist. Paid spend: **$0**.

## Status matrix

| Provider | Status | Catalog routes | Eligible | Capacity telemetry | Live inference | Production eligible |
|---|---|---|---|---|---|---|
| **groq** | `VERIFIED_USABLE_FREE` | 14 | 6 | measured (1 domain measured by bootstrap; sibling domains demand-measured) | yes, $0 | yes |
| **mistral** | `VERIFIED_USABLE_FREE` | 120 | 10 | measured | yes, $0 | yes |
| **openrouter** | `VERIFIED_USABLE_FREE` | 36 | 4 | measured (18 domains via `/key` metadata probe — zero inference) | yes, $0 | yes |
| **cloudflare-workers-ai** | `VERIFIED_FREE_BUT_TELEMETRY_BLOCKED` | 36 | 0 | **blocked** — `aiInferenceAdaptiveGroups` + `workersInvocationsAdaptive` authz-denied on env token; neuron guard fails closed | inference works (HTTP 200) | no — `R52_CLOUDFLARE_TELEMETRY_BLOCKED` |
| **google** | `VERIFIED_FREE_BUT_TELEMETRY_BLOCKED` | 38 | 0 | blocked — API key **suspended** (403 `PERMISSION_DENIED`) + free-policy gate unmet | fails 403 | no |
| **cerebras** | `NOT_PROVEN` | — | — | — | — | no — `PROMOTIONAL_CREDIT` ($5/30-day trial, not recurring free) |
| **github-models** | `VERIFIED_FREE_BUT_POLICY_EXCLUDED` | — | — | — | — | no — no production adapter path; legal review required |
| **openai** | `PAID_ONLY` | — | — | — | — | no — forbidden to 8-Bit |
| **anthropic** | `PAID_ONLY` | — | — | — | — | no — forbidden to 8-Bit |

## Verdict

**3 independently usable CodeForge-managed free credential domains** — groq, mistral,
openrouter — across 18 independent physical pools and 20 eligible routes. The desired
"3+ independent managed free domains" objective is met with real evidence; cerebras is
honestly excluded (trial credit, not product-free), google's key is suspended at the
provider, and cloudflare stays correctly fail-closed on the neuron guard.

## Why excluded routes are not usable capacity

- A catalog route is not supply: `VERIFIED_FREE` is a policy fact, not admission.
- `healthy:false` / `enabled:false` routes are hard-excluded before ranking.
- `PROMOTIONAL_CREDIT`, `PAID`, `TRIAL_CREDIT` supply classes never reach ForgeAuto/Free.
- Telemetry-blocked providers fail closed — unknown quota is never assumed free capacity.
