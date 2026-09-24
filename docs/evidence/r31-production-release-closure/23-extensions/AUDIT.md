# R31 Extensions — Desktop Lifecycle Audit

Extension host: `packages/plugins` (`ExtensionManager` + `ExtensionHost`), wired into the
desktop main process at `apps/desktop/src/main.ts:650` and bridged into the agent tool surface
via `pluginCommandHost` (`main.ts:1201` → `external-tools.ts`).

Lifecycle evidence (code-traced + `packages/plugins/test/extensions.test.ts` green):

- **install**: `loadDeveloperExtension` validates manifest + engine compat, registers without
  copying; managed installs scan `extensionsDir` at `start()`.
- **incompatible install**: `engineSatisfied(appVersion, engines.codeforge)` fails → refused
  (`loadDeveloperExtension` returns `{ok:false}`; managed entries land `status:"error"`).
- **malformed manifest**: `parseExtensionManifest` throw → per-extension `error` entry, host
  boots normally (never a crash).
- **enable/disable**: `setEnabled` persists the record and activates/deactivates; disabled
  extensions expose no `plugin__` tools (bridge re-enumerates live `list()`).
- **update/interrupted update**: no remote update channel exists (no marketplace); a half-copied
  managed dir fails manifest parse → `error` state, contained.
- **uninstall**: deactivate → record delete → `secretStore.deleteAll(extensionId)` → managed
  files removed (dev folders untouched).
- **crash containment**: `node:vm` sandbox; eval 3s / lifecycle 5s / command 10s timeouts;
  exceptions → `status:"error"` + `lastError`; host unaffected.
- **restart persistence**: `ExtensionStateStore` (settings.json in production) — enabled/disabled
  state and settings survive restarts; `start()` re-discovers + re-activates only `enabled` ones.
- **boot safety**: `initExtensions()` runs after `server.start()` — extensions cannot block boot.

Classification: **RELEASE_CERTIFIED** (local extension lifecycle).
