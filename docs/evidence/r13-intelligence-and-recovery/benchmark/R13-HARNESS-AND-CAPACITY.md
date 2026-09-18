# R13 public benchmark harness and capacity readiness

Recorded: 2026-09-18 before launch.

## Harness controls

- Runner: `scripts/r9-codeforge-bench.mjs` with `scripts/r12-codeforge-bench-r2-executor.mjs` as the generic R2 execution adapter.
- Selected scope: the 40 public cases only (`--split=ALL`, without `--include-protected`). Protected cases are neither executed nor used for training by this public campaign.
- Route: exact `openrouter` / `cohere/north-mini-code:free`; the harness rejects any unavailable/unverified route and permits no substitution or paid/BYOK fallback.
- Case timeout: unchanged at 300,000 ms.
- Execution topology: solo production workflow.
- Evidence: R13 output and raw fixture evidence are isolated below `docs/evidence/r13-intelligence-and-recovery/benchmark/`; R11/R12 paths are never supplied.
- Success accounting: a success requires terminal completion, visible acceptance, hidden acceptance, and persisted ForgeVerify/Completion Gate evidence. A completed-looking turn without all evidence remains non-success.

## Catalog-only provider check

The check used `OpenRouterAdapter.healthCheck()` and `listModels()` only; it submitted no model prompt and incurred no paid inference.

| Field | Observed |
| --- | --- |
| Checked at | `2026-09-18T08:23:08.674Z` |
| Provider health | `available` |
| Catalog latency | 413 ms |
| Exact route present | yes |
| Catalog free status | verified free, zero-priced |
| Tool capability | true |
| Context window | 256,000 |
| Known quota / reset | not exposed by catalog; unknown rather than inferred |
| Recent 429 in this R13 check | none observed; catalog-only checks cannot prove daily allowance |
| Expected campaign demand | approximately 607 provider calls in the R12 40-case campaign; actual R13 demand may differ |

Launch outcome: six raw public attempts were completed before the campaign was stopped without an aggregate result. Each received OpenRouter's `free-models-per-day-high-balance` 429 with `X-RateLimit-Remaining: 0` and reset `2026-09-19T00:00:00Z` (8:00 PM Eastern). The current environment therefore cannot support the remaining campaign before its known reset. R13 does not wait for that external condition and does not retry the incomplete campaign on another or paid route.
