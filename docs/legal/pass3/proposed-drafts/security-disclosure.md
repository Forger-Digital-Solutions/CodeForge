# CodeForge Security & Vulnerability Disclosure Policy

<!-- DRAFT — NOT YET EFFECTIVE — PENDING BUSINESS AND LEGAL REVIEW -->
<!-- Technical facts reconciled with the repository on 2026-09-18 (Security / Legal / Trust R1). -->

**Notice**: This document is an unexecuted draft prepared for CodeForge (a product of
`[LEGAL ENTITY NAME — OWNER INPUT REQUIRED]`). The canonical, current version of the reporting
policy is the repository `SECURITY.md`; this draft is the version intended for the public website.

---

## 1. How CodeForge protects you (what actually exists)

- **Credentials on your device** — provider API keys and CodeForge Cloud tokens are sealed with Electron `safeStorage` (operating-system-backed protection: DPAPI on Windows, Keychain on macOS, Secret Service on Linux where available). Unprotected storage is refused rather than used as a fallback.
- **Credentials on our servers** — CodeForge Cloud stores no user API keys and no GitHub access tokens. Session credentials are stored as one-way hashes. The one reversible value it must keep (a short-lived sign-in verifier) is encrypted with AES-256-GCM under a versioned server-side key.
- **Least-privilege GitHub access** — signing in asks only for your profile and email; repository write access exists only through a GitHub App you install on selected repositories, with per-repository tokens that expire in about an hour.
- **Isolation of the coding agent** — tool execution is confined to your workspace (path traversal and symlink escapes are refused), commands classified as risky require your approval, and every subprocess receives an environment with credentials removed.
- **Isolation of platform credentials** — the model never receives an API key or authorization header; provider credentials are injected server-side and never sent to your device.
- **Secret redaction** — tool output, diffs, errors, and logs pass through a credential redactor.
- **Desktop hardening** — Chromium sandbox, context isolation, no Node integration in the interface, validated inter-process messages, a strict content-security policy, and a per-launch bearer for the local API.
- **Payments** — card details are entered only on Stripe-hosted pages; CodeForge never receives them; webhooks are signature-verified and idempotent.
- **Testing** — an automated security regression gate runs cryptographic, secret-isolation, tenant-isolation, OAuth, payment, and desktop assertions on every change.

Full documentation: `docs/security/README.md`. We hold no third-party security certification.

## 2. Reporting a vulnerability

We welcome good-faith reports from security researchers and users. If you believe you have found a
vulnerability affecting CodeForge Desktop, the CLI, the VS Code extension, or CodeForge Cloud:

- **Do not** open a public GitHub issue or disclose publicly before we have had a chance to respond.
- **Contact**: `TODO_OWNER_SECURITY_CONTACT` (a monitored security mailbox and/or GitHub private vulnerability reporting will be published here — see `docs/security/OWNER-ACTIONS.md`).
- **Helpful report contents**: affected component and version, steps to reproduce, impact, any proof-of-concept, and how you would like to be credited.
- **Please avoid**: accessing other users' data, degrading the service, social engineering, or physical attacks. Test against your own accounts and repositories.

## 3. What to expect

These are targets, not contractual commitments: `[ATTORNEY REVIEW REQUIRED if binding SLAs are desired]`

- Acknowledgement of receipt within `[OWNER DECISION: e.g. 3 business days]`.
- An initial assessment and expected timeline within `[OWNER DECISION: e.g. 10 business days]`.
- Coordinated disclosure once a fix is available; credit in the release notes/advisory if you wish.
- No bug bounty program exists at this time.

## 4. Good-faith research

`[ATTORNEY REVIEW REQUIRED: safe-harbor language]` — the current position is that we will not
pursue legal action against researchers who act in good faith, follow this policy, and avoid
privacy violations, data destruction, and service disruption; counsel must confirm the exact
wording and scope before publication.

## 5. Supported versions

Security fixes are provided for the latest released version of CodeForge. Older releases should
be upgraded.
