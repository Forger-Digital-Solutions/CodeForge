# CodeForge Desktop BYOK Beta R1 Certification Report

## Verdict

`CODEFORGE_DESKTOP_BYOK_BETA_R1_BLOCKED`

This checkout passes the repository regression suite, but the required
Windows packaged candidate and packaged smoke/security evidence have not been
produced in this workspace. The result is therefore not a public-release
certification.

## Build identity

| Field | Result |
| --- | --- |
| Starting HEAD requested by milestone | `3d5ba374e1ebf140813401c0b4dcbcebdf6a010c` |
| Actual starting HEAD | `4904d2b1b9000ce3ff812dc119d844c6ab0206d2` |
| Source branch | `forger-digital-solutions-analyze-attached-request` |
| App version | `0.2.0` |
| Target architecture | Windows x64 |
| Final HEAD | Recorded in the release commit that adds this report |
| Remote availability | `REMOTE_CI_REQUIRES_PUSH_AUTHORIZATION` — exact candidate is absent from `origin` |
| Windows workflow | `.github/workflows/windows-desktop.yml`; no exact-candidate run ID |

The actual starting HEAD differs from the milestone prompt. Existing work was
preserved; no reset or cleanup was performed.

## Evidence completed

- `npm test -- --reporter=dot`: **PASS**, 58 test files and 577 tests.
- The owner-authorized beta age policy is **18+**. The desktop now requires a
  versioned acknowledgement without collecting date of birth.
- `vitest.config.ts` already excludes the separate VS Code Electron fixture
  topology; no `describe is not defined` failure reproduced.
- Electron window security settings are source-configured as
  `sandbox: true`, `nodeIntegration: false`, and `contextIsolation: true`.
- Windows packaging is configured for `windows-2022`, x64 Node, Python 3.11,
  pinned npm, NSIS, portable output, and the Electron-ABI SQLite binding.
- Provider model counts now use the authoritative `freeStatus ===
  "verified_free"` result rather than promotional or cost-profile inference.

## Not completed in this workspace

- Windows package creation, immutable artifact paths, file sizes, and SHA-256
  hashes.
- Packaged first-paint, packaged full/interrupt/recovery smoke, packaged
  security audit, installer acceptance, and screenshots.
- Candidate-specific dependency/license graph, third-party notices, and SBOM.
- Disposable-identity account deletion exercise and full packaged BYOK
  provider battery.
- Local commit hash and clean-worktree verification after final staging.

## Business and legal gates

| Gate | Status |
| --- | --- |
| Root LICENSE owner authorization | `LICENSE_OWNER_AUTHORIZATION_REQUIRED` |
| Minimum-age policy | `APPROVED_MINIMUM_AGE=18` |
| Legal documents active | Not established by this technical work |
| Counsel review complete | Not established by this technical work |
| Support contact | `SUPPORT_CONTACT_REQUIRED` if no approved route accompanies distribution |

No owner identity, age threshold, legal approval, support address, signing
identity, or provider data-policy claim is invented here.

## Remaining release blockers

1. Run the Windows `windows-desktop` workflow and retain the exact artifacts
   and packaged evidence under
   `docs/releases/evidence/desktop-byok-beta-r1/`.
2. Execute the packaged security, first-run, credential persistence, offline,
   interruption/recovery, and daily-driver gates against that exact artifact.
3. Resolve the root-license owner and minimum-age policy decisions.
4. Complete the candidate-specific license/notice review and obtain any
   required signing and distribution authorization.
