# Settings Control Plane + Extensions Foundation — Campaign Report

Branch: `forger-digital-solutions-forgegreen-certified` · Build: 0.4.0 (`35a8fb6`+dirty tree at validation time)

## Scope

Make Settings a truthful unified control plane for the installed Windows product, and give
CodeForge a secure extension foundation that preserves

```
CodeForge Core → controlled Extension Host → permission API → extensions
```

— never arbitrary plugin JavaScript in the renderer or core.

## What was built

### Settings control plane

- **Canonical per-setting registry** (`apps/desktop/src/renderer/settings/settings-defs.ts`):
  every persisted leaf + action + read-only status declares id, label, description, scope
  (application / workspace / account / provider / action), storage location, keyPath, restart
  requirement, and search keywords. A schema-coverage test proves every key in the canonical
  zod schema has a registry entry and every declared keyPath resolves against real defaults.
- **IA reorganization**: deduplicated General (account card → Profile & Account, ForgeZero
  badge → Verification & Safety, repo-index → dedicated page); new **Repository
  Intelligence** and **Extensions** pages; shell back button hidden while Settings owns
  navigation.
- **Per-setting anchors + search**: rows carry `id="setting-*"` anchors; search returns
  individual settings (not just sections) and deep-links + flash-highlights the target row.
- **Scope chips** on every row make APPLICATION/WORKSPACE/ACCOUNT/PROVIDER scope visible.
- **Persistence hardening**: settings read/write extracted to `settings-store.ts`; atomic
  tmp+rename writes; field/group-level corruption salvage; store-level abuse tests cover
  malformed JSON, leftover `.tmp`, and write failure.
- Per-item removal for stale recent projects.

### Extension foundation (`packages/plugins`)

- `manifest.ts` — strict zod manifest (`codeforge-extension.json`): namespaced id, semver,
  `main` confined to the folder, `engines.codeforge` range, declared permissions,
  contributes.commands/settings, strict-unknown-key rejection.
- `host.ts` — `node:vm` sandbox per extension. The context exposes only the frozen,
  permission-checked `codeforge` API: no `require`, `process`, `fs`, `fetch`, or timers.
  Module evaluation and `activate()`/`deactivate()` run under timeouts; extension failures
  are contained as per-extension error state.
- `api.ts` — capability surface: settings (declared keys only, type-checked), commands
  (contributed ids only), notifications (routed through user prefs), secrets
  (safeStorage-sealed, per-extension namespace), `workspace:read` resolved lazily per access.
- `manager.ts` — managed-dir discovery, developer-folder loading, persisted enable/disable,
  uninstall (state + sealed secrets cleaned), restart restoration, corrupt-manifest
  containment.
- Desktop wiring (`main.ts`, `preload.ts`/`preload.cjs`): `extensions:list/setEnabled/
  uninstall/loadDevFolder/getSetting/setSetting/runCommand` IPC, all sender-guarded +
  payload-validated; extension secrets sealed under `codeforge:extension-secrets`; state
  under `codeforge:extensions`; host starts after runtime init, never blocks boot;
  `Extensions` settings page lists status, permissions, settings, and error truthfully.

## Evidence

### Source suite

- `npm test`: **2932 pass / 36 skip / 2 fail** — the 2 failures are the intentional
  FG-11/FG-12E provenance canaries that fire because the working tree differs from the
  certified R16 source-state (expected under any source change).
- `apps/desktop`: 39 files / **335 tests** incl. registry coverage, identity, settings UI.
- `packages/plugins`: **25 tests** — manifest abuse, sandbox escape attempts (require /
  process / fs / fetch / timers all absent), permission denial, throwing activate/deactivate/
  commands contained, infinite-loop kill, settings schema enforcement, enable/disable/
  uninstall/restart round-trips, corrupt-manifest containment, lazy workspace:read.
- `settings-store.test.ts`: **9 tests** — malformed JSON salvage, atomic write, tmp cleanup,
  simulated write failure, Windows paths.

### Packaged product (`release/win-unpacked`, Electron 44.4.1)

- `PACKAGED_INTERNAL_DEPENDENCY_GRAPH_PASS` — `@codeforge/plugins` shipped in asar.
- `PACKAGED_RUNTIME_DEPENDENCY_GRAPH_PASS` — 321 modules, 15 externals.
- `PACKAGED_BROWSER_SECURITY_VALID=PASS` — sandbox, no nodeIntegration, contextIsolation,
  bearer-free preload.
- `PACKAGED_BUILD_IDENTITY_VALID=PASS`.
- Packaged smoke **full**: all markers PASS, including the new settings/extension set:
  `packaged_settings_roundtrip`, `packaged_settings_invalid_rejected`,
  `packaged_extensions_loaded` (fixture active + corrupt manifest contained),
  `packaged_extension_command`, `packaged_extension_workspace_read`,
  `packaged_extension_lifecycle`, `settings_repo_intel_page`, `settings_extensions_page`,
  plus the pre-existing control-plane trust boundary, renderer lifecycle, credential, and
  zero-prompt workflow markers.
- Packaged smoke **interrupt**: `electron_restart_interruption_ready=PASS` (exit 73).
- Packaged smoke **recover**: `electron_restart_failed_safely`, `no_approval_replay`,
  `fresh_task`, credential seal/legacy-migration markers all PASS.

### Native probes (this build)

- `launch-probe/` — **11 PASS / 0 WARN / 0 FAIL**: first frame +146 ms, zero renderer
  console errors, every control accessible-named, no overflow, 0% idle CPU, graceful
  WM_CLOSE exit in 2.3 s, no stray processes, runtime.json cleared, no console windows.
- `headless-probe/` — **PASS**: npm/node/cmd/bash children through the packaged ConPTY
  executor with zero console windows flashed.

## Defects found & fixed during validation

- `api.ts` snapshotted `getWorkspaceInfo()` at activation — an extension activated at boot
  saw `workspace: null` forever. Fixed to resolve lazily per access; regression test +
  packaged assertion (`packaged_extension_workspace_read`) guard it.
- `@codeforge/plugins` missing from electron-builder files — packaged main would have
  crashed on import. Added; internal-deps audit now proves it ships.
- `reset-preferences` action incorrectly declared `app-settings` storage → `none`.
- Duplicate shell + settings back buttons in settings mode → shell hides its own.

## Certification verdicts

| Surface | Verdict |
|---|---|
| Settings schema/persistence (validation, migration, corruption salvage, atomic writes) | CERTIFIED |
| Settings IA + per-setting registry + deep links + scope visibility | CERTIFIED |
| Settings UI truthfulness (no dead/duplicate controls; safeguards read-only) | CERTIFIED |
| Extension host isolation (no Node/Electron/network in sandbox) | CERTIFIED |
| Extension permissions, lifecycle, secrets, failure containment | CERTIFIED |
| Extension IPC/preload surface in packaged product | CERTIFIED |
| Packaged Windows behavior (smoke full/interrupt/recover, audits, native probes) | CERTIFIED |
| Managed-extension install UX (no store/catalog yet — dev-folder + managed-dir only) | FOUNDATION ONLY |
| Renderer-embedded extension UI contributions | NOT SHIPPED (by design — no arbitrary renderer injection) |

## Known limits

- `extensions:loadDevFolder` opens a native directory dialog; the IPC contract is exercised
  end-to-end by unit + manager tests, the OS dialog itself is not automatable in smoke.
- Extension secrets are exercised via the sealed store path; no packaged UI for secret
  entry exists yet (foundation ships the API + storage boundary).
