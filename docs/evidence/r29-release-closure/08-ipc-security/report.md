# Packaged boundary and security status

The final package's archive browser audit passed with Electron `sandbox=true`, `contextIsolation=true`, `webSecurity=true`, and `nodeIntegration=false`; it also confirmed the preload remains bearer-free. Six focused source suites covering Electron baseline, packaged browser configuration, server security/path confinement, MCP client behavior, and extensions passed **95 tests**.

The shell-driven packaged smoke failed before the renderer loaded: `RENDER_PROCESS_GONE=launch-failed:49` and `ERR_FAILED (-2)` loading the packaged `index.html`. The same packaged executable launched in the interactive desktop session, authenticated, and completed a real coding task. This discrepancy is unresolved, so the smoke gate is **failed/inconclusive for product security**; its IPC, extension, updater, and recovery markers cannot be counted as passed in R29.

The R29 secret scan self-test passed. The scan returned `REVIEW_REQUIRED`: 575 findings, 554 classified synthetic, 11 allowlisted, 10 owner-review items. The ten remaining items point to preserved R28 diagnostic/live-check fixtures; none point to R29 source. They were not auto-suppressed. The machine-readable scan is `secret-scan.json`.

R29 did not complete a hostile-renderer IPC fuzz campaign against the packaged main/preload boundary. In particular, malformed IPC inputs, prototype-shaped payloads, path/junction escapes, and updater/export abuse are **not proven** by this round's packaged evidence.
