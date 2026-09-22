# R26 Phase 4 — Live Model Roster Refresh & Planner Supply Investigation

Fresh live qualification against HEAD `2c89ca9` — not a replay of R25 results.
Zero spend verified: OpenRouter account `usage: 0` before and after the entire pass.

## Pre-flight (zero-inference)

`live-preflight.json`:

| Provider | Verdict | Basis |
|---|---|---|
| openrouter | LIVE_OK | `:free` routes $0-unit-priced in live catalog (443 models, 21 free) |
| groq | LIVE_OK | owner free-plan + observed rate-limit headers |
| cloudflare-workers-ai | **LIVE_OK (new)** | Workers Free 10k neurons/day is a provider-side hard stop |
| google | SKIPPED_FREE_ONLY_NOT_PROVEN | billing state unreadable → correctly fail-closed |

## Qualified roster — 6 routes

| Route | Verdict | Roles qualified | Notable gaps |
|---|---|---|---|
| `groq::qwen/qwen3.8-27b` | QUALIFIED | CODER, TOOL_AGENT, ANALYST, **PLANNER**, REVIEWER | — strongest route |
| `groq::openai/gpt-oss-120b` | QUALIFIED | CODER, TOOL_AGENT, ANALYST | PLANNER/REVIEWER NOT_TESTED (transient cases) |
| `groq::openai/gpt-oss-20b` | QUALIFIED | CODER, TOOL_AGENT, ANALYST, EXPLORER | PLANNER hard-fail |
| `openrouter::nex-agi/nex-n2.5-pro:free` | QUALIFIED | CODER, TOOL_AGENT, ANALYST | EXPLORER fail, PLANNER hard-fail, REVIEWER probation |
| `openrouter::nvidia/nemotron-3-ultra-550b-a55b:free` | QUALIFIED | CODER, TOOL_AGENT, ANALYST | EXPLORER probation, PLANNER+REVIEWER hard-fail |
| `openrouter::nvidia/nemotron-3.5-lightning:free` | **QUALIFIED (new)** | CODER | TOOL_AGENT probation, ANALYST fail, 1M context |

## Lost / regressed since R25

- `openrouter::nvidia/nemotron-3-super-120b-a12b:free` — was QUALIFIED, now **NOT_QUALIFIED**
  (all three compact probes failed; route degraded or down).
- `openrouter::nvidia/nemotron-3-ultra` — REVIEWER regressed QUALIFIED → HARD_FAILURE.
- `openrouter::thinkingmachines/inkling:free` — new candidate, NOT_QUALIFIED (failed fast).

## Planner supply investigation (mandate §14)

Root cause identified from per-case details: failing routes return **schema-valid but
semantically thin plans** — `schemaValid: true` with `tasks: 1`, `roles: ["coder"]`,
`requiredRolesPresent: false`, `dependencyOrderValid: false`, `verificationStepPresent: false`.
The models parse the contract and emit legal JSON, but collapse multi-role decomposition into a
single coder task. This is a **capability / protocol-strictness boundary of free-tier models**,
not schema unreliability, quota, or prompt-contract breakage — exactly what the qualification
suite exists to detect. The Planner protocol must NOT be loosened to manufacture supply.

Current Planner supply: effectively **1 route** (`groq::qwen3.8-27b`); `groq::gpt-oss-120b`
was Planner-qualified in R25 but its planner suite was NOT_TESTED this pass (8 transient cases).
Explorer supply is similarly thin (only `groq::gpt-oss-20b` fully qualified).

## Cloudflare finding

Workers AI pre-flight is now LIVE_OK, adapter + fail-closed neuron guard exist in
`@codeforge/providers` — **but nothing in `forge serve` instantiates the Cloudflare adapter**.
Qualifying CF routes would produce supply evidence the runtime cannot use. Recorded as a
wiring gap (release-blocker candidate), not silently qualified.

## Verdict

`R26_ROSTER_REFRESHED` — 6 live free routes, Planner supply = 1 confirmed route (Groq-only),
CF adapter wired-capable but unwired, Gemini still fail-closed. Evidence:
`qualification-r26.json`, `live-preflight.json`.
