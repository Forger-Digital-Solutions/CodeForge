# R4 deterministic scale simulation

Generated at 2026-09-16T01:09:38.356Z. This is a model-based capacity proof, not fabricated early-access telemetry.

| Scenario | Demand | Counted capacity | First-run success | Normal success | Blocks | p95 wait (min) |
|---|---:|---:|---:|---:|---:|---:|
| registered-1 | 1 | 520 | 100.0% | 100.0% | 0 | 0 |
| registered-10 | 10 | 520 | 100.0% | 100.0% | 0 | 0 |
| registered-25 | 25 | 520 | 100.0% | 100.0% | 0 | 0 |
| registered-50 | 50 | 520 | 100.0% | 100.0% | 0 | 0 |
| registered-100 | 100 | 520 | 100.0% | 100.0% | 0 | 0 |
| registered-200 | 200 | 520 | 100.0% | 100.0% | 0 | 0 |
| registered-373 | 373 | 520 | 100.0% | 100.0% | 0 | 0 |
| registered-500 | 500 | 520 | 100.0% | 93.8% | 31 | 4 |
| registered-1000 | 1000 | 520 | 100.0% | 46.8% | 531 | 62 |
| registered-373-dau-75 | 150 | 520 | 100.0% | 100.0% | 0 | 0 |
| registered-373-dau-150 | 300 | 520 | 100.0% | 100.0% | 0 | 0 |
| registered-373-dau-373 | 746 | 520 | 100.0% | 64.9% | 253 | 30 |
| peak-new-user-reserve | 150 | 520 | 100.0% | 100.0% | 0 | 0 |
| top-provider-outage | 150 | 270 | 100.0% | 100.0% | 0 | 0 |
| gateway-outage | 150 | 270 | 100.0% | 100.0% | 0 | 0 |
| promotion-ended | 150 | 458 | 100.0% | 100.0% | 0 | 0 |
| 50-huge-vs-50-normal | 450 | 113 | 100.0% | 22.4% | 349 | 186 |

OpenRouter's account credit balance was read successfully, but its API does not expose the remaining daily `:free` counter. The 1,000-request/day route is therefore modeled from the official ≥$10 policy and must remain header-observed at runtime.

Paid routes are absent from the eligible fleet. Kilo's IP-scoped route is retained as disabled research input until its current terms and privacy treatment are qualified.
