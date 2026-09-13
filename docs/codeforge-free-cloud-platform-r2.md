# CodeForge Free Cloud Platform — R2 Certification Record

**Verdict:** `CODEFORGE_FREE_CLOUD_PLATFORM_R2_BLOCKED`

R2 runtime hardening is implemented and source-level regression coverage passes. The candidate
cannot be certified because the packaged Windows renderer exits with Electron
`RENDER_PROCESS_GONE=launch-failed:49` while loading the packaged renderer, before first paint,
workspace UI, settings UI, or packaged workflow evidence. The same failure was reproduced with the
prior known-good R1 packaged executable, so this is recorded as an environment-level packaged
renderer blocker, not converted into a false product pass.

## Reconciled starting state

- Repository: `G:\CodeForge`.
- Initial R2 HEAD: `c6ac0541117d696e2f1f97c4248154c4b0d75c12`.
- R1 source record: implementation complete, packaged fresh-profile and real-provider execution
  still outstanding.
- R1 fixed-port smoke root cause: the packaged retry attempted to bind `127.0.0.1:3210` and hit
  `EADDRINUSE`; see `apps/desktop/release/r1-smoke-retry.stdout.log`.
- Final source candidate: `8b05773dd892de96bec52c5d7325622817e4dc75`.

## Runtime architecture

The desktop now starts `CodeForgeServer` on an ephemeral loopback port (`port: 0`), records the
actual endpoint only in the trusted main process, and exposes it to the primary renderer through
sender-guarded asynchronous IPC. Workspace and model-routing fetches wait for that endpoint and
use a dead `127.0.0.1:0` fallback until it is available. No renderer code contains a fixed runtime
port or a bearer secret.

Each instance writes an atomically replaced `runtime.json` manifest containing instance ID, PID,
profile, endpoint, startup time, version and ownership metadata. Startup classifies missing, stale,
active, malformed, non-loopback and ownership-mismatch records. Cleanup removes a manifest only
when its instance ID and PID match the current owner.

## Evidence

### Source and focused tests

- `npm.cmd run build --workspace=codeforge-desktop`: passed.
- Focused desktop/runtime suite: 5 files, 27 tests passed.
- Packaged browser security audit: passed (`sandbox=true`, `nodeIntegration=false`,
  `contextIsolation=true`, `webSecurity=true`, bearer injection remains main-process-owned).
- Runtime port tests prove an occupied unrelated listener does not break CodeForge and two server
  instances receive distinct endpoints.

### Full suite

`npm.cmd test` completed in 328.21 seconds:

- 312 files passed, 2 failed, 7 skipped.
- 2,356 tests passed, 2 failed, 36 skipped.
- The two failures are `fg11-source-state.test.ts` and `fg12e-harness-provenance.test.ts`, both
  caused by the repository no longer matching `docs/codeforge-forgegreen-certified-source-state.json`.
  This inherited source-state drift was not masked by updating the certified baseline.

### Provider discovery and policy

The live OpenRouter catalog integration discovered 22 current zero-unit candidates with no catalog
errors and registered them for ForgeZero evaluation. This is catalog evidence only: no candidate is
claimed as qualified or executable without a legitimate credential, capability check, allowance
evidence and qualification receipt. The R1 inventory remains the policy source for OpenRouter,
Z.AI, Groq, Gemini, SambaNova, Mistral, Cloudflare Workers AI, OpenCode Zen and the excluded
promotional, paid, development-only and product-only providers.

No environment credential value was persisted or emitted. No environment credential, manual
provider connection, OpenRouter PKCE browser completion, real free-cloud coding task, same-model
failover, cross-model ForgeAuto failover, or packaged UI flow was certified in this run.

### Packaged artifacts

Built from source candidate `8b05773dd892de96bec52c5d7325622817e4dc75`:

| Artifact | Size | SHA-256 |
|---|---:|---|
| `apps/desktop/release/CodeForge-Setup-0.3.0.exe` | 85,944,333 bytes | `9F00742C0A7371DF80A19F983ED37E0EF107EE2B497E261C901A67C1A216064E` |
| `apps/desktop/release/CodeForge-Portable.exe` | 85,673,584 bytes | `B9F592F8EEEF47E3D2B7B098102121EBBADAF5F679EA478C0D097914047C7CA8` |
| `apps/desktop/release/win-unpacked/CodeForge.exe` | 188,875,264 bytes | `54548AE86EDD165EDB3C4F0DA3E739A1244596BA6962435DDC39A22FAF54A5DE` |

### Packaged smoke

Both `node apps/desktop/scripts/packaged-smoke.js full` and `recovery` reached server startup and
recorded distinct ephemeral endpoints (`62722` and `62740`), then failed before UI evidence at:

`RENDER_PROCESS_GONE=launch-failed:49`

The failed load was the canonical packaged `file:///.../resources/app.asar/.../renderer/index.html`
path. The same launch failure was reproduced against the prior R1 packaged executable, so the
smoke result is an honest blocker. The recovery run classified the prior manifest as `stale`,
demonstrating the stale-record path without claiming successful recovery.

## Remaining blockers and next milestone

1. Resolve the host/Electron renderer launch failure and rerun fresh-profile full and recovery
   smoke until first paint and deterministic UI evidence are captured.
2. With a legitimate current free-provider credential, complete environment/manual connection,
   OpenRouter PKCE, qualification, same-model failover, cross-model ForgeAuto failover, and one
   real bounded coding task.
3. Reconcile the inherited ForgeGreen source-state document through its intended certification
   workflow; do not alter it merely to make the full suite green.

The next milestone is a clean packaged renderer launch followed by real free-cloud qualification;
R2 remains blocked until those gates have evidence.
