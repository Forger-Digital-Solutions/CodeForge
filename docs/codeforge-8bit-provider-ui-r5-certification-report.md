# CodeForge R5 Certification Report

Date: 2026-09-08

## 1. Verdict

`CODEFORGE_8BIT_PROVIDER_UI_R5_BLOCKED_LIVE_CODEX_AUTH`

The host-owned Codex transport, authority boundary, allowance gating, tests, and build are implemented. Certification remains blocked because the installed Codex app-server reports no authenticated ChatGPT account, and the desktop renderer/package smoke cannot launch its renderer in this environment.

## 2. Repository State

- Path: `G:\CodeForge`
- Branch and HEAD unchanged: `feat/codeforge-cloud` / `9b40dc26c4b4baf9863da558163af756a8817f0f`
- The worktree was already dirty at R5 start and remains dirty; inherited R3/R4 changes were preserved.
- No commit, reset, clean, checkout, push, or remote operation was performed.
- Node/npm: repository Node/npm runtime; Oxlint 1.82.0; Vitest 2.1.9; Electron 33.4.11; `@electron/rebuild` 4.2.0 in the desktop workspace.

## 3. R4 Blocker Reproduction

R4 had only an injected Codex transport seam. It did not own a production Codex app-server child process, JSONL lifecycle, or typed desktop IPC. R5 reproduced the missing live proof with the installed `codex.exe`: process/account-read works, but the account response is unauthenticated.

## 4. Codex App-Server Contract

The current official contract was checked against the [Codex app-server documentation](https://developers.openai.com/codex/app-server/): stdio JSONL framing, JSON-RPC-shaped messages with the wire header omitted, one `initialize` followed by `initialized`, `thread/start` or `thread/resume`, `turn/start` notifications, `turn/interrupt`, account login/logout, and account rate-limit reads. WebSocket was not used because the documentation marks it experimental/unsupported for production.

## 5. Production Transport

`CodexAppServerProcess` owns executable discovery, `spawn(..., shell:false)`, stdin/stdout JSONL framing, request correlation, bounded frames, startup/request/shutdown timeouts, streaming queues, stderr redaction, server-request responses, cancellation, process-death rejection, restart, and listener cleanup. Client methods are allowlisted; arbitrary protocol methods are rejected.

## 6. IPC and Security Boundary

Electron main owns the process and exposes only typed account-state/login-cancel/logout calls through the preload bridge. Renderer code receives sanitized status, account metadata, limits, process state, and redacted errors. It has no process handle, generic JSON-RPC method, cookie/token channel, or executable input.

## 7. CodeForge Authority Mapping

Codex is a separate `codex-account` provider route. ForgeZero remains the model eligibility authority, the server remains orchestration authority, and the existing CodeForge runtime remains the execution path. Codex is registered in the provider catalog only while the account has a currently available allowance.

## 8. Tool Mapping

CodeForge tools are not delegated to Codex. Requests containing CodeForge tools fail with `UNSUPPORTED_TOOL`; Codex server-initiated execution requests are rejected by the host callback. This preserves one executor and fails closed, but a positive live tool mapping is not yet proven.

## 9. Approval Mapping

The transport supports server-initiated request correlation and duplicate-request suppression. The current desktop host rejects built-in Codex command/file approval requests rather than creating a parallel executor. Existing CodeForge approval integration therefore remains the next live integration step.

## 10. Authentication

Only the documented managed ChatGPT browser flow is exposed: `account/login/start` with `type: chatgpt`, hosted success page, and `appBrand: chatgpt`; logout uses `account/logout`. Auth URLs are HTTPS-only and restricted to `openai.com`/`chatgpt.com` domains. No browser-cookie extraction, token copying, or API-key fallback is used.

## 11. Allowance and Billing Safety

`account/rateLimits/read` is re-read before every turn. Empty, stale, missing, or exhausted limits are ineligible. Exact Codex selection fails closed when unavailable; automatic routing cannot use the Codex catalog entry unless allowance is available. Codex has no OpenAI API paid fallback, and OpenAI API credentials remain a separate provider route.

The host also strips OpenAI/Codex API-key environment variables from the child process, so a separately configured BYOK key cannot be inherited as an accidental Codex fallback.

## 12. 8-Bit Boundary

8-Bit remains supply-only. Codex was not made an 8-Bit planner, verifier, approval authority, GEMS route, or orchestration layer.

## 13. Model Picker

The existing `ModelSelector` and `WorkspaceShell` were reused. The picker retains Automatic, 8-Bit, provider-backed, account-allowance, BYOK, GEMS, and setup/unavailable concepts; Codex appears under its own account section with unavailable/exhausted state metadata. Existing keyboard, focus, controlled open/close, disabled-row, long-label, scroll, and stale-selection behavior remains covered by picker tests.

## 14. Desktop Graphical Smoke

Blocked by the machine environment. The packaged executable reached server initialization, window creation, and renderer URL load, but Electron's renderer failed to launch; a headless retry avoided the GPU fatal exit but still produced no renderer evidence and timed out. No graphical picker interaction, screenshot, or accessibility certification is claimed.

## 15. Restart/Hydration

The transport restart path and stale pending-request invalidation pass deterministic tests. Codex catalog registration is removed on logout, exhaustion, auth failure, and process failure, preventing stale automatic routing. Full graphical restart hydration could not be exercised because the packaged renderer did not launch.

## 16. Live Codex Smoke

- Process/handshake: PASS; `codex.exe app-server --listen stdio://` initialized and shut down cleanly.
- `account/read`: PASS at the protocol level.
- Live health: `auth_required`; route state `stale`; models `0`.
- Login, allowance, minimal turn, logout, and authenticated restart: BLOCKED by the missing ChatGPT account authorization. No credentials were entered or fabricated.

## 17. Tool/Approval Live Smoke

BLOCKED. No authenticated live turn was available to elicit a safe Codex tool request. Deterministic transport tests prove server requests are host-owned, duplicate-suppressed, and fail-closed when unsupported.

## 18. Process Cleanup

The direct Codex child created for smoke was closed and verified absent. Packaged smoke children were also absent after each run. Cleanup was identity-based; an unrelated pre-existing `node` process was not terminated.

## 19. SQLite Diagnostic

The full suite reproduced the pre-existing best-effort `statement has been finalized` diagnostic during SQLite restart/steering teardown. It did not fail tests and is outside the Codex transport change. It remains a narrow persistence/lifecycle follow-up rather than being masked or broadly rewritten.

## 20. Security Audit

Codex runtime paths contain no raw `Authorization`, `Bearer`, `access_token`, `refresh_token`, cookie, or session credential propagation. The only `Bearer` match in the Codex test scope is a synthetic stderr-redaction fixture. Renderer IPC returns metadata only; errors and stderr pass through redaction. The broader dirty R4 diff still contains unrelated provider/cloud auth code and was not conflated with the Codex audit.

## 21. Failure Matrix

| Scenario | Result |
| --- | --- |
| Executable unavailable / spawn ENOENT | PASS |
| Generic spawn failure classification | PASS via deterministic spawn seam |
| Startup timeout | PASS |
| Malformed JSONL frame | PASS |
| Unknown protocol event | PASS; transported without authority effect |
| Request timeout | PASS |
| Process exits mid-request | PASS |
| Process exits between turns | PASS; next request starts a fresh child |
| Duplicate response | PASS; late duplicate ignored |
| Late response after timeout | PASS; pending map stays empty |
| Cancellation | PASS; stream closes promptly and interrupt is requested |
| Signed out | PASS; no models and auth-required state |
| Login failure | PASS; normalized and redacted |
| Login cancelled | PASS; login id is validated |
| Allowance unavailable | PASS; fail closed |
| Allowance exhausted | PASS; no turn starts |
| Allowance changes before execution | PASS; limits re-read before turn |
| Logout while idle | PASS; catalog route removed |
| Logout while request pending | PASS at transport close/pending rejection layer |
| Stale persisted Codex selection | PASS in reconciliation path; graphical proof blocked |
| Restart hydration | PASS at transport layer; graphical proof blocked |
| Unsupported Codex tool request | PASS; `UNSUPPORTED_TOOL` |
| Approval accepted/denied/cancelled | Protocol callback seam PASS; live CodeForge approval mapping not implemented |
| Duplicate approval | PASS; duplicate server request id handled once |
| Renderer generic protocol injection | PASS; no generic IPC surface |
| Codex to OpenAI paid fallback | PASS; impossible by route and policy |
| 8-Bit automatic alternate free provider | PASS; existing policy tests |
| Exact Codex pin with exhausted allowance | PASS; deterministic failure |
| App shutdown | PASS; child cleaned |
| App-server crash | PASS; child and pending state cleaned |

## 22. PostgreSQL Regression

BLOCKED by environment before Vitest: WSL Ubuntu enumeration returned `E_ACCESSDENIED`, and Docker's daemon was unavailable. The harness retained real PostgreSQL behavior and did not substitute SQLite or mocks. No PostgreSQL certification is claimed.

## 23. Full Test Results

- Lint: PASS, 0 violations.
- Typecheck: PASS.
- Build: PASS.
- Focused R5/authority/picker tests: PASS, 6 files / 48 tests, including 17 transport/provider tests.
- Default Vitest: PASS, 217 files passed / 5 skipped; 1,664 tests passed / 33 skipped.
- Packaged build: PASS, unsigned `release/win-unpacked` output produced.
- Packaged smoke: BLOCKED by renderer launch failure in this host environment.
- `git diff --check`: PASS.

## 24. Files Changed

R5 production/test additions and edits include:

- `packages/providers/src/codex-app-server-process.ts`
- `packages/providers/src/codex-account.ts`
- `packages/providers/src/index.ts`
- `packages/providers/test/codex-app-server-process.test.ts`
- `packages/providers/test/codex-account.test.ts`
- `apps/desktop/src/main.ts`
- `apps/desktop/src/preload.cjs`
- `apps/desktop/src/preload.ts`
- `apps/desktop/src/renderer/ProviderSetup.tsx`
- `apps/desktop/scripts/rebuild-native.mjs`
- `apps/desktop/scripts/packaged-smoke.js`
- `apps/desktop/package.json` and `package-lock.json` for the workspace rebuild tool

Inherited R3/R4 lint, provider, UI, server, PostgreSQL-harness, and documentation changes remain in the dirty worktree and were not reverted.

## 25. Certification Matrix

| Gate | Result |
| --- | --- |
| Host-owned process / renderer separation | PASS |
| Generic renderer protocol access | PASS: absent/rejected |
| CodeForge orchestration/tool authority | PASS for fail-closed boundary |
| CodeForge approval authority | BLOCKED: positive live mapping remains |
| ForgeGreen / ForgeVerify boundaries | PASS by regression suite |
| 8-Bit supply-only boundary | PASS |
| Documented auth and no secret exposure | PASS |
| Allowance revalidation / no paid fallback | PASS |
| Transport lifecycle/correlation/stream/timeout/cancel/restart | PASS |
| Existing picker reuse and semantic states | PASS at component/source-test level |
| Graphical desktop smoke | BLOCKED: renderer unavailable |
| Lint/typecheck/build/focused/default | PASS |
| Real PostgreSQL suite | BLOCKED: WSL/Docker unavailable |
| Live authenticated Codex proof | BLOCKED: account not authenticated |

## 26. Remaining Work

- Run the live ChatGPT managed login in a renderer-capable environment, then verify allowance, harmless turn, logout, and restart hydration.
- Map safe Codex command/file requests into the existing CodeForge tool and approval authority, or retain the current fail-closed behavior until that mapping is complete.
- Re-run graphical picker and accessibility smoke on a working Electron renderer host.
- Re-run the real PostgreSQL harness with WSL Ubuntu access or an externally managed PostgreSQL endpoint.
- Investigate the existing SQLite finalized-statement teardown diagnostic separately.
- Review the npm install audit warning (19 vulnerabilities reported) as dependency maintenance; no forced audit fix was run.

## 27. Recommended Next Milestone

`R5-LIVE-CODEX-AUTH-AND-APPROVAL-SMOKE`

Use a renderer-capable Windows environment with an explicitly authorized ChatGPT account and PostgreSQL endpoint, then complete live login/allowance/turn/logout/restart and one safe CodeForge-mediated approval before issuing a certification verdict.
