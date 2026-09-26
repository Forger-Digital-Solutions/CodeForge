# R44 BASELINE VERIFICATION

Recorded at the start of R44, before any R44 code change.

## Repository state

- **Branch:** `codex/r29-release-closure` — matches the R43 handoff expectation.
- **HEAD:** `42c5d39067ef92b22415ed5c54122e8f33572f47` — "R43: final report — partially
  verified, honest negative on live suppression". Matches the expected R43 tip `42c5d39`.
- **R43 commits present:** `58517b5` (suppression state-evidence guard),
  `a061b83` (receipt suite-version compatibility), `766d982` (compression failure-line fix),
  `c5e6a5c` (reviewer full-diff context + verification-evidence mislabel fix),
  `87815eb` (paired A/B corpus harness), `b04ab4b` (free-supply + endurance/scale evidence),
  `4b7374b` (suppression-safety artifact), `24ad011` (live corpus + root cause + regression),
  `42c5d39` (final report). All present in `git log`, contiguous on top of R42 `b3021b9`.
- **R43 evidence preserved:** `docs/evidence/r43-green-suppression/` — 15 committed
  artifacts including `R43-FINAL-REPORT.md`, untouched.
- **R43 harness scripts preserved:** `scripts/r43-suppression-ab.mjs`,
  `r43-qualification-sim.mjs`, `r43-compression-proof.mjs`, `r43-free-supply.mjs`.

## Working-tree drift (pre-existing, preserved)

Two files are dirty exactly as anticipated by the round brief ("two preserved benchmark
scripts"):

1. `scripts/r11-codeforge-bench-r2-executor.mjs` — one-line fixture change: the seeded
   `calculator.mjs` now writes `a + b` instead of the buggy `a - b` (the "repair the seeded
   bug" fixture no longer seeds a bug).
2. `scripts/r20-postgres-admission-benchmark.mjs` — one-line change: the latency comparator
   `latencies.sort((a, b) => a - b)` became `(a, b) => a + b` (invalid comparator — would
   corrupt percentile measurement if this script were re-run).

Both diffs were dirty before R44 began and are preserved verbatim per instructions. They are
benchmark tooling only; neither participates in the R44 corpus, runtime, or test suite.
Neither file is touched by R44 work.

## Untracked / ignored state

- `.audit-worktree-initial/` — ignored worktree copy with dangling node_modules links
  (git warnings only, no effect on status).
- No unexpected source drift: `git status --porcelain` shows only the two scripts above.
  All `docs/evidence/**`, `packages/**`, and test files are clean at the R43 tip.

## Provider credentials

- `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `GEMINI_API_KEY` all present in the
  environment — the live free-supply lanes are runnable this round.
- `NODE_ENV`/`CODEFORGE_ALLOW_TEST_PROVIDERS` unset (default production gate).

## Reproducibility

R43 state is reproducible: HEAD equals the published tip, all evidence artifacts are
committed and clean, and the only drift is the documented preserved-script pair. No silent
regeneration of historical evidence will occur; R44 writes only under
`docs/evidence/r44-*/`.
