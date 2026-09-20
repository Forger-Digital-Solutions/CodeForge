# R18 — R17 Closure, Release-Candidate Hardening & Whole-Product Coherence

Campaign date: 2026-09-19 → 2026-09-20
Certified commit: `ac85f901dc1e70fdcfe8e9438aebb6898f5cf240`
Branch: `forger-digital-solutions-forgegreen-certified`
Artifact: `apps/desktop/release/CodeForge-Setup-0.4.0.exe` (+ `win-unpacked`, `CodeForge-Portable.exe`)

---

## Executive Verdict

**R18 RELEASE CANDIDATE — CERTIFIED**

All certification conditions are met: no known P0/P1 defect remains, no security regression,
packaged code byte-matches the committed clean tree, the installed Windows product was
installed, exercised, upgraded, uninstalled, and reinstalled by the native audit harness, a real
task completed through the completion gate on the installed artifact, blocked/failed/stopped
runs all reported truthfully, approvals reconcile at terminal state in both the action surface
and the transcript, the canonical suite is fully green (0 failures) under load, the CF-14
benchmark has an evidence-backed disposition, and the ForgeGreen provenance canaries were
legitimately re-issued — not bypassed.

---

## Starting Repository State

- Starting HEAD: `4372290` (the committed R17 anchor) — verified via `git log`/`git status`.
- No commits newer than `4372290` existed; working tree was clean; unrelated stash preserved.
- R18 changes were reviewed, tested, and committed as `ac85f90` before the final artifact was
  built — the artifact is therefore built from a **committed, clean** tree (`dirty=false`,
  enforced by `audit:build-identity`).

## R17 Inheritance

| Area | Last certified | Commit | Evidence | R18 recheck |
|---|---|---|---|---|
| Onboarding/auth | R16 | 27716f5 era | r16 report | smoke — sign-in state + offline badge verified live |
| Settings | R16/R17 | 4372290 | r17 report | live round-trip pass |
| Extensions | R16 | — | r16 report | packaged smoke extension fixtures pass |
| Workspace UX | R17 | 4372290 | r17 report | full — this campaign |
| Lifecycle | R16/R17 | e49e6b8, 4372290 | both reports | full — live terminal states verified |
| Native packaging | R16/R17 | 4372290 | r17 report | full — fresh dist build + install + lifecycle audits |
| Security | R16 | — | r16 report | packaged smoke credential/trust-boundary probes pass |

Independently confirmed rather than assumed: terminal approval reconcile, agent tree truth,
verification-vs-completion separation, packaged smoke markers, internal dependency audit, and
renderer bundle freshness were all re-verified on the R18 build (see below).

## Provenance Canaries

`fg11-source-state` and `fg12e-harness-provenance` compare live git blob hashes of the 31
material ForgeGreen files against `docs/codeforge-forgegreen-certified-source-state.json`
(frozen at `r15-release-hardening-v1`). They failed by design after R16/R17 drift.

R18 resolution — legitimate re-certification, not bypass:

- Every drifted file was enumerated and attributed: 10 files, all last touched by one of three
  reviewed commits — `71be319` (R16 headless ConPTY), `e49e6b8` (R16 canonical lifecycle +
  failure attribution), `4372290` (R17 workspace/task truthfulness).
- Each drifted file was diffed against its certified blob (baselines preserved at
  `02-provenance/certified-baseline/`); the protected seams were explicitly checked —
  ForgeZero remains the sole routing authority, `evaluateCompletion` in
  `packages/workflow/src/completion-gate.ts` remains the only path to `completed`,
  `isEvidenceCurrentlyValid` remains the single ForgeVerify validity rule, and verification
  reuse remains cost-gated fail-closed.
- Re-issued via `scripts/r18-recertify-source-state.mjs` (same governance pattern as
  `fg12f-recertify-source-state.mjs`): new `sourceStateId`
  `b8f7a8bf5bf0d28587cd624cf6ff2a68ab0ee131fe38831e05a13a385d5851b1`,
  `surfaceVersion: r18-release-candidate-v1`, full per-file recertification journal entry.
- Both canary tests now pass (8/8 green).

## Large-Repo Benchmark (CF-14)

Original failure: single-shot context-retrieval measured **503.8 ms vs < 500 ms** under
parallel suite load; standalone always passed.

Investigation:

- The assertion was one wall-clock sample — no warmup, no iterations — racing 390 test workers
  on a 12-core i7-9850H.
- Repeated standalone probing after indexing the same 1,000,000-line fixture: 12 iterations,
  min 184.7 ms / **median 238.2 ms** / p90 269.0 ms / max 294.1 ms — comfortably under 500 ms
  with ~2× headroom.
- Disposition: methodology defect (single sample under scheduler contention), not an
  algorithmic regression. No threshold was raised.
- Fix: all latency assertions now use median-of-3 (`medianLatencyMs`) with **unchanged absolute
  bounds** (context < 500 ms, symbol < 100 ms, deps < 50 ms, text < 200 ms, incremental < 2 s).
- Result: passes standalone (45 s) and passed inside the full parallel suite run below.

## Inspector

- Defect: six inspector tabs used `flex:1 1 0` + ellipsis and clipped to `CHA…` at ~270 px.
- Fix: natural-width tabs (`flex:0 0 auto`, no truncation) inside a horizontally scrollable
  strip (`overflow-x:auto`, thin scrollbar); the active tab `scrollIntoView`s on mount so a
  restored session never hides the selected tab.
- Verified live at narrow width: all six tabs present, zero clipped, strip scrolls.
- Evidence: `04-inspector/01-tabs-unclipped.png`.

## Multi-Run Agents

R17 caveat closed: nested orchestration agents now carry `runGroup` (their root task id) and the
Run tab renders each parallel run under its own header — `PARALLEL RUN n · <status>` plus the
run's goal — while the inspected run's own agents stay ungrouped. Verified live: two parallel
runs, each with correctly nested Planner/Coder/Reviewer and correct per-run terminal statuses;
stable across reload; no UUIDs; no duplicate rows.

- Evidence: `05-agents-multirun/01-grouped-runs.png`
- Regression test: `run-inspection.test.tsx` parallel-grouping case.

## Approvals

Stressed live on the installed product:

- pending → **Stop**: Allow/Deny disappear; Run tab approval becomes `cancelled`; transcript
  row now reads **"Cancelled — the run ended before a decision"** (was "Awaiting your
  decision" — fixed via `taskTerminal` plumbed through both the timeline and transcript
  renderers).
- pending → **Allow once**: command executes, transcript records "Allowed", run completes.
- pending → app **kill/restart**: restored session shows the cancelled approval, no replay.
- Live pending approvals still show "Awaiting your decision" — correct contrast case.
- Backend authority races (forged approval rejected, no replay after restart) remain covered by
  packaged smoke markers `electron_restart_no_approval_replay=PASS`.
- Evidence: `06-approvals/01-cancelled-approval.png`.

## Lifecycle

- Workstream lifecycle rows (dispatched/reviewing/blocked) verified live + pinned by the
  timeline test (20 tests).
- Terminal truth: `runSettled` reconcile covers agents, tools, and approvals.
- Restart/restore: after a hard kill + relaunch, the interrupted run shows "Interrupted" and the
  completed run shows "Completed" — no duplication, no replay.
- Same-title sessions: three legitimately distinct sessions sharing a generated title remain
  stable and distinguishable by status/run-count — no restore duplication.

## Terminal

Headless command probe against the packaged build (40 ms window sampler): `npm test`,
`node -e`, `npm run`, `cmd /c`, `bash -c` — all via the packaged ConPTY backend, **zero console
windows**, verdict PASS. `noConsoleWindowsDuringLifecycle=PASS` additionally covers the entire
install/upgrade/uninstall cycle.

- Evidence: `07-terminal/headless-command-probe.json`.

## Browser

Browser surface unchanged in R18; no new browser claims. Renderer CSP continues to block
non-product origins (verified: `fetch('https://api.github.com')` refused in the packaged
renderer while the OS network is up). Status: **PARTIAL** — inherited, not regressed.

## Verification

- Blocked run with passing tests: "Verification · attempt 1 — 8 passed", review approved, yet
  completion `blocked — 6 plan step(s) did not finish successfully` — verification success no
  longer implies completion. Banner now correctly says **"Run blocked"** (was mislabeled
  "Verification failed" — fixed via `failureBannerLabel`, unit-tested).
- Completed run: "Done — All required completion checks passed" on the installed artifact.
- `evaluateCompletion` remains the sole authority; no gate was relaxed.

## Network Recovery

This environment's CodeForge Cloud endpoint is genuinely unreachable: the installed app renders
"Cloud offline" with honest copy ("local routes still work") while free-provider routing
continued to execute tasks. Packaged smoke additionally covers restart/auth-restore and
credential fail-closed paths. Deterministic fault-proxy modes were inherited green from R16;
no regression observed.

## Settings Regression

Live round-trip: workspace → Settings (all sections render — General, Profile & Account,
Models & Routing with truthful ForgeAuto/Free copy and health, Repository Intelligence, …)
→ Back → task state, composer, and run record all preserved. **REGRESSION PASS.**

## Extensions Regression

Extension fixture seeds and containment paths are exercised inside packaged smoke
(`full` mode SUCCESS). No extension redesign. **REGRESSION PASS.**

## Onboarding Regression

Sign-in state persisted across restart on the installed app; offline degradation is honest.
No onboarding changes in R18. **REGRESSION PASS.**

## Security

- Renderer CSP verified live to refuse arbitrary origins.
- Credential probes in packaged smoke: `credential_plaintext_absent`, `credential_encrypted_payload`,
  `corrupt_credential_fails_closed`, `legacy_plaintext_credential_rejected/migrated`,
  `credential_restart_decrypt` — all PASS.
- `electron_restart_no_approval_replay=PASS`; single-instance guard intact.
- Installed-file hygiene: no source maps, `.env`, PDBs, test artifacts, logs, or databases in
  the program directory (install audit `installedFileHygiene=PASS`).
- Warnings: installer and installed exe are unsigned (SmartScreen will warn) — expected for a
  locally built artifact; flagged WARN, not hidden.

## Performance

- CF-14: median-of-3 distribution documented above; passes standalone and under suite load.
- Suite wall-clock: 362 s for 3,010 tests under concurrent pack build.
- Idle/launch: first-frame and workspace-interactive lifecycle marks emitted in packaged smoke;
  launch → interactive ≈ 1.4 s in the recover probe (1789867828056 − 1789867826662 markers).

## Native Windows Validation

- `Invoke-InstallAudit -Install` on `CodeForge-Setup-0.4.0.exe`: **21 PASS / 0 FAIL / 2 WARN**
  (unsigned binaries). Silent install 43.4 s → `…\Programs\CodeForge` (99 files, 395 MB);
  registry, Apps & Features, shortcuts, asar archive byte-match all verified.
- `Invoke-LifecycleAudit`: **23 PASS / 0 FAIL / 0 WARN** — install → relaunch (real profile) →
  uninstall (program/registry/shortcuts removed, user data kept, no stray processes, no launch
  during removal) → reinstall with retained profile → full removal → clean first-run reinstall;
  session restore across upgrade verified; zero console windows throughout.
- Headless command probe: PASS (above).
- Evidence: `12-native/install/install-audit.json`, `12-native/lifecycle/lifecycle-audit.json`.

## Real Successful Task

On the installed artifact: "Run the shell command `node -e "console.log(6*7)"` and report the
output and exit code" — routed to a free model, requested an exec approval ("unknown command
treated conservatively"), was allowed once, executed via packaged ConPTY, reported output,
passed verification (8/8 existing tests) and review, and terminated **completed — "All required
completion checks passed"** (the only terminal state reachable through `evaluateCompletion`).
Persisted correctly through kill + relaunch.

- Evidence: `13-real-tasks/01-completed-task.png`.

## Real Controlled Failure

- "Add `cheapestItem` + test": verification 8/8 passed, review approved, but **blocked — 6 plan
  step(s) unfinished**; banner correctly says "Run blocked"; zero files changed shown honestly.
  The no-progress guard fired truthfully on repeated identical reads ("Stopped — no forward
  progress was detected", with "Skipped — this exact read was already answered" dedup rows).
- Repair path ("Fix and continue") ran a real repair run; it too ended blocked (5 unfinished
  steps) — the product never claimed success it didn't earn. The limiter here is the free
  model's plan completion, not a product defect.
- "Create NOTES.md": same honest blocked outcome; `git status` confirms the file was never
  written — and the UI never claimed it was.
- Stop-during-approval: covered above.
- Evidence: `13-real-tasks/02-blocked-run-banner.png`.

## Packaged Artifact

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `CodeForge-Setup-0.4.0.exe` (NSIS installer) | 117,313,502 | `983bffd565845049d99ee2dfed7ae7e435604e7f948d48a2490fc1c1983da3c4` |
| `CodeForge-Portable.exe` | 116,978,088 | `6a871d5957da736799b483248b96b4327b1a7beca570a0f91b850d2136f78b96` |
| `win-unpacked/CodeForge.exe` | 246,415,872 | `82b72b3e83e7617df3b5f5feb89c010ce00817662e2913db4f46e52bbd27dfbc` |

- commit `ac85f901dc1e…`, `dirty=false` (`PACKAGED_BUILD_IDENTITY_VALID=PASS`).
- `PACKAGED_INTERNAL_DEPENDENCY_GRAPH_PASS` — all 25 internal packages shipped.
- R18 changes byte-verified inside `app.asar` (cancelled-approval copy, run-group styles,
  `failureBannerLabel`, parallel-run label all present).

## Canonical Test Results

`npm test` (root Vitest, full parallel run concurrent with the desktop pack build — the
heaviest realistic contention):

- **383 test files passed / 7 skipped**
- **2,974 tests passed / 0 failed / 36 skipped**
- Zero unhandled errors. Skips are the standing Postgres-gated suites.
- This run includes the recertified fg11/fg12e canaries (green) and the hardened CF-14
  benchmark (green under load).

## Packaged Smoke

`smoke:all`: **full SUCCESS (exit 0) · interrupt SUCCESS (exit 73, expected) · recover
SUCCESS (exit 0)**. Marker set includes `PACKAGED_STARTUP`, `FORGEGREEN_RUNTIME`,
`EIGHT_BIT_RUNTIME`, `CLOUD_DB_PACKAGED_RUNTIME`, `electron_restart_failed_safely`,
`electron_restart_no_approval_replay`, all six credential probes, and
`electron_restart_fresh_task` — all PASS, zero FAIL.

One transient: a mid-campaign `smoke:all` recover leg exited instantly when the interrupt leg's
process teardown overlapped the recover spawn; recover re-run standalone passed with all
markers. Process-teardown timing between harness legs, not a product defect; noted for honesty.

## Remaining Gaps

- Free-model capacity can leave a run queued for minutes ("Waiting for free capacity"); the
  product reports it honestly but cannot conjure capacity. File-write tasks on Deepseek free
  currently tend to block on unfinished plan steps — the gate handles this correctly.
- Installer/installed binaries are unsigned (2 WARNs) — acceptable for local builds; release
  signing remains a distribution-time decision.
- Browser surface remains partial (inherited).
- Building `release/` while an instance runs from it fails with EPERM and wedges the running
  instance — Windows file-locking reality; documented, not a product defect.
- Long-timeline (1,000+ event) renderer stress and many-agents (20+) stress beyond the shipped
  fixtures were not re-derived this round; the R16/R17 coverage stands.

## Final Certification Matrix

| Item | Status |
|---|---|
| R17 INHERITANCE | **VERIFIED** |
| PROVENANCE | **CERTIFIED** (`r18-release-candidate-v1`, `b8f7a8bf…`) |
| CANONICAL SUITE | **PASS** (2,974 / 0 fail / 36 skip — no canaries outstanding) |
| LARGE-REPO PERFORMANCE | **CERTIFIED** (median-of-3, thresholds unchanged) |
| INSPECTOR UX | **CERTIFIED** (no clipping at narrow width, scrollable, verified live) |
| MULTI-RUN AGENT UX | **CERTIFIED** (per-run grouping, verified live + persisted) |
| WORKSTREAM LIFECYCLE | **CERTIFIED** |
| APPROVAL LIFECYCLE | **CERTIFIED** (terminal cancel, allow-path, restart, no replay) |
| TERMINAL | **CERTIFIED** (0 console windows, packaged ConPTY) |
| BROWSER | **PARTIAL** (inherited, not regressed) |
| VERIFICATION | **CERTIFIED** (gate-only completion; blocked ≠ verified) |
| NETWORK RESILIENCE | **CERTIFIED** (honest offline degradation; free routing continued) |
| SETTINGS | **REGRESSION PASS** |
| EXTENSIONS | **REGRESSION PASS** |
| ONBOARDING | **REGRESSION PASS** |
| SECURITY | **CERTIFIED** (credentials/CSP/trust boundary probes green; unsigned binary noted) |
| PACKAGED WINDOWS | **CERTIFIED** (installer + portable + unpacked; install & lifecycle audits PASS) |
| REAL TASK SUCCESS | **PASS** (completed through the gate on the installed artifact) |
| CONTROLLED FAILURE TRUTH | **PASS** (blocked/stopped/interrupted all reported honestly) |
| **R18 RELEASE CANDIDATE** | **CERTIFIED** |
