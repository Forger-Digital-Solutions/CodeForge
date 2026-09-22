# R27 Browser Runtime Report

Status: `R27_BROWSER_RUNTIME_AND_PACKAGED_SECURITY_PROVEN_RECOVERY_FIX_NOT_PACKAGED`

## Finding

The governed browser had broad real-browser coverage, but a navigation failure after creating a
tab left that tab allocated. For an explicitly targeted tab, Chromium could continue into its
internal error page after `goto` rejected, making an immediate retry race the unfinished error
navigation.

## R27 correction

When an implicit tab's first navigation fails, CodeForge closes and removes it. When a caller
supplies a tab id, CodeForge closes the failed underlying page, replaces it with a fresh page under
the same tab id, clears observations from that page, and returns the original structured navigation
failure. The caller can retry immediately without accumulating hidden tabs.

The unchanged governed boundary still uses isolated contexts, URL and redirect policy checks,
request-level SSRF protection, untrusted/sanitized page evidence, screenshot receipts, download
quarantine, and authority-gated browser writes.

## Deterministic validation

The browser suite ran against an actually installed Chromium-family browser and loopback fixtures:
34/34 tests passed. It exercised multiple addressable research tabs, navigation, inspection,
interaction, screenshots, downloads, ForgeVerify verdicts, policy denials, and the new recovery
path. Server external-tool wiring plus desktop browser-security coverage passed 27/27, and Browser
and Server typechecking passed.

The existing `apps/desktop/release/win-unpacked/resources/app.asar` contains the browser runtime,
tools, and verifier modules. Its packaged BrowserWindow audit passed: sandbox enabled, Node disabled,
context isolation and web security enabled, bearer injection held in main, and no bearer in preload.

## Boundary

The inspected desktop artifact predates the recovery source change, so it does not certify that
specific correction as packaged. No live web research or live cloud model chose these tools in this
validation, and no user-visible browser workbench was exercised. A fresh isolated desktop build and
visible smoke test are still required for that stronger claim.
