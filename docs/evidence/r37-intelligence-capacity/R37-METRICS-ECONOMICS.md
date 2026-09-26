# R37 — Metrics & Economics Vocabulary

One measurement vocabulary for 8-Bit, ForgeGreen, ForgeVerify, 16-Bit, and capacity ops.
Formulas below are the *implemented* semantics, not aspirational ones.

## Verified Work Multiplier (VWM)

Implemented: `R20MatchedExperimentHarness.compareForgeGreen` → `verifiedWorkMultiplier`.

```
VWM = baselineTokens / optimizedTokens     iff equalVerifiedOutcome
      undefined                            otherwise
equalVerifiedOutcome = (correctnessDelta === 0 && completionDelta === 0
                       && baseline.correct && candidate.correct)
```

A saving that costs correctness is not a saving — a 10×-cheaper wrong answer reports no
multiplier. `promotable` additionally requires `correctnessDelta >= -tolerance`,
`completionDelta >= 0`, and at least one positive efficiency axis. Free-route tasks count
as $0-cost; VWM measures *constrained supply units*, not literal dollars.

## Expected Completion Cost (16-Bit)

Implemented: `rank16Bit` in `packages/paid-auto/src/expected-cost.ts`.

```
attemptCostUsd = inputTokens/1e6 × inputPrice + outputTokens/1e6 × outputPrice
successRate    = measured, or DEFAULT 0.5 (floor 0.05 — unmeasured never assumed competent)
expectedAttempts = measured(1 + expectedRetries) | 1/successRate
                 × 1/toolReliability        (only when task.requiresTools)
expectedCostUsd  = attemptCost + failedAttempts × failedAttemptCost
                 + verificationCost + escalationProb × escalationCost
```

Exclusions are hard, not ranked: `CONTEXT_TOO_SMALL`, `TOOL_UNSUPPORTED`,
`PRICE_UNKNOWN` (null pricing never reads as $0). Default escalation cost = one attempt —
a lower bound, since escalation moves to a more expensive tier by definition.
Unmeasured candidates are labeled `UNMEASURED_EVIDENCE`; ties break on fullyMeasured then
roleFit. `CHEAPER_EXPECTED_COMPLETION` marks the winner.

## Estimator accuracy (task sizing)

Implemented: `ProviderCapacityGovernor.estimatorAccuracy(providerId?)`.

```
ratio = actualInputTokens / promptEstimate       (per dispatch, billed truth only)
reports: samples, meanRatio, p50Ratio, p95Ratio,
         underestimateRate (ratio > 1), overestimateRate (ratio < 1)
```

Reservation demand applies `estimatedPromptTokens × tokenizerRatio × 1.15` where the ratio
is a provider-level EMA bounded [1, 3] (unlearned floor 1.5). Underestimation > over is the
dangerous direction — it manufactures demand a pool cannot serve.

## Scarcity cost (right-fit routing)

Implemented: `rightFitPenalty` in FreeFabric. For context window W and demand d:

```
oversize = W / d
penalty  = 0                     if oversize ≤ 4
         = -min(12, log2(oversize)) otherwise
```

Bounded — it right-sizes near-ties within a supply domain. It never denies admission,
never crosses domain ordering, never makes an ineligible route eligible. A selected route
emitting a negative `rightFitPenalty` on standby peers produced `RIGHT_SIZE_PRESERVED`.

## False wait

A decision `QUEUED_FOR_CAPACITY` is **false** iff any candidate report shows an admissible
route that was not attempted — i.e. the explanation ledger contains a row with no negative
evidence. True waits require every candidate to carry negative rows:
`MODEL_QUOTA_EXHAUSTED` / `PROVIDER_QUOTA_EXHAUSTED` / `USER_QUOTA_EXHAUSTED` /
`USER_CONCURRENCY_LIMIT` / `HEALTH_EXCLUDED` / `ROLE_INELIGIBLE` / `DATA_POLICY_*` /
`RESERVATION_DENIED`. `FREE_WAIT_RATE = tasks entering waiting_for_free_capacity /
eligible free tasks`; `FALSE_WAIT_RATE` is the subset where the ledger is incomplete.

## Useful work

Counts only: `status === "completed" && correct === true` after the completion gate —
which itself requires verified evidence, not model self-report. "Correct" in A/B terms
means the verifier's semantic verdict, not the task's self-asserted summary.

## Metrics safety rules

1. Quality is primary: efficiency metrics are only computed within equal-verified-outcome
   comparisons.
2. Unmeasured inputs are labeled, never silent — defaults are floors/ceilings that real
   evidence can only improve upon, not invented certainty.
3. Free routes model $0 *price* but real *scarcity* — scarcity is expressed via quota
   windows and context fit, not fabricated dollar costs.
4. No metric rewards skipping verification, avoiding hard tasks, or weakening routes:
   VWM withholds itself, promotable requires non-negative quality deltas.
