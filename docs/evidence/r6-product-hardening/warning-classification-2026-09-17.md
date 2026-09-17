# R6.1 warning and error classification

Every diagnostic observed during R6 was investigated. The final owned-code lint, typecheck, build, tests, and nominal packaged runtime have no actionable owned-code warning or error.

| Diagnostic | Classification | Source/ownership | Risk and disposition |
|---|---|---|---|
| 396 initial Oxlint diagnostics | `CODEFORGE_DEFECT` / `CODEFORGE_CONFIGURATION` | Owned code and lint scope | Cleared. Added a zero-warning lint gate, corrected scope, removed dead imports/variables, and fixed the underlying high-risk findings rather than globally suppressing them. |
| Vite oversized-chunk/config API warnings | `CODEFORGE_CONFIGURATION` / `DEPRECATION` | Owned Vite configs | Cleared with deliberate vendor chunking and `import.meta.dirname`; both desktop and web production builds are clean. |
| Electron positional `console-message` callback deprecation | `DEPRECATION` | Owned desktop diagnostics | Cleared by migrating to `WebContentsConsoleMessageEventParams`; rebuilt interruption/recovery/full smoke contains no deprecation. |
| Electron security-probe `Invalid IPC sender` and browser CORS denial | `EXPECTED_NEGATIVE_TEST_OUTPUT` | Deliberate packaged adversarial probe | Retained as asserted proof that an untrusted secondary renderer cannot call privileged IPC or the bearer-protected loopback API. It is absent from nominal user flow. |
| Chromium lifecycle lines appear on Electron stderr with `INFO:CONSOLE` | `INFORMATIONAL_ONLY` | Chromium diagnostic transport for smoke-only lifecycle markers | No warning/error severity and only enabled by the smoke evidence environment variable. |
| electron-builder `duplicate dependency references` list | `INFORMATIONAL_ONLY` | electron-builder workspace graph traversal | No duplicate payload or unresolved dependency was found by the packaged internal/runtime closure audits. Package completed successfully. |
| npm user `.npmrc allow-scripts` ignored because root `package.json` declares `allowScripts` | `EXTERNAL_ENVIRONMENT` | User-level npm configuration, outside repository | The repository allowlist is intentionally authoritative and narrower. Audit results are valid; no repository suppression or host mutation was made. |
| `electron-winstaller` transitive install script blocked during install | `DEPENDENCY_WARNING` / `TOOLCHAIN_WARNING` | Optional/transitive Squirrel tooling | CodeForge targets NSIS/portable and does not execute this script. It was not allowlisted merely to quiet output; packaging and dependency closure passed without it. |
| Global npm shim points to a missing user-level npm CLI | `EXTERNAL_ENVIRONMENT` | Host npm installation | Used a pinned cached npm 12.0.2 runner. Repository build/test/package behavior is unaffected; repairing the user's global installation was outside campaign authority. |
| Git global ignore/config access warning in sandbox diagnostics | `EXTERNAL_ENVIRONMENT` | Host/sandbox Git configuration | Test setup now isolates Git global configuration. The authoritative bounded suite is clean. |
| Vitest isolate performance estimate | `INFORMATIONAL_ONLY` | Vitest 5 summary | It is a measured optimization suggestion, not a failure, leak, warning, or correctness diagnostic. Isolation remains enabled for safety. |
| Unconstrained Vitest timeout cascade | `TEST_HARNESS_WARNING` | Host resource saturation from excessive worker fan-out | The run was stopped and not counted. No product code was changed. The complete suite passed with `--maxWorkers=4`, 0 failures, and identical coverage. |
| PostgreSQL skips | `EXTERNAL_CREDENTIAL_REQUIRED` | Real external database suites | 7 files / 36 tests. They remain explicit skips; none were newly skipped or converted from failures. |
| Legal gate business/counsel blockers | `EXTERNAL_ENVIRONMENT` | Copyright holder, age-policy activation, document publication authority | Engineering legal checks pass; these are not converted to engineering success or hidden. |

No blanket `eslint-disable`, TypeScript weakening, stderr filtering, skipped-test conversion, Electron security weakening, or verification bypass was used.
