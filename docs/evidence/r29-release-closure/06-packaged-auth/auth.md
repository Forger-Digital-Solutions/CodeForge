# Packaged authentication observations

The installed `0.4.0` production package initially showed the signed-out first-run screen. The user completed the age/legal acknowledgement and GitHub sign-in interactively. The authenticated renderer displayed the account `Forger Digital Solutions` on the `CodeForge Free` plan and allowed a workspace to open. The rebuilt production-channel package resumed the authenticated workspace after the earlier app was closed, showing session persistence across a package relaunch.

The interactive OAuth callback, PKCE values, token storage contents, logout, and fresh login were not inspected or exercised. This evidence establishes the observed user path into an authenticated workspace, not a full OAuth cryptographic audit. No test-only authentication bypass was added.
