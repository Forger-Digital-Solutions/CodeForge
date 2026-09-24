# Packaged boundary and security status

The final package's archive browser audit passed with Electron `sandbox=true`, `contextIsolation=true`, `webSecurity=true`, and `nodeIntegration=false`; it also confirmed the preload remains bearer-free. Six focused source suites covering Electron baseline, packaged browser configuration, server security/path confinement, MCP client behavior, and extensions passed **95 tests**.

The shell-driven packaged smoke failed before renderer load inside the command sandbox: `RENDER_PROCESS_GONE=launch-failed:49` and `ERR_FAILED (-2)` loading packaged `index.html`. The same final executable and smoke harness passed all three modes outside that sandbox. The `full` run proved primary-renderer control-plane authentication, bearer withheld from preload/secondary renderer, rejection of absent/wrong bearer and forged approval/origin, secondary-renderer IPC rejection, settings validation, and extension lifecycle. `interrupt` and `recover` passed. The interactive desktop also launched and authenticated. The sandbox-only renderer failure is an execution-environment limit, not evidence of a packaged product failure.

The R29 secret scan self-test passed. The scan returned `REVIEW_REQUIRED`: 575 findings, 554 classified synthetic, 11 allowlisted, 10 owner-review items. The ten remaining items point to preserved R28 diagnostic/live-check fixtures; none point to R29 source. They were not auto-suppressed. The machine-readable scan is `secret-scan.json`.

R29 did not complete a hostile-renderer IPC fuzz campaign against the packaged main/preload boundary. In particular, malformed IPC inputs, prototype-shaped payloads, path/junction escapes, and updater/export abuse are **not proven** by this round's packaged evidence.
