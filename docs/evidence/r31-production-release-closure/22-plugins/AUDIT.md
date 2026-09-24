# R31 Plugins / Extensions Audit

CodeForge has ONE extension system (`packages/plugins` = the extension host); "plugins" and
"extensions" are the same subsystem here, not two competing concepts. MCP servers are a
separate governed surface (`packages/mcp`), not extensions.

## Lifecycle (ExtensionManager — `manager.ts`)

discoverManaged → loadFromDir (manifest parse; failures become `error`-state entries, never a
crash) → engine-compat check (`engines.codeforge` vs app version) → activate via ExtensionHost.
setEnabled persists + activates/deactivates; uninstall deactivates, deletes the record, wipes
the extension's secrets (`secretStore.deleteAll`), removes managed files (dev-mode links never
delete the developer's source). Settings are namespaced per-extension with manifest-declared
type validation.

## Isolation (ExtensionHost — `host.ts`)

Extension code runs in a `node:vm` context exposing only `module`/`exports`/`codeforge`/`console`
— no `require`, `process`, `fetch`, `fs`, `child_process`, timers. Isolation is structural.
Bounds: 3s module eval, 5s activate/deactivate, 10s command, 1MB main-file cap, 16KB command
result cap. Any throw → status `error` + `lastError`; the host process is never touched.

## Agent bridge (`plugin__` tools)

Desktop injects a live `PluginToolHost` (`main.ts:1201`) reading the manager; contributed
commands become `plugin__<ext>__<cmd>` tools — write-gated, Tier 2, re-enumerated per run so
disable takes effect without restart. Read-only roles are denied (external-tools-wiring tests).

## Desktop UX

Settings → Extensions section + IPC (`extensions:list|setEnabled|uninstall|loadDevFolder|
getSetting|setSetting|runCommand`). Extension host starts AFTER the server — an extension can
never block or crash app boot.

Tests: `packages/plugins/test/extensions.test.ts` — green.

Classification: **RELEASE_CERTIFIED** for local extensions. Remote install/discovery does not
exist (see 25-marketplace).
