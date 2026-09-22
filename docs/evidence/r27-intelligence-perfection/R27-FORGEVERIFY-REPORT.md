# R27 ForgeVerify Report: Windows Timeout Lifecycle & Process Tree Cleanup

Status: `R27_FORGEVERIFY_WINDOWS_TIMEOUT_LIFECYCLE_PROVEN`

## Overview & Defect Identification

During R27 adversarial verification on Windows, an in-flight failure was identified:
ForgeVerify executed verifier commands inside isolated temporary workspaces (`mkdtemp`). When a verifier timed out, the Windows terminal executor invoked `taskkill /T /F` on the child process tree and resolved the execution promise after a hardcoded 250ms timer.

Because Windows file handle release and process termination across grandchildren is asynchronous, the child process or its descendants still held open stdio/file handles when the test runner's `afterEach` hook executed `fs.rmSync(workspace, { recursive: true, force: true })`. This resulted in `EPERM: operation not permitted` workspace removal failures.

Additionally, a state-mutation race condition existed where an `abort` signal could initiate cancellation, but if process teardown took longer than the remaining timeout window, the timeout timer would subsequently fire and overwrite the exit status to `timed_out: true` (exit code 124) instead of `cancelled: true` (exit code 130).

## Root Cause Analysis

1. **Premature Settlement**: Resolving after 250ms rather than awaiting the process `'close'` event allowed execution control to return while process handles were still active in the kernel.
2. **Handle Release Timing**: In Node.js, the `'close'` event on `ChildProcess` is specifically emitted after both the process has exited AND all stdio streams have closed, guaranteeing that file descriptors and stdio pipes are closed.
3. **Timer Teardown Gaps**: In `executeViaPipe` and `executeViaConpty`, the `timeoutMs` timer was not cancelled immediately upon entering `stop()`, allowing a pending timeout callback to execute during an abort teardown.
4. **Pre-aborted Signals**: `spec.signal` did not check `spec.signal.aborted` at entry, meaning already-aborted signals would not trigger cancellation if no subsequent `'abort'` event was dispatched.

## Source Fix (`packages/terminal/src/executor.ts`)

The executor was updated across both `executeViaPipe` and `executeViaConpty` engines:

1. **Child Close Settlement**: Settle primarily on the child process `'close'` event. When `taskkill /T /F` terminates the tree, `'close'` fires as soon as the OS releases stdio pipes and child termination completes.
2. **Bounded Fallback**: A bounded grace period timer (`PROCESS_TREE_SETTLE_GRACE_MS = 2_000`) prevents indefinite hangs in the event that a broken child or external driver prevents `'close'` from firing.
3. **Timer Cancellation**: In `stop()`, `clearTimeout(timer)` is executed immediately to eliminate abort/timeout races.
4. **Reentrancy & Exactly-Once Settlement**: Both `settled` and `terminationStarted` flags prevent double-invocation of process-tree termination or double-settlement of the return promise.
5. **Pre-aborted Signal Guard**: Handled `signal.aborted === true` on initialization for zero-latency cancellation.
6. **Cross-Platform Compatibility**: Maintained `process.kill(-pid, "SIGKILL")` group killing on POSIX systems while ensuring Windows `taskkill.exe /pid <pid> /T /F` completes cleanly.

## Empirical Validation Results

### 1. Terminal Executor & Regression Suite (`packages/terminal/test/terminal.test.ts`)
- **29 / 29 tests passed (100% green)**
- Dedicated R27 tests added:
  - `timeout → process tree terminated → close observed or bounded fallback → workspace removable (pipe)`: **PASS** (399ms)
  - `10 consecutive timeout executions: 0 EPERM, 0 leaked child processes, 0 double settlements`: **PASS** (2999ms)
    - 10 iterations executed
    - 0 EPERM errors
    - 0 leaked child processes
    - 10/10 correct exit code 124 and `timedOut: true`
  - `cancellation with abort signal does not race with timeout timer`: **PASS**
  - `already-aborted signal cancels immediately without spawning child`: **PASS**

### 2. Full ForgeVerify Test Suite (`packages/workflow/test/`)
- **70 / 70 tests passed (6 test files)**
  - `forge-verify-evidence.test.ts`: 5/5 passed
  - `forge-verify.test.ts`: 6/6 passed
  - `r21-forgeverify-integrity.test.ts`: 7/7 passed
  - `verification-service.test.ts`: 17/17 passed (including `reports timeout deterministically and terminates descendants`)
  - `r21-forgeverify-stale-evidence-matrix.test.ts`: 11/11 passed
  - `r21-forgeverify-malicious-corpus.test.ts`: 24/24 passed (including hung verifier `[timeout]` with immediate `afterEach` directory removal)

## Documented Boundaries & Residual Risk

1. **Outside-Workspace Files**: Files located outside the target repository root are not hashed into `inputStateHash`. This is a documented architectural boundary; ForgeVerify certifies workspace content.
2. **Gitignored Content**: Content ignored by `.gitignore` (e.g. `node_modules`, cache files) does not alter `inputStateHash`. Dependency state is locked via the tracked package lockfile.
3. **Repository Authority**: The repository's declared verification command remains the authority on what constitutes verification. ForgeVerify detects empty test runner outputs, contradictory exit codes, and forged summary strings, but does not dictate test framework implementation.
