# Session, OAuth, and API Security

Covers Phases 8, 9, 23, 24, and 25 of the R1 campaign: the CodeForge Cloud API
(`apps/cloud-api/src/server.ts`, `packages/cloud-auth`) and the local control plane
(`packages/server/src/index.ts`).

## 1. Identity and OAuth

CodeForge has no passwords. GitHub OAuth (scope `read:user user:email`) establishes identity;
write access to repositories is a separate GitHub App grant
([github-access-model.md](./github-access-model.md)).

### Desktop sign-in (server-brokered, confidential client)

| Step | What happens | Control |
| --- | --- | --- |
| 1 | Desktop generates its own PKCE pair and opens an ephemeral loopback listener | Redirect URI must be `http://127.0.0.1:<port>/auth/callback` (`redirect-uri.ts`) |
| 2 | `POST /v1/auth/start {redirectUri, codeChallenge}` | Server creates a *second*, server-owned PKCE pair; the verifier is **AES-256-GCM sealed** with AAD `{purpose: github_pkce_verifier, schema: desktop, recordId: state}`; 10-minute single-use transaction |
| 3 | Browser → GitHub → `GET /v1/auth/github/callback?code&state` | The **only** callback registered on the GitHub OAuth App: one fixed HTTPS URL. State is consumed atomically (replay → static 400 page, no redirect). The redirect target comes from the stored transaction, never from the request |
| 4 | Cloud exchanges the code with the client secret + unsealed verifier, reads the profile, discards the GitHub token, mints a 120 s single-use handoff code (stored hashed, PKCE-bound), 302s to the loopback | The GitHub access token is never stored |
| 5 | `POST /v1/auth/exchange {code, codeVerifier}` | Atomic consume before any other check; PKCE S256 verified; only then are tokens minted |

Denied consent (`?error=`) ends on a static page (desktop) or the allowlisted return page with
`status=denied` (browser). Every failure emits `auth.oauth.state_invalid` / `auth.login.failed`
audit events without the code or token.

### Browser (FDS website) sign-in
Same server leg, but the result is an opaque 32-byte session token stored as a SHA-256 hash and
set as `__Host-codeforge-session` (HttpOnly; Secure; SameSite=Lax; Path=/; 7 days). The return
target must exactly match `CODEFORGE_ALLOWED_BROWSER_RETURN_URLS`.

Tests: `packages/cloud-auth/test/auth.test.ts`, `tests/cloud-adversarial-security.test.ts`,
`tests/security/attack-acceptance.test.ts` (ATTACK-001/002/003/007/008/014/015/016).

## 2. Tokens and sessions

| Credential | Lifetime | Storage | Revocation |
| --- | --- | --- | --- |
| Access token (JWT HS256; claims `sub`, `sid`, `planId`, `iat`, `exp`, `iss`) | 1 h | Desktop: sealed in `settings.json`; never in a cookie or URL | **Immediate**: every authenticated request verifies signature *and* that `sid` names a live, unrevoked, unexpired device session (`AuthService.verifyAccessSession`, 15 s in-process liveness cache that is cleared on logout/refresh/deletion). Logout, refresh rotation, breach revocation, and account deletion all kill the token at once (ATTACK-014) |
| Refresh token (`cfr_…`, 384 bits) | 30 d, rotated on every use | Desktop sealed; Cloud stores SHA-256 | Reuse of a *rotated* token is treated as theft → whole family revoked (`revoked_reason = breach`); reuse of a *logged-out* token revokes nothing else (a stale client, not an attacker) |
| Browser session token | 7 d | `__Host-` cookie; Cloud stores SHA-256 | `POST /v1/auth/browser/logout` revokes server-side and clears the cookie |
| Desktop handoff code (`cfa_…`) | 120 s, single use | Cloud stores SHA-256 | Consumed atomically |
| OAuth transaction / App callback state | 10 min, single use | Cloud | Consumed atomically; swept hourly |

Idle timeout is implicit in the 1 h access token; absolute session life is the 30-day refresh
window. A device list / "sign out everywhere" endpoint exists server-side
(`revokeAllUserDeviceSessions`, `AuthService.revokeAllSessions`) but is not yet exposed in the
UI — ARCHITECTURALLY PREPARED.

## 3. CORS and CSRF

- `Access-Control-Allow-Origin` is echoed only for an exact origin in `CODEFORGE_ALLOWED_ORIGINS` (defaults: the FDS site origins and loopback) or an `http://127.0.0.1:<port>` desktop origin; never `*`, never with credentials for an unlisted origin. Preflight from an unlisted origin → 403.
- The browser cookie is `SameSite=Lax`, `__Host-`-prefixed (Secure, host-only, Path=/). State-changing routes that a browser could reach with the cookie are limited to `POST /v1/auth/browser/logout` (Origin-checked); every other mutating route requires a Bearer token, which a cross-site page cannot attach. `DELETE /v1/account` is Bearer-only by design.
- The local control plane requires a per-process bearer header (never a cookie), refuses `Origin: null` unless a bearer is enforced (sandboxed-iframe drive-by), refuses non-loopback `Host` headers (DNS rebinding), and binds to 127.0.0.1 unless explicitly configured otherwise (`packages/server/test/network-exposure.test.ts`).

## 4. Security headers

Every Cloud response carries (`server.ts` `securityHeaders()`):

```text
Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
Cross-Origin-Opener-Policy: same-origin
Cache-Control: no-store, no-cache, must-revalidate   (JSON/redirects)
Strict-Transport-Security: max-age=31536000; includeSubDomains   (when the public origin is HTTPS)
```

The only HTML the API renders is a static sign-in error page (`style-src 'unsafe-inline'`, no
scripts, no reflected input). The desktop renderer's CSP is documented in
[electron-security.md](./electron-security.md).

## 5. Input handling and errors

- JSON bodies ≤ 1 MiB, parsed then validated with Zod schemas; unknown fields are stripped (a client cannot smuggle `planId`/`creditBalance` into settings — ATTACK-010). Publication metadata uses strict SHA patterns; plan ids are an enum.
- Query/path parameters are validated (`repositoryId` safe-integer check, workflow ids matched by route regex, `workerId` schema).
- Errors: validation and authentication messages are returned (redacted); publication/GitHub errors are stable codes; **anything else** becomes `500 {error: "Internal server error", code: "INTERNAL_ERROR", correlationId}` and is logged through the redacting logger with the correlation id. No stack traces, SQL, paths, or upstream bodies reach a client (`tests/security/attack-acceptance.test.ts` "unknown internal errors").
- Rate limit: 120 requests/minute per client IP for every non-health route (in-process bucket; `X-Forwarded-For` honored only with `CODEFORGE_TRUST_PROXY=true`); exceeding it is audited (`ratelimit.exceeded`). Known limitation: per-process, not distributed — a multi-instance deployment needs a shared limiter (documented in OWNER-ACTIONS).
- Payload limits elsewhere: publication artifacts ≤ 256 MiB streamed to disk with digest + length verification; hosted-workflow task ≤ 20 000 chars; worker output ≤ 32 KiB.

## 6. Injection surfaces

| Surface | Status |
| --- | --- |
| SQL | Parameterized queries everywhere (`@named` for SQLite, `$n` for pg); no string-built SQL from input |
| Command injection (Cloud) | The Cloud spawns only `git` with argument arrays for publication (`git-transport.ts`), with a sanitized env and no shell |
| Command injection (desktop git bridge) | `checkGitExecArgs` allowlists read-only subcommands and rejects global flags/`-c` |
| Path traversal | Cloud artifact keys are server-derived UUIDs under a fixed root; desktop workspace boundary is symlink/junction-aware (ATTACK-012) |
| SSRF | No user-supplied URL is fetched by the Cloud or the desktop except Stripe return URLs (origin-allowlisted) and `shell.openExternal` targets (https/localhost only) — ATTACK-013. Model tools have no URL-fetch capability; `run_command` is the user's own machine under approvals |
| Prototype pollution | Provider credential keys are allowlisted before assignment; `Object.defineProperty` used for credential maps; JSON bodies validated by Zod |
| Deserialization | JSON only; no `eval`, no `vm` on untrusted input |

## 7. Local control plane (desktop / `forge serve` / VS Code)

- Loopback bind by default; LAN bind only with an explicit `host`.
- Per-process bearer (`X-CodeForge-Control-Token`), generated with 256 bits of entropy at every launch: attached by the Electron main process at the session `webRequest` layer only for the trusted document; written to `~/.codeforge/control-token` (0600) by `forge serve`; held in memory by the VS Code extension.
- Origin gate: dev renderer origins (`http://localhost:5173`, `http://127.0.0.1:5173`) or `Origin: null` only when a bearer is enforced; everything else 403 even with a valid bearer.
- `Host` must be a loopback name when bound to loopback (421 otherwise).
- The bearer is never accepted from a query string (`/api/events?controlToken=` → 401).
