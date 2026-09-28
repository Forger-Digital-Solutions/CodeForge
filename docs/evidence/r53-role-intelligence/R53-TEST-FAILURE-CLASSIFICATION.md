# R53 broad-suite failure classification

The first root-config full run executed 4,142 tests: 4,089 passed, 48 skipped, and five failed across four files. The raw output is `R53-FULL-TEST-OUTPUT.txt`.

| Failure | Classification | Isolated result |
|---|---|---|
| `fg11-source-state` live certified state | Expected source drift while R53 material change was committed but not yet recertified | R53 `r53-role-intelligence-v1` recertification applied; source-state/provenance pair 8/8 pass |
| `fg12e-harness-provenance` certified state | Same expected pre-recertification drift | Same 8/8 pass |
| Two `desktop-cloud-bridge.e2e` cases | Machine-load timeout in the 500-file run, 15-second per-test bound | Whole file 6/6 pass in 42.47 s |
| `parallel-orchestrator-integration` concurrent worktree case | Machine-load timeout in the 500-file run, 30-second per-test bound | Whole file 4/4 pass in 61.67 s |

The isolated files were run with the root Vitest configuration, not a package-local configuration. The source-state cases changed only after deliberate certification. The three timeout cases had no code fix and passed their complete files alone, supporting load sensitivity rather than an R53 behavior regression. The bounded-worker server suite then finished 902 passed, 3 skipped, zero failed; the affected routing suite finished 529 passed, 2 skipped, zero failed; and the 16-Bit boundary suite finished 83 passed, zero failed or skipped.
