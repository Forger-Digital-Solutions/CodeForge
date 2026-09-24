# R31 Capability Persistence / Restart — Evidence

## Proven by packaged smoke `recover` mode (final R31 binary)

Evidence source: `npm run smoke:all` recover-mode output on
`win-unpacked/CodeForge.exe` (this campaign's final build).

- `electron_restart_failed_safely=PASS` — app state survives an
  interrupted (kill-73) restart without corruption.
- `electron_restart_no_approval_replay=PASS` — granted approvals are not
  replayed across restart; authority is not smuggled through persistence.
- `credential_restart_decrypt=PASS` — safeStorage-encrypted credentials
  decrypt correctly after restart.
- `legacy_plaintext_credential_migrated=PASS` + `rejected=PASS` —
  plaintext credentials are sealed on restart, never silently reused.
- `corrupt_credential_fails_closed=PASS` — corrupted credential payload
  fails closed, not open.
- `electron_restart_fresh_task=PASS` — a fresh task starts cleanly on the
  recovered instance.
- `packaged_auth_restore=PASS` (full mode) — authenticated session state
  restores across launch.

## Extension state persistence

`ExtensionManager` persists install/enable/disable/uninstall + settings +
secrets to disk (`packages/plugins/src/manager.ts`); packaged full-mode
smoke proved `packaged_extension_lifecycle=PASS` (load → command →
disable lifecycle within a session). Disabled extensions surface as
`disabled`/`error` state, not silently re-enabled — evaluation is
time-bounded and per-extension failures land in extension-local error
state (crash containment).

## MCP / external tool persistence

MCP servers are config-driven (`external-tools.ts`): a configured server
re-handshakes on demand; a dead server reports degraded/refused, never
phantom-healthy (mcp-lifecycle evidence: 9/9 cases). Nothing external is
enabled by default, so restart cannot resurrect an unconfigured tool.

## Broken-integration startup

A bad extension/server config cannot prevent launch: extension evaluation
errors are captured per-extension; MCP connect failures surface as
`UNREACHABLE`/`refused` state. Proven by mcp-lifecycle `dead-server` and
`crash-after-init` cases and by extension error-state handling.

## Residual gap (honest)

Cross-restart *extension enable/disable* persistence is asserted from the
manager's persistence code + audit, not from a dedicated packaged
restart-cycle test — the packaged recover smoke covers credentials,
approvals, task state, and session restore, which are the security-
sensitive persistence paths.
