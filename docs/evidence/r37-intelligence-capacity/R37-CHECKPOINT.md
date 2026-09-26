# R37 Checkpoint — Intelligence & Capacity (interim)

Branch `codex/r29-release-closure`. Commits this phase: `8587695` → `5537bce`.

| Commit | Scope |
|---|---|
| `8587695` | Estimator accuracy (`estimatorAccuracy` p50/p95/under-over), contextWindow plumbing, right-fit scarcity ranking + 4 adversarial tests |
| `a3cdedb` | Probation-tier role fallback: PROBATION verdicts eligible as degraded fallback, qualified tier always first |
| `f51f1f0` | Free-supply inventory doc: 33-provider classification audit |
| `a2bba63` | No-premature-wait proof: same-provider model-domain independence |
| `9646c0d` | Verified Work Multiplier on R20 matched-experiment harness |
| `5537bce` | 16-Bit expected-completion-cost ranker (ranking only, no paid activation) |

## VERIFIED (deterministic tests)

- **Mission F**: governor reports samples/mean/p50/p95 ratio + under/over rates from billed usage only.
- **Mission AH/Gate D**: 8k task picks 8k pool over 200k (`RIGHT_SIZE_PRESERVED`); 105k task reaches the 200k route; oversized-only-pool still admits; domain order preserved.
- **Mission G/H**: probation roles admit when sole supply (no wait); qualified beats probation regardless of score; no-evidence routes stay ineligible; reservation ledger mirrors eligibility.
- **Mission D**: one model's exhausted requests window never blocks sibling model pools.
- **Mission T**: `verifiedWorkMultiplier` = baseline/optimized tokens, only on equal verified outcomes; withheld on correctness regression.
- **Missions Y/AA/AB**: `rank16Bit` — expected-cost beats naive price (4-attempt GLM loses to 1-attempt Qwen); PRICE_UNKNOWN excludes; CONTEXT_TOO_SMALL/TOOL_UNSUPPORTED hard-exclude; roster fixed at the four registered models; `UNMEASURED_EVIDENCE` labeled.

## Test evidence

- 730 tests green across eight-bit/forge-zero/model-registry/providers after `8587695`.
- 519 green across eight-bit/forge-zero/model-registry after `a3cdedb`.
- 27 green in paid-auto after `5537bce`; benchmark harness suite green (6).

## SIMULATED ONLY

- Right-fit and probation-tier behavior proven against synthetic capacity routes, not live providers.
- 16-Bit evidence (successRate, retries) in tests is synthetic; no paid calls were made — the ranker is architecture, not activated routing.

## LIVE-PROVIDER VERIFIED

- `live-catalog-snapshot.test.ts` passed during regression (OpenRouter catalog refresh, routed models enumerated) — supply discovery works against the real endpoint.
- No live inference admission was re-probed this pass (quota conservation).

## UNRESOLVED / PLANNED

- ForgeVerify deep audit (V–X): verification strength vs. cost not yet re-measured this phase.
- Subagent benchmark (H-gate): topology efficiency evidence exists in r20 harness tests but no new R37 corpus run.
- ForgeGreen live A/B (E-gate): VWM instrumentation added; representative-corpus distribution not yet run.
- Adversarial runtime failover beyond fabric-level tests (quota-reset mid-wait recovery is covered by existing suites; no new chaos cases added this phase).
- Canonical full-suite regression not yet run for this phase (targeted suites only).

## Billing safety

No paid inference was executed. `deepseek-v4.1-flash` direct pricing is UNKNOWN and correctly
excludes; rank16Bit never returns unregistered models; PROMOTIONAL_CREDIT / OWNER_DEV / PAID
classes remain excluded from managed free supply by `freeRouteExclusionReason`.
