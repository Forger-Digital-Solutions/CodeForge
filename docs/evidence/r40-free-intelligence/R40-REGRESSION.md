# R40 Canonical Regression

## Canonical suite (parallel load)

| Metric | Value |
|---|---:|
| Passed | 3,774 |
| Failed | 5 |
| Skipped | 48 (8 Postgres-environment-gated files — expected) |
| Test files | 474 |
| Duration | ~1,124s |

## Failures — all proven environmental via standalone reruns

| File | Parallel failure | Standalone result |
|---|---|---|
| `cf14-large-repo-benchmark` | context-pack latency 618ms vs <500ms bound | **PASS** (61.3s test) |
| `delivery-certification` ×2 | 30s/60s vitest timeouts under parallel load | **PASS** 14/14 (fixture 7.6s, determinism 19.5s) |
| `progress-watchdog` ×2 | wall 2159ms vs ≤1800ms; cancelled-vs-blocked timing map | **PASS** 2/2 (1551ms/1435ms) |

All five are wall-clock assertions; none touch R40-changed code (`providers`, `eight-bit`). Signature consistent with R38/R39's documented parallel-load flakes.

## Typecheck / build

- `tsc -b` `@codeforge/providers`: clean
- `tsc -b` `@codeforge/eight-bit`: clean
- `vitest` `packages/providers/test/openai-compatible.test.ts`: 18/18 (incl. new Gemini-alias test)
- `vitest` eight-bit eligibility/qualification/router/lifecycle/free-fabric: 91/91

## Evidence of no weakening

The new eligibility test asserts BOTH directions: the 0.75 admission factor admits a 76k-window model for a 100k estimate AND still denies a 70k-window model. The 3 canonical flake failures were reproduced standalone rather than threshold-edited.
