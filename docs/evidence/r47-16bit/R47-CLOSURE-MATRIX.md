# R47 Closure Matrix — Free-Supply Resilience Closure + 16-Bit First Light

Baseline: `codex/r29-release-closure` @ `c0f8663`, clean tree, certified
`r46-free-supply-resilience-v1`. Phase A committed `1978bbf`; Phase B substrate
`41f75ac`; Phase B live `d8e1228`. Campaign spend: **$0.021986 of $0.50** (4.4%),
all receipted on the durable ledger.

## Phase A — shared-runtime closure

| Requirement | Status | Evidence |
|---|---|---|
| Explorer output-contract diagnosis | DONE | `summary` field absent from prompt contract; fixed with `STRUCTURED_OUTPUT_CONTRACTS` |
| Bounded deterministic structured-output recovery | DONE | synonym promotion + structural synthesis; no inferred conclusions, no raw persistence |
| Schema-failure classes as role evidence | DONE | `structured_output_failure`/`structured_output_repaired` in reliability + health authority |
| Free role coverage per independent pool | DONE | `R47-FREE-ROLE-COVERAGE.*` — account-boundary audit; Explorer single-account (groq) documented |
| Missing Planner/Reviewer coverage | DONE | staged durable probe; Mistral failures confirmed capability-shaped |
| Provider-construction observer audit | DONE | openrouter adapter was dropping `onResponse`; cloud-gateway unwired — both fixed |
| Managed-pool account-ID contract + fail closed | DONE | unscoped-fallback leak removed; `R47-ACCOUNT-IDENTITY-CONTRACT.md` |
| Data-policy contract tests | DONE | 10/10 ForgeZero capacity-policy tests |
| Phase A regression gate | DONE | 635 focused tests green; deterministic full-pipeline mission green |

## Phase B — 16-Bit first light

| Requirement | Status | Evidence |
|---|---|---|
| Spend controls before any live call | DONE | `BudgetGatedProviderAdapter` + durable `ESTIMATED_ONLY` alignment; 50/50 paid-auto tests |
| Roster + live pricing | DONE | `R47-16BIT-ROSTER.json`, `R47-16BIT-PRICING.json` — 4/4 fallback routes live-priced |
| Routing objective | DONE | route-priced `rank16Bit` + `priceOverrides`; `R47-16BIT-ROUTER-SHADOW.json` |
| Shadow routing proof | DONE | deterministic rankings across 5 role profiles |
| Role qualification + tool reliability | DONE (live) | 4 models × 6 roles, all receipted; `R47-16BIT-QUALIFY-*.json` |
| First live 16-Bit mission | DONE | glm-5.3-flash, **completed** at $0.0037, 149 s, first-try — `R47-16BIT-MISSION-glm-5.3-flash.json` |
| Free boundary preserved | DONE | 8-Bit paid calls: 0. Every paid call receipted (ACTUAL/ESTIMATED_ONLY/RELEASED). Unreceipted spend: 0. |
| Corpus/economics | DONE | measured ranking `R47-16BIT-MEASURED-RANKING.json`; per-call receipts + ledger snapshot |
| Regression | DONE | 75 focused tests (paid-auto + server pipeline incl. deterministic e2e) green; full build clean |

## Findings carried forward

1. **EXPLORER is the weakest role everywhere.** 0/4 paid models and all-but-one free
   account fail the explorer probe on read discipline. Free Groq gpt-oss-20b is the
   only qualified explorer — a single-account supply risk on both sides of the
   boundary.
2. **The ranker needs a qualification floor.** `rank16Bit` selects on price even
   when all candidates are NOT_QUALIFIED (EXPLORER column). A `minRoleFit`/`requireQualified`
   option — or upstream exclusion — is the correct place for the hard gate.
3. **Stream identity is unverifiable.** `StreamEvent` carries no served-model field;
   identity-grade verification exists only on `chat`. If identity assurance matters
   for streams, extend the provider event contract.
4. **Reasoning-token starvation is a planner/reviewer failure class** on
   deepseek/qwen — provider returns reasoning-only completions inside the output
   bound. Role output budgets for reasoning-heavy routes need headroom or a
   reasoning-aware retry.
5. **Paid execution needed three runtime wiring fixes** (service fallback on
   credential-absent direct, execution-adapter paid branch, durable ESTIMATED_ONLY)
   — all now regression-tested. The paid path was previously unreachable end-to-end.

## R48 recommendation

**Begin backend product integration / mode UX**, with two residual 16-Bit items:

- Per-role paid routing (missions pinned one-model-all-roles today; measured
  ranking shows glm/deepseek specialization is already cost-optimal per role).
- Explorer coverage: qualify gpt-oss-20b-class models on paid, or treat
  explorer as a free-role dependency in the product contract.

Return to shared runtime only if the broad regression sweep in §final report
surfaces a real regression — Phase A+B leave none known.
