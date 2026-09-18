# CodeForge Privacy Policy

<!-- DRAFT — NOT YET EFFECTIVE — PENDING BUSINESS AND LEGAL REVIEW -->
<!-- Technical facts reconciled with the repository on 2026-09-18 (Security / Legal / Trust R1). -->

**Notice**: This document is an unexecuted legal draft prepared for CodeForge (a product of
`[LEGAL ENTITY NAME — OWNER INPUT REQUIRED]`, referred to here as "Forger Digital Solutions" or
"we"). It does not constitute a binding privacy notice until formally approved, dated, and
published by authorized leadership after legal review. Every statement about how CodeForge
handles data below is verified against the software in the repository; every statement about
legal rights is subject to counsel's confirmation of which laws apply to you.

---

## 1. Overview

CodeForge is a local-first coding agent with an optional cloud account. Your repository stays on
your machine. When CodeForge asks an AI model to help with a task, it sends the relevant prompt
and code context to the model provider serving that request. CodeForge collects no product
analytics or telemetry. This policy explains what we process, why, where it goes, how long we
keep it, and the choices you have.

## 2. Data kept on your device (and the exceptions you control)

When you use the CodeForge desktop application:

- **Task history**: your sessions, agent event traces, tool output (after secret redaction), and verification evidence are stored in a SQLite database in the CodeForge data folder on your computer. We do not upload it.
- **Source code**: CodeForge reads, edits, and creates files inside the workspace you open. It does not clone, mirror, or sync your repositories to our servers. Exceptions you initiate: (a) sending context to a model provider for a task (Section 5); (b) using **Publish**, which uploads a git bundle of your certified commits to CodeForge Cloud so it can be pushed to your GitHub repository and is deleted after the push (Section 4).
- **Credentials**: provider API keys you connect (BYOK) and your CodeForge Cloud session tokens are stored on your device sealed with Electron's `safeStorage`, which uses operating-system-backed protection (DPAPI on Windows; Keychain on macOS; Secret Service where available on Linux). They are never uploaded to CodeForge Cloud and never shown to the application's user interface after you enter them. Where a secure backend is unavailable, CodeForge refuses to save the credential rather than storing it unprotected.
- **No remote access**: we cannot see your files, your local task history, or your local credentials, and we do not back up your local data.

## 3. Data processed by CodeForge Cloud (only if you sign in)

Signing in is optional; BYOK/direct providers work without an account.

- **Identity**: your GitHub numeric id, username, display name, avatar URL, and the primary verified email address you authorize GitHub to share (scope `read:user user:email`). We do not store your GitHub password (we never see it) or your GitHub access token (it is used once to read your profile and discarded).
- **Sessions**: a hashed refresh token, device name, IP address, browser/user-agent string, and timestamps for each signed-in device; on the website sign-in, a hashed session cookie (`__Host-codeforge-session`, HttpOnly, Secure).
- **Settings and usage**: your privacy routing mode and spend limit; per-request usage records (provider, model, token counts, estimated cost, credits, status). We do **not** store the text of prompts or model outputs relayed through hosted routes.
- **Billing metadata** (if billing is enabled): Stripe customer and subscription identifiers, plan, status, period dates, and minimized webhook records (identifiers, amounts, statuses). Card details are entered only on Stripe-hosted pages and never reach our servers. Stripe currently operates in test mode for CodeForge.
- **GitHub App authorization and publications**: the installation id, account name, the repositories you selected, and publication records (commit and tree hashes, target branch, pull-request number/URL, status).
- **Security audit events**: event type and outcome, your opaque account id, IP address, and small redacted details for security-relevant actions (sign-in, sign-out, failures, billing events). These never contain credentials.

## 4. Publishing to GitHub

If you use Publish, CodeForge uploads a bundle of the certified commits to CodeForge Cloud, which
pushes them to the repository you authorized using a token limited to that one repository and
valid for about an hour, opens a pull request, and then deletes the bundle. Bundles of failed
publications are removed automatically and when you delete your account.

## 5. AI model providers

To perform tasks, CodeForge transmits your prompt, the code context it selected, and tool results
to the model provider serving the request. Which provider depends on the route:

- **ForgeAuto / Managed Free and Paid routes**: your request is relayed through CodeForge Cloud (not stored) to a provider using CodeForge's own credentials. Today's providers are listed in our sub-processor list (`docs/legal/subprocessor-list.md`).
- **BYOK / direct providers**: your request goes from your machine directly to the provider under your own account; CodeForge Cloud is not involved.

Each provider's own privacy policy and terms govern what it does with that content. **Some free
tiers permit the provider to use your prompts for training or human review** — for example
Google's unpaid Gemini API tier. CodeForge's **Strict** privacy routing mode excludes such tiers
from ForgeAuto. We do not claim that any provider retains nothing; where a provider's retention
terms are not published we treat them as unknown. Full disclosure:
`docs/legal/ai-and-third-party-model-disclosure.md`. We do not use your prompts, code, or outputs
to train any CodeForge model, and we train none.

## 6. No analytics, advertising, or sale of personal data

CodeForge contains no analytics, advertising, session-replay, or crash-reporting software. The
application's only network traffic is to the model providers you use, GitHub during sign-in and
publishing, Stripe if you open billing, and CodeForge Cloud if you are signed in. We do not sell
personal data and do not share it for cross-context behavioral advertising. Our service
providers (hosting, database, payment processing, identity, and the model providers used by
hosted routes) process data on our behalf as described in the sub-processor list.

## 7. Retention and deletion

- **Local data**: kept on your device until you delete it (Settings › Data & Privacy › Open data folder).
- **Sign-in artifacts**: authorization transactions expire within 10 minutes; desktop handoff codes within 2 minutes; access tokens within 1 hour; refresh tokens within 30 days (rotated on use); website session cookies within 7 days. Expired and revoked records are purged automatically (revoked sessions are kept 30 days for replay detection).
- **Account data**: kept until you delete your account. Deleting your account (Settings › Profile › Delete account) permanently deletes your identity, sessions, settings, usage, ledger, entitlements, GitHub App authorizations, publication records and staged bundles, and revokes every active session, and returns a receipt listing categories and counts.
- **Retained after deletion**: security audit and abuse-prevention events with your account id removed, and billing records, for periods to be set by `[RETENTION PERIODS — OWNER INPUT REQUIRED]`; records required by law.
- **Backups**: our database provider keeps snapshots for its retention window (protected according to that provider's practices); deleted rows disappear from snapshots as they age out. We cannot delete individual rows from a provider snapshot.
- **Third parties**: data already sent to a model provider, GitHub, or Stripe is governed by their policies; revoke GitHub grants on GitHub.

Details: `docs/privacy/retention-and-deletion.md`.

## 8. Your rights and choices

Depending on where you live you may have rights to access, correct, delete, or export your
personal data, to object to or restrict certain processing, and to complain to a supervisory
authority. Which rights apply is determined by applicable law
`[APPLICABILITY — LEGAL REVIEW REQUIRED]`. How to exercise them:

- Access your account and usage in the app (Settings) or via the API (`GET /v1/account`, `GET /v1/usage`).
- Delete your account in the app or via `DELETE /v1/account`.
- Correct identity details on GitHub, then sign in again.
- Choose your route family, privacy routing mode, and connected providers in Settings.
- For anything else, contact `[PRIVACY CONTACT — OWNER INPUT REQUIRED]`; we verify requests against the email linked to your GitHub identity. Our internal procedure is `docs/privacy/privacy-rights-workflow.md`.

## 9. Security

We use HTTPS for all network communication; TLS with certificate validation between our API and
its database; operating-system-backed encryption for credentials stored on your device; AES-256-GCM
authenticated encryption with a versioned key for the sensitive values our servers store
reversibly; one-way hashing for session credentials; scoped, short-lived third-party
authorizations (GitHub); server-side isolation of platform credentials; per-account access
control; and automated security regression testing. No method of transmission or storage is
completely secure, and we hold no third-party security certification (such as SOC 2 or ISO
27001) at this time. Details: `docs/security/README.md`. To report a vulnerability see
`SECURITY.md`.

## 10. International transfers

CodeForge Cloud and its service providers operate in the United States; model providers may
process data in other regions under their terms. `[TRANSFER MECHANISM — LEGAL REVIEW REQUIRED]`

## 11. Children

CodeForge is intended for adults. The application asks you to confirm you are at least 18 years
old `[MINIMUM AGE — LEGAL REVIEW REQUIRED]`. We do not knowingly collect personal data from
children; if we learn we have, we delete the account.

## 12. Changes to this policy

We will post changes here with a new effective date and, for material changes affecting
signed-in users, notify you in the application or by the email linked to your account.

## 13. Contact

`[LEGAL ENTITY NAME — OWNER INPUT REQUIRED]`
`[MAILING ADDRESS — OWNER INPUT REQUIRED]`
`[PRIVACY CONTACT — OWNER INPUT REQUIRED]`
