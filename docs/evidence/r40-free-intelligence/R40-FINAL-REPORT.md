# CODEFORGE R40 FINAL

**Verdict: R40 PARTIALLY VERIFIED** — core hardening shipped and live-proven; Gemini entitlement remains provider-blocked; 262k+ context still unproven by quota, not capability.

## What changed (concrete implementation)

1. **Gemini credential aliasing** (`provider-factory.ts`): `aliasedCredentialStore` generalized to multi-alias with deterministic precedence — stored credential > `<ID>_API_KEY` > extra declared aliases. `createGeminiAdapter` now resolves `GOOGLE_API_KEY` → `GEMINI_API_KEY` → `GOOGLE_GENERATIVE_AI_API_KEY`. 3-armed env test added (18/18 provider tests pass). Live result: resolution works; the `GEMINI_API_KEY` itself returns **PERMISSION_DENIED/CONSUMER_SUSPENDED** at Google — account entitlement broken provider-side, not a CodeForge defect. Gate B: code-verified, live access BLOCKED.

2. **Bounded admission-side estimator correction** (`eligibility.ts`): `ESTIMATED_CONTEXT_ADMISSION_FACTOR = 0.75` applied only to the `INSUFFICIENT_CONTEXT` check. Raw estimates still drive packing/budget. Receipts showed actual/estimated = 0.35–0.64, so 0.75 narrows over-prediction while staying strictly above every observed ratio — cannot under-admit within the measured envelope. Test asserts both directions (76k admits, 70k denies at 100k estimate). Gate G: PARTIAL — over-estimation corrected at the admission boundary; the estimator itself intentionally unchanged.

## Live free supply (Gate A — PASS)

64 verified-free routes, unchanged across R39→R40 refreshes (0 drift): openrouter 21, mistral 37, groq 6 — 3 independent domains. Cerebras excluded (credit terminal). Gemini fail-closed by provider key rejection.

## 8-Bit improvements

- **Recovery proven live** (`recovery-probe.json`): `gpt-oss-20b` (was quota-depleted) and `gpt-oss-120b` (was PROVIDER_ERROR) both **RECOVERED_SERVING** at re-probe — real degraded→recovered transitions. mistral-small/medium remain persistently tier-gated (correctly classified non-transient); mistral-large AUTH divergence persists.
- **Role qualification** (`R40-ROLE-QUALIFICATION.json`): codestral 4/4 roles; gpt-oss-120b 3/4 after budget correction; north-mini-code 2/4 — **found a real routing fact: reasoning models starve output on bounded maxTokens** (north-mini-code burned 457/500 tokens on reasoning, empty content). Role assignment must size output budgets to reasoning overhead.
- **Estimator receipts** (`R40-TOKEN-CALIBRATION.json`): added real-code corpus receipts — 0.64 (codestral) / 0.52 (cohere) vs 0.35–0.49 synthetic. Correction factor chosen from measured envelope, not guessed.

## ForgeGreen (Gate F — PARTIAL, honest)

Cumulative corpus now n=9 pairs (6 R39 + 3 R40: test-repair, multi-file, refactor). All 3 new pairs BOTH_PASS.

| Metric | n=8 BOTH_PASS | Note |
|---|---|---|
| Requests median green/baseline | 1.000 (0.60–1.26) | 3 of 8 regressions |
| Input tokens median | 0.973 (0.60–1.23) | task-dependent |
| Aggregate VWM | **1.107×** | vs 1.25× at n=5 — larger sample is more sobering |
| Wall median | 0.927 | |

Green's advantage is concentrated on 4 strong pairs (~-25–40%) and roughly neutral on structured multi-file work (multi-file regressed +26% calls — stochastic tool-round-trip variance, counters identical, zero errors). Honest conclusion: ForgeGreen's measured benefit is real but **smaller and more task-dependent than earlier reports suggested**. Savings concentrate where duplicate reads/searches exist to suppress.

## ForgeVerify (carried evidence)

R39's layering evidence stands: deterministic misses 4/4 semantic defects; live reviewer catches them at ~30–270 tokens/case. `forgeverify-value.json` retained. No change needed — deterministic-first + targeted semantic review remains the proven cost/benefit shape.

## Subagents

Adaptive classifier observed live choosing `normal` with reasonCodes recorded (`adaptive-tiny.json`); tiny topology = 0 model calls. The `DEFAULT_NORMAL` borderline-escalation risk is logged, not tuned — the R39 goal that triggered it was itself corrupted by shell quoting, so no classifier defect is actually evidenced. Heterogeneous role assignment untested live (Gate J: PARTIAL — role-suitability data now exists to drive it).

## Long context (Gate H — PASS)

`R40-LONG-CONTEXT.json`: **`ministral-8b-latest` served 111,408 billed input tokens live** (800KB prompt, 8.5s, $0) — 2.7× the R39 record (41,789), approaching its 128k claim. nemotron-3-super served 20,913. `mistral-medium-2604` still RATE_LIMITED — 262k remains unproven by quota, recorded not claimed.

## Self-healing (Gate L — PASS)

Full degrade→failover→recover cycle captured across real time: groq models failed (quota) in R39, alternates served, models recovered by R40 re-probe and re-entered supply — no restart, no manual intervention. Deterministic cooldown/re-entry tests (health.ts machinery) green.

## Endurance (Gate M — PASS)

~140 additional live calls this round (refresh, probes, qualification, corpus, context, reviewer). Failures seen: persistent tier-429s, AUTH, PAYMENT_REQUIRED, quota depletion+recovery. Zero false waits, zero manual interventions, zero paid inference.

## 373-user scale (Gate N — PASS)

`R40-SCALE.json` — 746/746 tasks, 0 starvation, fair first-admissions, 50 rate-limit events absorbed at 373 users, 0 lease leaks, 0 ledger divergences under the 3-provider fault topology.

## 16-Bit readiness (Gate O — PASS)

Free/paid separation intact: catalog-refresh scenario 6 (free→paid terms → fail closed) green; paid roster tests untouched (18/18 R38); no live workload touched a paid route; `ESTIMATED_CONTEXT_ADMISSION_FACTOR` is free-fabric admission only. Health/quota-domain/role-suitability primitives (shared with a future 16-Bit chooser) hardened without conflation.

## Regression (Gate P — PASS)

3,774 pass / 5 fail / 48 skip. All 5 failures are wall-clock assertions under parallel load; each standalone-verified green (cf14 61.3s; delivery-cert 14/14; watchdog 2/2). Same flake family as R38/R39, zero new unexplained failures. `tsc -b` clean on touched packages.

## Remaining blockers (real)

- **Gemini**: `GEMINI_API_KEY` rejected PERMISSION_DENIED — account-side, not code.
- **262k+ context**: `mistral-medium-2604` quota-gates every attempt; unproven.
- **Heterogeneous role assignment**: qualification data exists; a live heterogeneous-vs-homogeneous topology A/B not yet run.
- **ForgeGreen effect size**: 1.107× aggregate at n=8 — modest; regression pairs show the benefit is concentrated, not uniform.
- **Classifier**: `DEFAULT_NORMAL` borderline escalation flag unconfirmed (triggering input was corrupted).
- **Estimator**: still over-predicts ~1.6–2.8× internally; only the admission consumer is corrected — packing paths remain conservative (intentional).
- **Live catalog churn**: never observed across ~3h cumulative observation; re-entry proven by probe recovery + deterministic tests only.

## Commits

- `c527f79` — R40: Gemini credential aliasing, bounded admission-side estimator correction, recovery probes, role-qualification corpus, +3 ForgeGreen pairs, 111k live context, evidence + regression.

## Next milestone (R41, evidence-driven)

1. Heterogeneous role-model assignment: route reviewer/explorer/coder by the qualification signal now measured (codestral strong generalist; gpt-oss needs large output budgets; north-mini-code bounded-budget fragile).
2. Live heterogeneous topology A/B vs homogeneous on the corpus.
3. Gemini: replace/repair the suspended key or mark provider dead in inventory until a valid entitlement appears.
4. ForgeGreen: instrument WHY multi-file pairs regress (call-sequence diffing is in the corpus already) — tune supersededCompaction threshold on that evidence.
5. Topology classifier: re-test the borderline-goal case with uncorrupted input; tune `DEFAULT_NORMAL` triggers if the escalation reproduces.
