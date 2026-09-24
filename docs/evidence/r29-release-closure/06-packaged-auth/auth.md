# Packaged authentication observations

The installed `0.4.0` production package initially showed the signed-out first-run screen. The user completed the age/legal acknowledgement and GitHub sign-in interactively. The authenticated renderer displayed the account `Forger Digital Solutions` on the `CodeForge Free` plan and allowed a workspace to open. The rebuilt production-channel package resumed the authenticated workspace after the earlier app was closed, showing session persistence across a package relaunch.

After several hours, one rebuilt launch presented the signed-out first-run screen despite sealed access and refresh token fields still being present in the profile store. The user signed in again; the cause of the earlier restoration failure was not isolated. A later launch of the final package restored the authenticated workspace and prior task. The final renderer also displayed the persisted GPT-OSS 120B model choice after R29 fixed a startup settings effect that had stopped before the runtime endpoint appeared.

The interactive OAuth callback, PKCE values, token storage contents, logout, and a controlled logout-then-fresh-login cycle were not inspected or exercised. This evidence establishes the observed user path into an authenticated workspace, not a full OAuth cryptographic audit. No test-only authentication bypass was added.
