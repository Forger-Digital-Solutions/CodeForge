# R38 — Capacity Scale + 16-Bit Sensitivity (SIMULATED / DETERMINISTIC)

## Scale sweep (R20ScaleHarness, `evidenceClass: "simulated"`)

4 routes × 4 concurrency, T0 bug-fix tasks, burst arrivals, 30s queue cap.

| Users | Tasks | Completed | Queue P95 | Max depth | Starvation | Jain |
|---|---|---|---|---|---|---|
| 1 | 2 | 2 | 80ms | 1 | 0 | 1.0 |
| 10 | 20 | 20 | 80ms | 10 | 0 | 1.0 |
| 50 | 100 | 100 | 400ms | 84 | 0 | 1.0 |
| 100 | 200 | 200 | 880ms | 184 | 0 | 1.0 |

Zero starvation and perfect fairness through 100 virtual users; queue depth grows
linearly with offered load — no collapse pathology. Combined with the R37 topology
finding (fanout under one saturated pool destroyed 74% of tasks), the scale story is:
parallelism is safe when supply is wide, harmful when narrow — which is exactly what
the smallest-effective-topology selector encodes.

## 16-Bit sensitivity (`expected-cost.test.ts`, 18 tests green)

Measured sensitivity of `rank16Bit` over the frozen roster:

| Perturbation | Effect |
|---|---|
| Winner success ±10% | Ordering stable — qwen stays selected |
| Output tokens doubled | Ordering stable — linear cost scaling, no flip |
| Retry rate +2 on winner | Expected cost rises proportionally; ordering can flip |
| Verification cost $0.05 on winner | Reorders to glm — review economics are material |
| `requiresTools` + toolReliability 0.5 vs 0.99 | Reorders — tool reliability only matters when tools are required |
| No evidence at all | Falls to cheapest priced route, labeled `UNMEASURED_EVIDENCE` |

The chooser is **stable but honest**: it does not flip on noise, does not pretend
unmeasured inputs are certain, and moves when real evidence (verification cost,
retries, tool reliability) materially changes expected completion cost. No paid
inference was consumed; all inputs are explicit hypotheses in tests.
