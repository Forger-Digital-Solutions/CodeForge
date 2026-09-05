# CODEFORGE CF-16 CERTIFICATION REPORT

## Verdict

CF16_BLOCKED

## Takeover state

The repository was inspected on `feat/codeforge-cloud` at `19296b8197418602a73fc450328aeab9a203c7db`. The worktree contains the inherited CF-14/CF-15 changes and was preserved. `git diff --check` passes. Node is `v24.19.0`; the globally installed npm shim is broken because its npm CLI target is absent.

## CF-16R production migration

`packages/workflow/src/forge-verify.ts` provides a typed verifier registry, versioned policy-driven plans, explicit requirements, structured commands, immutable attempts/evidence, bounded redacted output, SHA-256 provenance hashes, deterministic workspace state identity, retry history, restart interruption recovery, set-based current-evidence summaries, and receipts. State identity includes canonical workspace identity, Git HEAD, dirty diff, untracked contents, and a non-Git directory fallback.

The legacy workflow command API now routes through a strict structured adapter: shell-only forms fail closed, and compatibility reports are derived from ForgeVerify execution rather than independently executing commands. `WorkflowEngine` passes the resulting summary to Completion Gate; no legacy report can override missing, stale, or non-passing evidence.

Workflow service persists plans, attempts, and terminal evidence as run-scoped session records. Plans/evidence use append-only persistence with idempotent duplicate insertion; attempts may make only their explicit `running` to terminal transition. A later service workflow marks persisted `running` attempts `interrupted`, never successful. The service emits structured, persisted `forgeverify.plan_created`, `forgeverify.attempt_started`, and `forgeverify.evidence_created` SSE events. Run inspection and the desktop inspection projection use those records/events without parsing process output.

The cloud database contract now includes ForgeVerify plan, attempt, and evidence primitives backed by migration `006_cf16r2_forgeverify_evidence` in both SQLite and PostgreSQL. Plans and evidence are append-only; each attempt has at most one evidence row; terminal attempt transitions are guarded and PostgreSQL uses row locking. The shared cloud parity suite covers creation, reload, duplicate evidence idempotency, and terminal immutability. A shared session observer persists the same records for parallel, mission, and delivery verification paths as well as the workflow path.

## Bypass matrix

| Surface | Current state | CF-16R2 disposition |
| --- | --- | --- |
| Shared `WorkflowEngine` / `runVerification` | Legacy strings accepted at the API boundary | Routed through the strict structured adapter and ForgeVerify executor |
| Parallel orchestrator/workstreams | Command arrays remain as durable input state; execution is delegated to ForgeVerify | Migrated; state is input, not an execution authority |
| Mission supervisor/autonomous orchestration | Mission aggregation remains for policy input and usage accounting | Migrated; final verification calls ForgeVerify |
| Delivery/publication checks | Delivery verification delegates to ForgeVerify; publication materialization checks remain structural Git/lease guards | Migrated for executable verification; authorization and lease checks remain separate authority |
| Session workflow inspection | ForgeVerify records/events persisted and projected | Migrated |

## Verification performed

- Full TypeScript project build: passed (`node node_modules/typescript/bin/tsc -b --pretty false`).
- Focused ForgeVerify, workflow, persistence, protocol, UI projection, parallel, mission, and delivery regressions pass (90 tests across 17 files, including 23 targeted orchestration/delivery tests) through the local Vitest runtime.
- `git diff --check`: passed.

## Certification blockers

The phase is not certifiable yet. Cloud SQLite/PostgreSQL contracts and migrations are present, but this environment has no accessible PostgreSQL listener (`wsl --status` is access-denied and port 5432 is not listening), so real PostgreSQL execution/concurrency/restart evidence cannot be claimed. The complete suite has not been certified with PostgreSQL enabled and zero required skips; an earlier attempted suite reported PostgreSQL-gated skips. Therefore no claim of CF-16 completion is made.

## CF-16R3 proof attempt

### Takeover and environment inventory

- Root: `G:\CodeForge`
- Branch: `feat/codeforge-cloud`
- HEAD: `19296b8197418602a73fc450328aeab9a203c7db`
- Final Git state: inherited worktree remains dirty (160 status entries); all inherited changes were preserved and no reset/clean/checkout operation was used.
- Node: `v24.19.0`
- Package manager: the global npm shim is broken (`npm-cli.js` is missing); repository-local Node runtimes were used directly.
- PostgreSQL environment variables: `CODEFORGE_TEST_POSTGRES_URL` and `DATABASE_URL` are unset. No credential values were printed.
- Native Windows PostgreSQL: no matching service or common installation directory found; port 5432 is not listening.
- WSL: `wsl --list --verbose` and `wsl --status` return `Wsl/EnumerateDistros/Service/E_ACCESSDENIED`.
- Docker: Docker CLI `29.7.2` is installed, but the daemon is unavailable (`docker_engine` named pipe missing); containers/images cannot be inspected or started.
- Repository setup: `scripts/setup-local-pg.mjs` is present and retains CF-15S scoped, idempotent HBA rules; it requires the unavailable WSL environment.

### PostgreSQL-gated test inventory

| Test | SQLite/local coverage | PostgreSQL coverage | Gate |
| --- | ---: | ---: | --- |
| `packages/cloud-db/test/postgres.test.ts` | 6 mock/unit tests | 2 real-server tests | `CODEFORGE_TEST_POSTGRES_URL` or `DATABASE_URL` |
| `packages/cloud-db/test/parity.test.ts` | 15 parity tests | 15 dynamically registered parity tests | `CODEFORGE_TEST_POSTGRES_URL` or `DATABASE_URL` |
| `packages/cloud-db/test/publication-lease.test.ts` | 1 conformance test | 1 dynamically registered conformance test | `CODEFORGE_TEST_POSTGRES_URL` or `DATABASE_URL` |
| `tests/cloud-postgres-adversarial.test.ts` | 0 | 13 tests | `CODEFORGE_TEST_POSTGRES_URL` |
| `tests/two-client-authority.test.ts` | 6 local tests | 6 PostgreSQL tests | `CODEFORGE_TEST_POSTGRES_URL` |

The installed Node `pg` driver is available. With no PostgreSQL URL, the cloud-db local run reported `33 passed, 2 skipped`; the two skips are the required real-server tests. The adversarial and two-client PostgreSQL tests were also unavailable. No Node `pg` connectivity probe or PostgreSQL SQL/concurrency/reload gate was possible because no legitimate server endpoint exists.

### Current proof and verdict

- Root TypeScript build gate: passed with `node node_modules\\typescript\\bin\\tsc -b --force --pretty false`.
- `git diff --check`: passed.
- Current ForgeVerify/workflow/UI/cloud parity gate: 41 tests passed.
- Current autonomous gate after the final fix: 12 tests passed.
- Full-suite attempt: 167 files passed, 1 file skipped, and 1,285 tests passed before the final autonomous compatibility fix; its two autonomous failures are stale relative to the current tree and were subsequently rerun green. It must not be treated as a PostgreSQL-enabled certification.
- Final production-authority audit: shared workflow, parallel, mission, autonomous, delivery, and Completion Gate paths use ForgeVerify; publication materialization remains a structural authorization/lease path rather than a verifier authority.

Because genuine PostgreSQL execution, two-client concurrency, restart/reload from PostgreSQL, and Completion Gate consumption of reloaded PostgreSQL evidence remain unproven, the literal CF-16R3 verdict is **CF16_BLOCKED**.

## CF-16R4 REAL POSTGRESQL CERTIFICATION

### Verdict

CF16_PASS

### Takeover and environment

- Root: `G:\CodeForge`
- Branch: `feat/codeforge-cloud`
- HEAD: `19296b8197418602a73fc450328aeab9a203c7db`
- The inherited dirty worktree was preserved; no reset, clean, checkout, commit, or unrelated restoration was performed.
- Node: `v24.19.0`.
- `npm.cmd`: `11.17.0`; the PowerShell npm shim remains broken, so the repository-local Node/Vitest entry point was used for the test gate.
- `git diff --check`: passed before and after certification.
- The parent shell did not expose `CODEFORGE_TEST_POSTGRES_URL`; the already-running WSL PostgreSQL instance was reached through its local test endpoint without changing PostgreSQL configuration or printing credentials.

### PostgreSQL proof

Node `pg` executed `SELECT version(), current_database(), current_user` successfully: PostgreSQL `16.15`, database `codeforge_test_db`, user `codeforge_test`. The focused real-PostgreSQL gate passed with 7 files, 78 tests, 0 failures, and 0 skips.

| Required proof | Result |
| --- | --- |
| Plan persistence and reload | PASS |
| Attempt persistence and terminal transition | PASS |
| Evidence persistence/reload and hash retention | PASS |
| SQLite/PostgreSQL parity | PASS; 30 parity tests in the final suite |
| Terminal immutability | PASS; invalid terminal rewrite rejected |
| Duplicate callback/evidence idempotency | PASS; one logical terminal/evidence result |
| Retry history | PASS; separate immutable failed and passed attempts |
| Two-client concurrency | PASS; duplicate and conflicting terminal races coherent |
| Transaction/final-state coherence | PASS; terminal evidence pairs remained coherent |
| Restart/reload recovery | PASS; running became interrupted, never passed |
| PostgreSQL-backed Completion Gate | PASS; reloaded summary produced `completed` only with matching evidence |
| Stale evidence after reload | PASS; workspace mutation retained history and blocked current completion |
| Real Git state hash | PASS; same HEAD with dirty change differed |
| Cross-worktree identity | PASS; worktree identity differed and could not reuse evidence |

### Production-path and adversarial audit

The complete PostgreSQL-enabled suite passed with **170 test files, 1,335 tests, 0 failures, and 0 skips**. It covered the current equivalents of the required workflow, ForgeVerify evidence, Completion Gate, persistence, parallel, mission, autonomous, delivery, publication, SSE replay, run inspection, desktop projection, ForgeGreen, Repository Intelligence, Chat/Agent separation, and subagent-permission regressions.

| Audit surface | Result |
| --- | --- |
| Shared, parallel, mission, autonomous, and delivery verification | PASS; all execute through ForgeVerify |
| Autonomous no-verifier compatibility | PASS; 12/12 autonomous-orchestrator tests |
| Delivery failure/success boundary | PASS; failed ForgeVerify blocks delivery and legacy flags do not bypass it |
| Publication authority separation | PASS; verification remains separate from lease, ownership, token, and publication authority |
| Completion Gate call sites | PASS; production gate is `evaluateCompletion`; verification summary is ForgeVerify-derived |
| Model, repository-text, and stdout spoofing | PASS; narration/comments/output cannot create evidence or completion |
| Node test-output parsing | PASS; process lifecycle/exit status remains authoritative |
| Cancellation, timeout, and infrastructure error | PASS; distinct terminal negative states |
| SSE replay/reconnect and run inspection | PASS; server-authoritative, idempotent reconstruction |
| ForgeGreen and Repository Intelligence independence | PASS; advisory signals cannot lower trusted obligations |
| Chat vs Agent and subagent permission ceilings | PASS |

The repository-wide search classified legacy-looking names as compatibility inputs, durable plan data, display/diagnostic data, or values derived from ForgeVerify. No production verification-authority bypass was found. Publication authorization and delivery authority remain independent of ForgeVerify PASS.

### Gates and arithmetic

- Focused PostgreSQL gate: 7 files / 78 tests, all passed, zero skips.
- Full PostgreSQL-enabled monorepo gate: 170 files / 1,335 tests, all passed, zero skips.
- Full TypeScript gate: passed with `node node_modules/typescript/bin/tsc -b --force --pretty false`.
- Full production build: passed for all workspaces, desktop main/renderer, and web Vite output.
- `git diff --check`: exit code 0.
- Skip inventory: none; no required or optional tests were skipped.
- Test-count reconciliation: Vitest reported 170 passed files and 1,335 passed tests; no skipped, pending, or failed tests were reported.

### Deferred ForgeGreen requirement

The companion requirement `53A. DEFERRED FORGEGREEN REQUIREMENT — STEER-AWARE EXECUTION HOLD` was executed as a scope constraint, not as an implementation request. CF-16R4 preserved the boundary and did not add composer typing detection, `UserIntentHold` runtime states, scheduler changes, autonomous-dispatch changes, cancellation-semantic changes, or new UI controls. Those invariants are recorded for the immediate post-CF-16 ForgeGreen phase.

### Final Git state and limitations

The worktree remains dirty with the inherited CF-14/CF-15/CF-16 changes plus the certification documentation update. No credentials, temporary probes, or environment-specific PostgreSQL addresses were added to the repository. The local PostgreSQL endpoint is test infrastructure state and is not product configuration.

All strict CF-16R4 conditions were satisfied by executable evidence. The final verdict is:

CF16_PASS
