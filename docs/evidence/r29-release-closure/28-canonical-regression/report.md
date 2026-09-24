# R29 regression record

The first full `vitest run` completed in 797.20 seconds: 459 files (447 passed, 8 skipped, 4 failed) and 3,625 tests (3,573 passed, 48 skipped, 4 failed). The failures were:

| Suite | Full-run result | Follow-up |
| --- | --- | --- |
| `apps/cloud-api/test/desktop-cloud-bridge.e2e.test.ts` | One 15-second timeout, followed by a closed-database error | Passed in the isolated two-file rerun (7/7 tests across both files). Concurrent packaging load was present during the full run. |
| `packages/repo-intelligence/test/cf14-large-repo-benchmark.test.ts` | Context benchmark 578.66 ms over its 500 ms threshold | Passed in the same rerun without packaging load. |
| `packages/forgegreen-campaign/test/fg11-source-state.test.ts` | Live source no longer matches the frozen Candidate D source state | Expected historical certification drift after R29 production edits; the old certified state was not rewritten. Current-source recertification remains open. |
| `packages/forgegreen-campaign/test/fg12e-harness-provenance.test.ts` | `FG12E_SOURCE_STATE_DRIFT` against the same old source state | Same historical drift, still a red canonical gate. |

The R27 golden validation returned `PARTIAL`, 13 `PASS` and the same two `BLOCKED_ENVIRONMENT` cases as the frozen baseline: `r27-tiny-median` and `r27-small-config-merge` require a `python` executable absent on this host. The task statuses matched the previous record exactly. The fresh `golden-r29.json` is separate; the original R27 evidence file was restored byte for byte after the runner rewrote it.

`npm run typecheck` passed after the R29 runtime and desktop changes. `npm run lint` initially found two preexisting unused imports in desktop files; removing them made lint pass. Focused post-fix UI suites passed 61/61 tests. Earlier focused runtime runs passed 68/68 and 36/36 tests, and six security-oriented source suites passed 95/95 tests. These focused passes do not change the full-suite red result.

A second default full-suite attempt after the final settings fix was stopped after widespread wall-clock timeouts appeared in concurrently running million-line, Git/worktree, delivery, and verifier suites. It had no trustworthy final aggregate and is **not counted as a pass**. The newly affected files were then rerun without other heavy suites: FG-2 repository efficiency 2/2, delivery 13/13, parallel worktree orchestration 4/4, ForgeGreen restart/fallback 3/3, and autonomous orchestration 13/13. Together with the earlier two-file rerun, seven files and 42 tests passed in isolation. The historical FG-11/FG-12E source-state failures remain genuine red gates.

The package build, internal dependency audit (353 runtime modules, 18 external imports), build-identity audit, production endpoint audit, and browser archive security audit passed. Shell-driven packaged `full` smoke failed inside the command sandbox before renderer load with `RENDER_PROCESS_GONE=launch-failed:49` and `ERR_FAILED (-2)`. Repeating the same harness outside that sandbox passed `full`, `interrupt` (expected exit 73), and `recover` on the final package. The interactive packaged desktop separately launched, authenticated, restored a prior task and saved model, and an earlier R29 package completed one real coding task.

Verdict: canonical regression is **not green** because the two historical source-state gates still fail against R29 code. Packaged smoke is green when the process is permitted to launch an Electron renderer.
