# R31 Second-Hardware Validation — Status

## Classification: `EXTERNAL_DEPENDENCY`

Only one Windows host is available in this environment
(`DESKTOP-84IIHSU`, Windows 10.0.26200 x64). No authorized second
physical machine is accessible.

## Validation bundle prepared

A near-single-command validation path exists for a second host:

1. Copy `apps/desktop/release/` artifacts (installer, portable,
   win-unpacked) plus `benchmarks/r31/` to the target host.
2. Run `powershell -ExecutionPolicy Bypass -File benchmarks/r31/install-lifecycle.ps1`
   under a disposable profile for install lifecycle, or simply install
   `CodeForge-Setup-0.4.0.exe` and launch.
3. `npm run smoke:all` equivalent — the packaged smoke modes
   (`full`/`interrupt`/`recover`) run against `win-unpacked\CodeForge.exe`
   and are proven portable within this repo (they passed here on the
   final R31 binary).

Expected artifact hashes (must match on the second host):

- `CodeForge-Setup-0.4.0.exe`: `3ebb9f599cbe82eb4c535317e64abc251f849576ab9dfa5dd70af57da2d565da`
- `CodeForge-Portable.exe`: `9780135e4e3c8ebd20aef04a4f0efe251992ea933ffdd9a4190b9e3db24cf0ad0`
- `win-unpacked/CodeForge.exe`: `0079d559221901662452ec0ef04385ba67339ee41b0495c6888ab8e1b2921439`
- `win-unpacked/resources/app.asar`: `b2cbd913012b021a1cf6af35943a3e4c86c759c59e67bda86878ac3a51155d1d`

## What IS proven single-host

- Packaged startup, auth restore, workflow, control-plane bearer
  rejection, extension lifecycle, credential encryption — all PASS on the
  final binary (`smoke:all` full/interrupt/recover).
- The packaged binary runs from `win-unpacked` with an isolated
  user-data dir (endurance harness proves profile portability).

No second-hardware claim is made. This is an honest external blocker.
