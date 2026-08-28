# CodeForge Desktop Release Reproduction Guide

This document outlines the canonical, deterministic procedure to build, package, test, and verify CodeForge release artifacts from a fresh repository checkout.

## Prerequisites

- **Operating System**: Windows 10/11 x64
- **Node.js**: `>= 20.0.0` (Node 24 LTS recommended)
- **npm**: `>= 10.0.0`
- **C++ Build Tools**: Visual Studio Build Tools (MSVC v143 / Windows SDK) for native module compilation via `node-gyp`

---

## 1. Fresh Dependency Installation

From the repository root:

```powershell
npm ci
```

This installs all dependencies strictly from `package-lock.json`, executes `patch-package` for `builder-util`, and configures the workspace tree. No manual modifications to `node_modules` are ever required.

---

## 2. Validation & Build

Run typecheck, tests, and monorepo build:

```powershell
# 1. Typecheck across all workspace packages
npm run typecheck

# 2. Execute full unit and integration test suite
npm test

# 3. Compile all workspace packages and native Electron SQLite module
npm run build
```

Expected results:
- Typecheck: 0 errors.
- Test Suite: 55/55 test files passing, 552/552 tests passing (100% pass rate).
- Build: All packages compiled to `dist/`, `better_sqlite3.node` compiled for Electron 33 ABI.

---

## 3. Package Unpacked Runtime

Package the desktop application without installers:

```powershell
npm run pack --workspace=codeforge-desktop
```

Artifacts created:
- `apps/desktop/release/win-unpacked/CodeForge.exe`
- `apps/desktop/release/win-unpacked/resources/app.asar`
- `apps/desktop/release/win-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node`

---

## 4. Run Packaged E2E Smoke Suite

Execute the comprehensive packaged Electron verification harness:

```powershell
# Full smoke (startup, onboarding, workspace containment, workflow, repair, safeStorage DPAPI)
npm run smoke --workspace=codeforge-desktop

# Interruption smoke (pending approval -> process exit 73)
npm run smoke:interrupt --workspace=codeforge-desktop

# Recovery smoke (restart -> non-resumptive recovery -> credential reload -> fresh workflow)
npm run smoke:recover --workspace=codeforge-desktop
```

Or run all smoke modes sequentially:

```powershell
npm run smoke:all --workspace=codeforge-desktop
```

Expected exit codes:
- `smoke`: `0`
- `smoke:interrupt`: `0` (harness captures exit code 73 as expected success)
- `smoke:recover`: `0`

---

## 5. Build Distribution Installers

Generate the NSIS installer and portable executable:

```powershell
npm run dist --workspace=codeforge-desktop
```

Shipping artifacts created:
- `apps/desktop/release/CodeForge-Setup-0.1.0.exe` (NSIS interactive installer)
- `apps/desktop/release/CodeForge-Portable.exe` (Standalone portable executable)
- `apps/desktop/release/win-unpacked/CodeForge.exe` (Unpacked standalone runtime)
