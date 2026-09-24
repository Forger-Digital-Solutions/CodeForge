# CodeForge R29 release closure certification — 2026-09-23

## Verdict

`CODEFORGE_R29_RELEASE_BLOCKED`

R29 established a real authenticated packaged-desktop completion and corrected several runtime and release defects. It did **not** establish dependable large-task autonomy, multi-hour endurance, hostile packaged boundary resistance, second-hardware behavior, full install/update/uninstall lifecycle, or signed distribution. The canonical test suite also remains red against an earlier frozen ForgeGreen source state. Broader user release is therefore not certified.

## Source and environment

- Repository: `G:\CodeForge`, branch `codex/r29-release-closure`; R28 starting commit `397263782a764e9378167addbc5f9e4ad097868a`.
- R29 packaged source commit: `0dbca660ba721b7cde5bcd6bd6d7cbbb01e600f7`; version `0.4.0`; Windows 11 `10.0.26200`, x64, Intel Core i7-9850H, 12 logical processors, 32 GiB RAM. Only this host was available.
- Production-channel package identity reports `dirty=true` because the release wrapper temporarily stamps tracked `cloud-endpoints.json` to the production endpoint during build. The repository was clean immediately before that build. The strict `--require-clean` identity audit fails; this release pipeline limitation remains open. The archive, installer, portable executable, and unpacked executable hashes and Authenticode results are in `docs/evidence/r29-release-closure/23-update-install-uninstall/package-artifacts.json`.
- R28 frozen evidence rechecked **52/52** hashes and byte counts with zero mismatches. The R28 freeze and older certification were retained unchanged.

## Core findings

| Area | R29 result | Evidence and limit |
| --- | --- | --- |
| Large-task autonomy | **Blocked** | R28's three locked runs and both R29 attempts failed the independent hidden verifier. The first R29 run made seven real source edits in 451,482 ms, passed only the visible syntax check, and ended with four plan steps unfinished. The second hit three provider-network errors before editing. A meaningful multi-task battery did not complete. See `03-large-task-analysis/` and `05-large-task-benchmarks/`. |
| Progress authority | **Improved, focused tests pass** | Byte-identical tool and direct edits now return `TOOL_NO_EFFECT`; repeated attempts trigger reread/replan feedback and terminal no-progress blocking. Same-line replacements no longer appear as `+0/-0`. The completion gate was not relaxed. A live semantic improvement is not yet demonstrated. |
| Packaged auth and dogfood | **Verified for one real task** | The user completed first-run GitHub sign-in. An earlier R29 production-channel package, using real Electron renderer/preload/main and CodeForge Cloud, changed `src/add.mjs`, ran `npm test`, reached 11/11 workflow stages and gate `completed`, and passed six independent hidden cases. A later final package restored the authenticated account, task, and saved GPT-OSS 120B model. One intervening launch required the user to sign in again; the cause was not isolated. See `06-packaged-auth/` and `07-packaged-dogfood/`. |
| Desktop UI truth | **Material fixes verified** | The model picker now resolves canonical models for its label, posts selection to the actual new task session, and reloads saved settings after the runtime endpoint appears. Final packaged UI showed the saved GPT-OSS 120B choice. Session routing was proven by the earlier dogfood run; the final package was not asked to repeat the coding task. |
| Packaged smoke | **Pass outside command sandbox** | Final package passed `full`, `interrupt`, and `recover`. Full smoke included renderer lifecycle, control-plane bearer isolation and forged-request rejection, settings, extension lifecycle, updater guards, repository indexing, and workflow markers. The same harness failed renderer launch inside the command sandbox; that environment limitation is retained in the record. See `08-ipc-security/packaged-smoke-receipt.json`. |
| Packaged security | **Limited** | Browser archive settings audit and 95 focused source security tests passed. The packaged smoke exercised selected IPC boundaries, but no broad hostile-renderer fuzz campaign, path/junction escape matrix, or high-risk Computer Use penetration was completed. Secret scan returned `REVIEW_REQUIRED` with ten owner-review findings in preserved R28 fixtures. |
| MCP and extensions | **Limited** | Source tests passed; packaged smoke proved a cooperative extension's load/command/read/lifecycle. Hostile packaged MCP servers and realistic extension VM escape attempts remain unproven. Extensions run in Node `vm` in the app process and are not certified as a hardened boundary for hostile third-party code. |
| Diagnostics export | **Verified success path, limited** | Final packaged Settings exported a 20,528-byte support bundle with 52 log entries and visible success state. Read-only inspection found no raw credential or bearer patterns. The live profile had no planted secret, and cancellation/failure/temp-cleanup paths were not exercised. See `12-diagnostics-export/`. |
| Endurance and crash recovery | **Unproven at target duration** | No multi-hour unattended R29 run. Packaged interrupt/recover smoke passed, but active real-task crash and restart recovery was not measured. |
| Free routing and failover | **Fail-closed observed, failover unproven** | Initial ForgeAuto attempt refused when 47 verified records yielded zero healthy qualified routes; it made no edits. A later qualified Groq GPT-OSS route completed dogfood after a free-capacity wait. No second eligible same-model direct free provider path was available, so real cross-provider failover was not claimed. No paid or local inference was used. |
| 8-Bit, ForgeGreen, Planner, subagents | **Expanded R29 proof incomplete** | Route admission was observed live; the requested rotation, matched task-set efficiency, planner battery, and adaptive topology battery were not completed. R28 evidence remains the baseline only. |
| Tools, GitHub, memory, performance | **Expanded R29 proof incomplete** | Cross-tool autonomous tasks, the authorized disposable GitHub loop, long-context retrieval/isolation, and new performance comparisons were not completed. The R28 disposable GitHub repository cleanup gap remains. |
| Second hardware | **Blocked by unavailable host** | No materially different Windows machine was available; no comparative install, cold-start, RAM, or task measurements exist. |
| Install/update/uninstall | **Limited** | Production package and runtime dependency audits passed, including a newly caught and fixed missing `electron-updater` dependency. Smoke exercised updater status/check/install guards and credential recovery. A version A→B update, install/uninstall/reinstall, data-preservation path, and rollback were not exercised. |
| Signing | **Blocked** | Windows Authenticode reported `NotSigned` for NSIS installer, portable executable, and unpacked `CodeForge.exe`. Builder signing log lines were not counted as signatures. No trusted release signing identity was available. |

## Large-task benchmark attempts

Both R29 attempts used the same `r27-large-config-rename` fixture through the verified-free OpenRouter `nvidia/nemotron-3-super-120b-a12b:free` route. They are diagnostic attempts, not a multi-task battery.

| Run | Requests | Real edits | Wall time | Hidden verifier | Completion |
| --- | ---: | ---: | ---: | --- | --- |
| `3186b00c` | 30 | 7 files, each +1/-1 | 451,482 ms | Fail | Blocked; four plan steps unfinished |
| `d6e1dd92` | 4 | 0 | 67,294 ms | Fail | Blocked after three provider errors; four plan steps unfinished |

The first attempt's visible syntax check passed while its hidden semantic verifier failed. The R28 comparison includes three preserved blocked large-task runs; no R29 attempt establishes a higher completion ceiling. The source receipts are in `05-large-task-benchmarks/`.

## Endurance measurement

The one authenticated packaged dogfood session ran from `19:31:42.561Z` to `19:32:53.154Z` (70.593 seconds), including a roughly 60-second free-capacity wait. No R29 multi-hour soak, repeated task sequence, resource slope, or active-task crash recovery measurement was completed. The `full`, `interrupt`, and `recover` packaged smoke modes are functional checks only.

## Regression and release gate

The first full Vitest run completed 459 files and 3,625 tests: 447 files passed, eight skipped, four failed; 3,573 tests passed, 48 skipped, four failed. Two timing-sensitive failures passed in an isolated rerun. A second default full-suite attempt after the final settings fix was stopped after pervasive timeouts in concurrently running heavy suites; it is not counted as a pass. Seven affected files and 42 tests passed when rerun without other heavy suites. Two ForgeGreen campaign tests still reject current R29 source against the frozen Candidate D identity; the historical freeze was not edited to force green. Details are in `28-canonical-regression/report.md`.

R27 golden validation matched the frozen baseline: 13 passes and the same two Python-absent `BLOCKED_ENVIRONMENT` cases. Typecheck and lint passed. Focused UI, runtime, and source security suites passed. The package build, internal/runtime dependency audits, build identity audit, production endpoint audit, and all three outside-sandbox packaged smoke modes passed. None of these narrower passes overrides the red canonical source-state gate.

## Release decision

The product can perform a real authenticated packaged coding task and export a diagnostic bundle on this host with verified-free routing and the completion gate intact. R29 is **not** a release candidate for broader users while the large-task ceiling, incomplete security and endurance proof, untested lifecycle, unavailable second hardware, unsigned artifacts, and canonical source-state drift remain. No production deploy, paid inference, GitHub mutation, or push was performed in R29.

Evidence is under `docs/evidence/r29-release-closure/`; the final SHA-256 manifest freezes the written receipts and this certification after the last regression result is recorded.
