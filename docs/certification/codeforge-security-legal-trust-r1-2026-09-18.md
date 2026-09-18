# CodeForge Security / Legal / Trust R1 — Certification

Date: 2026-09-18
Branch: `forger-digital-solutions-forgegreen-certified`
Campaign commits: `2de62f8` (implementation, preserved as WIP) and the follow-up documentation/gate commit that carries this report; later 0.4.0 release-candidate work (`e3b8ac3`, `2a7d62f`, `b8ee115`) was reviewed for regressions of these controls and found to preserve them.
Scope owner: lead security engineer role for the R1 campaign (this repository only; no live infrastructure was modified).

## 1. Executive verdict

```text
CODEFORGE_SECURITY_R1_CERTIFIED_WITH_EXTERNAL_ACTIONS
```

The repository now has a tested cryptographic storage layer, closed legacy plaintext paths, an
authenticated local control plane on every product entry point, immediate session revocation,
payment-status-gated billing, purged retention for short-lived secrets and publication bundles, a
redacting logger and security audit trail, an automated security regression gate, and public
documentation whose claims are machine-checked against the code. No critical gap remains in the
code. The verdict is conditional on the external actions in §17 — above all configuring the
data-encryption key ring on every staging/production deployment (the Cloud now refuses to boot
without it) and establishing a real security contact. Nothing in this report asserts a regulatory
certification; see §18–§19 for the exact claims that are and are not supported.

## 2. Scope

Examined: the complete monorepo (apps `cloud-api`, `desktop`, `web`; all 44 packages), the Render
blueprint and Docker image, GitHub Actions, migrations for both database drivers, the Electron
main/preload/renderer, the local control plane, provider adapters, billing, the existing
legal package (`docs/legal`, passes 1–3), public copy (README, SECURITY.md, settings/about/onboarding
UI text), dependency tree, and repository history for secrets. Not examined: the FDS website (a
separate repository), live Render/Supabase/Neon/Stripe/GitHub dashboards (no access; owner
actions), live provider inference (no spend was authorized).

## 3. Changes implemented (code)

| Area | Change | Files |
| --- | --- | --- |
| Cryptographic storage | New `@codeforge/crypto`: AES-256-GCM envelope with per-record DEK, versioned KEK wrapping, canonical AAD binding, fail-closed decryption, staged rotation, key-ring parsing, fail-closed runtime factory | `packages/crypto/src/{envelope,key-provider,runtime,index}.ts` |
| Sealed server secret | Server-owned GitHub PKCE verifier sealed at rest with AAD `{purpose, leg, state}`; legacy plaintext read path refused; Postgres column widened | `packages/cloud-auth/src/auth-service.ts`, migration `008` |
| Configuration | `CODEFORGE_DATA_ENCRYPTION_KEYS` (required in staging/prod; ephemeral in dev), `CODEFORGE_DATA_ENCRYPTION_ACTIVE_KEY`, `CODEFORGE_SECURITY_CONTACT` (validated, no placeholders); redacted startup summary; blueprint, `.env.example`, staging contract/preflight updated | `apps/cloud-api/src/{config,staging-contract,staging-preflight}.ts`, `render.yaml`, `.env.example` |
| Session security | Every authenticated request verifies signature **and** live session (`verifyAccessSession`, 15 s cache invalidated on logout/refresh/deletion); `exp`/`iss` mandatory, `iat` skew check; `getDeviceSessionById` on both drivers; `revokeAllSessions`, `forgetSessionsOf` | `packages/cloud-auth/src/{auth-service,jwt}.ts`, `packages/cloud-db/src/{interface,sqlite,postgres}.ts` |
| Security audit trail | `SecurityAuditLog` + sinks; `security_audit_events` table (migration 008) with account-link severing on deletion; events emitted across auth, billing, GitHub App, settings, rate limit, crypto | `packages/secrets/src/security-audit.ts`, `apps/cloud-api/src/server.ts` |
| Logging redaction | `createRedactingLogger`/`redactValue` (field-name + shape redaction, bounded, error flattening); redaction patterns extended (CodeForge tokens/codes, Stripe, JWT, cookies, control token, Slack/GitLab/Anthropic) and word-boundary anchored to stop over-matching identifiers | `packages/secrets/src/{redacting-logger,redaction}.ts` |
| Child-process isolation | Env filter moved to `@codeforge/secrets`, deny list extended (DB URLs, `PGPASSWORD`, Stripe, key ring, control token, Supabase/Vault/Doppler/Sentry prefixes, `ENCRYPTION_KEY`, `_DSN`, `CONNECTION_STRING`); applied to the four previously unsanitized git spawn sites | `packages/secrets/src/env-filter.ts`, `packages/server/src/{autonomous-orchestrator,integration-service}.ts`, `packages/context/src/pack.ts`, `packages/repo-intelligence/src/engine.ts` |
| Cloud API hardening | Security headers on every response (CSP `default-src 'none'; frame-ancestors 'none'`, HSTS when HTTPS, Permissions-Policy, COOP, nosniff, no-referrer, no-store); generic `INTERNAL_ERROR` + correlation id for unknown errors; plan-id enum; Stripe return-URL origin allowlist; rate-limit audit; `security.txt` route gated on a real contact; retention sweep at boot and hourly | `apps/cloud-api/src/{server,billing-return-url,security-txt}.ts` |
| Billing integrity | `payment_status` gate (`deferred_awaiting_payment`), `async_payment_succeeded/failed` handling, unknown-user and cross-user subscription rejection, live-mode event refusal, malformed-event refusal, canceled-state protection against out-of-order `updated`/`invoice.paid`, minimized stored webhook payloads (no names/emails/addresses) | `packages/cloud-billing/src/stripe-service.ts` |
| Retention | `purgeExpiredSecurityArtifacts` (both drivers); publication bundle purge on account deletion and hourly sweep of terminal failures; deletion receipt reports `artifactsPurged`; deleted accounts' tokens refused immediately | `packages/cloud-db`, `apps/cloud-api/src/{publication-service,account-deletion,server}.ts` |
| Local control plane | `Origin: null` admitted only behind a bearer; loopback `Host` check (421) against DNS rebinding; `generateControlPlaneToken`; `forge serve` writes a 0600 bearer file and enforces it; VS Code extension generates and sends a bearer | `packages/server/src/index.ts`, `packages/cli/src/index.ts`, `packages/vscode/src/extension.ts` |
| Desktop | Pure, tested secure-credential codec; legacy plaintext read path closed; startup migration seals legacy plaintext (never destroys, reports blocked); 401 on delete clears local tokens; deny-by-default web permissions and downloads; production CSP without `'unsafe-inline'` scripts (build plugin); packaged smoke asserts plaintext rejection + migration | `apps/desktop/src/{secure-credential-codec,main}.ts`, `apps/desktop/vite.config.ts` |
| Claims gate | Security/compliance claim patterns added to the legal-policy claims scanner; public-claims scan script with negation/quotation/third-party-attribution handling | `packages/legal-policy/src/claims-scanner.ts`, `scripts/security/public-claims-scan.mjs` |
| Gates and CI | Secret scan (with self-test and reviewed allowlist), dependency audit + SBOM (expiring allowlist), doc-link validation, `security-gate.yml`, npm scripts `security:*`; scratch files ignored | `scripts/security/*`, `.github/workflows/security-gate.yml`, `package.json`, `.gitignore` |

## 4. Cryptographic architecture

Exactly as documented in `docs/security/encryption.md`: `cfe1.<kekVersion>.<wrappedDEK>.<nonce>.<ct>.<tag>`; AES-256-GCM (16-byte tag) with a fresh 32-byte DEK and 12-byte nonce per encryption; DEK wrapped with the active KEK version under the same AAD; canonical sorted-JSON AAD of `{purpose, recordId, schema, tenantId}`; envelopes name their KEK version; unknown versions and any tamper fail closed; rotation re-wraps under the active version without exposing plaintext. Key material: `CODEFORGE_DATA_ENCRYPTION_KEYS` (`v:material` entries; base64/base64url/hex 32 bytes or ≥32-char secret via HKDF-SHA256; placeholders refused). The local KEK provider is a server-only versioned master key, explicitly **not** a KMS; `KeyEncryptionProvider` is the KMS seam. Tokens: SHA-256 hashes of ≥256-bit CSPRNG values; JWT HS256 pinned; timing-safe comparisons throughout; TLS with certificate validation to the database; HSTS emitted for HTTPS origins.

## 5. Secret storage (exact behavior)

- Cloud env only: provider keys, GitHub OAuth secret + App key, JWT secret, KEK ring, Stripe keys, DB URL — never in DB, responses, logs, child processes, or clients.
- Cloud DB: no user API keys, no GitHub tokens; refresh/browser/desktop-code hashes; sealed PKCE verifiers (10-minute life, swept).
- Desktop `settings.json`: BYOK keys and Cloud tokens as `enc:` `safeStorage` payloads only; plaintext never read back; legacy plaintext sealed at startup or left unusable.
- Local bearer: memory (desktop, VS Code) or 0600 file (`forge serve`), regenerated per launch.
- Inventory and never-list: `docs/security/data-classification.md`, `docs/security/secrets-management.md`.

## 6. Authentication / OAuth results

Server-brokered GitHub OAuth with two PKCE pairs, fixed HTTPS callback, single-use state, sealed server verifier, 120-second hashed single-use desktop code, rotating refresh with breach-family revocation, `__Host-` HttpOnly Secure SameSite=Lax browser cookie, and access tokens that die at logout/revocation/deletion. No passwords exist. Tests: `packages/cloud-auth` (30), `tests/cloud-adversarial-security.test.ts`, `tests/production-auth-bypass-guard.test.ts`, ATTACK-001/002/003/007/008/014/015/016 — all pass.

## 7. Electron results

All windows: `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`, `webSecurity:true`; no bypass switches; navigation and popups denied; external links `https:`/`http://localhost` only; every `ipcMain.handle` validates the sender (enumerated by test, 0 unguarded); preload exposes named methods only and never the bearer or a credential; web permissions and downloads denied by default; production CSP `script-src 'self'` (verified in the built `dist/renderer/index.html`); local secrets via the tested codec. Not code-signed; no auto-updater; fuses not configured (owner/release-engineering items). Tests: `apps/desktop/test/electron-security-baseline.test.ts` (8), `secure-credential-codec.test.ts` (8), plus existing preload/CSP/packaged-audit/control-plane-trust suites — all pass.

## 8. GitHub results

Identity OAuth scope `read:user user:email` only; GitHub access token never stored; write access only via GitHub App installation with per-repository, one-hour, `contents:write`+`pull_requests:write` tokens minted after a live re-check; installation revocation propagates; bundles deleted after push and purged on deletion/failure. Documented in `docs/security/github-access-model.md`; tests in `packages/cloud-auth/test/github-app.test.ts` and the publication e2e suites — pass.

## 9. Tenant isolation results

Authorization derives solely from the verified live token; foreign ids are 404 before side effects; sealed secrets are AAD-bound to their record; billing grants verify subscription ownership; client-supplied plan/balance fields are stripped. No DB-level RLS (PARTIAL, documented). Tests: ATTACK-003/010/011, `apps/cloud-api/test/publication-http.e2e.test.ts`, `hosted-workflow-authority.test.ts`, `account-deletion.test.ts`, `tests/two-client-authority.test.ts`, `tests/cloud-concurrency-ledger.test.ts` — pass.

## 10. Billing / payments results

Stripe-hosted card entry only (no card fields, no card columns); HMAC-SHA256 webhook verification with 300 s tolerance and timing-safe compare; atomic idempotent event claim; `payment_status` gate; live-mode refusal; out-of-order cancellation safety; return-URL allowlist; server-side price selection; minimized stored payloads. TEST mode only; live billing untested by design. Tests: `packages/cloud-billing` (3), ATTACK-009/010, `apps/cloud-api/test/cloud-api.test.ts` — pass.

## 11. Agent blast-radius results

Every spawn site now receives the sanitized environment (agent `run_command`, `CommandService`, all git call sites in server, context packing, repository intelligence). ATTACK-005 runs `env`/`set` and a Node `process.env` dump through the real `CommandService` with eight planted control-plane secrets — none appear. Workspace containment (ATTACK-012) and tool-output redaction hold. Residual: approved commands run with the user's OS privileges inside the workspace (documented, by design).

## 12. Legal / privacy documentation

Created: `docs/security/` (19 documents + `well-known/security.txt`), `docs/privacy/` (5), `docs/legal/subprocessor-list.md`, `docs/legal/ai-and-third-party-model-disclosure.md`, `docs/legal/data-processing-addendum-draft.md`, `docs/legal/OWNER-LEGAL-INPUTS.md`, `docs/FAQ.md`, `docs/ABOUT.md`. Updated: `SECURITY.md`, `README.md`, `docs/legal/README.md`, `docs/legal/data-flow-inventory.md` (status banner), the Pass-3 proposed drafts for the Privacy Policy (rewritten to the real architecture — removed "hardware encryption", "servers never host your source", "hashed customer ids", invented 7-year/30-day retention, wrong deletion path), Security Disclosure (invented SLAs replaced with non-binding targets; controls corrected), Terms of Service (GitHub access, AI-generated code, plans/quotas, accounts/termination, contact, standardized placeholders), AUP (platform-secret extraction, cross-tenant attacks, authorized security research carve-out), Billing terms (real plans/credits/limits, Stripe-hosted card entry, cancellation via Portal, tax placeholder). Desktop copy: About section (security/data-flow links, honest license status), Data & Privacy (accurate Cloud statement). No legal entity, address, contact, governing law, refund period, or age policy was invented; every remaining placeholder is indexed in `docs/legal/OWNER-LEGAL-INPUTS.md`.

## 13. Security tests (commands and results)

```text
npx vitest run packages/crypto packages/secrets packages/cloud-auth packages/cloud-billing tests/security \
  apps/desktop/test/electron-security-baseline.test.ts apps/desktop/test/secure-credential-codec.test.ts \
  packages/server/test/network-exposure.test.ts apps/cloud-api
→ Test Files 20 passed (20) · Tests 211 passed (211)          (2026-09-18)

npx vitest run tests/security packages/crypto
→ Test Files 2 passed (2) · Tests 38 passed (38)  — ATTACK-001…016 all PASS (see docs/security/security-testing.md)

node scripts/security/secret-scan.mjs --self-test --scan
→ {"selfTest":"PASS"} · status PASS · ownerReviewRequired 0 · synthetic 511 · allowlisted 5 (docs/evidence/security-r1/secret-scan.json)

node scripts/security/audit-dependencies.mjs
→ status PASS · 0 advisories (info/low/moderate/high/critical all 0) · 540 components in sbom.json · install scripts: better-sqlite3, electron-winstaller, fsevents

node scripts/security/public-claims-scan.mjs
→ status PASS · 149 files · 0 blocking claims

node scripts/security/validate-doc-links.mjs
→ status PASS after this report was written (the four pending links pointed at this file)
```

## 14. Full regression

```text
npm run typecheck   → exit 0
npm run lint        → exit 0 (oxlint --deny-warnings)
npx vitest run      → Test Files 360 passed | 7 skipped · Tests 2722 passed | 36 skipped · exit 0
```

Full regression result (2026-09-18, `npx vitest run` at the repository root, Windows 11, Node 24): **Test Files 360 passed | 7 skipped (367) · Tests 2722 passed | 36 skipped (2758) · Duration 331.7 s · exit 0**. The 7 skipped files are the PostgreSQL suites that self-skip without `CODEFORGE_TEST_POSTGRES_URL`; `cloud-ci.yml` runs them against a real TLS PostgreSQL container.

## 15. Dependency / security scanning

`npm audit`: 0 vulnerabilities across 540 lockfile components. SBOM summary written to
`docs/evidence/security-r1/sbom.json`. Repository secret scan: no real credential in tracked or
untracked-unignored files; only synthetic fixtures and documented placeholders. Electron 44.4.1,
`pg` 8.23.0, `better-sqlite3` 12.11.1; no third-party cryptographic or authentication libraries.

## 16. Remaining risks (no euphemisms)

| Id | Risk | Status |
| --- | --- | --- |
| R-01 | PII and billing metadata are readable from a stolen database dump; disk/backup encryption is the provider's and unverified | Open — OA-04; application-layer PII encryption is a roadmap item |
| R-02 | A full Cloud environment leak is a full compromise; no managed KMS/HSM yet | Open — seam prepared; OA-03/OA-05 |
| R-04/R-13 | Approved agent commands run with the user's OS privileges inside the workspace; repository scripts can read workspace content | Accepted, documented to users |
| R-05 | No npm package provenance/signature verification | Open |
| R-07/R-10/R-17 | Same-OS-user malware can read `settings.json` (DPAPI) or process memory | Out of scope (platform limit), documented |
| R-08 | Single HS256 signing secret; rotation invalidates all access tokens (no `kid` overlap) | Open — prepared |
| R-11 | No PostgreSQL row-level security (application-layer isolation only) | Open — PARTIAL |
| R-12 | Stripe live mode never exercised; live-key refusal is by design | Open — OA-08 |
| R-15 | Publication bundles may linger on Render's ephemeral disk until container replacement | Open — OA-09 |
| R-16 | Pattern redaction cannot recognize unprefixed high-entropy secrets | Accepted, documented |
| R-18 | Operator dashboards are the administrative surface; MFA/audit unverified | Open — OA-05 |
| R-19 | Rate limiting and session-liveness cache are per process (single-instance assumption) | Open — documented |
| R-20 | Releases unsigned; no Electron fuses; no auto-update | Open — OA-07/OA-15 |
| R-21 | Retention periods for audit and billing records undecided (retained indefinitely with links severed) | Open — OA-06 |
| R-22 | No backup restore drill performed; no alerting on audit thresholds | Open — OA-12/OA-13 |

## 17. External owner actions

Blocking a public release: OA-01 (set `CODEFORGE_DATA_ENCRYPTION_KEYS` on existing deployments — boot fails without it), OA-02 (security contact), OA-03 (secret escrow), OA-04 (backup facts), OA-05 (operator MFA/audit), OA-06 (retention decisions). Non-blocking: OA-07…OA-15. Full detail: `docs/security/OWNER-ACTIONS.md`. Legal inputs: `docs/legal/OWNER-LEGAL-INPUTS.md`.

## 18. Public claims approved (evidence-backed)

- "CodeForge uses modern authenticated encryption (AES-256-GCM with a versioned key) for the sensitive values its servers store reversibly, one-way hashing for session credentials, encrypted transport (HTTPS; TLS with certificate validation to its database), scoped third-party authorization (GitHub profile-only sign-in; per-repository, short-lived GitHub App tokens), and server-side isolation of platform credentials."
- "Provider keys you connect are sealed on your device with operating-system-backed encryption (Electron `safeStorage`) and are never uploaded to CodeForge Cloud."
- "CodeForge Cloud stores no repositories, no prompts or model outputs, no user API keys, no GitHub access tokens, and no payment-card data."
- "The model never receives an API key or authorization header; agent subprocesses run with credentials removed; the agent is confined to your workspace and to the commands you approve."
- "CodeForge collects no product telemetry, analytics, or crash reports; the only cookie is the sign-in session cookie."
- "Signing out invalidates your session immediately; deleting your account deletes your Cloud data in one transaction and revokes every session."
- "Every security control above is covered by automated tests that run in CI on every change (`security-gate`)."
- "Windows releases are verifiable by published SHA-256 sums."

## 19. Public claims prohibited (not supported yet)

- Any SOC 2, ISO 27001, PCI DSS, HIPAA, FedRAMP, or FIPS certification/validation/compliance claim; any "GDPR compliant"/"CCPA compliant" claim.
- "End-to-end encrypted", "zero knowledge", "military-grade", "bank-grade", "unhackable", "hardware encryption".
- "Your code never leaves your computer" (context goes to the selected provider; publication uploads a bundle).
- "We never retain / providers never retain your data" or any "zero retention" statement about a provider.
- "Encrypted backups" or specific backup retention until OA-04 confirms them.
- "Code-signed releases", "automatic updates", "row-level security", "KMS/HSM-managed keys".
- Any binding vulnerability-response SLA or safe-harbor promise until counsel approves the wording.
- Any billing, refund, or price statement until the owner decides them (Stripe is test-mode only).

## 20. Final verdict

`CODEFORGE_SECURITY_R1_CERTIFIED_WITH_EXTERNAL_ACTIONS` — the code and documentation meet the R1
baseline the architecture can support today; public release additionally requires OA-01…OA-06.
