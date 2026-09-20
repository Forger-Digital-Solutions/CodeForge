# R21 Repo Intelligence — Retrieval Quality Checkpoint (M4 partial)

Recorded: 2026-09-20
Branch: `forger-digital-solutions-forgegreen-certified`
Spend: `$0` — deterministic engine + synthetic corpus; no provider calls.

## Method

Added `packages/repo-intelligence/test/r21-retrieval-quality.test.ts`: a seeded layered
repository (~300 files: 10 controllers, 10 repositories, 12 services, 10 pages, 14 tests,
220 filler files, plus deliberately contaminating artifacts `dist/app.bundle.js`,
`node_modules/leftover/index.js`, `src/gen/client.generated.ts`) indexed by the real
`RepoIntelligenceEngine`, then queried with 6 labeled task phrasings (symbol needles,
explicit-path mention, symptom descriptions, cross-layer feature). Metrics: recall@15,
mean reciprocal rank, full expected-set coverage, generated/vendor contamination count,
freshness after rename+refresh. Raw numbers in `retrieval-quality.json`.

## Defects measured, then fixed

| # | Defect | Evidence | Fix |
|---|---|---|---|
| RI-001 | Generated/vendor artifacts outranked real source: for the symbol needle `paginateResults`, `dist/app.bundle.js`, `node_modules/leftover/index.js`, `src/gen/client.generated.ts` held ranks 1–3; the real file ranked 4. | `before.needleSymbolTop5` in retrieval-quality.json | `findRelevantContext` now excludes rows flagged `generated` unless the task explicitly names the path (`task_explicit_path` matches survive) or asks about generated/build artifacts. Files remain indexed — exclusion is a delivery filter, not an indexing gap. |
| RI-002 | Filename-pattern generated files were never flagged: `*.generated.ts` sits under `src/` where no `GENERATED_SEGMENTS` directory segment applies. | `src/gen/client.generated.ts` contaminating needle-symbol | `GENERATED_FILE_PATTERN` (`[._-](generated|gen|auto|designer|min)\.`) applied to the basename at index time, in addition to directory-segment detection. Verified not to false-positive `agent.ts`, `admin.ts`, `regenerate.test.ts` (separator required before the marker). |
| RI-003 | `findDependents` returned duplicate paths — a dependent reachable via both `imports` and `test_for` edges appeared twice. | `before.findDependentsDuplicates` | Dedup by `source_path`, first edge-kind record wins (kind ordering preserved). |

## Measured result

| Metric | Before | After |
|---|---|---|
| recall@15 | 1.0 | 1.0 |
| MRR | 0.5290 | **0.7652** |
| full coverage @15 | 1.0 | 1.0 |
| contaminated cases | 1 (3 generated paths in top-5) | **0** |
| needle-symbol first expected rank | 4 | **1** |
| symptom-session-expiry first expected rank | 11 | 11 (unchanged — see below) |
| cross-layer-orders first expected rank | — | 2 |

## Known boundary (honest)

- **Symptom queries rank weakly.** `symptom-session-expiry` ("users get logged out after a
  few minutes, sessions seem to expire too early") still places the expected implementation
  at rank 11 — inside the recall window but with poor precision. This is lexical dilution:
  symptom phrasing shares almost no tokens with symbol names, and BM25 on content favors
  files that mention "users"/"session" generically. Left unfixed deliberately — boosting
  symptom lexicons risks overfitting to this benchmark. Recorded as the next quality target.
- **Generated files stay indexed.** The filter operates at delivery, not indexing, so a task
  that names `client.generated.ts` explicitly still resolves it. Stale content *inside* a
  generated artifact (old symbol name surviving because codegen didn't rerun) is correctly
  attributed to the artifact, not to source-index staleness.
- Corpus is synthetic-layered (~300 files). CF-14's 1M-line benchmark covers scale; this
  suite covers rank quality. Real-repo precision remains unmeasured — flagged for M15.

## Authority posture

No completion, permission, or routing semantics touched. The generated flag is a retrieval
hygiene signal only; `findDependents` dedup is a pure bugfix. Completeness reporting
(UNKNOWN/PARTIAL/COMPLETE) unchanged — the filter does not raise or lower it.

## Test evidence

| Suite | Result |
|---|---|
| `r21-retrieval-quality.test.ts` | 4/4 |
| `cf14-certification.test.ts` | green |
| `cf14-large-repo-benchmark.test.ts` (1M-line index + query latency) | green (53.9s) |
| `fg2-certification.test.ts` | 22/22 |
| `fg2-efficiency.test.ts` (warm reuse, 1M-line incremental) | 2/2 |
| `engine.test.ts` | green |
| Package total | **44/44** |
