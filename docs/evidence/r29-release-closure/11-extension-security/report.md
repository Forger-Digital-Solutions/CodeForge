# Extension security status

The extension source suite passed in the focused security run, including checks that ordinary extension code has no direct `require`, `process`, `fetch`, or timers and that declared permissions are enforced. The packaged full smoke could not load its fixture renderer, so packaged hostile-extension lifecycle evidence was not obtained in R29.

The extension host executes extension code with Node's `vm` in the CodeForge process. The tests demonstrate cooperative capability scoping, but this architecture is **not certified as a hardened boundary for untrusted third-party code**. Realistic VM/prototype escape attempts, credential exfiltration, network denial, and packaged upgrade/uninstall secret cleanup remain open.
