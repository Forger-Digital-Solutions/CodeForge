# R29 regression record

The full `vitest run` completed in 797.20 seconds: 459 files (447 passed, 8 skipped, 4 failed) and 3,625 tests (3,573 passed, 48 skipped, 4 failed). The failures were:

| Suite | Full-run result | Follow-up |
| --- | --- | --- |
| `apps/cloud-api/test/desktop-cloud-bridge.e2e.test.ts` | One 15-second timeout, followed by a closed-database error | Passed in the isolated two-file rerun (7/7 tests across both files). Concurrent packaging load was present during the full run. |
| `packages/repo-intelligence/test/cf14-large-repo-benchmark.test.ts` | Context benchmark 578.66 ms over its 500 ms threshold | Passed in the same rerun without packaging load. |
| `packages/forgegreen-campaign/test/fg11-source-state.test.ts` | Live source no longer matches the frozen Candidate D source state | Expected historical certification drift after R29 production edits; the old certified state was not rewritten. Current-source recertification remains open. |
| `packages/forgegreen-campaign/test/fg12e-harness-provenance.test.ts` | `FG12E_SOURCE_STATE_DRIFT` against the same old source state | Same historical drift, still a red canonical gate. |

The R27 golden validation returned `PARTIAL`, 13 `PASS` and the same two `BLOCKED_ENVIRONMENT` cases as the frozen baseline: `r27-tiny-median` and `r27-small-config-merge` require a `python` executable absent on this host. The task statuses matched the previous record exactly. The fresh `golden-r29.json` is separate; the original R27 evidence file was restored byte for byte after the runner rewrote it.

`npm run typecheck` passed after the R29 runtime and desktop changes. `npm run lint` initially found two preexisting unused imports in desktop files; removing them made lint pass. Focused post-fix UI suites passed 61/61 tests. Earlier focused runtime runs passed 68/68 and 36/36 tests, and six security-oriented source suites passed 95/95 tests. These focused passes do not change the full-suite red result.

The package build, internal dependency audit (353 runtime modules, 18 external imports), build-identity audit, production endpoint audit, and browser archive security audit passed. The shell-driven packaged `full` smoke failed before renderer load with `RENDER_PROCESS_GONE=launch-failed:49` and `ERR_FAILED (-2)`; `interrupt` and `recover` were not counted as passed. The interactive packaged desktop did launch, authenticate, and complete one real coding task, but it is separate evidence from the failed smoke gate.

Verdict: canonical regression is **not green**. The two historical source-state gates and the packaged smoke launch remain unresolved for release certification.
