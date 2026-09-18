# CodeForge Security Policy

This is the canonical security policy for CodeForge (desktop app, CLI, VS Code extension, and
CodeForge Cloud). The full engineering documentation lives in [`docs/security/`](docs/security/README.md).

## Supported versions

| Version | Supported |
| --- | --- |
| Latest release on the [Releases page](https://github.com/Forger-Digital-Solutions/CodeForge/releases) and `master` | Yes |
| Older releases | No — please upgrade |

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

- **Contact**: `TODO_OWNER_SECURITY_CONTACT` — a monitored security mailbox and/or GitHub private
  vulnerability reporting will be published here once the owner configures it (tracked as
  OA-02 in [`docs/security/OWNER-ACTIONS.md`](docs/security/OWNER-ACTIONS.md)). Until then, use
  GitHub's **"Report a vulnerability"** button on this repository if it is enabled, and otherwise
  contact the maintainers privately through the repository owner profile.
- **What helps**: the component and version (desktop build, commit, or Cloud endpoint), steps to
  reproduce, the impact you observed, a minimal proof of concept, and whether you want credit.
- **Please**: test only against accounts, repositories, and data you own or are authorized to
  test; do not access other users' data; do not degrade the service. Good-faith research
  conducted this way is welcome. Formal safe-harbor wording is pending legal review
  (`docs/legal/OWNER-LEGAL-INPUTS.md`, L-12).
- **What to expect**: acknowledgement and an assessment as quickly as the maintainers can manage;
  coordinated disclosure once a fix ships; credit in the release notes if you want it. There is no
  bug bounty program at this time. Machine-readable contact: `/.well-known/security.txt` on the
  Cloud API once configured ([template](docs/security/well-known/security.txt)).

## What CodeForge does to protect you (implemented and tested)

| Area | Control |
| --- | --- |
| Credentials on your device | Provider keys and Cloud tokens are sealed with Electron `safeStorage` (OS-backed: DPAPI / Keychain / Secret Service); plaintext is never read back or written as a fallback |
| Credentials on our servers | No user API keys and no GitHub access tokens are stored; session credentials are one-way hashed; the one reversible sign-in value is AES-256-GCM sealed under a versioned server-side key ring |
| Sign-in | GitHub OAuth (profile + email only) brokered by the server with PKCE, single-use state and codes, rotating refresh tokens with replay detection, and access tokens that stop working the moment you sign out |
| GitHub access | Repository writes only through a GitHub App you install on selected repositories; per-repository tokens that expire in about an hour |
| Agent execution | Workspace containment (traversal, symlink, junction), command-risk approvals, and a credential-free environment for every subprocess |
| Platform credentials | Provider keys are injected server-side and never sent to your device or shown to a model |
| Logging | A redacting logger and a credential-free security audit trail |
| Desktop | Chromium sandbox, context isolation, no Node integration, validated IPC, strict production CSP, denied web permissions, per-launch bearer for the local API, loopback-only binding with DNS-rebinding and `Origin: null` guards |
| Payments | Stripe-hosted card entry only; signed, idempotent webhooks; payment-status gate; test mode only today |
| Regression | `security-gate` CI: crypto, secret-isolation, tenant-isolation, OAuth, payment, and Electron suites plus secret, dependency, claim, and link scans (`npm run security:tests`, `npm run security:gate`) |

What CodeForge does **not** claim: it is not end-to-end encrypted (the Cloud and the model
provider process plaintext), not zero-knowledge, holds no SOC 2 / ISO 27001 / PCI DSS / HIPAA /
FedRAMP / FIPS certification, and its Windows releases are not yet code-signed (verify the
published SHA-256 sums). See
[`docs/security/compliance-readiness-matrix.md`](docs/security/compliance-readiness-matrix.md).

## Zero-billing enforcement

CodeForge's `ForgeZero` subsystem refuses to route to models whose zero-cost status cannot be
verified (fail-closed). This describes CodeForge's own routing behavior, not a guarantee about
what a third-party provider might independently bill.

## Further reading

- Threat model: [`docs/security/threat-model.md`](docs/security/threat-model.md)
- Encryption and key management: [`docs/security/encryption.md`](docs/security/encryption.md), [`docs/security/key-management-and-rotation.md`](docs/security/key-management-and-rotation.md)
- Where your code goes: [`docs/security/data-flow.md`](docs/security/data-flow.md)
- Incident response: [`docs/security/incident-response.md`](docs/security/incident-response.md)
- Certification report: [`docs/certification/codeforge-security-legal-trust-r1-2026-09-18.md`](docs/certification/codeforge-security-legal-trust-r1-2026-09-18.md)
