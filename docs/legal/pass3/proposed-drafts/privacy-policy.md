# CodeForge Privacy Policy

<!-- DRAFT — NOT YET EFFECTIVE — PENDING BUSINESS AND LEGAL REVIEW -->

**Notice**: This document is an unexecuted legal draft prepared for CodeForge (a product of Forger Digital Solutions). It does not constitute a binding privacy notice until formally approved, dated, and published by authorized leadership.

---

## 1. Overview & Commitment to Local-First Architecture
CodeForge is designed with a **local-first, zero-telemetry architecture**. We believe your source code and development activities should remain under your control. This Privacy Policy explains what data CodeForge processes, what data remains exclusively on your workstation, and how third-party AI providers handle data when you configure model routing.

## 2. What Data Remains on Your Local Device
When you use the CodeForge Desktop Application:
- **Local SQLite Database (`sessions.db`)**: Your session chat histories, agent event traces, tool execution outputs, and local project paths are stored solely in an SQLite database on your local hard drive.
- **Source Code**: CodeForge inspects, edits, and creates files locally within your authorized workspace. CodeForge servers never clone, sync, or host your local source code repositories.
- **Credential Storage**: Third-party AI provider API keys (OpenRouter, Google, Groq) and CodeForge Cloud authentication tokens are stored locally on your device in encrypted form using operating system-backed hardware encryption via Electron's `safeStorage` API (DPAPI on Windows, Keychain on macOS, Secret Service on Linux).
- **No Access by CodeForge**: Forger Digital Solutions does not have remote access to your local workstation, does not back up your local database, and cannot view your local files.

## 3. What Data Is Processed by CodeForge Cloud
If and only if you choose to sign in to the optional CodeForge Cloud Service:
- **Identity Information**: We process your public GitHub user profile (GitHub numeric ID, username, display name, and avatar URL) via server-brokered GitHub OAuth to provision your account. We do not store your GitHub password or GitHub OAuth access token.
- **Account & Billing Records**: If billing is enabled, we process subscription status, customer identifier hashes, and transaction timestamps. Credit card details are handled directly by Stripe and are never received or stored on CodeForge servers.
- **Session & Device Tokens**: We store hashed device tokens and session state in our hosted PostgreSQL database to maintain authenticated sessions and manage allowance quotas.
- **Cloud Erasure Rights (GDPR Art. 17)**: If you are an EU/EEA resident, you have the right to request the total erasure of your cloud account. You may submit an erasure request via `DELETE /api/account` or by emailing `[BUSINESS DECISION: privacy@forgerdigitalsolutions.com]`.

## 4. Zero Analytics Telemetry Policy
- **No Product Telemetry**: CodeForge contains **zero background tracking, product usage telemetry, advertising trackers, or crash reporting SDKs** (no Google Analytics, Sentry, Mixpanel, Segment, or PostHog).
- **Network Egress Clarification**: While CodeForge collects zero analytics telemetry, the application naturally initiates network requests to:
  1. Your configured third-party AI inference providers during active sessions.
  2. The CodeForge Cloud API, if you sign in to a cloud account.
  3. GitHub OAuth authorization endpoints during sign-in.

## 5. Third-Party AI Model Provider Data Flows
When you ask CodeForge to perform a task, the agent transmits relevant code snippets and prompt instructions to the AI model provider you have configured:
- **Google Gemini Unpaid Tier Notice**: If you configure Google Gemini using an unpaid API key from Google AI Studio, Google's Terms of Service state that Google uses prompts and outputs for model training and product improvement, and human reviewers may read and annotate this data. **Do not submit sensitive, confidential, or proprietary employer code to unpaid model tiers.**
- **Google Gemini Paid Tier**: When accessed via a Paid Google Cloud billing project, prompts and outputs are not used for model training and are governed by Google Cloud's Data Processing Addendum.
- **OpenRouter**: Requests routed through OpenRouter are forwarded to the selected downstream model provider in accordance with OpenRouter's privacy policy and DPA.

## 6. Children's Privacy
CodeForge is strictly intended for individuals who are **18 years of age or older**. We do not knowingly collect personal data from individuals under 18. If we become aware that a user under 18 has registered for a Cloud account, we will immediately delete that account.

## 7. Data Retention Schedule
- **Local Desktop Data**: Retained indefinitely on your machine until you manually clear it.
- **Cloud Account Data**: Retained until you delete your account.
- **Cloud Session Tokens**: Automatically expired and purged after 30 days of inactivity.
- **Billing Records**: Retained for 7 years to satisfy statutory tax, legal, and audit compliance requirements.

## 8. Contact Information & Data Protection Officer
For questions regarding this Privacy Policy or to exercise your statutory privacy rights, contact:
`[BUSINESS DECISION REQUIRED: privacy@forgerdigitalsolutions.com / Legal Address]`
