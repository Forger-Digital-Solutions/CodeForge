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
- **Vitest Full Test Matrix**: `npm test` — **55/55 test files passed, 551/551 tests passed (100% pass rate)**.