# CodeForge Windows Release Build

This is the canonical Windows release procedure. It is designed for a fresh checkout and does not permit manual edits or binary copies inside `node_modules`.

## Audited environment

- R6 audit base: `41e0102d1a860107a6741026944b369ea4eeaa42`
- Final audited source: the working tree described by the R6 certification report; no R6 commit was created
- Windows: NT `10.0.26200`, x64
- Host Node.js: `24.19.0`
- npm: `12.0.2` (repository audit runner)
- Electron: `44.4.1`
- Embedded Node.js: `24.21.0`
- Electron module ABI: `149`
- `better-sqlite3`: `12.11.1`
- `electron-builder`: `26.15.3`

## Prerequisites

- Windows 10 or 11 x64
- Node.js 20 or newer
- npm 10 or newer
- Visual Studio C++ build tools with MSVC v143 and a Windows SDK
- Python 3 discoverable by node-gyp

End users do not need the native build toolchain. It is required only on release builders.

## Clean source chain

Run from the repository root:

```powershell
npm ci --no-audit --no-fund
npm run typecheck
npm test
npm run build
npm run build --workspace=@codeforge/web
npm run pack --workspace=codeforge-desktop
npm run smoke:all --workspace=codeforge-desktop
npm run dist --workspace=codeforge-desktop
```

The R6 audited test result is 339 files passed and 7 files skipped; 2,545 tests passed and 36 tests skipped. Every skip is an explicit real-PostgreSQL integration suite gated on external database credentials; no flaky or broken local test was suppressed.

## Native SQLite build

`npm run build:native --workspace=codeforge-desktop` launches `apps/desktop/scripts/rebuild-native.mjs`. The launcher:

- invokes `@electron/rebuild` through the absolute host Node executable;
- derives the installed Electron version (`44.4.1` in R6) and rebuilds for ABI `149`;
- rebuilds only `better-sqlite3` from source;
- gives node-gyp a short, deduplicated, build-tool-prioritized PATH;
- supplies a strict environment allowlist so provider credentials and unrelated host secrets do not reach verbose build diagnostics.

The ordinary workspace build does not rebuild native code. `pack`, `dist`, and `dev` invoke the native step where Electron compatibility is required. Windows CI invokes it once through `dist`.

## ABI-independent SQLite test

The SQLite driver test never skips. If the installed binding matches host Node, Vitest executes it directly. If a packaging step has rebuilt the binding for Electron, the same test launches Electron with `ELECTRON_RUN_AS_NODE=1` and executes the durable restart test there. Coverage includes selection, schema creation, parameter binding, commit, rollback, WAL, restart persistence, and corrupt-database failure with handle cleanup.

## Packaged smoke

`npm run smoke:all --workspace=codeforge-desktop` runs:

- full, expected application exit `0`;
- interrupt, expected application exit `73` after persisted ambiguous approval state exists;
- recover, expected application exit `0` after non-resumptive recovery and a fresh successful task.

The harness uses a disposable `--user-data-dir`, a cryptographic per-suite fake secret, a per-run nonce, exact evidence markers, actual repaired file contents, and a 90-second watchdog. It rejects stale result files and does not print the test secret. The full mode performs five renderer reloads.

Set `CODEFORGE_SMOKE_EXECUTABLE` to run the same full assertions against an installed or portable executable.

## Artifacts

`npm run dist --workspace=codeforge-desktop` produces:

- `apps/desktop/release/CodeForge-Setup-0.4.0.exe`
- `apps/desktop/release/CodeForge-Portable.exe`
- `apps/desktop/release/win-unpacked/CodeForge.exe`
- `apps/desktop/release/win-unpacked/resources/app.asar`

The release uses the one-click per-user NSIS configuration because the assisted per-user template can crash in `System.dll` on affected Windows systems. The audit built NSIS and portable artifacts twice with the release directory removed between runs. A silent per-user NSIS install, full installed-app smoke, and silent uninstall all passed. The portable executable passed the same full smoke.

## Payload policy

The ASAR contains desktop output, the runtime CodeForge package closure, zod, bindings, file-uri-to-path, and better-sqlite3 runtime files. It excludes build tools, test workspaces, source maps, declarations, TypeScript build metadata, and native intermediate outputs. Only `better_sqlite3.node` is unpacked. Runtime package license files remain present.

## CI

`.github/workflows/windows-desktop.yml` performs clean install, typecheck, workspace build, tests, NSIS/portable distribution, packaged SQLite verification, full/interrupt/recover smoke, native-binding presence checks, and artifact upload on Windows.

## External release inputs

The audited artifacts are unsigned because no code-signing identity was supplied. A real external-provider call is not part of deterministic release certification and requires an explicitly authorized credential.
