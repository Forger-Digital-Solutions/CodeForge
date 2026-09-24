# CodeForge R30 release unblocking certification — 2026-09-24

**Verdict: `CODEFORGE_R30_RELEASE_BLOCKED`.** R30 produced one independently verified substantial autonomous coding completion, repaired inherited source-state regression drift, and built and smoked a fresh production-endpoint desktop package. The mandatory release gates are not all met. In particular, large-task reliability was 1/8, the exact R30 package has no authenticated real coding task, the binaries are unsigned, and endurance, penetration, lifecycle, and second-hardware proof remain incomplete.

## Source and inheritance

R30 began from clean `96b7f21ef87e4f8ca886b0e886d25295c2b88526` on `codex/r29-release-closure`. The R29 release verdict remains `CODEFORGE_R29_RELEASE_BLOCKED`. Its frozen evidence verified 38/38 files; retained R28 evidence verified 52/52. The [read-only inherited check](../evidence/r30-release-unblocking/00-recovery/inherited-evidence.json) avoided changing either historical freeze. The fresh release package identifies product source commit `999d41683da9b6eb5fa2059e28f46f8b1d3dc576`, version 0.4.0, and `dirty=false`. Evidence and this certification are committed separately after the product build. No remote push was authorized or performed.

Current test host: Windows NT 10.0.26200.0, x64, Intel i7-9850H, 12 logical processors, 34,060,460,032 bytes RAM, Node v24.19.0. GPU telemetry was unavailable. See [host receipt](../evidence/r30-release-unblocking/09-second-hardware/current-host.json).

## Release-blocker matrix

| Gate | R29 | R30 result | Evidence and remaining boundary |
| --- | --- | --- | --- |
| A. Large real coding tasks | blocked | **blocked** | [Eight-attempt summary](../evidence/r30-release-unblocking/04-large-task-benchmarks/summary.json): 1/8 autonomous and independently correct. Feature/refactor semantics, loop termination, and 429 recovery remain unreliable. |
| B. Full regression | failed | **pass** | Initial 2 source-state drift failures reproduced; guarded recertification and final 459-file full suite recorded in the [regression report](../evidence/r30-release-unblocking/02-regression/report.md). |
| C. Packaged endurance | incomplete | **blocked** | [Short packaged smoke](../evidence/r30-release-unblocking/12-packaged-runtime/report.md) passed; no multi-hour continuous process/resource trend. |
| D. Security/penetration | incomplete | **blocked** | [Security report](../evidence/r30-release-unblocking/07-security/report.md): dependency, claims, and links checks pass; secret scanner review and penetration matrix remain open. |
| E. Install/update lifecycle | incomplete | **blocked** | [Preflight](../evidence/r30-release-unblocking/08-install-lifecycle/preflight.json) found an existing user installation; the isolated installer harness refused to replace it. Upgrade, repair, uninstall, rollback unproven. |
| F. Second hardware | incomplete | **blocked** | Only the current host was available; [second-host procedure](../evidence/r30-release-unblocking/09-second-hardware/report.md) prepared. |
| G. Windows signing | unsigned | **blocked** | All three fresh executables report `NotSigned`; [CI signing gate](../evidence/r30-release-unblocking/10-signing/report.md) prepared but production certificate unavailable. |
| H. Authenticated production runtime | R29 pass | **blocked for R30 artifact** | R29's older package performed a real task. Fresh R30 artifact passed three smoke modes but has no real authenticated coding receipt. |
| I. Performance/resource stability | partial | **incomplete** | One large task took 405,402 ms and the packaged smoke remained responsive; no endurance trend or broad performance comparison. |
| J. Final reproducibility | incomplete | **partial** | Source identity, hashes, receipts, and freeze verifier are retained; unresolved release gates prevent candidate certification. |

## Engineering and task results

The R29 full suite was reproduced at 459 files, 3,625 tests: 3,575 passed, 48 skipped, 2 failed. Both failures were source-state provenance drift following legitimate prior commits. R30 appended guarded source-state lineage instead of weakening assertions. The final R30 suite passed 3,577, skipped 48 environment-dependent tests (47 real PostgreSQL, one Python verifier), and failed zero. A general rename safeguard now tells the implementation agent to keep public CLI flags, wire keys, and persisted identifiers stable unless the task requests a public change. The frozen large-repository rename task first failed 8/9 hidden checks by changing `--max-retries`; after the safeguard, a new zero-intervention run passed workflow completion and all 9/9 hidden checks. It used the verified-free OpenRouter Nemotron 3 Super route, 28 model requests, 23 tool calls, 154,580 measured input tokens, 15,641 output tokens, and 405,402 ms. Four requests had unavailable token usage. All eight attempts, including infrastructure and provider failures, remain counted. [Failure analysis](../evidence/r30-release-unblocking/03-large-task-analysis/report.md) gives exact causes and measurement limits. The suite does not prove subagent topology benefits or hosted admission behavior.

The release wrapper now builds before staging a production Cloud endpoint under ignored `dist/`, leaving tracked source unchanged. The packaged main process resolves that manifest from its compiled directory. This fixed a real package audit failure found in the first build. A signed-tag CI path requires production signing credentials and checks Authenticode and timestamps before upload. The negative check rejected unsigned binaries. No production signing certificate was available.

## Fresh package and runtime

The fresh package was built from `999d416` with a production HTTPS endpoint and clean embedded build identity. Internal/runtime dependency audits, strict identity audit, production auth endpoint audit, and packaged browser security audit passed. The [raw packaged smoke](../evidence/r30-release-unblocking/12-packaged-runtime/smoke/smoke-result.txt) and [runtime report](../evidence/r30-release-unblocking/12-packaged-runtime/report.md) record `full`, `interrupt`, and `recover` passing against the new unpacked executable. The smoke uses a test provider. It does not prove the desktop UI → real authentication → free provider → code edit → verification → persistence path on this exact artifact. R29's genuine task result remains inherited historical evidence only.

| Fresh artifact | Bytes | SHA-256 | Authenticode |
| --- | ---: | --- | --- |
| `win-unpacked/resources/app.asar` | 45,564,776 | `768b6557819dd527f50dcb3e3e12c09adfcd0f586cd2db19a04e3279986777bd` | n/a |
| `win-unpacked/CodeForge.exe` | 246,415,872 | `404225edd63ca1cc0372272d1ecf5086def9e22183c5c44d02c38831718194cc` | NotSigned |
| `CodeForge-Setup-0.4.0.exe` | 120,823,725 | `6ae47b2e42dc165940ac6127f1ef238b56aee5de095dedf0fa7c9d529a88223b` | NotSigned |
| `CodeForge-Portable.exe` | 120,488,313 | `3c0931c6211193c4bd87edb6396b0c42b70a02808cd4ac0ab9cf9604af6e664f` | NotSigned |

The [artifact receipt](../evidence/r30-release-unblocking/14-release-artifacts/artifacts.json) records full source identity and hashes. No install-to-archive match was observed because installation did not run. No DPI, multi-monitor, second-machine, or multi-hour packaged endurance claim is made.

## Security and lifecycle limits

The canonical tests and package smoke covered several Electron, credential, and IPC controls, but the requested manual penetration matrix was not executed. A pattern scanner's ten owner-review findings occur in R28 test fixtures and were triaged by source context; the scanner still reports review required. No real credential validity was tested. No verified release-critical vulnerability is claimed, and absence of such a vulnerability is not certified.

An existing per-user CodeForge 0.4.0 installation was present on this machine. The isolated lifecycle harness stopped before setup or uninstall, preserving that installation. A clean account or separate host, earlier-version installer, seeded user state, and controlled update failure are required to complete the lifecycle matrix. The release-consumer GitHub workflow exists but was not run on these unpublished R30 bytes.

## Decision and reproduction

Do not distribute this as a release candidate. Continue with reproducible feature/refactor/failure-recovery tasks until reliability is defensible; execute a real authenticated coding task with this exact package; perform long-running packaged telemetry and authorized penetration tests; prove clean install/upgrade/repair/update recovery on another Windows environment; and sign, timestamp, and inspect the final binaries with a real production certificate. Rebuild and refreeze hashes after any code or signing change. The [R30 evidence freeze](../evidence/r30-release-unblocking/R30-EVIDENCE-FREEZE.json) binds the receipts and artifacts for this blocked decision.
