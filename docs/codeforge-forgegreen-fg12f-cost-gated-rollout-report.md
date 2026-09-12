# CodeForge ForgeGreen FG-12F — Cost-Gated Verification Evidence Reuse Production Rollout Report

Generated: 2026-09-11T22:07:05.998Z

## Verdict precondition: `CODEFORGE_FORGEGREEN_FG12F_COST_GATED_REUSE_CERTIFIED`

> This artifact is the measured corpus evidence. The final FG-12F verdict is issued in the task response after repository validation (typecheck, build, full Vitest suite) completes with zero failures.

## Policy

- Policy version: `fg12f-verification-reuse-cost-gated-1` — execution state **ACTIVE_SAFE_COST_GATED**
- Threshold: **250 ms**, inclusive (estimatedFreshMs >= 250 is eligible; 249 is not). FG-12E measured break-even ≈152 ms (IQR 139–184 ms); 250 ms sits above the p75 overhead and at the low end of the consistently-positive class, so the cheap `node --check` class (~81 ms) stays fresh.
- Unknown cost: **FRESH_VERIFY** — never reused on a guess.
- Duration statistic: median of the most-recent trusted samples (window 5); single prior successful sample allowed at lower confidence.
- Identity requirements: verifierId + verifierVersion + definitionDigest.
- Kill switch: `CODEFORGE_FORGEGREEN_OPTIMIZATION (OFF/SHADOW ceiling, effective without restart)`.

## Historical cost source

elapsedMs of prior PASSED evidence records persisted verbatim by createForgeVerifyPersistenceObserver.evidenceCreated into the session SQLite store, loaded via loadForgeVerifyEvidence for the same session; fresh executions append new records (append-only, §18). No speculative model-based cost prediction exists anywhere in this path.

## Rollout seam

- Integration point: packages/workflow/src/verification-service.ts: runVerification — after authoritative plan construction, before executeVerificationPlan
- Architecture: `caller → verification service (runVerification) → cost-gated reuse advisor → ForgeVerify authoritative execution`
- Callers covered: `workflow-engine.ts (via workflow-service inline observer)`, `autonomous-orchestrator.ts`, `delivery-service.ts`, `mission-supervisor.ts`, `parallel-orchestrator.ts`
- Final authority: executeVerificationPlan's pre-existing reuse revalidation is unchanged and remains mandatory.

## Corpus results (all through production composition)

| Class | Expected | Result | Failures |
| --- | --- | --- | --- |
| Cheap (10) | all fresh | PASS | 0 |
| Moderate (10) | gated reuse | PASS | 0 |
| Expensive (10) | reuse + no child process | PASS | 0 |
| Unknown-cost cold start (10) | fresh then learned reuse | PASS | 0 |
| Threshold boundary (249/250/251) | inclusive ≥250 | PASS | 0 |
| Partial reuse plan | per-verifier gating | PASS | 0 |
| Restart | history reloads; mutation refused | PASS | 0 |
| Invalidation | cost never rescues invalid | PASS | 0 |
| Kill switch | OFF disables immediately | PASS | 0 |
| Failure fallback | advisor failure -> fresh | PASS | 0 |

## Actual prevented work

- Verifier executions avoided: **30**
- Child processes not spawned: **30** (marker-count proven for sleeper verifiers)
- Reference prevented time (sum of reused records' own prior measured durations): **15136 ms**
- Observed run-2 wall-clock savings across eligible cases: **15442 ms**

## Incremental cost-gate overhead (§28)

FG-12F-specific additions only; pre-existing ForgeVerify plan/input-state-hash work is NOT attributed to the cost policy (§28).

| Component | p50 (ms) | p75 (ms) | p95 (ms) |
| --- | --- | --- | --- |
| durationLookupMs | 0.106 | 0.117 | 0.232 |
| advisorEvaluationMs | 0.084 | 0.097 | 0.182 |
| receiptReconcileMs | 0.011 | 0.013 | 0.07 |
| receiptPersistenceMs | 0.157 | 0.171 | 6.611 |
| **Total (sum of medians)** | **0.359** | | |

For comparison, FG-12E measured the pre-existing `createVerificationInputStateHash` cost at ~140–145 ms — an order of magnitude above the entire FG-12F addition, and explicitly NOT attributed to the cost policy.

## Source-state lineage

FG-11 → FG-12D → FG-12F

- FG-12F certified source-state: `733b611a4edc4aea39bb63f77008961af648d59d9f548e49e7ce521384d976db` (surface `fg12f-certified-v1`)
- FG-12D prior: `ac8414ebd2a85803bde97d35a5409ca1be7a5d156ae3be57a070ebb5ba72ad53`
- FG-11 prior: `f9cb465db299648b01593111f3ebbfd90a8c2bc98b84f08a44ba051bb8d4c36a`

## Commit status

Per FG-12F §37 the production rollout changes are left UNCOMMITTED for review. Nothing pushed, nothing deployed, no provider cost.

