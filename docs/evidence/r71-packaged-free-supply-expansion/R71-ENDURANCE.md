# R71 bounded real autonomous campaign

[Raw campaign](R71-TASK-CAMPAIGN.json), [derived audit metrics](final-audit.json), and `benchmarks/r71/tasks.mjs` preserve real tasks and outcomes. The production AutonomousRunOrchestrator uses actual Eight-Bit/FreeFabric/ForgeZero and Kilo transport, public synthetic repositories, normal workspace tools, permissions, review/verification/integration gates. No test provider or substituted dispatch was used.

Eight task classes were prepared: bug fix, small feature, refactor, tests, docs, review, explicit multi-file change, multi-package change. Target was 20 attempts, with 180-second task deadlines and stop after two consecutive noncompletions to avoid burning scarce free quota. Only the first two classes were attempted; remaining classes and 18 target attempts are **unexecuted**, not successes or parked runs.

| Task | Outcome / wall time | Observed worker telemetry | Verification / integration |
|---|---|---|---|
| 01 bug fix | cancelled at deadline / 182385 ms including settlement | 24 model requests, 22 tool calls, 74840 input / 3986 output tokens. Explorer identified the off-by-one error but its completion output did not finish correctly; coder did not complete within deadline. | No verification attempts, no passed review, no integrated diff. Reservations 0. |
| 02 small feature | blocked / 105118 ms | 32 model requests, 31 tool calls, 100429 input / 2154 output tokens. Explorer exhausted 10 turns; coder failed on organic Cohere 429. | No verification attempts, no passed review, no integrated diff. Reservations 0. |

Attempted 2; completed 0; completion **0%**; longest success streak **0**; terminal blocked 1 and cancelled 1; parked 0 in the recorded final states; false autonomous completions **0 among these two outcomes**. Retry/duplicate-work counters report zero, but repeated tool/model activity is observable, so zero counters are not independent proof that work was never duplicated. The complete turns remain in raw evidence for diagnosis.

Root causes are insufficient measured autonomous role quality/schema adherence, repetitive tool turns, bounded deadline, then real upstream scarcity. Planner/reviewer qualification failed; no policy or completion gate was relaxed to force success. One measured coder route cannot supply a healthy qualified fallback at the failure instant. This is a meaningful stop condition, not 20 fabricated attempts.

The campaign records starting commit 2ac1ede0 because it ran during R71 development. The loaded built runtime included the R71 transport changes later frozen in b61af87; it is explicitly **dirty development execution**, not evidence from the frozen packaged candidate. The subsequent full build/package has independent clean provenance.

Gate G is **PARTIAL, not satisfied**. Reliable everyday autonomous completion across classes is not demonstrated. The later OpenRouter interactive file edit is successful but is not an additional autonomous endurance success and does not change the 0/2 result.
