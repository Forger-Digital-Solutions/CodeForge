# CodeForgeBench 40-case capacity preflight — 2026-09-18

The existing deterministic ForgeZero preflight was run against the R14 production-approved fleet.
Because no candidate passed every Managed Free gate, the production route and pool inputs are
empty. No benchmark request was dispatched.

## Estimate

- Planned cases: `40`
- Topology: `explorer-planner-coder-reviewer`
- Expected model turns: `8` per case
- Expected retries: `2` per case
- Expected verification calls: `2` per case
- Expected input/output: `24,000 / 8,000` tokens per case
- Minimum independent providers: `2`

## Result

```json
{
  "status": "INSUFFICIENT_CAPACITY",
  "plannedTasks": 40,
  "safeTaskUnits": 0,
  "eligiblePoolCount": 0,
  "independentProviderCount": 0,
  "reasons": [
    "role explorer has no eligible route",
    "role planner has no eligible route",
    "role coder has no eligible route",
    "role reviewer has no eligible route",
    "NO_ELIGIBLE_FREE_ROUTE",
    "NO_SAFE_CAPACITY",
    "PLANNED_TASKS_EXCEED_SAFE_CAPACITY",
    "INSUFFICIENT_INDEPENDENT_PROVIDERS"
  ]
}
```

Verdict: `CODEFORGE_FREE_BENCHMARK_CAPACITY_READY = NO`. The absolute no-launch rule was honored.
