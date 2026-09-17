# CodeForge R7 release certification — 2026-09-17

## A. Verdict

`CODEFORGE_R7_ENGINEERING_READY_EXTERNAL_GATES_REMAIN`.

CodeForge passes its deterministic engineering, production build, package-closure, Electron-hardening, persistence, interruption, recovery, completion-authority, and packaged-smoke gates on this Windows host. It is not a release candidate: live free-provider qualification, real PostgreSQL, hosted first-run OAuth, Authenticode signing, and trustworthy installer upgrade/uninstall evidence remain incomplete or blocked.

## B. Starting state

- Repository: `G:\CodeForge`
- Branch / HEAD: `forger-digital-solutions-forgegreen-certified` / `41e0102d1a860107a6741026944b369ea4eeaa42`
- R6 reconciliation: HEAD matches R6 exactly. The tree was already dirty with 213 R6/R6.1 hardening/certification changes (2,704 additions, 5,184 deletions); no R7 source code was edited.
- Toolchain: Node `v24.19.0`, npm runner `11.17.0`, declared Electron `44.4.1`, electron-builder `26.15.3`.

Baseline detail is preserved in `docs/evidence/r7-release-certification/baseline-and-environment-2026-09-17.json`.

## C. Changes made

No product source fix was justified. R7 generated this report, its gate records, and sanitized live-provider evidence. The installer finding requires a version/upgrade-policy decision; changing release versioning during a testing campaign would be speculative.

## D–F. Deterministic matrix and PostgreSQL certification

| Gate | Result |
|---|---|
| Lockfile dry-run, lint, typecheck, workspace build | PASS; lint 0 errors / 0 warnings |
| Production dependency audit | PASS; 0 vulnerabilities |
| Full Vitest suite | PASS; 339 files / 2,545 tests passed; 7 files / 36 tests skipped; 0 failures; 525.88s |
| Completion, ForgeVerify negative paths, routing boundaries, BYOK isolation, subagents, recovery, Git/filesystem/approval torture | PASS through the full deterministic suite |
| PostgreSQL | BLOCKED: all 36 real-PostgreSQL tests remain skipped because no authorized endpoint is configured |

To finish the PostgreSQL gate, provide a disposable `CODEFORGE_TEST_POSTGRES_URL` and run `node scripts/postgres-test-harness.mjs -- node C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js test -- --maxWorkers=4`.

## G–J. Provider, ForgeAuto, Paid Auto, and BYOK

- Groq exact `openai/gpt-oss-20b`: `BLOCKED_BY_EXTERNAL_PROVIDER`. The live catalog listed the exact model (13 models total), but its live allowance stream finished without text, so zero routes were qualified. No fallback occurred.
- Managed-Free R1 live topology: `BLOCKED_BY_PROVIDER_OR_PHASE_BUDGET`. Two read-only Explorers and a Planner used only `groq::openai/gpt-oss-120b`; all three were cancelled at the documented 90-second phase ceiling. The run remained `blocked`, made no file change, performed no verification, and never claimed completion.
- ForgeAuto/Free, Paid Auto separation, GEMS exclusion, BYOK cross-user isolation, receipt/accounting, failure, retry, cancellation, and exact-pin behavior: PASS in deterministic contract/integration coverage. No paid, BYOK, or GEMS fallback was observed or authorized in the live run.

Live evidence: `docs/evidence/r7-release-certification/managed-free-r1-live-groq-2026-09-17.json` and `docs/evidence/post-paid-auto-r1/r5-groq-09381e32-d39e-4c55-8ce9-c49397866c27.json`.

## K–M. Agent runtime, ForgeVerify, interruption and recovery

The deterministic suite and production smoke cover Explorer/Planner/Coder/Reviewer topology, read-only explorer permissions, isolated writer worktree, reviewer/verification authority, concurrency limits, cancellation propagation, malformed output, no-progress/budget stops, failing verification, durable state, restart, and no approval replay.

The packaged full smoke passed actual repository indexing/search, bounded repair, verification, five renderer reloads, encrypted-credential round trip, secondary-renderer denial, and control-plane bearer isolation. Interruption returned expected exit `73`; recovery marked ambiguous work safely blocked and allowed a fresh task.

## N. OAuth

`BLOCKED_BY_EXTERNAL_DEPLOYMENT`. The packaged development manifest points to `http://127.0.0.1:3220`; `/health/ready` was actively refused. No hosted authorization endpoint existed to open in Chrome, so a genuine GitHub OAuth flow, account switch, logout, and hosted inference were not fabricated.

## O–P. Electron, package, installer, and signing

- Distribution build: PASS for unpacked, NSIS, and portable artifact creation.
- Package closure: PASS; 22 internal packages and 280 runtime modules / 15 external packages were audited.
- Electron security: PASS — `sandbox=true`, `nodeIntegration=false`, `contextIsolation=true`, `webSecurity=true`, guarded control-plane bearer injection, and bearer-free preload.
- Packaged smoke: PASS only in a normal Windows process. The restricted test shell causes Windows renderer `launch-failed:49`; an unsandboxed launch reached the interactive workspace and the full/interruption/recovery smoke passed, so this is an environment limitation rather than a product defect.
- Signing: BLOCKED. Setup, portable, and unpacked executables are `NotSigned`.
- Installer: BLOCKED. The unsigned NSIS setup returned zero, but its installed payload remained an existing Electron `33.4.11` build instead of the fresh Electron `44.4.1` artifact. Its uninstall registration references a prior RC4 directory. The stale uninstaller was deliberately not executed because it could remove pre-existing user software.

## Q–S. Security, warnings, performance/resource findings

Production dependency audit found zero vulnerabilities. Package security and credential persistence checks pass. A filename-only credential-signature scan found explicit test fixtures/documentation only; it did not print potential secret values. The full suite’s bounded worker configuration completed without saturation. No new material CPU, memory, process, worktree, or temp-file leak was demonstrated.

All warnings were classified in `docs/evidence/r7-release-certification/gate-results-2026-09-17.json`: host npm shim, restricted-shell Electron launch, expected adversarial IPC/CORS denials, and informational toolchain output.

## T. Remaining release blockers

| Blocker | Owner | Required action | Source change required? | Prevented gate |
|---|---|---|---|---|
| Live Managed-Free route | Provider/account owner | Restore a working free allowance/text stream, then rerun exact and agent-loop qualification | Unknown until a reproducible adapter defect exists | Provider / ForgeAuto certification |
| Real PostgreSQL | Infrastructure owner | Supply disposable authorized PostgreSQL URL and run all skipped tests | No | PostgreSQL certification |
| Hosted OAuth | Deployment/GitHub app owner | Deploy reachable Cloud API and authorize real clean-profile OAuth | No known source defect | OAuth / first-run acceptance |
| Authenticode | Signing-identity owner | Supply signing identity and verify every distributed EXE | No | Signed installer certification |
| Same-version install/upgrade | Release owner | Define version increment/upgrade policy and test against a known prior installation; ensure registry/uninstaller targets the installed payload | Potential release configuration change | Installer upgrade/uninstall certification |
| Business/counsel decisions | Business/counsel | Resolve license-holder, policy activation, and publication decisions | No | Public-release approval |

## U. Recommendation

Continue local deterministic dogfood and bounded engineering work. Do not label this build a release candidate or public release. Expanded/provider-backed dogfood requires a qualified real free route; public-release readiness additionally requires PostgreSQL, hosted OAuth, signing, and installer-upgrade evidence. Technical status is separate from unresolved business/legal approval.

## Final state

- Starting / final HEAD: `41e0102d1a860107a6741026944b369ea4eeaa42` / `41e0102d1a860107a6741026944b369ea4eeaa42`
- Commits / push: none / none
- Source modifications by R7: none
- Generated R7 files: this report and `docs/evidence/r7-release-certification/`
