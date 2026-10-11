# R84 workspace validation

Node 24.19.0, npm 11.17.0. npm ci --ignore-scripts --no-audit --no-fund installed isolated locked worktree dependencies. No native SQLite rebuild ran on the user host; node:sqlite is available. Parent checkout dependency resolution is not authoritative.

The initial sandbox child-process startup failure (exit -1073741502) is retained separately. The real isolated [build baseline](build-baseline.log) failed because the CLI-first build reached the server before forge-aaa declarations existed. packages/server/tsconfig.json now references its already-declared forge-aaa dependency. Parent-linked workspace SSE type failures did not reproduce with isolated dependencies.

Full [build-release.log](build-release.log) and [lint-release.log](lint-release.log) pass. Renderer chunk-size messages are warnings, not suppressed failures. Lint repairs preserve effectful calls, remove unused bindings, correct a nullish-fallback expression, and replace invalid lazy generators without disabling rules. Exact changed paths are in [implementation-files.txt](implementation-files.txt).

| Executed scope | Passed | Failed | Skipped/pending |
|---|---:|---:|---:|
| [core-tests-final.json](core-tests-final.json) | 924 | 0 | 6 |
| [reviewer-contract-final.json](reviewer-contract-final.json) | 17 | 0 | 0 |
| [model-terms-tests-final.json](model-terms-tests-final.json) | 81 | 0 | 0 |
| [fairness-recovery-tests.json](fairness-recovery-tests.json) | 47 | 0 | 0 |
| [routing-lint-regression.json](routing-lint-regression.json) | 516 | 0 | 2 |
| [repository-tests.json](repository-tests.json) | 5167 | 32 | 57 |

Scopes overlap. They are never added as unique tests. The failed first core run, eligibility run and benchmark-runner mismatch remain beside corrected runs. In eligibility-recovery-tests.json, 177 tests outside free-cloud-registry passed; nine registry fixtures incorrectly depended on the now-restricted production alias. The final registry run passes all 81 using a synthetic allowed alias while explicit negative tests still reject actual NVIDIA and Auto Free routes.

Security tests: 136 passed in [security-tests.log](security-tests.log). Node accounting tests: two passed in [metrics-tests-final-2.log](metrics-tests-final-2.log). Provider-packaging contracts ran in the model-registry scope; actual installer/signing/smoke-install is NOT RUN. Repository suite finished: 32 failed, 57 skipped/pending; receipt retained.
