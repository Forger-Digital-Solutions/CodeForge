# CodeForge Final Windows Release Reliability Audit

## Scope and source

- Starting SHA: `728608472a08f0594526e5390f70d6ea7fb1b86b`
- Final audited source: the local audit commit containing this document (`git rev-parse HEAD`)
- Audit method: hostile clean-source reproduction, native ABI switching, Windows process races, payload inspection, dual installer builds, installed-app smoke, portable smoke, and packaged interruption/recovery

The audit found and corrected six locally controllable weaknesses: ABI-dependent SQLite skipping, an oversized secret-bearing native-build environment, a packaged-smoke wrapper that trusted exit codes without validating fresh evidence, verification-child inheritance of package-manager credentials, a first-run packaged-smoke readiness race, and an assisted per-user NSIS `System.dll` crash. It also corrected SQLite initialization handle cleanup and removed unnecessary build/test content from the packaged payload.

## Contradictions resolved

### SQLite skip

Resolved. The release-critical `better-sqlite3` test executes in the compatible runtime regardless of the last native build. The post-Electron-rebuild full suite passed 55/55 files and 556/556 tests with zero skips.

### NSIS failure

Resolved. The original build failure reproduced as MSBuild reporting that `node` was not recognized while inheriting an extremely long PATH. The same verbose native-build path also exposed unrelated credential variables. The tracked launcher now uses an absolute Node executable, a 2,048-character bounded tool-prioritized PATH, and a strict environment allowlist. A separate runtime defect in the assisted per-user NSIS template also reproduced as a `System.dll` access violation; the release now uses the compatible one-click per-user configuration. NSIS and portable builds passed twice after deleting release output between builds.

## Verification matrix

| Gate | Result |
| --- | --- |
| Fresh `npm ci` | PASS |
| Typecheck | PASS |
| Test files | 55/55 PASS |
| Tests | 556/556 PASS |
| Skipped | 0 |
| Workspace build | PASS |
| Independent web build | PASS |
| Electron native rebuild | PASS |
| Unpacked package | PASS |
| NSIS build, two clean outputs | PASS |
| Silent per-user install | PASS |
| Installed executable full smoke | PASS |
| Silent uninstall | PASS |
| Portable full smoke | PASS |
| Packaged full / interrupt / recover | PASS / PASS / PASS |

## Reliability stress

- Approval exactly-once: 75 mixed approve, deny, cancel, and timeout races; no second approval succeeded.
- Terminal state: completed and failed terminal-state races remained immutable with one terminal emission.
- Concurrency: one workflow per session and 20 global workflows were enforced; cancellation released all slots and a subsequent workflow started.
- Command termination: timeout and cancel settled once; Windows descendants terminated and temporary workspaces unlocked when run with normal OS process privileges.
- Renderer reconstruction: five packaged renderer reloads reached the same completed task without duplicate effects.
- SSE reconstruction: eight sequential replay/reconnect cycles contained one matching terminal event and unique sequence numbers.
- Persistence: WAL, commit, rollback, multi-open read behavior, restart durability, corrupt database failure, and failed-initialization handle cleanup passed.

## Security invariants

- ForgeZero continues to reject paid, locally hosted, unknown-cost, stale-free, offline, quota-exhausted, provider-mismatched, and fallback-enabled candidates.
- Exact model selection does not substitute another provider or model.
- Approval denial, cancellation, expiration, duplicate resolution, and late resolution do not authorize effects.
- Traversal, absolute escape, prefix collision, junction escape, stale hash, and cross-workspace attacks fail closed.
- Provider credentials are filtered from child processes, prompts, persisted sessions/events, tool output, and renderer IPC.
- Packaged safeStorage proves encryption, restart decrypt, corrupt-ciphertext rejection, and absence of plaintext fallback.
- Restart recovery is intentionally non-resumptive: ambiguous work is failed safely, approvals are not replayed, and no stale effect auto-runs.

## Packaged content

Only `node_modules/better-sqlite3/build/Release/better_sqlite3.node` is unpacked. ASAR inspection found the required main, preload, renderer, server/runtime packages, zod, bindings, file-uri-to-path, SQLite binding, and runtime licenses. It found no build tools, integration-test workspace, source maps, TypeScript metadata, Git data, smoke state, or native intermediate output.

## CI coverage

Windows CI now runs clean install, typecheck, workspace build, the full test suite, NSIS plus portable distribution, packaged native persistence, full/interrupt/recover smoke, payload binding verification, and artifact upload. The redundant pre-build native compilation was removed; `dist` owns the single CI native rebuild.

## External limitations

- Live external-provider call: not run; no audit credential was authorized for live inference.
- Windows code signing: not performed; no signing identity was supplied.

Neither limitation changes the deterministic local safety and reproducibility results, but signing should be supplied for public Windows distribution.
