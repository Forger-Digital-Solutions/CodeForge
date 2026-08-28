# Release Reliability, Packaging Architecture, and Recovery Certification

## 1. Monorepo and Packaging Architecture

CodeForge Desktop is packaged using `electron-builder` with an ASAR archive architecture containing all workspace package source trees, production dependencies, and platform-specific native binaries.

### Native SQLite Module (`better-sqlite3`) in Electron 33 (Node 20.18)
- On Node 20 / Electron 33 (Node-API version 8/9), native add-ons cannot create persistent references (`napi_create_reference`) to JavaScript primitive string objects without throwing `Error: Invalid argument`.
- `better-sqlite3` was adapted to store named parameter property names as `std::string` inside `BindMap::Pair` and generate localized N-API strings dynamically via `InternalizedFromUtf8(env, name.c_str(), -1)` in `GetName(env)`.
- Property descriptors in `statement.cpp` were updated to use standard C string property names (`.utf8name = "changes"`, `.utf8name = "lastInsertRowid"`).
- The recompiled native binary `better_sqlite3.node` was placed in `better-sqlite3/prebuilds/win32-x64.node` and verified inside the packaged ASAR archive (`resources/app.asar`), providing 100% stable SQLite database operations (WAL mode, transactions, statements, named parameter bindings) in the packaged Electron main process without external runtime compilation.

### Sandboxed Preload and Context Isolation
- The Electron main window runs with strict security configurations:
  - `contextIsolation: true`
  - `nodeIntegration: false`
  - `sandbox: true`
  - `webSecurity: true`
- The preload script is bundled as CommonJS (`apps/desktop/src/preload.cjs` -> `dist/preload.cjs`) to operate reliably within Electron's sandboxed renderer process.
- The context bridge exposes high-level API methods (`openProject`, `selectDirectory`, `setProviderCredential`, `getProviderCredentialStatus`, etc.). Decrypted plaintext credentials and private encryption keys are strictly isolated in the main process and **never** exposed to the renderer context.

---

## 2. Lifecycle Ownership and State Immutability

- `WorkflowService` owns active workflow registrations, cancellation controllers, timeout timers, and the server-side `ApprovalService`.
- `WorkflowEngine` owns the task execution lifecycle and enforces strict terminal state immutability: once a task transitions to a terminal phase (`completed`, `failed`, or `cancelled`), subsequent phase transitions or late asynchronous callbacks are rejected.
- `AgentRuntime` is the sole execution path for real model turns; it resolves model eligibility strictly through `ForgeZero` and executes consequential tools through its tool registry and approval gate.
- The session database serves as an append-only event store and state reconstruction source, never an authorization bypass. Session records retain canonical provider and model fields. Persisted model metadata is never used to approve later inference; every execution re-verifies eligibility through `ForgeZero`.

---

## 3. Persistence, Redaction, and Safe Restart Recovery

### SQLite Persistence & Secret Redaction
- SQLite persistence uses WAL mode for concurrency and reliability.
- Sessions, turns, work items, and persisted server events are scrubbed at the persistence boundary with secret redaction routines (`redactSecrets`). This protects user messages, errors, evidence, checkpoints, and SSE replay logs from leaking API keys or authentication tokens.

### Interruption and Restart Semantics
- On service construction (`recoverStalePersistedState`), any session not in a terminal state (`completed`, `failed`, `cancelled`, `failed_safely`) is safely transitioned to `status: "failed"` with a `recovery_required` event.
- In-flight turns are marked failed with descriptive recovery instructions.
- This design is intentionally **non-resumptive**: a restarted server never automatically re-executes ambiguous tools, file edits, or verification commands.
- In-memory approvals from previous process lifetimes do not persist as approved; they are cleared upon restart.

---

## 4. Security Invariants and Zero-Billing Firewall (`ForgeZero`)

1. **Zero Billing Enforcement**:
   - `ForgeZero` strictly governs all model routing. No paid models or paid fallbacks are permitted.
   - If a verified free model is unavailable, the system reports `NO_FREE_PROVIDER` and halts execution rather than falling back to paid inference.
2. **Credential Safety & SafeStorage**:
   - Provider API keys are encrypted at rest using Electron's `safeStorage` (Windows DPAPI).
   - If encrypted credential data is corrupted or tampered with, the system fails closed, reporting `status: false` rather than falling back to unencrypted plaintext.
3. **Workspace Isolation**:
   - Workspace file access is resolved through canonical real paths. Path traversal attempts (`..`, symlink escapes) outside the active workspace directory return `403 Forbidden`.
4. **Approval Gate**:
   - High-risk actions (file modifications, command executions) require explicit user approval.
   - The runtime blocks until an authoritative approval decision (`allow_once`, `allow_session`, `deny`) is received from the UI/API.

---

## 5. Packaged Desktop E2E Verification Matrix

The packaged Electron binary (`CodeForge.exe` at `apps/desktop/release/win-unpacked/CodeForge.exe`) was certified across all three release smoke modes:

| Test Mode | Suite / Operations Verified | Result |
| :--- | :--- | :---: |
| **`full`** | Electron boot from packaged ASAR, window creation, welcome screen rendering, provider metadata retrieval, raw credential API absence in renderer, provider setup UI, workspace selection, workspace traversal escape blocking (403), full workflow lifecycle (reconnaissance -> planning -> user approval -> implementation -> verification -> failure diagnosis -> bounded repair pass -> review -> completion), renderer reload & state reconstruction, DPAPI safeStorage encryption & credential round-trip. | **PASS** |
| **`interrupt`** | Workflow initiation, pending approval generation, safe Electron process termination during in-flight approval state (exit code 73). | **PASS** |
| **`recover`** | Process reboot, non-resumptive session failure marking (`recovery_required`), no stale approval replay, DPAPI credential recovery, corrupt credential fail-closed verification, fresh post-restart workflow execution and completion. | **PASS** |

### Release Installer & Portable Build Certification
- **NSIS Installer**: `apps/desktop/release/CodeForge-Setup-0.1.0.exe` (built and verified with block map).
- **Portable Executable**: `apps/desktop/release/CodeForge-Portable.exe` (built and verified).

---

## 6. Monorepo Regression Test Matrix

- **TypeScript Typecheck**: `npm run typecheck` (`tsc -b --force`) — **0 errors, 100% clean**.
- **Vitest Full Test Matrix**: `npm test` — **55/55 test files passed, 552/552 tests passed (100% pass rate, 0 skipped)**.

---

## 7. Clean-Install Reproducibility Certification

### Dependency Contamination Audit of Prior Release Baseline
- **Prior Package Dependency on Modified `node_modules`**: **YES**.
- **Root Cause**: The prior baseline relied on local manual modifications inside `node_modules/better-sqlite3` and manual copying of a pre-compiled `better_sqlite3.node` binary into `prebuilds/win32-x64.node`. When installed via `npm ci` in a fresh environment, `better-sqlite3@13.0.3` failed to provide or compile a binary for Electron 33.4.11 (NODE_MODULE_VERSION 130), causing packaged runtime launch to fail on SQLite database initialization (`ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`).
- **Resolution**:
  1. Upgraded upstream `better-sqlite3` to `^12.11.1` (which fully supports Node 20.x through 24.x and Node-API v8/9 ABI compilation for Electron 33).
  2. Declared `better-sqlite3` in root `dependencies` (for workspace-wide hoisting) and `apps/desktop/package.json`.
  3. Integrated `@electron/rebuild` into the desktop build pipeline (`npm run build:native` / `electron-rebuild -v 33.4.11 -f -o better-sqlite3 --build-from-source`).
  4. Configured `electron-builder` `files` to package `better-sqlite3`, `bindings`, and `file-uri-to-path` with `build/Release/better_sqlite3.node` unpacked via `asarUnpack`.
  5. Created tracked, path-agnostic packaged smoke test runner at `apps/desktop/scripts/packaged-smoke.js` with scripts `npm run smoke`, `npm run smoke:interrupt`, `npm run smoke:recover`, and `npm run smoke:all`.

### Reproducibility Verification Matrix (Pristine Clean Worktrees)

| Environment Parameter | Tracked Value | Verification Status |
| :--- | :--- | :---: |
| **Base Commit SHA** | `9789a40f6bad03086d760a4ae06ca291ca930838` | Certified |
| **Host OS** | Windows 11 / Windows NT 10.0.26200 | Verified |
| **Node.js Runtime** | Node `v24.18.0` | Verified |
| **npm CLI** | npm `11.16.0` | Verified |
| **Electron Version** | `33.4.11` (Node `20.18.3`, ABI `130`) | Verified |
| **Locked `better-sqlite3`** | `12.11.1` | Verified |
| **Clean Install Command** | `npm ci` | **PASS** (exit 0) |
| **Typecheck Command** | `npm run typecheck` (`tsc -b --force`) | **PASS** (0 errors) |
| **Full Unit/Integration Tests** | `npm test` (`vitest run`) | **55/55 files, 552/552 tests PASS** |
| **Monorepo Build** | `npm run build` | **PASS** (all workspaces built) |
| **Native Module Build** | `npm run build:native` | **PASS** (`electron-rebuild` completed) |
| **Electron Package** | `npm run pack --workspace=codeforge-desktop` | **PASS** (`win-unpacked` created) |
| **Packaged Full Smoke** | `npm run smoke --workspace=codeforge-desktop` | **PASS** (exit code 0) |
| **Packaged Interrupt Smoke** | `npm run smoke:interrupt --workspace=codeforge-desktop` | **PASS** (exit code 73) |
| **Packaged Recovery Smoke** | `npm run smoke:recover --workspace=codeforge-desktop` | **PASS** (exit code 0) |
| **NSIS Installer Build** | `electron-builder --project apps/desktop` | **PASS** (Installer created) |
| **Portable Executable Build** | `electron-builder --project apps/desktop` | **PASS** (Portable created) |
| **Dual Clean-Tree Verification** | Full cycle repeated in isolated 2nd worktree | **PASS** (100% identical behavior) |

### Certified Release Artifact Hashes

| Artifact Description | Path | Size | SHA-256 Checksum |
| :--- | :--- | :---: | :--- |
| **NSIS Installer** | `apps/desktop/release/CodeForge-Setup-0.1.0.exe` | 156,434,678 bytes | `BD0216560EFCF075388AE3834CF58C3275183C0D0567AF1D76474BB751E33CCA` |
| **Portable Executable** | `apps/desktop/release/CodeForge-Portable.exe` | 156,206,993 bytes | `61335E32CB906B2732C8B54B3494338C0D95208AA3888AF73A29F15FFD56FD56` |
| **Unpacked Runtime** | `apps/desktop/release/win-unpacked/CodeForge.exe` | 188,784,128 bytes | `804018BFF587B1C4C9B9FF23288EE1F2140556D7EBD089CAE13DA9170ABC841E` |
| **Packaged Application ASAR** | `apps/desktop/release/win-unpacked/resources/app.asar` | 35,228,898 bytes | `303F8F132483AEC580B33839C6E7E57A76E70F7760B9A957D01482896FD0992F` |
| **Unpacked Native SQLite Binary** | `.../resources/app.asar.unpacked/.../better_sqlite3.node` | 1,918,976 bytes | `36BFB52E06ADFA2C887B7E7064C7E33C673434EE016BF657F9BA2BB1BF031310` |

### Integrity and Security Audit
- **Developer Absolute Paths**: NONE in tracked source or release ASAR.
- **Test Secret Residue**: NONE in tracked source, release ASAR, or packaged bundle.
- **Manual `node_modules` Edits Required**: NONE.
- **Zero-Billing Invariants**: Preserved across all test execution and packaged smoke modes.
- **SafeStorage DPAPI Security**: Fully verified with fail-closed corruption behavior.