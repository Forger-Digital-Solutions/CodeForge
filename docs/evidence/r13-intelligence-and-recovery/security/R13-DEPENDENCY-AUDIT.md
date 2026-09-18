# R13 dependency audit

Recorded: 2026-09-18

`npm` in PowerShell resolves to a stale `C:\Program Files\nodejs\npm.ps1` shim whose target user-global npm CLI is absent. The installed `npm.cmd` 11.17.0 is healthy, so R13 used that supported binary directly without changing PATH, reinstalling packages, upgrading dependencies, or rewriting the lockfile.

| Scope | Command | Result |
| --- | --- | --- |
| Complete dependency graph | `npm.cmd audit --json` | 0 vulnerabilities: 0 info, 0 low, 0 moderate, 0 high, 0 critical |
| Production dependencies | `npm.cmd audit --omit=dev --json` | 0 vulnerabilities: 0 info, 0 low, 0 moderate, 0 high, 0 critical |

Both reports count 150 production, 438 development, 67 optional, and 13 peer dependencies (588 total). There are no direct or transitive vulnerability findings, so no remediation or dependency upgrade is indicated. npm emitted only an informational npm-12 availability notice and an existing `allow-scripts` configuration warning; neither changes the zero-vulnerability result. The R13 lockfile change is the intentional local workspace linkage for `@codeforge/intelligence`, not third-party package churn.

Raw reports: `dependency-audit-r13.json` and `dependency-audit-production-r13.json`.
