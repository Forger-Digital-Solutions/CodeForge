# Newly Discovered Issues (Missing from Pass 1) — Pass 2 Independent Review

<!-- PASS 2 ADVERSARIAL REVIEW — NOT LEGAL ADVICE — DRAFT ONLY -->

## Overview
During the Pass 2 adversarial review, several critical legal, technical, and commercial risks were identified that were entirely missed by the Pass 1 audit.

## 1. Google API Key Deprecation (LEGAL/COMMERCIAL-P1-NEW-01)
- **The Finding:** As of June 19, 2026, Google deprecated unrestricted standard API keys (the format typically assigned to `GEMINI_API_KEY`). By September 2026, these standard keys are being aggressively rejected in favor of service-account bound "auth keys."
- **Why Pass 1 Missed It:** Pass 1 read the Gemini Terms of Service but failed to read the current API Authentication documentation or test the live API endpoints.
- **Impact:** CodeForge's BYOK (Bring Your Own Key) integration for Google Gemini may be entirely broken for newly registered users, or will break imminently. The codebase (`packages/model-registry/src/snapshot.ts`) still assumes standard API key string injection.
- **Remediation:** [ENGINEERING RECOMMENDATION] Update the authentication flow for Gemini to support Google Cloud Service Account JSON credentials or OAuth2, deprecating the legacy single-string API key approach.

## 2. `codeforge-vscode` License Publishing Risk (LEGAL-P2-NEW-02)
- **The Finding:** The `packages/vscode` directory builds `codeforge-vscode`. This package is missing a `"license"` field in its `package.json`, AND it is the *only* package not marked `"private": true`.
- **Why Pass 1 Missed It:** Pass 1 aggregated all missing licenses into a single block of "20 packages" and assumed they were all private monorepo packages. Pass 1 miscounted (there are 39) and failed to notice the VS Code extension's specific status.
- **Impact:** When published to the Visual Studio Code Marketplace via `vsce publish`, the lack of an explicit license defaults to "All Rights Reserved" under US Copyright law. Users installing an AI coding agent generally expect open-source (e.g., MIT) or explicit EULA terms. A missing license creates legal ambiguity for end-users regarding their right to install and use the extension.
- **Remediation:** [BUSINESS DECISION] Formally define the license for the VS Code client (e.g., MIT, Apache 2.0, or a custom EULA) and inject it into `packages/vscode/package.json`.

## 3. GitHub OAuth Credential Storage Security (SECURITY/LEGAL-P2-NEW-03)
- **The Finding:** CodeForge utilizes GitHub OAuth for repository access. A Pass 2 codebase scan for secure credential storage APIs (such as Electron's `safeStorage`, `keytar`, or platform keychain integrations) yielded **zero results**.
- **Why Pass 1 Missed It:** Pass 1 focused purely on Terms of Service text and missed platform security implementation requirements.
- **Impact:** If GitHub OAuth tokens (which may possess high-privilege `repo` scopes) are stored in plaintext in local config files or `localStorage`, it represents a significant security vulnerability. While not a direct violation of a specific third-party API contract, it exposes CodeForge to immense liability in the event of local machine compromise.
- **Remediation:** [ENGINEERING RECOMMENDATION] Implement Electron's `safeStorage` API to encrypt OAuth tokens before persisting them to disk on Windows, macOS, and Linux.

## 4. Eight-Bit Health Check Exponential Backoff Validity (COMMERCIAL-P3-NEW-04)
- **The Finding:** `packages/eight-bit/src/health.ts` implements health tracking and exponential backoff (`cooldownMsFor`) for rate limits (429) and auth failures (401).
- **Why Pass 1 Missed It:** Pass 1 evaluated the existence of 8-Bit, but didn't verify if its health-checking mechanisms were robust enough to avoid triggering automated bans from providers like OpenRouter or Anthropic.
- **Impact:** The current backoff caps at 15 minutes (`MAX_COOLDOWN_MS`). If an API key is permanently revoked, CodeForge will continue probing it every 15 minutes indefinitely while the app is running. This could trigger aggressive IP bans from providers for the user.
- **Remediation:** [ENGINEERING RECOMMENDATION] Implement a permanent "SUSPENDED" state for keys that repeatedly fail 401 Unauthorized after a long threshold, requiring manual user intervention to resume probing.
