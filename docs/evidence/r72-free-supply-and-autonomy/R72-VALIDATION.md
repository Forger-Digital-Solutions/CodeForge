# R72 validation

| Recorded stage | Total | Pass | Fail | Skip |
|---|---:|---:|---:|---:|
| [focused-tests](focused-tests.json) | 110 | 110 | 0 | 0 |
| [final-focus-tests](final-focus-tests.json) | 32 | 32 | 0 | 0 |
| [affected-tests](affected-tests.json) | 2801 | 2782 | 13 | 6 |
| [final-boundary-tests](final-boundary-tests.json) | 26 | 26 | 0 | 0 |
| [final-verification-suite](final-verification-suite.json) | 260 | 259 | 0 | 1 |

The initial 2801-test affected run is retained with all 13 failures. It used an unnecessarily deep temp path inside an ignored Git checkout and overlapped heavyweight Windows worktree/process tests. Standalone rechecks cleared orchestrator/publication timeouts and deep-path preconditions without changing assertions. Native temp outside any repository cleared the remaining fixture-boundary failures. The latter exposed a real correctness gap for ignored child workspaces, which was fixed in production rather than only hidden by changing the harness.

All eight previously failing files passed standalone at a valid boundary. The final 26-test corpus also passes at the exact in-repository ignored boundary, including new invalidation and file-review tests. The final complete verification/completion suite passes 259/260 with one skip, no failures. Intermediate hardening receipts retain the failures that drove the fixes; source changes during those stages mean they are diagnostic receipts, not final certification. Test stages overlap; do not sum their counts as independent coverage.

Full workspace build at 5ebe3fbca2250f01e9bf1188ab14ff24429c4727 passed ([log](final-workspace-build.log)); package typechecks and renderer compilation included. Earlier host npm build could not launch configured Git Bash; using the native Windows npm script shell resolved it without changing repository configuration. TypeScript tsc -b, main and renderer checks passed. Five static package audits passed. Six skips in the initial affected set and one skip in the final verification subset are not claimed as live/provider/PostgreSQL certification. No remaining critical regression was observed in final checks. Unavailable live/package acceptance gates remain separate from passing deterministic tests.

[Standalone receipts](isolated-rechecks.json), [native-boundary receipts](native-rechecks.json), [preservation and credential audit](final-audit.json).
