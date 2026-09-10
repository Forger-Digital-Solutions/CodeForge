# CodeForge R6 Certification Report

## 1. Verdict

`CODEFORGE_R6_BLOCKED_CODEX_ALLOWANCE_RESET`

## 2. Repository State

- **Branch**: `feat/codeforge-cloud`
- **HEAD**: `9b40dc26c4b4baf9863da558163af756a8817f0f`
- **Lint**: Passed (0 warnings, 0 errors on 513 files via oxlint)
- **Typecheck**: Passed (`tsc -b --force`, exit code 0)
- **Build**: Passed (all workspace packages built cleanly)
- **Tests**: Full default suite passed (218 test files passed, 5 skipped; 1,683 tests passed, 33 skipped)
- **PostgreSQL**: Real PostgreSQL harness passed (9 test files, 75 tests)
- **Packaged Non-Live Smoke**: Passed across all modes (`full`, `interrupt`, `recover`)

## 3. Continuation Starting Point

This report documents the final closure of all engineering items for the R6 certification run. All inherited work from the R3–R6 lineage (HEAD `9b40dc26c4b4baf9863da558163af756a8817f0f`) has been strictly preserved. No resets, clean operations, or unrelated checkouts were performed.

## 4. Existing R6 Proof Preserved

The following foundational R6 architectural and runtime requirements have been validated and remain green:

- Packaged renderer `modelProviders is not defined` defect repaired
- PostgreSQL harness and real PostgreSQL suites passed
- Live Codex previously emitted `item/tool/call` for `codeforge.write_file`
- CodeForge entered `waiting_for_approval`
- Approval correlation, acceptance, denial, cancellation, deduplication, and invalid-decision hardening passed
- Duplicate approval projection fixed via ID-based deduplication
- Exact Codex pin exhaustion no longer falls through to automatic routing
- Automatic ForgeZero/8-Bit failover semantics preserved
- Renderer Codex state hydration uses narrow authoritative subscription
- Packaged picker certification correctly treats Codex row as `role="option"`

## 5. Packaged Smoke Evidence Root Cause

In prior runs, packaged smoke execution exited without producing the expected smoke evidence because:

1. **User-Data Directory Scoping in Single-Instance Guard**: `installSingleInstanceGuard` uses Electron's `app.requestSingleInstanceLock()`. Electron binds that lock to the effective `userData` directory. Because `app.setPath("userData", ...)` was not invoked at the very top of `main.ts` prior to the single-instance guard, the lock evaluated against the default system user profile (`%APPDATA%\CodeForge`) rather than the isolated `smokeProfile` supplied via `CODEFORGE_USER_DATA_DIR`. Any existing lock in the system profile caused second-instance termination (`app.quit()`), exiting before reaching `startPrimaryInstance()`.
2. **Artifact Packaging Synchronization**: TypeScript changes in `src/main.ts` require compiling to `dist/main.js` and repackaging into `app.asar` via `electron-builder`. Previous diagnostics were evaluated against an un-repackaged binary prior to full rebuilding.

## 6. Packaged Smoke Fix

1. **Top-Level Profile Override**: Positioned `app.setPath("userData", process.env.CODEFORGE_USER_DATA_DIR)` at the earliest entrypoint in `apps/desktop/src/main.ts`, before `installSingleInstanceGuard` is called, ensuring that each smoke profile acquires its own isolated lock.
2. **Durable Synchronous File-Based Evidence Channel**: Main process records lifecycle markers via synchronous file appends (`fs.appendFileSync`) to the file specified by `CODEFORGE_SMOKE_OUT` (`smoke-result.log`), eliminating stdout/stderr stream buffering races and event loop teardown truncation.
3. **Noisy Diagnostic Clean-Up**: Removed temporary debugging appends while preserving deterministic milestone markers (`WHEN_READY_*`, `smoke_mode`, `smoke_run_id`, `packaged_*`, etc.).
4. **Clean Fresh Packaging**: Recompiled desktop main, renderer, rebuilt native `better-sqlite3`, and generated a fresh `win-unpacked` distribution at `apps/desktop/release/win-unpacked/CodeForge.exe` and `resources/app.asar`.

## 7. Smoke Evidence Integrity

- **Run ID Correlation**: Each smoke invocation generates a cryptographic UUID (`runId = randomUUID()`) passed via `CODEFORGE_SMOKE_RUN_ID`. The harness asserts that `currentRunEvidence` contains `smoke_run_id=${runId}`.
- **Stale Result Rejection**: `packaged-smoke.js` records the `startingSize` of `smokeOut` before process spawn and parses only bytes written subsequent to `startingSize`, guaranteeing that evidence from prior runs cannot produce a false PASS.
- **Leakage Prevention**: Harness asserts that dynamic secrets (e.g., `testSecret`) never appear in output evidence.
- **Screenshots**: High-resolution sanitized screenshots are captured during smoke execution (`apps/desktop/release/codeforge-r6-model-picker.png`).

## 8. Codex Executable Discovery

`CodexAppServerProcess` in `packages/providers/src/codex-app-server-process.ts`:

- Explicit executable paths (`CODEFORGE_CODEX_EXECUTABLE` or constructor option) are authoritative.
- Windows npm package resolution checks standard directories:
  - `%LOCALAPPDATA%\npm\node_modules\@openai\codex\bin\`
  - `%APPDATA%\npm\node_modules\@openai\codex\bin\`
  - `%ProgramFiles%\nodejs\node_modules\@openai\codex\bin\`
  - `%ProgramFiles(x86)%\nodejs\node_modules\@openai\codex\bin\`
- Distinguishes native executables (`.exe`) from Node scripts (`.js`, `.mjs`, `.cjs`).
- When a Node script is detected on Windows, invokes via `process.execPath` (Node) with the script path as the initial argument:
  ```typescript
  const actualExecutable = isNodeScript(this.executable) ? process.execPath : this.executable;
  const actualArgs = isNodeScript(this.executable) ? [this.executable, ...this.args] : this.args;
  ```
- Missing executable reports `EXECUTABLE_NOT_FOUND` with non-retryable status when explicitly configured.

## 9. Codex Error Classification

Codex transport errors are classified cleanly by `CodexTransportError` with codes:

- `EXECUTABLE_NOT_FOUND`: Executable does not exist at spawn time
- `SPAWN_FAILED`: Process spawn failed
- `STARTUP_TIMEOUT`: App-server did not initialize within timeout
- `REQUEST_TIMEOUT`: Individual request timed out
- `MALFORMED_FRAME`: JSONL frame could not be parsed
- `PROCESS_EXITED`: Child process exited unexpectedly
- `UNSUPPORTED_METHOD`: Client attempted to call a disallowed method

All errors pass through `redactSecrets` before exposure.

## 10. Packaged Desktop Smoke Results

Executed against fresh packaged artifact (`G:\CodeForge\apps\desktop\release\win-unpacked\CodeForge.exe`):

1. **Full Smoke** (`node apps/desktop/scripts/packaged-smoke.js full`):
   - Exit code: 0
   - Evidence: `PACKAGED_FULL_SMOKE_OK`
   - Verified: Electron initialized, renderer loaded, welcome screen, provider setup UI, workspace tree restored, substantial repository indexing (258 files, 259 symbols), repository search query, workflow repair loop, 5x renderer reload rehydration, encrypted credential round-trip, model picker mouse/keyboard navigation and responsiveness.
2. **Interruption Smoke** (`node apps/desktop/scripts/packaged-smoke.js interrupt`):
   - Exit code: 73 (expected intentional restart exit code)
   - Evidence: `PACKAGED_INTERRUPT_EXPECTED_EXIT`, `electron_restart_interruption_ready=PASS`
   - Verified: Workflow started, pending approval generated, process cleanly interrupted.
3. **Recovery Smoke** (`node apps/desktop/scripts/packaged-smoke.js recover`):
   - Exit code: 0
   - Evidence: `PACKAGED_RECOVERY_SMOKE_OK`, `electron_restart_replan_required=PASS`, `electron_restart_no_approval_replay=PASS`
   - Verified: Interrupted session hydrated in `recovering` state, pending approval invalidated and rejected on replay, encrypted credentials decrypted across restart, fresh task executed to completion.

## 11. Codex Account / Allowance State

Authoritative query via `scripts/r6-codex-account-login.mjs`:

```json
{
  "authenticated": true,
  "existingSession": true,
  "authMode": "chatgpt",
  "planType": "plus",
  "allowanceState": "allowance_exhausted",
  "rateLimitWindows": 2
}
```

- **Authentication**: Valid active session under ChatGPT Plus.
- **Capacity**: Allowance is genuinely exhausted on the external provider account.
- **Safety Policy**: Under CodeForge zero-billing rules, no paid fallback or artificial bypass is permitted.

## 12. Live Exact Codex Turn

Validated in prior R6 lineage; pending live re-run upon provider allowance reset.

## 13. Live Tool Request

Validated in prior R6 lineage; dynamic tool calling (`item/tool/call`) confirmed with `codeforge.write_file`.

## 14. Graphical Approval

Validated in prior R6 lineage and unit/integration suites (`codex-approval-bridge.test.ts`).

## 15. Exactly-Once Tool Execution

Validated in prior R6 lineage with ID-based approval deduplication.

## 16. Same-Profile Restart

Validated in packaged desktop smoke tests (`interrupt` and `recover` modes).

## 17. Logout

Validated in prior R6 lineage and `codex-account.test.ts`.

## 18. Exact-Pin Rejection

Validated in `eight-bit-restart-and-exact-pin.test.ts` and `model-selection-boundary.test.ts`.

## 19. Automatic Routing Regression

Preserved and validated in router determinism suites.

## 20. Billing Safety

ForgeZero zero-billing firewall is active. No paid API fallback or local LLM inference is permitted. All completions pass through `evaluateCompletion` in `packages/workflow/src/completion-gate.ts`.

## 21. Process Cleanup

All owned processes cleanly terminated. No orphan background tasks or processes remain. Stray diagnostics (`2124`, `2132`, `r6-diag-codex-auth.mjs`) removed.

## 22. PostgreSQL Certification

Real PostgreSQL test harness results (`scripts/postgres-test-harness.mjs` against WSL Ubuntu PostgreSQL `127.0.0.1:5432/codeforge_test_db`):

```
Test Files: 9 passed (9)
Tests: 75 passed (75)
Duration: 7.73s
```

Harness suites:
- `packages/eight-bit/test/postgres.test.ts` (2 tests)
- `packages/cloud-db/test/postgres.test.ts` (6 tests)
- `packages/cloud-db/test/publication-lease.test.ts` (2 tests)
- `packages/cloud-db/test/parity.test.ts` (30 tests)
- `tests/fg1-postgres-ledger.test.ts` (1 test)
- `tests/cloud-postgres-adversarial.test.ts` (14 tests)
- `packages/server/test/cf17-pg-restart-e2e.test.ts` (1 test)
- `tests/two-client-authority.test.ts` (12 tests)
- `tests/migration-namespace-collision.test.ts` (7 tests)

## 23. SQLite Diagnostic

`node:sqlite` on Node >= 22.5 with transparent fallback to `better-sqlite3` on earlier runtimes. Native bindings successfully rebuilt for Electron 33.4.11.

## 24. Security / Privacy Audit

- No hardcoded user paths in executable resolution.
- No access tokens, refresh tokens, or auth URLs in outputs or logs.
- Secrets redacted via `redactSecrets`.
- Host-owned capability-shaped IPC prevents renderer privilege escalation.
- Child process environment explicitly scrubbed of `OPENAI_API_KEY`, `CODEFORGE_OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_OPENAI_API_KEY`.

## 25. Focused Tests

Focused R6 test suite results:
```
Test Files: 8 passed (8)
Tests: 77 passed (77)
```
- `packages/providers/test/codex-app-server-process.test.ts` (14 tests)
- `packages/providers/test/codex-account.test.ts` (11 tests)
- `packages/server/test/codex-approval-bridge.test.ts` (4 tests)
- `packages/server/test/model-selection-boundary.test.ts` (8 tests)
- `packages/server/test/eight-bit-restart-and-exact-pin.test.ts` (2 tests)
- `packages/ui/test/model-selector.test.tsx` (16 tests)
- `apps/desktop/test/preload-bridge.test.ts` (6 tests)
- `apps/desktop/test/application.test.ts` (16 tests)

## 26. Full Tests

Full default test suite results:
```
Test Files: 218 passed | 5 skipped (223 total)
Tests: 1683 passed | 33 skipped (1716 total)
Duration: 169.65s
Exit code: 0
```

## 27. Packaging

- **Electron**: 33.4.11
- **Electron Builder**: 25.1.8
- **Packaged Executable**: `G:\CodeForge\apps\desktop\release\win-unpacked\CodeForge.exe`
- **Resource Archive**: `G:\CodeForge\apps\desktop\release\win-unpacked\resources\app.asar`
- **ASAR Integrity**: Verified (`dist/main.js` hash matches archive metadata)
- **Packaged Smoke**: `full` (PASS), `interrupt` (PASS), `recover` (PASS)

## 28. Repository Hygiene

- `git diff --check` passed cleanly (no whitespace errors).
- All changes scoped to certification and fix requirements.
- No unstaged extraneous or diagnostic artifacts.

## 29. Files Changed in this Continuation

- `apps/desktop/src/main.ts`: Configured top-level `userData` override before single instance lock; removed noisy temporary logging.
- `package.json`: Restored `lint` script and `oxlint` devDependency.
- `packages/providers/src/codex-app-server-process.ts`: Removed unused `dirname` import.
- `packages/providers/test/codex-app-server-process.test.ts`: Updated platform fallback test to accept Node script spawn invocation.
- `docs/r6-certification-report.md`: Updated with packaged smoke root cause, fix, and final test results.

## 30. Certification Matrix

| Gate | Status | Notes |
|------|--------|-------|
| Repository lint | ✅ PASS | 0 warnings, 0 errors on 513 files |
| Full typecheck | ✅ PASS | Exit code 0 (`tsc -b --force`) |
| Full build | ✅ PASS | All workspaces built cleanly |
| Focused R6 tests | ✅ PASS | 8 files, 77 tests |
| Full default test suite | ✅ PASS | 218 files, 1683 tests |
| Real PostgreSQL harness | ✅ PASS | 9 files, 75 tests |
| Desktop packaging | ✅ PASS | Fresh unpacked artifact produced |
| Packaged non-live smoke | ✅ PASS | `full`, `interrupt`, `recover` all passed |
| Codex executable resolution | ✅ PASS | Node script & native executable resolution verified |
| Codex error classification | ✅ PASS | All error codes verified |
| Security / privacy audit | ✅ PASS | No tokens, hardcoded paths, or credentials leaked |
| Codex allowance check | ⚠️ BLOCKED | Authoritative state: `allowance_exhausted` |
| Live packaged Codex sequence | ⚠️ BLOCKED | Blocked solely by external provider allowance |

## 31. Remaining Work

- Rerun the final authenticated live Codex approval/restart/logout certification sequence once account allowance is available.

## 32. Recommended Next Milestone

`CODEFORGE_UI_AUTH_UPGRADE_R1` (pending final live allowance rerun sequence).
