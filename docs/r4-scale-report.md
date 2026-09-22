# R4 deterministic scale simulation

Generated at 2026-09-22T02:02:44.533Z. This is a model-based capacity proof, not fabricated early-access telemetry.

| Scenario | Demand | Counted capacity | First-run success | Normal success | Blocks | p95 wait (min) |
|---|---:|---:|---:|---:|---:|---:|
| registered-1 | 1 | 0 | 0.0% | 100.0% | 1 | 60 |
| registered-10 | 10 | 0 | 0.0% | 0.0% | 10 | 600 |
| registered-25 | 25 | 0 | 0.0% | 0.0% | 25 | 1500 |
| registered-50 | 50 | 0 | 0.0% | 0.0% | 50 | 3000 |
| registered-100 | 100 | 0 | 0.0% | 0.0% | 100 | 6000 |
| registered-200 | 200 | 0 | 0.0% | 0.0% | 200 | 12000 |
| registered-373 | 373 | 0 | 0.0% | 0.0% | 373 | 22380 |
| registered-500 | 500 | 0 | 0.0% | 0.0% | 500 | 30000 |
| registered-1000 | 1000 | 0 | 0.0% | 0.0% | 1000 | 60000 |
| registered-373-dau-75 | 150 | 0 | 0.0% | 0.0% | 150 | 9000 |
| registered-373-dau-150 | 300 | 0 | 0.0% | 0.0% | 300 | 18000 |
| registered-373-dau-373 | 746 | 0 | 0.0% | 0.0% | 746 | 44760 |
| peak-new-user-reserve | 150 | 0 | 0.0% | 0.0% | 150 | 9000 |
| top-provider-outage | 150 | 0 | 0.0% | 0.0% | 150 | 9000 |
| gateway-outage | 150 | 0 | 0.0% | 0.0% | 150 | 9000 |
| promotion-ended | 150 | 0 | 0.0% | 0.0% | 150 | 9000 |
| 50-huge-vs-50-normal | 450 | 0 | 100.0% | 0.0% | 450 | 27000 |

OpenRouter's account credit balance was read successfully, but its API does not expose the remaining daily `:free` counter. The 1,000-request/day route is therefore modeled from the official ≥$10 policy and must remain header-observed at runtime.

Paid routes are absent from the eligible fleet. Kilo's IP-scoped route is retained as disabled research input until its current terms and privacy treatment are qualified.
