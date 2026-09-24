# R29 technical demonstration replay

This transcript records real observations, including the blocked gates; it is not a staged end-to-end release video. `transcript.json` links each scene to its primary receipt.

1. Run `node benchmarks/r29/verify-r28-freeze.mjs` from the repository root. Expect 52 matched files, zero mismatches.
2. Inspect `07-packaged-dogfood/packaged-run-receipt.json` for the actual UI session, route, five tool calls, completion decision, diff, and hidden-verifier result. Run `node docs/evidence/r29-release-closure/07-packaged-dogfood/hidden-verify.mjs` against the preserved corrected fixture to recheck six cases. This rechecks the resulting behavior; it does not replay the hosted model call.
3. Inspect `08-ipc-security/packaged-smoke-receipt.json`. On a Windows desktop allowed to launch Electron renderer children, `node apps/desktop/scripts/packaged-smoke.js full`, then `interrupt`, then `recover` reproduces the three packaged smoke gates. The command sandbox on this host blocked renderer creation, so these commands were run outside it for the passing receipt.
4. Inspect `12-diagnostics-export/receipt.json` for the packaged support-bundle success path. The raw bundle stays in the local CodeForge profile; the receipt includes its hash and a limited credential-pattern scan.
5. Compare the ignored local binaries with `23-update-install-uninstall/package-artifacts.json`; check Authenticode separately. The package built from source commit `0dbca66` carries a production endpoint stamp and is unsigned.

Replaying the authenticated UI task from scratch requires a human to sign in and a fresh copy of the small bug fixture. The preserved fixture is already corrected, so its hidden verifier is a result check, not a second autonomous task run. No GitHub PR, integrated browser task, or live cross-provider failover is represented as demonstrated here.
