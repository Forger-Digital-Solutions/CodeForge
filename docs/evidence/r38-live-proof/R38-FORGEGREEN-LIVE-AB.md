# R38 — ForgeGreen Live A/B (LIVE_FREE_PROVIDER, n=1)

Raw: `forgegreen-ab.json`, `orchestrator-live-normal.json`.

## Setup

Production `AutonomousRunOrchestrator` + `AgentRuntime` + real `FreeFabric` admission +
real `ForgeZero` + real `OpenRouterAdapter`, route `cohere/north-mini-code:free`
(catalog-verified free, billed $0.00). Task: fix `multiply` in a seeded repo, real
verification command asserting `a*b`. `coderExecutor` is a deterministic file writer
(so verified outcome is equal by construction — the A/B isolates the *reasoning-role*
inference cost: explorer + reviewer + verification passes).

- Baseline arm: `efficiencyControls: { duplicateSuppression:false,
  toolOutputCompression:false, supersededCompaction:false }`
- Green arm: defaults (all ForgeGreen levers on)

## Result

| Metric | Baseline | ForgeGreen | Δ |
|---|---|---|---|
| Verifier outcome | completed (verifAttempts 1) | completed (verifAttempts 1) | **equal** |
| Provider calls | 14 | 9 | −36% |
| Input tokens (provider-billed) | 25,814 | 15,758 | −39% |
| Output tokens | 3,378 | 1,998 | −41% |
| Wall time | 72.3s | 57.5s | −21% |
| Provider errors | 0 | 0 | — |
| Verified Work Multiplier | — | **1.64×** | on tokens |

All 23 calls succeeded — zero rate limits, zero malformed output from this model.
The quality gate holds: equal verified outcome → the multiplier is reportable.

## Honest limits

- n = 1 task, 1 model, 1 provider. This is proof the machinery works live, **not** a
  population estimate. No variance, no confidence interval.
- Coder inference is scripted — the A/B measures ForgeGreen's effect on
  exploration/review/verification context, which is where the levers act.
- A second scenario (`orchestrator-live-normal.json`, topology normal, 13 calls,
  29.9k in / 2.4k out, completed) corroborates that the free model survives the
  production structured-output protocol.
