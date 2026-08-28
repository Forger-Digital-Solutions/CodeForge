# CodeForge Windows Release Build

This is the canonical Windows release procedure. It is designed for a fresh checkout and does not permit manual edits or binary copies inside `node_modules`.

## Audited environment

- Starting source: `728608472a08f0594526e5390f70d6ea7fb1b86b`
- Final audited source: the local audit commit containing this document (`git rev-parse HEAD`)
- Windows: NT `10.0.26200`, x64
- Host Node.js: `24.18.0`
- npm: `11.16.0`
- Electron: `33.4.11`
- Embedded Node.js: `20.18.3`
- Electron module ABI: `130`
- `better-sqlite3`: `12.11.1`
- `electron-builder`: `25.1.8`

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

The audited test result is 55/55 files and 556/556 tests passing with zero skipped tests.

## Native SQLite build

`npm run build:native --workspace=codeforge-desktop` launches `apps/desktop/scripts/rebuild-native.mjs`. The launcher:

- invokes `@electron/rebuild` through the absolute host Node executable;
- targets Electron `33.4.11` and ABI `130`;
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

- `apps/desktop/release/CodeForge-Setup-0.1.0.exe`
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
