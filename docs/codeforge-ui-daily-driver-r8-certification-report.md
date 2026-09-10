# CodeForge R8 daily-driver UX certification

Status: `CODEFORGE_R8_DAILY_DRIVER_UX_PASS`

CodeForge R8 passes the daily-driver UX certification on the secure packaged Windows desktop. The sandbox-enabled `release-r8-secure-final` completed the full, interruption, and recovery smoke traces outside the Codex command runner's nested containment. A fresh profile completed the real staging GitHub OAuth redirect in secure candidate 5, and the exact final artifact subsequently restored that profile's encrypted Cloud credentials and authenticated zero state.

No GitHub human-approval page was observed. The account already appeared to have an authorization grant, so GitHub redirected the browser through the callback without presenting a new consent page. The certified result is therefore `COMPLETED_EXISTING_GRANT_REDIRECT`, not a witnessed human approval. Live denial/cancellation was not exercised. Code inspection found that provider denial currently ends on a static Cloud 400 response instead of redirecting an error to the desktop loopback callback, so the desktop would likely wait until timeout; this remains a known UX limitation. Automated tests cover endpoint rejection and friendly error sanitization, but not that end-to-end denial path.

## Certified secure package

The final certification artifact is `apps/desktop/release-r8-secure-final`.

- Electron 33.4.11 ran with `sandbox: true`, `nodeIntegration: false`, `contextIsolation: true`, and `webSecurity: true`.
- The full smoke reached first paint and recorded `PACKAGED_STARTUP=PASS` and `PACKAGED_FULL_SMOKE_OK`; the final smoke log contains zero renderer-gone or packaged-failure markers.
- The interruption and recovery smokes recorded `PACKAGED_INTERRUPT_EXPECTED_EXIT` and `PACKAGED_RECOVERY_SMOKE_OK`.
- Runtime imports for ForgeGreen, 8-Bit, and Cloud DB passed from the packaged archive.
- Repository indexing and known-answer search passed against 258 files and 259 symbols.
- The workflow completed after bounded repair, then remained coherent across five renderer reloads.
- The renderer exposed no raw credential-read API.
- Packaged `safeStorage` encryption, credential round-trip, corrupt-credential fail-closed behavior, restart decryption, and no-approval-replay recovery passed.
- A fresh post-restart no-op workflow terminated as `blocked` through the completion gate instead of being reported as success.

The final exact-endpoint, internal-dependency, runtime-dependency, and browser-security audits passed. All 20 required `@codeforge/*` packages were present, and the runtime audit scanned 196 packaged modules and all 15 external runtime packages. This includes `xtend`, closing the earlier `Cannot find module 'xtend/mutable'` packaging defect. The exact final executable also restored the real authenticated account on the `free` plan, displayed the authenticated zero state, and exposed no raw credential API.

## Candidate bisection and `launch-failed:49`

Every secure candidate below retained the production renderer security settings and embedded the exact staging endpoint.

| Candidate | Controlled change | Endpoint audit | Observed result |
| --- | --- | --- | --- |
| `release-r8-secure-candidate2` | Secure package using the earlier packaged renderer URL construction | PASS | `launch-failed:49` when run inside the nested Codex command sandbox |
| `release-r8-secure-candidate3` | Replaced the packaged renderer URL construction with `BrowserWindow.loadFile()` | PASS | Same nested-containment failure |
| `release-r8-secure-candidate4` | Began creating the window before server initialization | PASS | Same nested-containment failure |
| `release-r8-secure-candidate5` | Awaited secure window content loading before server startup | PASS | Full, interruption, and recovery smokes passed outside nested command containment |

The earlier exit 49 observations were a certification-harness containment problem: the packaged Electron process was launched from the already sandboxed Codex command runner, nesting Chromium's Windows renderer sandbox inside another restricted process boundary. The secure candidate reached first paint and completed all traces when launched from an ordinary host process outside that command sandbox. The historical failures are retained as diagnostic evidence, but there is no unresolved `launch-failed:49` for the certified launch path.

The bisection improved startup ordering and canonical file loading, but the passing result is not attributed solely to either source change because the nested command sandbox was a confounding launch condition. No production `--no-sandbox` switch or renderer-sandbox bypass was added.

## Staging endpoint and OAuth evidence

The packaged endpoint audit passed for secure candidates 2 through 5 and the final artifact with the exact authority:

`https://codeforge-cloud-staging.onrender.com`

The public staging probe passed all 21 of 21 checks. The packaged application ignored development environment overrides, rejected loopback authority for staging/production, and used the endpoint embedded in its packaged manifest.

A fresh packaged user profile completed the real staging GitHub OAuth callback under secure candidate 5 and established an authenticated CodeForge Cloud session. Access and refresh tokens were stored through Electron `safeStorage`; candidate 5 first proved restart restoration, then the exact final artifact reopened the same encrypted profile and recovered the free-plan account and authenticated zero state without exposing raw tokens to the renderer.

The OAuth evidence must be described precisely:

- `humanApprovalPageObserved`: `false`
- `authorizationResult`: `COMPLETED_EXISTING_GRANT_REDIRECT`
- GitHub appears to have reused an existing authorization grant and redirected immediately; this is an inference from the observed redirect, not proof of a new human approval.
- A live user-denial or cancellation was not performed. Provider denial currently returns a static Cloud 400 instead of redirecting `error=access_denied` to the loopback listener, so the desktop would likely time out. Automated endpoint/auth tests prove fail-closed request rejection and sanitized user-facing errors, but they do not certify this end-to-end denial experience.

Static packaged provenance, the live callback target, encrypted persistence, and restart restoration are certified. No credentials are included in this report or its JSON companion.

## Source-manifest restoration

The staging manifest was used only to create and audit the preserved packaged candidates. The source file `apps/desktop/cloud-endpoints.json` was restored after packaging to:

- channel: `development`
- development endpoint: `http://127.0.0.1:3220`
- no staging or production endpoint in source

This prevents a local checkout from remaining accidentally stamped for staging while preserving the packaged evidence.

## ForgeZero and inference safety

ForgeZero remains the sole routing eligibility boundary. Current policy gates passed for both required prohibitions:

- paid inference is never selected or used as fallback;
- local LLM inference is ineligible even when its nominal price is zero.

Unknown or unverifiable free status continues to fail closed. The packaged smoke provider is an explicit certification fixture and is not evidence of paid or local production inference.

## Visual and UX evidence

The secure final artifact captured and visually passed the following packaged states:

1. `01-authenticated-zero-state.png` — authenticated workspace zero state.
2. `02-workspace-ready.png` — indexed workspace and repository intelligence.
3. `02a-model-catalog.png` — model-selection catalog.
4. `02b-model-filter.png` — model/provider filtering.
5. `03-workflow-completed.png` — completed workflow after bounded repair.
6. `04-recovery.png` — restart recovery and continued usability.

The captures are under `apps/desktop/release-r8-secure-final/smoke-captures`. They were produced by the sandbox-enabled final artifact, not by the no-sandbox diagnostic.

## Verification summary

- Focused endpoint and authentication tests: 29 passed.
- Full desktop suite: 13 files, 99 tests passed.
- ForgeZero suite: 9 files, 87 tests passed.
- Full TypeScript compilation: passed.
- Renderer Vite production build: passed.
- Packaged internal dependency audit: passed.
- Packaged runtime dependency audit: passed.
- Exact packaged staging endpoint audit: passed for candidates 2–5.
- Public staging remote probe: 21/21 passed.
- Secure final artifact full/interruption/recovery smoke: passed with zero renderer-gone or packaged-failure markers.
- Exact final artifact restoration of the encrypted real-OAuth profile and free-plan authenticated zero state: passed.
- `git diff --check`: passed at the recorded checkpoint.

## Diagnostic-only artifact

`apps/desktop/release-r8-sandbox-diagnostic2` is permanently diagnostic and marked `NOT_FOR_RELEASE`.

- Renderer sandbox: disabled.
- Node integration: disabled.
- Context isolation: enabled.
- Web security: enabled.
- Full smoke: passed for diagnosis only.

It is not a production candidate, contributes no secure-startup evidence, must never be released, and must not replace the certified sandbox-enabled package.

## Release gates

| Gate | Result |
| --- | --- |
| `PACKAGED_INTERNAL_DEPENDENCY_GRAPH` | PASS |
| `PACKAGED_RUNTIME_DEPENDENCY_GRAPH` | PASS |
| `EXACT_PACKAGED_AUTH_ENDPOINT` | PASS |
| `PACKAGED_BROWSER_SECURITY_AUDIT` | PASS |
| `PUBLIC_STAGING_REMOTE_PROBE` | PASS — 21/21 |
| `AUTH_ERROR_SANITIZATION` | PASS |
| `NODE_INTEGRATION_DISABLED` | PASS |
| `CONTEXT_ISOLATION_ENABLED` | PASS |
| `WEB_SECURITY_ENABLED` | PASS |
| `PRELOAD_IPC_BOUNDARY` | PASS |
| `SANDBOX_ENABLED_FIRST_PAINT` | PASS |
| `SANDBOX_ENABLED_FULL_SMOKE` | PASS |
| `PACKAGED_INTERRUPT_RECOVERY` | PASS |
| `ENCRYPTED_TOKEN_PERSISTENCE` | PASS |
| `AUTHENTICATED_RESTART_RESTORATION` | PASS |
| `NO_PAID_INFERENCE` | PASS |
| `NO_LOCAL_LLM_INFERENCE` | PASS |
| `FORGEZERO_FAIL_CLOSED` | PASS |
| `NO_UNRESOLVED_LAUNCH_FAILED_49` | PASS |
| `PACKAGED_VISUAL_QA` | PASS |
| `LIVE_OAUTH_HUMAN_APPROVAL_OBSERVED` | NOT OBSERVED — existing grant redirected without a consent page |
| `LIVE_OAUTH_DENIAL_OBSERVED` | NOT EXERCISED — known static-400/desktop-timeout limitation; automated error sanitization passed |
| `CODEFORGE_R8_DAILY_DRIVER_UX` | PASS |

## Final release artifact

The certified artifact is `apps/desktop/release-r8-secure-final`.

| Artifact | Size | SHA-256 |
| --- | ---: | --- |
| `win-unpacked/CodeForge.exe` | 188,875,264 bytes | `3854F29EF52CBAF5C4BB2D361B1569F6CB311368BC532CE9C51EE017B0DBB9EC` |
| `win-unpacked/resources/app.asar` | 22,342,283 bytes | `B0F4D3C4730503EC0B7EC78B2BEEDBFEDCB2244AC0824A2B0BF596A571895839` |

R8 is certified without weakening the production sandbox, without paid or local inference, and without fabricating a human OAuth approval. Any later artifact with different bytes must rerun the applicable packaged audits and smokes before distribution.
