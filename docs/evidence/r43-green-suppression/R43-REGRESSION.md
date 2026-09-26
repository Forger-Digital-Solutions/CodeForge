# R43 Canonical Regression

- Command: `npm test` (vitest run, canonical order)
- Baseline (R42): 3,846 pass / 0 fail / 48 skip in 610.5s
- R43 result: **3,861 pass / 2 fail / 48 skip** in 495.4s — 480 files, 3,911 tests

## Delta explanation (every changed count accounted)

- +16 new deterministic tests: `r43-dedup-safety.test.ts` (8) + `r43-suppression-evidence.test.ts` (8)
- +1 new compression regression test (vitest/tap failure-format retention)
- -2 pass / +2 fail: `fg11-source-state` + `fg12e-harness-provenance` — the certified source-state
  document still referenced R42 material hashes while R43 legitimately changed
  `packages/server/src/autonomous-orchestrator.ts` (reviewer diff context). Expected drift,
  not a code regression.
- Post-run: `scripts/r42-recertify-source-state.mjs` re-issued the state
  (id `09afc53f…`) with an R43 reconciliation entry; both tests re-ran standalone — 8/8 pass.
- Effective post-recertification totals: **3,863 pass / 0 fail / 48 skip**.

## Skips

All 48 skips are Postgres-gated files, consistent with prior canonical runs.

## Typecheck

`npx tsc -b` clean across all workspaces.

## Targeted surfaces beyond canonical

- model-registry chaos/registry/catalog-refresh: 77/77
- role-quality / role-qualification / role-routing: 44/44
- compression + history-compaction + context-efficiency: 21/21
- orchestrator + e2e + subagents: 30/30
