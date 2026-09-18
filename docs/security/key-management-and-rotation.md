# Key Management and Rotation

Scope: every key or secret the CodeForge Cloud and desktop rely on, how each is versioned, and
the exact rotation procedure. Emergency rotation (after suspected compromise) is in
[incident-response.md](./incident-response.md); this document is the routine procedure.

## 1. Inventory

| Key / secret | Purpose | Lives in | Versioned? | Rotation impact |
| --- | --- | --- | --- | --- |
| `CODEFORGE_DATA_ENCRYPTION_KEYS` (KEK ring) | Wraps per-record DEKs for sealed secrets | Cloud env | **Yes** — `v:material` entries; envelopes record their KEK version | None for users when staged (§3); previous versions stay decrypt-only until every envelope is re-wrapped |
| `JWT_SECRET` | Signs/verifies access tokens (HS256) | Cloud env | No (single secret) | Every outstanding access token (≤1 h) becomes invalid at rotation; refresh tokens are unaffected (hashed, DB-validated), so clients silently re-mint on next refresh |
| `GITHUB_CLIENT_SECRET` | OAuth code exchange | Cloud env + GitHub OAuth App | GitHub allows two concurrent secrets | Only sign-ins in flight during the swap fail (10-minute transactions) |
| `GITHUB_APP_PRIVATE_KEY` | Signs App JWTs | Cloud env + GitHub App | GitHub allows multiple keys | Publications in flight re-mint tokens on retry |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe API + webhook verification (TEST mode) | Cloud env + Stripe dashboard | Stripe supports rolling keys and multiple webhook endpoints | Webhooks signed with an old secret fail verification (Stripe retries) |
| Platform provider keys | Hosted Free inference | Cloud env + provider dashboards | Provider-dependent | Capacity discovery re-runs at boot; a revoked key simply removes that provider's routes |
| `DATABASE_URL` | PostgreSQL | Cloud env + provider | Provider-dependent | Restart required |
| Local control-plane bearer | Loopback API auth | Process memory | Per process | Regenerated at every launch (desktop, CLI, VS Code) |
| BYOK provider keys | User's own provider access | Desktop `safeStorage` | n/a (user-managed) | User deletes/re-enters in Settings › Providers; the provider dashboard revokes |
| Electron `safeStorage` master key | Seals desktop secrets | OS (DPAPI/Keychain/Secret Service) | OS-managed | Tied to the OS user; a new OS user profile cannot read the old file (by design) |

## 2. The KEK ring — format and rules

```text
CODEFORGE_DATA_ENCRYPTION_KEYS="2:<base64 32 bytes>,1:<base64 32 bytes>"
CODEFORGE_DATA_ENCRYPTION_ACTIVE_KEY=2        # optional; defaults to the highest version
```

- Generate material with `openssl rand -base64 32` (or `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`).
- A ≥32-character opaque string is also accepted (HKDF-SHA256-stretched) so Render's `generateValue: true` works for the *first* key; use explicit base64 for rotations so the ring can be expressed as `v:material`.
- Duplicate versions, short material, and placeholder-looking material (`test…`, `password…`, repeated characters) are refused at boot (`packages/crypto/src/key-provider.ts`, tests in `packages/crypto/test/envelope.test.ts`).
- Staging and production **refuse to boot** without the variable; development uses an ephemeral per-process key and prints `(EPHEMERAL — development only)` in the startup summary. The startup summary prints only `activeKey=vN knownKeys=[…]`, never material.
- The ring must never be committed, logged, placed in `settings.json`, or passed to a child process (`CODEFORGE_DATA_ENCRYPTION_KEYS` is on the env-filter deny list).

## 3. Staged KEK rotation (routine, zero-downtime)

Envelopes name the KEK version that wrapped them, so rotation is three deploys, each reversible:

| Step | Ring value | Behavior | Verification |
| --- | --- | --- | --- |
| 0 (today) | `1:K1` | All envelopes are v1 | `describeConfig` → `activeKey=v1 knownKeys=[v1]` |
| 1 — stage | `2:K2,1:K1` | New envelopes are written under v2; v1 envelopes still open | Start a sign-in, confirm `activeKey=v2 knownKeys=[v2,v1]`; ATTACK-015 models this exact state |
| 2 — re-wrap | same | Long-lived envelopes are re-encrypted with `SecretEnvelopeService.rotate()`; today the only sealed rows live ≤10 minutes, so they expire naturally within the window and no batch job is needed | `SELECT count(*) FROM oauth_transactions WHERE github_code_verifier LIKE 'cfe1.1.%'` → 0 after 10 minutes |
| 3 — retire | `2:K2` | v1 is removed; any v1 envelope that somehow remains fails closed with `ENVELOPE_KEY_UNAVAILABLE` (audited as `crypto.decrypt.failed`) | `activeKey=v2 knownKeys=[v2]` |

Rollback at any step is "restore the previous ring value and redeploy" — nothing is destroyed
until step 3, and step 3 is only taken once step 2 shows zero old-version envelopes. When a
future feature seals long-lived data, step 2 becomes an explicit re-wrap job that iterates rows,
calls `rotate()`, writes back, and reports `crypto.key.rotation` progress; the service and its
tests already support that (`envelope.test.ts` case 11).

## 4. `JWT_SECRET` rotation

1. Generate a new ≥32-character random secret.
2. Set it in Render; redeploy. All access tokens become invalid; clients hit 401 and refresh.
3. Because refresh validation is a DB lookup of the token hash and session liveness, users are not signed out.
4. Not yet supported: dual-secret (kid) verification for a seamless overlap window — ARCHITECTURALLY PREPARED (the verifier is a single function; adding a `kid` header and a secret list is a contained change).

## 5. GitHub credentials

- **OAuth client secret:** in the GitHub OAuth App settings generate a second secret, set it in Render, redeploy, then delete the old secret on GitHub. Sign-ins in flight at the moment of the swap restart (their transactions are single-use and 10 minutes long).
- **App private key:** generate a new key in the GitHub App settings, set `GITHUB_APP_PRIVATE_KEY` (with `\n`-escaped newlines) in Render, redeploy, delete the old key. Installation tokens already minted keep working until their 1-hour expiry; new publications use the new key.
- Neither secret is ever stored by CodeForge outside the env; nothing in the database references them.

## 6. Stripe (TEST mode)

Roll the restricted/secret key in the Stripe dashboard, update `STRIPE_SECRET_KEY`, redeploy. For
the webhook secret, add the new endpoint secret, update `STRIPE_WEBHOOK_SECRET`, redeploy, then
delete the old endpoint. Live-mode keys are refused at boot; moving to live mode is an explicit
business/legal decision tracked in [OWNER-ACTIONS.md](./OWNER-ACTIONS.md).

## 7. Provider keys

Rotate in the provider console, update the env var, redeploy. `CloudProviderRegistry.discover`
runs at boot and on a TTL, so capacity reflects the new key without code changes. Revoking a key
without replacement removes that provider's routes (fail-closed: no route is ever served with a
missing credential).

## 8. Audit events

| Event | Emitted when |
| --- | --- |
| `crypto.decrypt.failed` | A sealed value fails authentication or names an unknown KEK version |
| `crypto.key.rotation` | Reserved for the re-wrap job (progress counts); not emitted today because no long-lived sealed rows exist |
| `auth.session.rejected` | Access token refused after `JWT_SECRET` rotation or session revocation |

## 9. Key destruction and recovery

- Never delete a KEK version while any envelope may still reference it (step 3 check).
- A backup taken during step 1 is restorable with the step-1 ring; a backup taken at step 0 needs `1:K1` present. Keep retired KEK material in the operator's secret manager (not in the Cloud env) for the backup retention window — see [backups-and-recovery.md](./backups-and-recovery.md).
- Losing every KEK version makes sealed rows unreadable. Today that means at most a few in-flight sign-ins fail and restart; it destroys no user data. This remains true only while sealed rows are short-lived — a feature that seals long-lived data must add the KEK to the operator's escrow procedure first.
