# CodeForge 0.4.0 Desktop Installed RC Certification

Date: 2026-09-18  
Repository: `G:\CodeForge`  
Baseline commit: `2a7d62f999daef6bedc16eb6402dcafb10a495b5`  
Version under test: `0.4.0`

## Executive result

**Verdict: NOT READY for installed-desktop release certification.**

The source, dependency install, typecheck, lint, build, full regression suite,
security gates, PostgreSQL adversarial suite, fresh packaging, NSIS installer
execution, and uninstall path were validated. The first installer defect was
fixed: the previous one-click NSIS configuration produced a portable-style
installer that could exit successfully without creating a persistent install.
The rebuilt installer is a real assisted per-user installer and its install and
uninstall paths pass.

Certification remains blocked because the installed application's renderer/UI
launch was not proven in this managed Windows environment. A fresh packaged
build from the `G:` workspace starts its local server but fails to load the
renderer with Electron `ERR_FAILED` for the canonical `file:///G:/...` URL. A
fresh per-user installed copy was created from the rebuilt installer, but the
native UI smoke harness did not produce a successful renderer-ready record and
timed out. The current managed token also cannot inspect the older protected
per-user install shown in the supplied screenshot. Therefore installed UI
workflows, restart/recovery, and real user journeys are blocked rather than
claimed as passing.

The supplied screenshot shows a stale shortcut or launcher target referring to:

`C:\Users\Daddy_FDS\AppData\Local\CodeForge-RC4-Installed-20260914\CodeForge.exe`

That file was absent. It is treated as diagnostic evidence, not as an
instruction to preserve or delete protected user data.

## Source and build gates

| Gate | Result | Evidence |
|---|---|---|
| Initial Git baseline | PASS | Worktree was clean at campaign start; final changes are intentional and listed below. |
| Version consistency | PASS | Package, desktop metadata, installer metadata, and final executables report `0.4.0`. |
| Dependency install | PASS | `npm.cmd ci --no-audit --no-fund` completed successfully. |
| Typecheck | PASS | `npm.cmd run typecheck`. |
| Lint | PASS | `npm.cmd run lint`. |
| Build | PASS | `npm.cmd run build`. |
| Full regression | PASS | 360 test files passed, 7 skipped; 2,722 tests passed, 36 skipped. |
| Focused desktop startup/watchdog tests | PASS | 4 files, 25 tests passed. |
| PostgreSQL adversarial suite | PASS | 12 files, 80 tests passed against the configured PostgreSQL endpoint. |
| Security gate | PASS | Elevated reproducible run: secret self-test pass; dependency audit pass; public claims pass with 0 blocking hits; documentation links pass with 0 broken links. |
| Final source diff check | PASS | `git diff --check` passed. |

The PostgreSQL adversarial fixture now uses a unique subscription id per run,
preventing a persisted test record from making a later clean run fail. The
progress watchdog now starts after durable child startup boundaries and maps a
watchdog budget cancellation to `blocked`, preserving the completion policy.

## Packaging and installer gates

| Gate | Result | Evidence |
|---|---|---|
| Fresh release directory | PASS | Previous release output was moved aside to `apps/desktop/release-pre-campaign-20260918`; the final release was rebuilt from current source. |
| Final desktop packaging | PASS | `npm.cmd run dist --workspace=codeforge-desktop` exited 0. |
| Installer configuration | PASS | NSIS is now assisted per-user (`oneClick=false`, `perMachine=false`) with selectable install directory and desktop/start-menu shortcuts. |
| Installer execution | PASS | Final setup executable exited 0 and created the timestamped validation install directory. |
| Installed executable provenance | PASS | Installed executable reported version `0.4.0` and matched the final unpacked executable hash. |
| Uninstall | PASS | Final uninstaller exited 0; validation install directory and desktop shortcut were removed. |
| Installed application launch | BLOCKED | Native installed UI did not produce a renderer-ready smoke result in the managed environment. |
| Fresh profile boot | BLOCKED | Depends on the blocked installed renderer/UI gate. |
| Upgrade behavior | BLOCKED | Not certified while the fresh installed UI gate is blocked. |

### Final artifacts

| Artifact | Size | SHA-256 |
|---|---:|---|
| `apps/desktop/release/CodeForge-Setup-0.4.0.exe` | 115,713,488 bytes | `C03A1D28E7A840C4BDFAF4A662A07CD487978F01B5C9B9B62212F19398171891` |
| `apps/desktop/release/CodeForge-Portable.exe` | 115,378,407 bytes | `62AFBF58E6A901F1B2C1C806C2E19ECB152DBAE7E510709E1D44D94C6C8A4EA7` |
| `apps/desktop/release/win-unpacked/CodeForge.exe` | 246,415,872 bytes | `92BAB122D6E893392B0C2600CAD0F00B747FFCADCFAB5ED2BEF3857A585330E6` |

Installer validation used the per-user directory
`C:\Users\Daddy_FDS\AppData\Local\CodeForge-Installed-Validation-Final-20260918`.
That directory no longer exists after the successful uninstall check.

## Installed-workflow matrix

`Automated` means covered by source/package/runtime tests; it is not a claim
that the installed native UI passed. `Blocked` means the installed UI gate
prevented a valid end-to-end observation.

| Workflow | Result | Notes |
|---|---|---|
| GitHub login | BLOCKED | No native UI/credential session was available. |
| Logout | BLOCKED | Depends on installed UI. |
| Account switch | BLOCKED | Depends on installed UI. |
| Provider settings | BLOCKED | Depends on installed UI. |
| Ollama connect | BLOCKED | No installed UI certification; local inference is prohibited by policy. |
| Ollama persistence | BLOCKED | Same gate; no local model route was used. |
| Ollama disconnect/isolation | BLOCKED | Same gate; no local model route was used. |
| Free Auto provider isolation | PASS — Automated | Covered by zero-billing/provider routing tests. |
| Real agent task | BLOCKED | Installed renderer not certified. |
| Tool execution | BLOCKED — Installed UI; PASS — Automated | Runtime tool contracts and tests passed. |
| File edit | BLOCKED — Installed UI; PASS — Automated | No installed UI proof. |
| ForgeVerify | BLOCKED — Installed UI; PASS — Automated | Completion/proof gates passed in tests. |
| User interrupt | BLOCKED — Installed UI; PASS — Automated | Control-flow coverage passed in tests. |
| Recovery/retry | BLOCKED — Installed UI; PASS — Automated | Runtime recovery tests passed. |
| 8-Bit mode | PASS — Automated | Policy and routing boundary tests passed. |
| ForgeGreen mode | PASS — Automated | Policy and routing boundary tests passed. |
| 16-Bit boundary | PASS — Automated | Boundary tests passed. |
| Paid Auto boundary | PASS — Automated | Paid routes remain rejected. |
| GEMS boundary | PASS — Automated | Governance boundary tests passed. |
| BYOK isolation | PASS — Automated | Isolation tests passed. |
| Network failure behavior | PASS — Automated; BLOCKED — Installed UI | Failure handling was tested without an installed UI claim. |
| Provider stream interruption | PASS — Automated; BLOCKED — Installed UI | Interruption handling was tested without an installed UI claim. |
| Performance/idle behavior | BLOCKED | Installed UI did not reach a certifiable renderer-ready state. |
| Large repository behavior | PASS — Automated | Synthetic FG2 coverage included 1,000,000 lines, 1,001 files, and a one-file incremental change. |
| Restart behavior | BLOCKED | Requires a successful installed UI session. |
| Uninstall cleanup | PASS | Installer/uninstaller validation removed the install directory and shortcut. |
| Logging redaction | PASS — Automated | Security scans and redaction tests passed. |

## Defects fixed during campaign

1. NSIS was configured as one-click portable-style packaging. It now builds an
   assisted per-user installer with a persistent install directory.
2. Packaged renderer loading used Electron `loadFile` and failed in the tested
   ASAR/non-system-volume path. Production loading now uses the canonical
   `pathToFileURL(...).href` with `loadURL`, with startup tests updated.
3. The progress watchdog began measuring before child startup had completed and
   could misclassify normal initialization. It now starts after child
   registration and startup transitions, and preserves `blocked` semantics for
   watchdog budget exhaustion.
4. The PostgreSQL full-product fixture used a reusable subscription id and was
   made run-isolated with a UUID suffix.
5. A stale certification-document link was repaired; the elevated security
   gate now reports zero broken documentation links.

The renderer change removes the malformed Windows URL failure mode but did not
clear the full installed UI gate in this environment. A follow-up run must
retest on a normal supported Windows user profile and, if the failure reproduces
there, capture the Electron renderer/OS error and continue the fix before
certification.

## Changed files

- `apps/desktop/package.json`
- `apps/desktop/src/main.ts`
- `apps/desktop/test/startup-reliability.test.ts`
- `packages/server/src/subagent-manager.ts`
- `packages/server/test/progress-watchdog.test.ts`
- `tests/cloud-postgres-adversarial.test.ts`
- `docs/certification/codeforge-managed-free-fleet-qualification.md`
- `docs/evidence/security-r1/dependency-audit.json`
- `docs/evidence/security-r1/doc-links.json`
- `docs/evidence/security-r1/public-claims-scan.json`
- `docs/evidence/security-r1/sbom.json`
- `docs/evidence/security-r1/secret-scan.json`
- `CODEFORGE-0.4-DESKTOP-INSTALLED-RC-CERTIFICATION.md`

## Release accounting

- Money spent: `$0`
- Paid inference: none
- Local LLM inference: none
- Deployment: none
- Push: none
- Certification status: **NOT READY** until installed renderer/UI, fresh
  profile, real workflows, restart/recovery, and upgrade behavior are rerun
  successfully on a supported Windows profile.
