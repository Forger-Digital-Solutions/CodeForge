# CodeForge Free Cloud Platform R5

Status: `CODEFORGE_FREE_CLOUD_PLATFORM_R5_BLOCKED`

## 1. Verdict

`CODEFORGE_FREE_CLOUD_PLATFORM_R5_BLOCKED`

Continuation 2 (2026-09-13, 17:10Z onward) removed the native-UI blocker: the exact packaged candidates are now driven through real Windows mouse/keyboard control (§20). The single remaining blocker is external: `OPENROUTER_DAILY_FREE_REQUEST_CAP_EXHAUSTED` — one probe answered `429 free-models-per-day` with `X-RateLimit-Limit: 50`, `X-RateLimit-Remaining: 0`, reset `2026-09-14T00:00:00Z`, after the earlier attempts in this window consumed the day's allowance. The live packaged coding task runs at the reset through the established native UI control; no API substitute was or will be used.

## 2. Reconciled Starting State

Branch `forger-digital-solutions-forgegreen-certified`; HEAD `18c9f941ffe1961d5a1ca2b525afbb57a9b7af77`; package version `0.3.0`. R5 remains a substantial uncommitted worktree inherited from the prior continuation. Required summary files had not existed at handoff; this document and its JSON companion now record the recovered state without discarding it.

## 3. Inherited R5 Work Verified

The worktree contains the renderer lifecycle markers, the late-bound ephemeral-origin bearer filter, no-route fail-closed runtime behavior, OpenRouter in-band error/finish handling, bounded free-route qualification diagnostics, Windows `windowsHide` git helpers, and Windows test-root/worker isolation. The exact ForgeGreen state is `464343d9548f70b354d4496caa1de8ad5e4373612b8a847f0ef643bdfa36c84e`.

## 4. Flake Repeatability

The historical 11-file Windows integration group passed three consecutive serialized file-level runs, each with all normal assertions and its existing 30-second test timeout retained: 102/102 tests in 203.21 s, 173.45 s, and 173.19 s. The group retains real git, worktree, server, delivery, and workflow behavior; serialization prevents unrelated repository-mutating files from contending in the same instant. Earlier 6-worker evidence, including observed timeout failures, is retained rather than overwritten.

## 5. Application / Package Equivalence

`npm.cmd run build` completed cleanly. A fresh Electron Builder `dist` then produced the exact version-0.3.0 Setup, Portable, and unpacked artifacts at 2026-09-13 12:46–12:47 local time. The normal PowerShell `npm` shim is broken on this host; `npm.cmd` was used and its output is preserved.

## 6. Foreground Host Launch; Renderer Lifecycle; Runtime Ownership; First Paint / Workspace

The exact rebuilt unpacked smoke shows BrowserWindow construction, preload entry and bridge readiness, DOM/load completion, renderer bootstrap/root mount/first frame, workspace root, runtime connection, and workspace interaction. Its runtime bound an owned loopback ephemeral endpoint (`61609` in recovery smoke) and installed the bearer filter only for that endpoint. The renderer never receives the bearer.

## 7. Unpacked, Portable, and Installed Smoke

The exact rebuilt unpacked candidate passed `full`, `interrupt`, and `recover`. Interruption exits with expected code 73; recovery proves no approval replay and a safe blocked terminal recovery path. The previously captured Portable and installed evidence is historical; their equivalent current-candidate UI runs remain part of the single native-UI blocker.

## 8. Settings / Picker UX

Historic R5 screenshots show the canonical picker and Settings. The currently rebuilt package cannot be driven through visible UI here, so its picker cannot be re-attested after current live qualification.

## 9. Current Provider Inventory and Qualification

Authenticated metadata refresh at `2026-09-13T16:49:06.712Z` found 22 verified zero-unit OpenRouter routes, 19 tool-capable candidates, and zero discovery errors. `nvidia/nemotron-3-super-120b-a12b:free` remains genuinely verified-free and a persisted product receipt records all compact tool-call, edit, and structured-output cases passing (`QUALIFIED`). Nemotron's earlier edit probe failed after a successful read and an empty second turn; a later upstream 502 was correctly surfaced as transient rather than mis-scored as model failure. The normal registry captured 19 verified routes, one healthy route, one primary coding model, and `openrouter::nvidia/nemotron-3-super-120b-a12b:free` as `QUALIFIED`.

## 10. ForgeAuto Admission and Packaged Picker

The persisted product registry proves normal admission rather than manually fabricated eligibility: qualification receipt, ForgeZero policy, verified-free route metadata, health, and the Free registry are all present. The current picker visual proof is blocked only because native UI control is unavailable.

## 11. Disposable Repo and Real Coding Task

Prior packaged live-task evidence used an expired-session fixture and was correctly blocked by `evaluateCompletion` for `no_effective_change`; it did not falsely complete. No direct API/harness substitute was run. A fresh packaged UI task through the rebuilt artifact is still mandatory.

## 12. ForgeVerify, Completion, Persisted Response, Recovery

The historical attempted task persisted its final blocked response and completion-gate rationale. The current exact package's recovery smoke passes interruption recovery, no approval replay, credential encryption/restart checks, and safe terminal blocking. A successful real task still needs repository test output, ForgeVerify, authoritative completion, and persisted final response.

## 13. Free vs Paid and Credential Security

Discovery and bounded qualification use only OpenRouter routes whose registry metadata is `verified_free`/`:free`; paid routes remain excluded by ForgeZero. The rebuilt archive audit passes sandbox, disabled Node integration, context isolation, web security, endpoint-scoped bearer injection, and bearer-free preload. Existing R5 evidence leak scan is `PASS_NO_MATCHES`; no credential value was printed by this continuation.

## 14. Focused Tests and Final Full Suite

The saved final R5 full suite is clean: 318 passed test files, 7 skipped; 2,370 passed tests, 36 skipped; zero failed; 369.58 seconds. The current root build also passed after the inherited R5 source was rebuilt.

## 15. ForgeGreen State

The guarded source-state record is valid at `464343d9548f70b354d4496caa1de8ad5e4373612b8a847f0ef643bdfa36c84e`. Its R5 recertifications cover the no-eligible-route fail-closed behavior and hidden git console-window correction. No hand-authored state hash was introduced.

## 16. Packaged Candidate and Security Audit

| Artifact | SHA-256 | Bytes |
| --- | --- | ---: |
| `CodeForge-Setup-0.3.0.exe` | `B10D5161D9524D0EF11F2E657FC13C210804360A04B328B98F5A38CE7C109D7C` | 85,948,057 |
| `CodeForge-Portable.exe` | `7E011228A8AD5B4905F517B6C598FD2DA26E9A6E738708FB5AB940D830696DF1` | 85,677,306 |
| `win-unpacked/CodeForge.exe` | `AFDC8E7EE6BC787DEAACBD8B84522B646A0915D6801FC836D8831D53189F949C` | 188,875,264 |
| `win-unpacked/resources/app.asar` | `3D8ADDF452E8C2754F820A28F4D558FB722EF1CD0AA6608D14B65B28E663E0FC` | 23,092,906 |

The rebuilt package passes browser-security, runtime-dependency (243 packaged modules / 15 external packages), and stamped development/smoke endpoint audits.

## 20. Continuation 2 — Native Windows UI Control (2026-09-13)

Mechanism: the session's computer-use toolkit (native mouse/keyboard/screenshot) granted at tier "full" for the unpacked, Portable (temp-extracted) and installed executables. Evidence PNGs are DPI-aware desktop captures (`native-ui/capture-window.ps1`, 3500×2040 px at 250 % scale); process proof via `foreground/capture-process-context.ps1`. No remote-debugging port and no CDP were used for any certification flow (a separate diagnostic instance served only read-only accessibility audits).

| Gate | Result | Evidence (`apps/desktop/release/r5-evidence/native-ui/`) |
| --- | --- | --- |
| Unpacked candidate launches in interactive session 1 with a real top-level window; renderer lifecycle complete in ~2 s; owned ephemeral runtime (127.0.0.1:53986) | PASS | `picker/process-context-unpacked-probe.json`, `unpacked-probe.log` |
| Packaged picker shows `nvidia/nemotron-3-super-120b-a12b` exactly once: Free · Ready · Recommended; 8-Bit qualification "qualified"; ForgeAuto/Free "Eligible"; routes (2): OpenRouter free api / Environment / Healthy / ForgeAuto eligible, Cloudflare not connected; no paid requirement; no probation label | PASS | `picker/01-nemotron-detail-qualified-eligible.png`, `picker/02-picker-scrolled-connect-and-gems.png` |
| ForgeAuto admission through production Settings: default ForgeAuto/Free; Routing Healthy; Fallback enabled ("Paid models are never a fallback"); 19 verified routes · 1 qualified primary coding agent · 0 cooling down · 16 awaiting qualification | PASS | `picker/03-settings-models-routing-forgeauto-admission.png` |
| Portable candidate, fresh isolated profile (dev-cloud sign-in seeded): launch → first-run chooser → native Select Project Folder → workspace (master, clean tree, index 3 files/2 symbols) → picker (truthful "Qualifying free models… · No route", no receipts yet) → Settings › Provider Connections (`OPENROUTER_API_KEY · Detected in environment · In use`; value never shown) → native composer typing → close (clean quit) → relaunch restores the workspace | PASS | `portable/01…06-*.png`, `portable/process-context*.json` |
| Installed candidate (Setup 0.3.0 registered per-user; `CodeForge.exe`/`app.asar` hashes identical to the unpacked candidate; fresh isolated profile): launch → chooser → project open → workspace → picker → Settings › About ("Running from an installed package", Electron 33.4.11 / Node 20.18.3 / Chromium 130) → close → relaunch restores the workspace | PASS | `installed/01…03-*.png`, `installed/process-context.json` |
| Earlier 502-blocked task surfaces truthfully after relaunch ("Task needs attention"; Run tab BLOCKED with rationale) | PASS | `audit/shots/05-failed-task-transcript-inspector-overview.png` |
| Live packaged coding task → tests → ForgeVerify → completion gate → persisted response; close safeguard during an approval wait | PENDING (quota reset 00:00Z) | `native-ui/live/RUNBOOK.md` |

Disposable repository re-baselined for the live task: `C:\Users\Daddy_FDS\CodeForge Live\r5\session-lib` at `8cc123e`, clean worktree, 7/7 tests, defect reproduces (`native-ui/live/00-baseline.txt`).

Quota conservation (no bypass): launch-time 8-Bit qualification fires once per process after discovery and nothing re-triggers it; the candidate is therefore launched a few minutes before the reset so its bounded cycle spends itself against the exhausted cap, leaving the full 50-request window to the task (analysis in the runbook).

Product defects observed while driving the UI — none touch the free-route engine gates; all logged for the UX lock (`apps/desktop/release/ui-lock-evidence/ui-defect-inventory.md`): stale "Cloud offline" chip after 2 of 4 relaunches; "Discovering free routes…" never settling on fresh profiles; model detail dialog ignores Esc; duplicate "Devstral 2" rows; unqualified routes labelled "Ready"; the user's prompt absent from the transcript; Changes/Tests panels permanently empty.

## 17. Remaining Blockers

1. OpenRouter free-tier daily cap exhausted until 2026-09-14T00:00Z (external, verified by rate-limit headers). The live packaged coding task, ForgeVerify, completion, persisted-response and close-safeguard evidence run at the reset through the established native UI control (§20, `native-ui/live/RUNBOOK.md`).

No paid inference, billing enablement, local-model fallback, remote push, or secret exposure is required to clear these gates.

## 18. Evidence Paths

`apps/desktop/release/r5-evidence/tests/flaky-group-serial-stability-{1,2,3}.log`; `apps/desktop/release/r5-evidence/tests/full-run4-final.stdout.log`; `apps/desktop/release/r5-evidence/free-cloud/discovery-refresh-current.json`; `apps/desktop/release/r5-evidence/free-cloud/nemotron-super-qualify.json`; `apps/desktop/release/r5-evidence/live/free-cloud-registry-after-qualification.json`; `apps/desktop/release/r5-evidence/smoke-all-current.log`; `apps/desktop/release/r5-evidence/build-root-current.log`; `apps/desktop/release/r5-evidence/dist-r5-current.log`.

## 19. Next Recommended Milestone

Run the exact rebuilt Portable or unpacked candidate in a session with native UI automation, submit the expired-session regression task through the visible chat, and preserve its real completion-gate evidence. Do not consume further free-model capacity before that task.
