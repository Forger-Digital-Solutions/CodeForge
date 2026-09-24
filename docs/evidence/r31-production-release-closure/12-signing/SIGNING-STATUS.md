# R31 Windows Signing — Status

## Evidence

`readiness.json` — produced by `benchmarks/r31/signing-readiness.ps1`
against the final R31 artifacts.

## Result: `SIGNING_PENDING` — external blocker

- `availableCodeSigningIdentityCount: 0` — no code-signing certificate in
  any accessible store
- `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`: not configured
- All three artifacts: `Get-AuthenticodeSignature` = `NotSigned`,
  no signer, no timestamp:
  - `CodeForge.exe` (win-unpacked): `0079d559221901662452ec0ef04385ba67339ee41b0495c6888ab8e1b2921439`
  - `CodeForge-Setup-0.4.0.exe`: `3ebb9f599cbe82eb4c535317e64abc251f849576ab9dfa5dd70af57da2d565da`
  - `CodeForge-Portable.exe`: `9780135e4e3c8ebd20aef04a4f0efe251992ea933ffdd9a4190b9e3db24cf0ad0`

Electron-builder's log invoked `signtool.exe`, but with no certificate
available the authoritative post-build check reports `NotSigned`.

## Product-side state

The signing gate itself is implemented (readiness harness produces an
authoritative receipt and would fail certification on `NotSigned` when a
signature is required). What is missing is a legitimate Authenticode
certificate — that is a procurement/infra dependency, not a CodeForge
software defect. Per campaign rules, no fake/self-signed certificate was
used to claim completion.

## Classification

`EXTERNAL_DEPENDENCY` — production signing blocked on certificate
availability. All other artifact gates (build, hash receipts, packaged
smoke) pass.
