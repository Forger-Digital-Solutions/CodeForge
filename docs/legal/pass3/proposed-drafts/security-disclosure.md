# CodeForge Security Vulnerability Disclosure & Architecture Policy

<!-- DRAFT — NOT YET EFFECTIVE — PENDING BUSINESS AND LEGAL REVIEW -->

**Notice**: This document is an unexecuted technical draft prepared for CodeForge (a product of Forger Digital Solutions).

---

## 1. Security Architecture Principles
CodeForge is built around defense-in-depth security principles designed to isolate agent autonomous execution and protect sensitive developer credentials:
- **Encrypted Local Credentials**: Third-party AI provider API keys and CodeForge Cloud authentication tokens are never stored in plaintext on disk. The Desktop App uses operating system-backed hardware encryption via Electron's `safeStorage` API:
  - Windows: Data Protection API (DPAPI)
  - macOS: Apple Keychain Services
  - Linux: Secret Service API / KWallet
- **Workspace Confinement**: Tool execution strictly validates paths against the active workspace root (`resolveWithinWorkspace()`), actively rejecting relative path traversal escapes (`..`).
- **Command Sanitization**: Managed child processes run with sanitized environments, stripping sensitive host credentials before spawning.
- **In-Flight Secret Redaction**: All tool outputs and terminal logs pass through an automated secret scanner (`redactSecrets()`) before being displayed in the UI or sent to model context, redacting patterns matching AWS keys, GitHub tokens, and provider API keys.

## 2. Reporting a Security Vulnerability
We welcome responsible vulnerability reports from security researchers and developers. If you believe you have discovered a security vulnerability affecting CodeForge Desktop or CodeForge Cloud:
- **Do Not Disclose Publicly**: Please do not open a public GitHub issue or disclose the vulnerability publicly until we have had an opportunity to review and remediate it.
- **Security Contact**: Email your report to:
  `[BUSINESS DECISION: security@forgerdigitalsolutions.com]`
- **Encryption**: `[BUSINESS DECISION: Link to Security PGP Public Key]`.

## 3. Responsible Disclosure SLA
- **Acknowledgment**: We strive to acknowledge receipt of your vulnerability report within **48 business hours**.
- **Assessment**: We will provide an initial severity assessment and remediation timeline within **5 business days**.
- **Coordinated Disclosure**: We commit to releasing a patch within **90 days** (or sooner for critical vulnerabilities) and will credit your discovery in our security advisories upon release.
