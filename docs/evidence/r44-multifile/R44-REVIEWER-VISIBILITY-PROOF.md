# R44 — Reviewer Visibility Regression Proof (§18)

## The R43 defect this closes

The orchestrator once sent the reviewer a ~2KB-truncated `git diff` and labeled the same
diff as `verificationEvidence` — verification had not run, and a defect in any file past
the 2KB cut was structurally invisible to the reviewer.

## What R44 proves

`buildReviewerDiffContext` (extracted from `autonomous-orchestrator.ts`) produces the
reviewer context as a pure function, pinned by
`packages/server/test/r44-reviewer-visibility.test.ts` — 3/3:

1. **Full inventory** — the `git diff --stat` list names every changed file, even when the
   body must truncate.
2. **Post-2KB defect visibility** — a planted defect in file C past the old 2000-byte
   boundary reaches the reviewer body verbatim.
3. **Explicit truncation** — when the 24KB bound cuts the body, the context carries an
   explicit marker with the omitted byte count and a recovery pointer; the tail is never
   dropped silently.

The "verification evidence" mislabel stays fixed: the reviewer receives no verification
section until commands have actually run (R43 fix, re-asserted here by the fixture shape).

## Design contract

Reviewer context is *bounded but semantically complete*: the complete changed-file
inventory always ships, and the diff body is bounded at ~24KB with an explicit omission
record — large enough that realistic coordinated diffs (the corpus's `r44-large-diff`
family exceeds the old bound ~12×) arrive whole.
