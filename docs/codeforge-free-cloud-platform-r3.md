# CodeForge Free Cloud Platform — R3 Recovery Record

## 1. Verdict

`CODEFORGE_FREE_CLOUD_PLATFORM_R3_BLOCKED`

## 2. Reconciled Starting State

Repository `G:\CodeForge`, branch `forger-digital-solutions-forgegreen-certified`, HEAD
`18c9f941ffe1961d5a1ca2b525afbb57a9b7af77`; R2 candidate
`8b05773dd892de96bec52c5d7325622817e4dc75` is in ancestry. The initial tree was clean.

## 3. Renderer Failure Root Cause

`launch-failed:49` is a Chromium renderer-sandbox failure caused by starting packaged Electron
under the Codex command runner's already constrained process environment. It is not evidence that
the CodeForge renderer, preload, ASAR layout, or Windows host cannot launch normally. R8's secure,
ordinary-host launch evidence records first paint and full/recovery smoke with the same Electron
33.4.11 security posture. Starting the R2 executable from this turn still inherits the agent's
containment and displayed an Electron Error window, so it is deliberately not counted as a pass.

## 4. Minimal Electron Control Result

`apps/desktop/sandbox-minimal-diagnostic` is the isolated Electron 33.4.11 control. Historical
R8 evidence records secure packaged first paint outside nested containment. This R3 environment
cannot independently reproduce that ordinary-host launch path.

## 5. Host / Windows Evidence

The host reports Windows 10 Pro (version 2009). Application Event Log inspection found no
CodeForge/Electron crash record correlated with the R3 attempt. GPU/OS CIM details were denied by
the current execution token, so no hardware-specific claim is made.

## 6. GPU / Sandbox / Preload Diagnosis

Earlier controlled diagnostics include default/disabled-GPU and diagnostic sandbox variants. The
secure R8 package passed with `sandbox=true`; no GPU or no-sandbox production workaround is
retained. The packaged audit and focused preload/control-plane tests pass in R3.

## 7. Production Fix

No unsafe renderer switch was added. The production path uses `BrowserWindow.loadFile()` for the
canonical packaged file URL, with the renderer created and loaded under the standard security
settings. The only correction required for exit 49 is to run GUI smoke outside nested containment.

## 8. Security Impact

Current packaged audit: PASS — sandbox enabled, Node integration disabled, context isolation and
web security enabled, main-process bearer injection present, and the preload bearer-free.

## 9. Fresh Profile First Paint

Not rerun as a host-native R3 observation. Existing R8 secure evidence passed this gate; an R3
launch from this agent is containment-confounded and is not substituted for it.

## 10. Unpacked Candidate

R2 unpacked executable hash: `54548AE86EDD165EDB3C4F0DA3E739A1244596BA6962435DDC39A22FAF54A5DE`.
Its ASAR and native dependency are present; packaged security audit passes. Host-native R3 smoke
remains pending.

## 11. Portable Candidate

R2 portable hash: `B9F592F8EEEF47E3D2B7B098102121EBBADAF5F679EA478C0D097914047C7CA8`.
No new host-native R3 portable smoke was possible from the constrained runner.

## 12. Installed Candidate

R2 setup hash: `9F00742C0A7371DF80A19F983ED37E0EF107EE2B497E261C901A67C1A216064E`.
Installation was not repeated; no installer mutation was performed.

## 13. Runtime / Renderer Ownership

A fresh direct-launch profile produced owned `runtime.json` with executable path, PID, instance
ID, and `http://127.0.0.1:53528`. Focused ownership/control-plane/preload/package-security tests:
4 files, 32 tests passed.

## 14. Recovery / Restart

Historical R8 secure full/interruption/recovery smoke passed. Current R3 constrained launch cannot
certify a replacement host-native recovery trace.

## 15. Workspace UX

Existing R8 secure captures show workspace-ready and completed/recovery states. No claim is made
for a new R3 visual observation.

## 16. Settings UX

Existing R1/R8 evidence covers functional Settings navigation and provider surfaces. R3 did not
obtain new native-window accessibility access.

## 17. Model Picker

Canonical picker behavior is source-tested; one canonical model can have multiple routes without
duplicate top-level entries. Current R3 did not add a visual claim.

## 18. Provider Discovery

The full-suite live catalog snapshot reached OpenRouter and registered 22 verified zero-unit
candidates, zero allowance candidates, and zero errors. Catalog pricing alone did not admit any
route to ForgeAuto.

## 19. Credential Discovery

No credential value was read or logged. R3 has no new packaged UI credential-discovery proof.

## 20. Provider Authentication

No new legitimate authenticated provider session was established in R3.

## 21. 8-Bit Qualification

No new live qualification receipt was issued. Qualification remains fail-closed pending legitimate
authentication and capacity.

## 22. Current Free Fleet

No R3 route is admitted. The 22 catalog candidates remain candidates only.

## 23. Same-Model Failover

Deterministic tests cover same-model route failover; no live R3 provider route pair was available.

## 24. ForgeAuto Cross-Model Failover

Deterministic active-run failover coverage passed in the full suite. No live R3 cross-model event
was fabricated.

## 25. Real Free Cloud Coding Task

Not completed in R3. Prior evidence records a real zero-priced OpenRouter task, but it did not
pass the completion gate before the provider daily cap. It is not counted as an R3 success.

## 26. Active-Task Close / Recovery

Covered by existing deterministic and R8 recovery evidence; no fresh native R3 UI trace.

## 27. Free vs BYOK Policy

ForgeZero policy tests passed in the full suite. Catalog discovery never bypasses qualification,
and no paid or local model was selected.

## 28. ForgeGreen Drift Reconciliation

The prior certificate missed four reviewed material files. The guarded canonical workflow now
requires exactly those paths and generated source-state
`72673f2c31852263cd41bd056250628e9acbd966085eef9cc45546e2402cc873`.
FG-11 and FG-12E provenance tests pass; unexpected future drift fails the workflow.

## 29. Focused Tests

Desktop ownership/control-plane/preload/package security: 4 files, 32 tests passed. ForgeGreen
source-state/provenance: 2 files, 8 tests passed. Packaged browser-security audit: PASS.

## 30. Full Test Aggregate

`npm.cmd test`: 314 files passed, 7 skipped; 2,358 tests passed, 36 skipped; 302.00 seconds.

## 31. Performance

No new reliable host-native first-paint timing was captured. The full suite's million-line
repository check passed; it is not renderer timing evidence.

## 32. Runtime Candidate

Version `0.3.0`; application code remains the R2 packaged candidate. This R3 work changes only
the certified-source-state workflow and evidence, so a new binary was not misrepresented.

## 33. Packaged Candidate

Artifacts remain under `apps/desktop/release`: Setup 85,944,333 bytes; Portable 85,673,584 bytes;
unpacked executable 188,875,264 bytes. See R2 record for exact SHA-256 values.

## 34. Security Audit

`npm.cmd run audit:browser-security --workspace=codeforge-desktop -- release\\win-unpacked`: PASS.

## 35. Remaining Blockers

1. Run the current exact package from an ordinary Windows desktop process outside Codex command
   containment and capture fresh-profile first-paint plus unpacked, portable, installed, and
   recovery traces.
2. Obtain legitimate authenticated free-provider capacity, qualify a route, and complete one
   packaged autonomous coding task through ForgeVerify and the completion gate.

## 36. Evidence Paths

- `docs/codeforge-free-cloud-platform-r3.md`
- `docs/codeforge-free-cloud-platform-r3.json`
- `docs/codeforge-free-cloud-platform-r2.md`
- `docs/codeforge-ui-daily-driver-r8-certification-report.md`
- `docs/codeforge-codex-full-system-certification-r1.md`
- `apps/desktop/release/r3-direct-launch-profile/runtime.json`
- `apps/desktop/release/smoke-result.log`

## 37. Next Recommended Milestone

Run a normal desktop-host smoke harness, then use a legitimately authenticated free provider with
available quota for qualification and a bounded completion-gated coding task.
