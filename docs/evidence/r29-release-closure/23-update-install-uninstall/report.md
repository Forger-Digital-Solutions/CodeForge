# Package and lifecycle status

The production-channel packaging gate reached the live cloud readiness endpoint and passed build identity and endpoint audits. R29 found a missing `electron-updater` package in `app.asar`; the manifest now includes it and its transitive runtime dependencies, and the release script runs the runtime dependency audit as a mandatory gate. The rebuilt archive passed the dependency graph audit: 353 runtime modules and 18 external imports scanned.

The checkout was clean immediately before the final production build, but the release wrapper temporarily modifies tracked `cloud-endpoints.json` to stamp the production endpoint before the build-identity script runs. The package therefore reports `dirty=true`, and `audit-packaged-build-identity.mjs release --require-clean` fails. The ordinary identity audit passes and names the correct R29 commit, but a strict clean-source release artifact is not yet produced by this pipeline.

The final package was launched from `win-unpacked` in an authenticated desktop session and showed the prior completed task and saved model choice after relaunch. The earlier package performed the actual coding dogfood run. All three packaged smoke modes passed outside the command sandbox: `full`, `interrupt` (expected exit 73), and `recover`. The full smoke covered updater status/check/install guards; recovery covered corrupt credential refusal, plaintext migration, and no approval replay. The same smoke failed renderer launch inside the command sandbox, an environment restriction established by the successful outside-sandbox run.

Installer upgrade, uninstaller behavior, rollback, user-profile preservation across installer versions, and a signed updater round trip were not exercised. The generated binaries remain unsigned.
