# Owner Actions (Security / Legal / Trust R1)

Actions that only the owner/operator of CodeForge can take because they happen outside this
repository: platform settings, vendor dashboards, DNS, certificates, business and legal
decisions. Nothing here is coding work. Each entry states why it exists, the risk of leaving it
undone, where it happens, exact steps, whether it blocks a public release, and how to verify.

Legal/business inputs (entity name, addresses, governing law, refund terms, contacts for the
policies) are tracked separately in [`docs/legal/OWNER-LEGAL-INPUTS.md`](../legal/OWNER-LEGAL-INPUTS.md).

| # | Action | Blocks public release? |
| --- | --- | --- |
| OA-01 | Set `CODEFORGE_DATA_ENCRYPTION_KEYS` on every staging/production deployment | **Yes** (the Cloud refuses to boot without it) |
| OA-02 | Establish the security contact and set `CODEFORGE_SECURITY_CONTACT` | **Yes** (public vulnerability policy needs a real contact) |
| OA-03 | Escrow all Cloud secrets (incl. the key ring) in an owner-controlled secret manager | Yes |
| OA-04 | Verify the database provider's backup encryption, retention, and access controls; record them | Yes (privacy documents promise only what this confirms) |
| OA-05 | Enable MFA and audit logging on Render, the database provider, GitHub org, Stripe, and provider consoles | Yes |
| OA-06 | Decide retention periods for BILLING_RECORD and SECURITY_AUDIT classes | Yes (privacy policy and deletion receipts reference them) |
| OA-07 | Obtain a Windows code-signing certificate and wire it into the release workflow | No (releases ship unsigned with SHA-256 sums today; strongly recommended) |
| OA-08 | Decide whether/when Stripe moves from TEST to LIVE mode | No (billing is test-only until decided) |
| OA-09 | Configure persistent, encrypted storage (or object storage with lifecycle rules) for publication bundles on Render | No (bundles are short-lived; ephemeral disk is acceptable for staging) |
| OA-10 | Confirm `CODEFORGE_TRUST_PROXY`/`CODEFORGE_TRUSTED_REGION_HEADER` match the real edge; enable HSTS preload only when every subdomain is HTTPS | No |
| OA-11 | Configure Dependabot/Renovate (or a scheduled `security:audit` run) and branch protection requiring `security-gate` | No |
| OA-12 | Perform and record a backup restore drill on staging | No |
| OA-13 | Set up alerting on audit-event thresholds in the platform log tool | No |
| OA-14 | Publish `security.txt` on the FDS website domain(s) as well as the API | No |
| OA-15 | Add `@electron/fuses` hardening to the packaging step (release-engineering, no external input, but needs a packaged-build verification cycle) | No |

## OA-01 — Data-encryption key ring
- **Why**: the Cloud seals the server-owned PKCE verifier (and any future reversible secret) with a KEK ring from this variable; staging/production refuse to boot without it.
- **Risk if undone**: the next staging/production deploy fails at boot (fail-closed by design).
- **Where**: Render → service → Environment. `render.yaml` now declares the variable with `generateValue: true` for *new* blueprint deployments; an **existing** service must have it added manually.
- **Steps**: `openssl rand -base64 32` → set `CODEFORGE_DATA_ENCRYPTION_KEYS=1:<value>` → deploy → confirm the boot log line contains `secretEnvelope=local-kek activeKey=v1 knownKeys=[v1]`.
- **Verify**: `npm run cloud:staging:preflight` passes `crypto.key_ring_present`; a staging sign-in completes.

## OA-02 — Security contact
- **Why**: `SECURITY.md`, `security.txt`, the privacy policy, and incident response all need a monitored channel; CodeForge refuses to publish a placeholder.
- **Risk**: researchers cannot report vulnerabilities privately; disclosure happens in public issues.
- **Where**: a mailbox (e.g. a `security@` alias on the FDS domain) or a GitHub private vulnerability reporting setting; then Render env.
- **Steps**: create the alias with at least two recipients; optionally enable GitHub → Settings → Code security → Private vulnerability reporting; set `CODEFORGE_SECURITY_CONTACT=mailto:<alias>`; redeploy; replace `TODO_OWNER_SECURITY_CONTACT` in `SECURITY.md`, `docs/security/well-known/security.txt`, and the legal drafts.
- **Verify**: `curl https://<api>/.well-known/security.txt` returns the contact; `SECURITY.md` has no TODO marker.

## OA-03 — Secret escrow
- **Why**: Render is the only holder of the JWT secret, key ring, and provider keys; losing the Render account means losing them (the key ring in particular must survive backup retention windows).
- **Steps**: store every value in the organization's password/secret manager with the date and version; repeat at every rotation; document who has access.
- **Verify**: a second maintainer can restore the env from escrow alone.

## OA-04 — Database provider backups
- **Why**: [backups-and-recovery.md](./backups-and-recovery.md) can only say "provider-managed" until the actual plan settings are confirmed.
- **Steps**: in the Supabase/Neon dashboard record: encryption at rest (yes/no, key management), backup frequency, retention window, point-in-time recovery, who can download backups, region. Paste the facts into `backups-and-recovery.md` and the privacy retention document.
- **Verify**: the privacy documents no longer say "REQUIRES THIRD-PARTY VERIFICATION" for backup retention.

## OA-05 — Operator account hardening
- **Why**: there is no CodeForge admin API; operator access to Render, the database, GitHub (org owner), Stripe, and provider consoles *is* the administrative surface (threat model R-18).
- **Steps**: enforce MFA on every account; enable audit logs where offered; restrict Render/DB dashboard membership to maintainers; use restricted Stripe keys (`rk_`) with only the permissions the Cloud needs (Checkout Sessions, Billing Portal, webhooks).
- **Verify**: list of accounts with MFA status kept alongside OA-03.

## OA-06 — Retention decisions
- **Why**: `packages/legal-policy/src/retention.ts` marks BILLING_RECORD and SECURITY_AUDIT as `BUSINESS_DECISION_REQUIRED`; the code retains them after account deletion with the user link severed, without a purge horizon.
- **Steps**: decide (with counsel/accountant) e.g. "billing records 7 years; security audit events 12 months", then set the numbers in `retention.ts` (engineering will wire the purge once numbers exist) and in the privacy policy.
- **Verify**: `DEFAULT_RETENTION_POLICY` shows `CONFIGURED` for both classes.

## OA-07 — Code signing
- **Why**: unsigned installers trigger SmartScreen and cannot be attributed; users currently verify SHA-256 sums manually.
- **Steps**: obtain an OV/EV code-signing certificate (or Azure Trusted Signing); add the signing configuration to `apps/desktop/package.json` (`win.sign`/`certificateSubjectName`) and the secret to `windows-desktop.yml`; keep the private key in an HSM/KMS, never in the repository.
- **Verify**: `Get-AuthenticodeSignature CodeForge-Setup-*.exe` shows a valid signature on a release asset.

## OA-08 — Stripe live mode
- **Why**: the Cloud refuses live keys at boot by design; moving to live mode is a commercial and legal decision (pricing, refunds, tax) that the billing terms must reflect first.
- **Steps**: complete `docs/legal/OWNER-LEGAL-INPUTS.md` billing items; remove the live-key refusal deliberately in code (with a review) only after that; use restricted live keys; register the live webhook endpoint.
- **Verify**: billing terms published; `config.ts` change reviewed; `ATTACK-009` extended with live-mode fixtures.

## OA-09 — Bundle storage
- **Why**: publication bundles (source code) sit on Render's disk until pushed; ephemeral disks may keep bytes until the container is replaced (threat model R-15).
- **Steps**: attach a Render persistent disk (encrypted at rest per Render) mounted at the artifact directory, or move artifacts to object storage with a 24-hour lifecycle rule; document the choice in `data-flow.md`.
- **Verify**: `describeConfig`/deployment notes name the artifact root; lifecycle rule visible in the provider console.

## OA-10 — Edge/proxy configuration
- **Why**: `CODEFORGE_TRUST_PROXY=true` is only safe when the service is reachable exclusively through the platform proxy; the region header must be one the edge sets and clients cannot forge.
- **Steps**: confirm with Render that direct access bypassing the proxy is impossible; set the region header name only if the edge provides one; enable HSTS preload submission only when the whole domain is HTTPS.
- **Verify**: the trust-proxy test in `tests/cloud-adversarial-security.test.ts` documents the behavior; production headers inspected with `curl -I`.

## OA-11 — Dependency automation and branch protection
- **Steps**: enable Dependabot security updates on the repository; require the `security-gate` and `cloud-ci` checks on `master`; restrict force-push.
- **Verify**: a PR without green `security-gate` cannot merge.

## OA-12 — Restore drill
- **Steps**: follow `backups-and-recovery.md` §"Restore drill (staging)"; record date, duration, and outcome under `docs/evidence/security-r1/`.

## OA-13 — Alerting
- **Steps**: in the platform log tool, alert on spikes of `billing.webhook.signature_invalid`, `auth.session.replay_detected`, `crypto.decrypt.failed`, `ratelimit.exceeded`, and on any `INTERNAL_ERROR` burst.

## OA-14 — security.txt on the website
- **Steps**: publish the same file at `https://forgerdigitalsolutions.com/.well-known/security.txt` (the FDS site is not in this repository); keep `Expires` within a year and renew.

## OA-15 — Electron fuses
- **Steps**: add `@electron/fuses` to `apps/desktop/scripts` to flip `RunAsNode=false`, `EnableNodeCliInspectArguments=false`, `EnableNodeOptionsEnvironmentVariable=false`, `OnlyLoadAppFromAsar=true`, `EnableEmbeddedAsarIntegrityValidation=true` after packaging; run the packaged smoke; ship.
