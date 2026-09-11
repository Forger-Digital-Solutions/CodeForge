# Release Evidence

Current source gates: **PASS** — typecheck and build passed; the full Vitest
suite passed with 58 files and 577 tests after the age-policy change.

Windows package gates: **PENDING**. The exact local commit is not on the
remote, and the authorization expressly prohibits pushing merely to trigger
CI. Therefore there is no exact-candidate workflow run ID, portable artifact,
installer artifact, SHA-256 manifest, packaged security audit, or screenshot
set to cite.

Required next action: authorize pushing the local release commit (or otherwise
make that exact commit available to the repository), then dispatch
`windows-desktop.yml` against that commit and download the resulting artifacts.

Evidence directory:
`docs/releases/evidence/desktop-byok-beta-r1/`.
