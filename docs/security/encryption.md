# Encryption in CodeForge

This document states exactly which cryptographic constructions CodeForge uses, where, and why.
Everything here is **IMPLEMENTED** and **TESTED** unless marked otherwise. CodeForge uses only
Node's built-in `node:crypto` (OpenSSL) primitives and Electron's `safeStorage`; it defines no
algorithms of its own.

## 1. Reversible secrets at rest in the Cloud — `@codeforge/crypto`

**What is protected today:** the server-owned GitHub PKCE verifier stored in
`oauth_transactions.github_code_verifier` and `browser_oauth_transactions.github_code_verifier`
for the ≤10-minute life of a sign-in attempt. It is the only reversible credential-class value the
Cloud stores; every other credential is either never stored or stored as a hash (§3). The
service is general and is the mandatory path for any future reversible secret (rule 2 in
[data-classification.md](./data-classification.md)).

**Construction** (`packages/crypto/src/envelope.ts`, `key-provider.ts`):

```text
DEK        = 32 random bytes (CSPRNG: crypto.randomBytes), fresh for every encryption
nonce      = 12 random bytes, fresh for every encryption
aad        = canonical JSON of the binding context {purpose, recordId?, schema?, tenantId?} (keys sorted)
ct || tag  = AES-256-GCM(key = DEK, iv = nonce, plaintext, aad)     tag = 16 bytes
wrappedDEK = AES-256-GCM(key = KEK[v], iv = 12 random bytes, DEK, aad)   (LocalKeyEncryptionProvider)

envelope   = "cfe1" . kekVersion . b64url(wrappedDEK) . b64url(nonce) . b64url(ct) . b64url(tag)
```

Properties, each with the test that proves it (`packages/crypto/test/envelope.test.ts`):

| Property | How | Test |
| --- | --- | --- |
| Authenticated encryption; 256-bit keys | AES-256-GCM, 16-byte tag, explicit `authTagLength` | 1/2 |
| No nonce reuse | Fresh 96-bit random nonce *and* fresh DEK per encryption — nonce reuse under the same key is impossible by construction | 3/4 (200 encryptions → 200 distinct nonces, ciphertexts, wrapped DEKs) |
| Fail closed on tampering | Any modification of ciphertext, nonce, tag, wrapped DEK, version, or AAD throws `EnvelopeError`; no partial plaintext is ever returned | 5, 6, 7, 7b, 9, 13 |
| Wrong key fails | Same version number with different material → authentication failure | 8 |
| Context binding (AAD) | Envelope opened only with the same `{purpose, recordId, schema, tenantId}`; moving a sealed value between rows, users, or purposes fails | 9; ATTACK-003 |
| Key versioning | Envelope names its KEK version; decrypt-only previous versions are honored; unknown versions fail with `ENVELOPE_KEY_UNAVAILABLE` | 10 |
| Rotation without loss | `rotate()` decrypts with the old version and re-encrypts with fresh DEK/nonce under the active version, plaintext never leaves the call | 11; ATTACK-015 |
| Legacy migration | `isEnvelope()` distinguishes sealed from legacy values; sealing is idempotent | 12 |
| No plaintext in logs/errors | Error messages and `describeEnvelope()` metadata never contain the plaintext | 14 |
| Bounded input | 64 KiB plaintext limit | "binds binary payloads" |

**Key material** (`CODEFORGE_DATA_ENCRYPTION_KEYS`): comma-separated `<version>:<material>`
entries; material is 32 random bytes as base64/base64url/hex (preferred) or a ≥32-character
secret stretched with HKDF-SHA256 (so a platform-generated random string works). Placeholder-like
material is refused. Details: [key-management-and-rotation.md](./key-management-and-rotation.md).

**What this is not:** the local key-encryption provider wraps DEKs with a KEK from the process
environment. It is a versioned, server-only master key — **not a KMS/HSM**. The
`KeyEncryptionProvider` interface (`wrapKey`/`unwrapKey`) is the seam a managed KMS implementation
plugs into without changing stored envelopes (ARCHITECTURALLY PREPARED).

**Where the primitives are not exposed:** the envelope service is constructed in
`apps/cloud-api/src/config.ts` and handed to `AuthService`; no HTTP route, IPC channel, renderer
module, or model tool can call encrypt/decrypt.

## 2. User secrets at rest on the desktop — Electron `safeStorage`

**What is protected:** BYOK provider API keys and the desktop's copy of the Cloud access/refresh
tokens, in `userData/settings.json` as `enc:<base64>`.

**Construction:** `safeStorage.encryptString` / `decryptString` — Chromium's OS Crypt. On Windows
this is DPAPI bound to the user account; on macOS the Keychain; on Linux the Secret Service /
kwallet backend when one is available. CodeForge describes this as **operating-system-backed
encryption**, not "hardware encryption".

**Rules** (`apps/desktop/src/secure-credential-codec.ts`, tests in
`apps/desktop/test/secure-credential-codec.test.ts`):
- a value that is not an `enc:` payload is never returned as a credential (legacy plaintext read path closed);
- sealing never degrades to plaintext — if the backend is unavailable, the write throws and nothing is persisted;
- legacy plaintext found on disk is sealed in place on first launch; if it cannot be sealed it is left untouched and unusable, never destroyed;
- corrupt payloads fail closed;
- the renderer only ever learns a boolean "connected" status, never the value.

**Limits (stated honestly):** OS Crypt protects against other users and offline disk access; it
does not protect against malware running as the same OS user on the same machine.

## 3. Hashing of authentication material

| Value | Storage | Hash |
| --- | --- | --- |
| Refresh token (`cfr_` + 48 random bytes base64url) | `device_sessions.refresh_token_hash` | SHA-256 |
| Desktop auth code (`cfa_` + 32 random bytes) | `desktop_auth_codes.code_hash` | SHA-256 |
| Browser session token (32 random bytes) | `browser_sessions.session_token_hash` | SHA-256 |

These tokens have ≥256 bits of entropy from the CSPRNG, so an unsalted SHA-256 is a one-way
lookup key, not a password hash: brute force is infeasible and rainbow tables do not apply.
Comparison is by hash lookup; JWT signatures and the local control-plane bearer are compared with
`crypto.timingSafeEqual`.

## 4. Passwords

CodeForge has **no passwords**. GitHub OAuth is the only identity provider; there is no password
table, reset flow, or password hashing to audit. If passwords are ever introduced, Argon2id via a
maintained library is the required algorithm (NIST SP 800-63B / OWASP Password Storage guidance),
and this document must be updated first.

## 5. Signatures and MACs

| Use | Algorithm | Notes |
| --- | --- | --- |
| Cloud access tokens | JWT HS256 (HMAC-SHA256) with `JWT_SECRET` (≥32 chars, test default refused in staging/prod) | `alg` pinned to HS256; `exp`, `iss` mandatory; `iat` skew-checked; timing-safe compare (`packages/cloud-auth/src/jwt.ts`) |
| GitHub App assertions | RS256 with the App private key | 9-minute life, `iat` backdated 60 s, only inside `GitHubAppClient` |
| Stripe webhooks | HMAC-SHA256 over `t.payload`, 300 s tolerance, timing-safe compare of every `v1` candidate | `packages/cloud-billing/src/stripe-service.ts` |
| PKCE | S256 (`SHA-256(verifier)` base64url) | both desktop and server legs |
| Publication integrity | SHA-256 over the bundle; length + digest verified before execution | `apps/cloud-api/src/artifact-store.ts` |

## 6. Transport

- Cloud API: HTTPS terminated by Render; `Strict-Transport-Security: max-age=31536000; includeSubDomains` is emitted whenever the configured public origin is HTTPS. (`REQUIRES DEPLOYMENT CONFIGURATION`: HSTS preload and the exact TLS policy are the platform's.)
- Cloud → PostgreSQL: TLS with certificate validation; in staging/production a non-loopback database without `CODEFORGE_CLOUD_DB_SSL=true` refuses to boot, and `sslmode=disable|allow|prefer|no-verify` are rejected (`apps/cloud-api/src/config.ts`). The Docker image trusts the Supabase root CA (`certs/supabase-prod-ca-2021.crt`).
- Desktop → Cloud/providers/GitHub: HTTPS via Node/Electron's TLS stack with default certificate verification; the packaged app refuses to redirect privileged traffic to a runtime-supplied Cloud URL (`apps/desktop/cloud-endpoints.json`).
- Local control plane: plain HTTP on 127.0.0.1 only, authenticated by the per-process bearer (loopback traffic never leaves the host).

## 7. Randomness

All tokens, nonces, keys, states, and codes come from `crypto.randomBytes` (OpenSSL CSPRNG).
No `Math.random` is used for anything security-relevant.

## 8. What CodeForge does not claim

- Not end-to-end encrypted: the Cloud and the selected model provider process plaintext prompts.
- Not zero-knowledge: the Cloud can decrypt what it seals (that is the point of a server-side seal).
- No FIPS validation; no formal cryptographic review by a third party (REQUIRES THIRD-PARTY VERIFICATION).
