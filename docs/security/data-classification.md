# CodeForge Data & Secret Classification

This matrix is derived from the repository (schemas in `packages/cloud-db/src/migrations.ts`,
`packages/sessions`, the desktop settings store in `apps/desktop/src/main.ts`, and the Cloud
configuration in `apps/cloud-api/src/config.ts`). It is the authority the privacy documents and
the retention policy point at. Nothing here is aspirational: if a row says "encrypted", the code
path is named.

## Classes

| Class | Definition | Baseline handling |
| --- | --- | --- |
| **CRITICAL SECRET** | Compromise lets an attacker act as CodeForge itself or read everything | Process environment only; never in the database, a client, a log, a child process, or a test fixture |
| **USER SECRET** | Compromise lets an attacker act as one user against a third party | Sealed at rest (OS-backed on device; AES-256-GCM envelope in the Cloud); never returned after submission; never logged |
| **AUTHENTICATION DATA** | Session/handoff material for CodeForge itself | Stored only as SHA-256 hashes (non-reversible) or sealed; short-lived; revocable |
| **SENSITIVE USER DATA** | Personal or account data | Minimized; access scoped by user id; purged on account deletion; not logged beyond opaque ids |
| **USER CONTENT / CONFIDENTIAL WORK PRODUCT** | Source code, prompts, patches, generated artifacts | Stays on device unless a feature needs it; transient in the Cloud; sent only to the provider the user or routing selected; never used to train CodeForge models |
| **ORDINARY APPLICATION DATA** | Catalog/pricing/capability metadata, aggregate metrics | No special handling |

## Matrix

Legend for *Encryption*: "sealed" = reversible encryption (AES-256-GCM envelope, or Electron
`safeStorage`); "hashed" = SHA-256, non-reversible; "TLS" = in transit only; "provider disk" = the
database provider's storage encryption (Supabase/Neon), which CodeForge does not control.

| Data type | Class | Source | Purpose | Storage location | Encryption | Retention | Deletion | Authorized readers | Third-party destinations | Logging policy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Platform provider API keys (`OPENROUTER_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `ZHIPU_API_KEY`/`ZAI_API_KEY`, `CLOUDFLARE_API_KEY`+`CLOUDFLARE_ACCOUNT_ID`) | CRITICAL SECRET | Operator | Hosted Free / Paid Auto inference | Cloud process env (Render secret env vars) | Provider secret store; TLS to providers | Until rotated | Rotate in Render; restart | Cloud process only | The provider that owns the key | Never (env filter, redactor, `describeConfig` lists provider *ids* only) |
| `GITHUB_CLIENT_SECRET` | CRITICAL SECRET | Operator | OAuth code exchange | Cloud env | — | Until rotated | Rotate in GitHub + Render | Cloud process | GitHub | Never |
| `GITHUB_APP_PRIVATE_KEY` | CRITICAL SECRET | Operator | Sign App JWTs to mint installation tokens | Cloud env | — | Until rotated | Rotate in GitHub + Render | Cloud process (`GitHubAppClient` only) | GitHub | Never (`GitHubAppClient` collapses upstream bodies to codes) |
| `JWT_SECRET` | CRITICAL SECRET | Operator (Render `generateValue`) | Sign/verify access tokens | Cloud env | — | Until rotated (rotation invalidates all access tokens ≤1 h) | Rotate | Cloud process | None | Never |
| `CODEFORGE_DATA_ENCRYPTION_KEYS` (key ring) | CRITICAL SECRET | Operator | Wrap per-record data keys | Cloud env | — | Versioned; previous versions kept decrypt-only until rotation completes | See [key-management-and-rotation.md](./key-management-and-rotation.md) | Cloud process (`@codeforge/crypto`) | None | Never (only `activeKey=vN` is printed) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (TEST mode only; live refused at boot) | CRITICAL SECRET | Operator | Create Checkout/Portal sessions; verify webhooks | Cloud env | — | Until rotated | Rotate in Stripe + Render | Cloud process | Stripe | Never |
| `DATABASE_URL` | CRITICAL SECRET | Operator | Connect to PostgreSQL | Cloud env | TLS with certificate validation (required outside loopback in staging/prod) | Until rotated | Rotate in provider + Render | Cloud process | Supabase/Neon | Never (`describeConfig` prints driver + TLS flag only) |
| Local control-plane bearer | AUTH DATA | Generated per process | Authenticate renderer/CLI clients to the loopback API | Electron main memory; `~/.codeforge/control-token` (0600) for `forge serve`; VS Code extension memory | — | Process lifetime | Deleted at exit (CLI) | Same OS user | None | Never (header-name redaction) |
| BYOK provider keys | USER SECRET | User (Settings › Providers) or an enabled environment credential | Direct provider calls from the device | `userData/settings.json` under `codeforge:provider-credentials` | Sealed with Electron `safeStorage` (DPAPI on Windows; Keychain/Secret Service where available); plaintext read path closed; legacy plaintext sealed on first launch | Until the user deletes the provider | `provider:deleteCredential` IPC removes the entry | Electron main process (`DesktopCredentialStore`); never the renderer | The provider the user chose | Never (renderer gets a boolean status only) |
| Cloud access token (desktop copy) | AUTH DATA | Cloud | Bearer for Cloud calls (≤1 h) | `userData/settings.json` | Sealed with `safeStorage` | ≤1 h validity | Cleared on logout/deletion/401 | Electron main | CodeForge Cloud | Never |
| Cloud refresh token (desktop copy) | USER SECRET | Cloud | Rotate sessions (≤30 d) | `userData/settings.json` | Sealed with `safeStorage` | ≤30 d, rotated on use | Cleared on logout; server revokes | Electron main | CodeForge Cloud | Never (`cfr_` shape redacted) |
| Refresh-token hash (`device_sessions.refresh_token_hash`) | AUTH DATA | Cloud | Validate/rotate refresh tokens; replay detection | PostgreSQL | Hashed (SHA-256); provider disk | Session ≤30 d; revoked rows kept 30 d for replay detection, then purged | Hourly sweep; account deletion | Cloud process | None | Never |
| Browser session token hash (`browser_sessions.session_token_hash`) | AUTH DATA | Cloud | FDS website sign-in (`__Host-codeforge-session`, HttpOnly, Secure, SameSite=Lax, 7 d) | PostgreSQL | Hashed; provider disk | 7 d | Sweep; logout; account deletion | Cloud process | None | Never (`codeforge-session=` redacted) |
| Desktop auth code hash (`desktop_auth_codes.code_hash`) | AUTH DATA | Cloud | 120 s single-use handoff to the loopback listener | PostgreSQL | Hashed | 120 s | Sweep | Cloud process | Passes through the system browser as a URL parameter (worthless after use) | `cfa_` shape redacted |
| Server-owned GitHub PKCE verifier (`oauth_transactions.github_code_verifier`, `browser_oauth_transactions.github_code_verifier`) | AUTH DATA (reversible) | Cloud | Confidential-client code exchange | PostgreSQL | **Sealed**: AES-256-GCM envelope, per-record DEK, KEK-wrapped, AAD bound to `{purpose, leg, state}` | 10 min | Sweep deletes expired/consumed rows | Cloud process | GitHub (once, in the token exchange) | Never |
| Desktop PKCE challenge (`oauth_transactions.code_challenge`) | AUTH DATA | Desktop | Bind code redemption to the starting process | PostgreSQL | Plaintext (it is a hash of the desktop verifier) | 10 min | Sweep | Cloud process | None | Never |
| GitHub App callback state | AUTH DATA | Cloud | Single-use CSRF token for App installation | PostgreSQL | Plaintext random 256-bit | ≤10 min | Sweep | Cloud process | GitHub (as `state`) | Never |
| GitHub OAuth access token | USER SECRET | GitHub | Read the profile once at sign-in | **Not stored** (memory for one request) | TLS | Seconds | n/a | Cloud process | GitHub | Never (`gho_` shape redacted) |
| GitHub App installation token | USER SECRET (repo-scoped) | GitHub | Push + PR for one publication | **Not stored** (memory for one publication) | TLS | ≤1 h | n/a | Cloud publication executor | GitHub | Never |
| User record (`users`: display name, avatar URL, `github:<id>` primary identity) | SENSITIVE USER DATA | GitHub profile | Account | PostgreSQL | Provider disk | Account lifetime | Account deletion (hard delete) | Cloud; the user (`/v1/account`) | None | Opaque user id only |
| Identity record (`identities`: provider user id, login, avatar, authorized email) | SENSITIVE USER DATA | GitHub (`read:user user:email`) | Link account to GitHub; show identity in Settings | PostgreSQL | Provider disk | Account lifetime | Account deletion | Cloud; the user | None | Never logged (audit events carry user id only) |
| Device session metadata (`device_sessions`: device name, IP, user-agent, timestamps) | SENSITIVE USER DATA | Request | Session management; abuse investigation | PostgreSQL | Provider disk | Session life + 30 d | Sweep; account deletion | Cloud; the user (device list not yet exposed) | None | IP appears in security audit events |
| Browser OAuth return target | SENSITIVE USER DATA | Allowlisted static-site URL | Redirect after sign-in | PostgreSQL | — | 10 min | Sweep | Cloud | None | Never |
| Subscription/entitlement/credit ledger/usage events/reservations/hosted requests | SENSITIVE USER DATA (billing/usage) | Cloud accounting | Plan enforcement, spend caps, receipts | PostgreSQL | Provider disk | Account lifetime today (a BILLING_RECORD retention period is a pending business decision — see `packages/legal-policy/src/retention.ts`) | Account deletion deletes them today; a legally required retention window may change this once decided | Cloud; the user (`/v1/usage`, `/v1/account`) | Stripe holds its own copies | Amounts/ids only |
| Stripe webhook records (`billing_webhook_events`: event id, type, status, minimized payload — ids, amounts, statuses only; names/emails/addresses are dropped before storage) | SENSITIVE USER DATA (billing) | Stripe | Idempotent webhook processing; reconciliation audit | PostgreSQL | Provider disk | Not user-keyed; retained as a billing/idempotency record (period pending business decision — see `docs/privacy/retention-and-deletion.md`) | Not deleted on account deletion (idempotency guard against replayed events; no direct identifiers remain) | Cloud | Stripe | Event id/type only |
| Card number / CVV / expiry | — | — | **Never collected by CodeForge.** Stripe-hosted Checkout and Customer Portal collect them on Stripe's origin. | Not stored | — | — | — | Stripe only | Stripe | Never present |
| Account settings (privacy routing mode, spend limit) | SENSITIVE USER DATA | User | Routing policy | PostgreSQL | Provider disk | Account lifetime | Account deletion | Cloud; the user | None | Field names only (audit) |
| Security audit events (`security_audit_events`) | SECURITY AUDIT | Cloud | Detect/investigate abuse; incident evidence | PostgreSQL | Provider disk | Retained after account deletion with the user link severed (period pending business decision) | Anonymized on deletion | Cloud operators | Render stdout (redacted JSON line) | This *is* the log; never carries a credential |
| Abuse events (`abuse_events`) | SECURITY AUDIT | Cloud | Same | PostgreSQL | Provider disk | Same | Anonymized on deletion | Cloud operators | None | Same |
| Hosted workflow session/task text and worker outputs (`@codeforge/sessions` on the Cloud database) | USER CONTENT | Desktop (API capability not yet used by the shipping desktop) | Server-authoritative hosted workflows | PostgreSQL | Provider disk | Account lifetime | Account deletion (purged first) | Cloud; owner | None | Never |
| Hosted inference messages (prompt + context) | USER CONTENT | Desktop | One inference call | **Not persisted** by the Cloud (streamed through) | TLS both hops | Seconds | n/a | Cloud process; the selected provider | The provider (its own retention policy applies — see `docs/privacy/third-party-processing.md`) | Never (usage row records token counts only) |
| Publication git bundle | USER CONTENT | Desktop | Push certified commits and open a PR | Cloud artifact dir (`<uuid>.bundle`, ≤256 MiB) | Filesystem only (Render disk); SHA-256 integrity | Until pushed (deleted on completion) or terminal failure (swept hourly) | Deleted on completion/terminal failure; purged on account deletion | Cloud publication executor | GitHub (as commits) | Never (bytes never logged or stored in SQL) |
| Local task history (`userData/codeforge.db`: sessions, turns, events, work items, verification evidence) | USER CONTENT | Local runtime | Resume work; show activity | Device SQLite | OS file permissions; contents redacted before persistence | Until the user clears the data folder | User action (Settings › Open data folder) | Same OS user | None | Redacted at write time |
| Repository files and worktrees | USER CONTENT | User | The work itself | Device; provider (as context) | Device disk | User-controlled | User-controlled | User; agent within the workspace boundary | Selected provider (context only) | Never logged wholesale; diffs redacted |
| Model catalog, free-route qualification receipts, ForgeGreen cache | ORDINARY | Providers/CodeForge | Routing | Device + Cloud | — | Rolling | Rolling | Everyone | None | Yes |
| Aggregate security counters (`SecurityAuditLog.snapshot()`) | ORDINARY | Cloud | Health | Memory | — | Process | — | Operators | None | Yes |

## Rules the classification imposes on code

1. A CRITICAL SECRET may only be read by `loadCloudRuntimeConfig`/`resolveCloudProviderCredentials` and consumed by the adapter or client that needs it. It is never copied onto a record type that is serialized.
2. A USER SECRET is sealed before it touches disk (`sealCredential` on the desktop; `SecretEnvelopeService.encrypt` in the Cloud) and is opened only in the trusted process that needs it, for the duration of one operation.
3. AUTH DATA that must be looked up is stored as a hash; AUTH DATA that must be reversible is sealed with AAD naming its record.
4. Every SENSITIVE USER DATA query is scoped by the authenticated user id (see [tenant-isolation.md](./tenant-isolation.md)).
5. USER CONTENT is never sent anywhere the user did not select: the routing mode, the connected provider, and the publication action are the user's choices; the Cloud never trains on it.
6. Logs carry opaque ids, event names, and counts. The redacting logger and audit sanitizer enforce this at the boundary ([logging-and-audit.md](./logging-and-audit.md)).
