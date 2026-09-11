# Disputed Findings Resolution — Pass 3 Final Reconciliation

<!-- PASS 3 FINAL RECONCILIATION — NOT LEGAL ADVICE — DRAFT ONLY -->

**Date**: 2026-09-11
**Author**: Pass 3 Independent Reviewer
**Methodology**: Independent primary-source re-investigation, end-to-end codebase tracing, and packaged binary inspection. Neither Pass 1 nor Pass 2 is presumed authoritative.

---

## Executive Summary of Reconciled Findings

| Disputed Finding | Pass 1 Claim | Pass 2 Finding | Pass 3 Final Resolution | Final Status |
|---|---|---|---|---|
| **Gemini API Authentication** | Assumed standard API key format works indefinitely. | Claimed Google deprecated standard keys in June 2026; asserted CodeForge must rewrite auth to use Service Account JSON or OAuth2. | **CONFIRMED WITH CORRECTION / NARROWED**: Google deprecated unrestricted legacy standard keys (`AIza...`) in favor of service-account-bound "Auth Keys". However, Google AI Studio generates these Auth Keys as standard string tokens that are still passed via `Authorization: Bearer <key>`. CodeForge does NOT need raw Service Account JSON uploads or mandatory OAuth2 for Desktop BYOK. | **CONFIRMED_WITH_CORRECTION** |
| **GitHub OAuth Token Storage** | Flagged OAuth integration generally. | Claimed GitHub OAuth tokens are "likely stored unencrypted" due to negative search for `safeStorage`/`keytar`. Rated P2 risk. | **COMPLETELY DISPROVED**: CodeForge Desktop never receives or stores a GitHub OAuth token! The flow is server-brokered with PKCE. CodeForge Cloud drops the GitHub token immediately after fetching the `read:user` profile and stores zero GitHub tokens in Postgres. Furthermore, Desktop DOES use Electron `safeStorage.encryptString()` (DPAPI/Keychain) to encrypt all local credentials. | **DISPROVED** |
| **OpenRouter ToS §7 (Resale)** | Claimed hosted proxying and routing violated ToS Section 7. | Narrowed to distinguish Desktop BYOK (permitted) from Cloud multi-tenant proxying (restricted). | **CONFIRMED WITH NARROWER SCOPE**: Standard terms (§7.4) prohibit reselling API access and §7.3 prohibits multi-account pooling. Desktop BYOK is clearly permitted. Cloud multi-tenant routing requires an Enterprise/Commercial Agreement. | **CONFIRMED_WITH_NARROWER_SCOPE** |
| **GDPR Art. 17 (Right to Erasure)** | Declared an immediate P0 launch blocker across all sessions. | Narrowed to Cloud DB; asserted local SQLite is user-controlled. | **CONFIRMED FOR CLOUD / REJECTED FOR DESKTOP**: CodeForge is NOT the data controller (GDPR Art. 4(7)) for local SQLite sessions residing on the user's hard drive; CodeForge has no legal obligation or technical means to erase local files. For Cloud PostgreSQL, CodeForge IS the controller; lack of account deletion is a true P0 blocker for Cloud API launch in the EEA. | **NARROWED** |
| **CCPA/CPRA Applicability** | Treated CCPA as an immediate P0/P1 compliance blocker. | Downgraded to P3 because thresholds are unmet. | **DOWNGRADED**: Statutory thresholds under Cal. Civ. Code § 1798.140(c) ($25M revenue, 100k consumers) are not met by pre-commercial CodeForge. CCPA obligations do not legally attach today. Retained as an engineering best practice before scaling. | **DOWNGRADED** |
| **Internal Package License Count** | Reported exactly 20 internal packages missing `"license"` field. | Reported 39 packages missing `"license"` field. | **REPRODUCED & EXPLAINED**: Exactly 39 packages in `packages/` and 3 apps in `apps/` lack `"license"`. Pass 1 stopped counting at 20 or used an incomplete glob. 38 packages are marked `"private": true`; only `codeforge-vscode` is not private. | **CONFIRMED PASS 2 COUNT (39)** |
| **`codeforge-vscode` License Gap** | Not identified. | Identified as public package missing license, claimed current launch blocker. | **NARROWED**: The package is in development and has NOT been published to the VS Code Marketplace. It is a pre-marketplace publication requirement (P2), not an active desktop release blocker. | **NARROWED** |
| **Electron FFmpeg & Copyleft** | Raised potential LGPL copyleft contamination concerns. | Concluded standard Electron non-LGPL stub; zero copyleft risk. | **CONFIRMED SAFE**: Bundled `ffmpeg.dll` is Electron's standard build (omitting proprietary codecs); Chromium and Electron notices are bundled (`LICENSES.chromium.html`). No GPL/AGPL dependencies exist in `app.asar`. | **CONFIRMED SAFE** |
| **Stripe Test Mode** | Classified as P1 legal risk. | Downgraded to P2 commercial readiness blocker. | **DOWNGRADED**: Hardcoded configuration guard in `apps/cloud-api/src/config.ts` actively refuses live Stripe keys at boot. Test mode is a development boundary, not a deceptive commercial violation. | **DOWNGRADED (P3 / Pre-Commercial)** |
| **Host OS Tool Execution** | Described as "completely unsandboxed execution". | Described as unsandboxed host OS execution. | **RECONCILED WITH PRECISE LANGUAGE**: Execution occurs via managed hidden child processes directly on the host OS without container/VM isolation. However, strict path confinement, environment sanitization, 60s timeouts, secret redaction, and human approval gates are enforced. | **RECONCILED** |

---

## Detailed Investigation 1: Gemini API Authentication

### Pass 1 vs. Pass 2 Disagreement
- **Pass 1**: Treated Google Gemini API key as a standard static credential (`GEMINI_API_KEY`), noting free quota allowance.
- **Pass 2**: Claimed Google deprecated standard API keys in June 2026, and asserted that CodeForge must rewrite its provider layer to require Google Cloud Service Account JSON credentials or OAuth2.

### Pass 3 Independent Investigation
1. **Primary Source**: Google Gemini API Official Documentation (`ai.google.dev`), updated September 2026.
2. **Finding (`EXTERNAL_CONTRACT_FACT`)**:
   - Google deprecated *unrestricted, legacy standard API keys* (the legacy Google Cloud Console keys with the `AIza...` prefix that lacked service-account IAM bindings).
   - As of June 19, 2026, unrestricted standard keys are rejected by the Gemini API endpoints.
   - However, the replacement is **"Authorization (Auth) Keys"**.
   - When a user visits Google AI Studio and clicks "Get API key", Google AI Studio **automatically creates an Auth Key bound to a Google Cloud project and service account under the hood**.
   - To the developer and end-user, this Auth Key is **still an API key string**!
   - The user copies the key string from Google AI Studio and injects it via environment variable (`GEMINI_API_KEY`) or config.
   - The OpenAI-compatible endpoint used by CodeForge (`https://generativelanguage.googleapis.com/v1beta/openai`) accepts this Auth Key string directly in the standard HTTP header:
     ```http
     Authorization: Bearer <AUTH_KEY_STRING>
     ```
3. **Repository Fact (`REPOSITORY_FACT`)**:
   - CodeForge's `OpenAICompatibleAdapter` (`packages/providers/src/openai-compatible.ts`) sends `Authorization: Bearer <key>` by default.
   - It already connects to `https://generativelanguage.googleapis.com/v1beta/openai` (`packages/providers/src/provider-factory.ts:39`).
4. **Pass 3 Resolution**:
   - Pass 2 was **factually correct** that legacy unrestricted keys are deprecated.
   - Pass 2 was **critically incorrect** in claiming CodeForge must force users to upload raw Service Account JSON files or implement complex Google OAuth2 for Desktop BYOK.
   - The UX remains standard: users generate an Auth Key in Google AI Studio and enter it into CodeForge.
   - **Remediation**: Update onboarding documentation and in-app error handling to clarify that keys must be generated via Google AI Studio (Auth Key format), and provide clear guidance if an obsolete `AIza...` legacy key is rejected.

---

## Detailed Investigation 2: GitHub OAuth Credential Storage

### Pass 1 vs. Pass 2 Disagreement
- **Pass 1**: Flagged OAuth as an external dependency requiring scopes review.
- **Pass 2**: Conducted a negative code search for `safeStorage` and `keytar`, concluded that GitHub OAuth tokens were "likely stored unencrypted in local config or localStorage," and labeled this a major security liability (P2 / N-02).

### Pass 3 End-to-End Tracing
Pass 3 traced the credential lifecycle through every hop across Desktop and Cloud.

1. **Desktop Initiation (`apps/desktop/src/cloud-auth-flow.ts`)**:
   - The Desktop client is a **public client**. It holds **no GitHub client secret** and **never communicates with GitHub's token endpoint** (`cloud-auth-flow.ts:9-16`).
   - Desktop generates an ephemeral PKCE verifier/challenge pair (`createDesktopPkce()`).
   - Desktop calls Cloud API `POST /v1/auth/start`.
2. **Cloud Brokering (`packages/cloud-auth/src/auth-service.ts`)**:
   - Cloud acts as the **confidential client**. It generates a second, server-held PKCE pair for GitHub.
   - User authenticates with GitHub in the browser. GitHub requests only the minimal scope: `read:user` (`github-oauth.ts:16`).
   - GitHub redirects back to Cloud callback: `GET /v1/auth/github/callback`.
   - Cloud exchanges the code with GitHub for a short-lived access token (`exchangeGitHubCode()`).
   - Cloud calls GitHub API `GET /user` to fetch the user profile (`fetchGitHubUserProfile()`).
   - **CRITICAL FINDING (`REPOSITORY_FACT`)**: **Cloud NEVER persists the GitHub access token in PostgreSQL!** The token is discarded immediately after fetching the public profile (`auth-service.ts:248-267` and `332-348`).
   - Cloud provisions the local user record and mints a single-use, 120-second handoff authorization code (`createDesktopAuthCode()`).
   - Cloud redirects to Desktop's loopback listener with this single-use code.
3. **Desktop Redemption (`apps/desktop/src/main.ts:1545-1553`)**:
   - Desktop exchanges the handoff code and PKCE verifier with Cloud API `POST /v1/auth/exchange`.
   - Cloud verifies the PKCE binding and mints **CodeForge Cloud JWT tokens** (`accessToken`, `refreshToken`).
   - Desktop receives the CodeForge Cloud tokens. **Desktop never sees or touches a GitHub OAuth token.**
4. **Desktop Persistence (`apps/desktop/src/main.ts:305-311`, `536-542`)**:
   - Desktop calls `saveCloudTokens(accessToken, refreshToken, user)`:
     ```typescript
     function saveCloudTokens(accessToken: string, refreshToken: string, user: any): void {
       const settings = readSettings();
       settings[CLOUD_ACCESS_TOKEN_KEY] = encryptCredential(accessToken);
       settings[CLOUD_REFRESH_TOKEN_KEY] = encryptCredential(refreshToken);
       settings[CLOUD_USER_KEY] = user;
       writeSettingsAtomic(settings);
     }
     ```
   - And `encryptCredential` explicitly uses Electron's native `safeStorage` API:
     ```typescript
     function encryptCredential(value: string): string {
       if (!safeStorage.isEncryptionAvailable()) {
         throw new Error("Secure credential storage is unavailable; the credential was not saved.");
       }
       const buf = safeStorage.encryptString(value);
       return `enc:${buf.toString("base64")}`;
     }
     ```
   - On Windows, `safeStorage` delegates to DPAPI (Data Protection API). On macOS, it delegates to Keychain. On Linux, it delegates to Secret Service / KWallet.
   - Provider API keys (OpenRouter, Gemini, Groq) are ALSO encrypted using this exact mechanism (`main.ts:369`).
5. **Pass 3 Resolution**:
   - Pass 2's finding was based on a flawed search and is **COMPLETELY DISPROVED**.
   - No GitHub OAuth tokens are stored on either Desktop or Cloud.
   - All persisted desktop credentials (Cloud JWTs and provider API keys) are **fully encrypted at rest using OS-backed hardware/user keys via Electron `safeStorage`**.
   - Issue LEGAL-P2-NEW-03 / N-02 is **STRUCK FROM THE REGISTER**.

---

## Detailed Investigation 3: OpenRouter §7 Reselling vs. BYOK

### Primary Source Verification (`EXTERNAL_CONTRACT_FACT`)
- **Document**: OpenRouter Terms of Service (`https://openrouter.ai/terms`).
- **Effective Date**: August 31, 2026 (verified current as of September 11, 2026).
- **Clause §7.3**: Prohibits creating "multiple accounts as a single user, for purposes of bypassing or circumventing use limits on the Site or Service or for any other reason".
- **Clause §7.4**: Prohibits accessing "the Site or Service for purposes of reselling API access to Models or otherwise developing a competing service".
- **Clause §8**: Restricts "Red Teaming" and adversarial probing without prior written consent.
- **Clause §10.2**: Mandates a Data Processing Agreement (DPA) for commercial / for-profit operations.

### Reconciliation Across 8 Technical Architectures
Pass 3 reconciles the dispute between Pass 1 and Pass 2 across the 8 specific architectures:

1. **Architecture A — Desktop User BYOK**:
   - *Data Path*: User enters own key -> Desktop client -> OpenRouter API.
   - *Status*: **PERMITTED_BY_CURRENT_STANDARD_TERMS**. CodeForge acts as an HTTP client application, not a reseller or competing service.
2. **Architecture B — User OAuth PKCE**:
   - *Data Path*: User authenticates directly with OpenRouter via browser PKCE.
   - *Status*: **PERMITTED_BY_CURRENT_STANDARD_TERMS**.
3. **Architecture C — CodeForge-Owned Key on Desktop**:
   - *Data Path*: Desktop binary bundles a CodeForge-owned key.
   - *Status*: **RESTRICTED**. Distributing a shared key risks account pooling and immediate suspension under §7.3.
4. **Architecture D — Multi-Tenant Cloud Proxy (Hosted Routing)**:
   - *Data Path*: Cloud API receives user prompt -> calls OpenRouter via single CodeForge key.
   - *Status*: **RESTRICTED / ENTERPRISE_AGREEMENT_REQUIRED**. Monetizing this layer violates §7.4 ("reselling API access"). Pooling users behind one account violates §7.3.
5. **Architecture E — ForgeAuto/Free Hosted Routing**:
   - *Data Path*: Cloud API routes free users to OpenRouter `:free` models via shared key.
   - *Status*: **RESTRICTED / ENTERPRISE_AGREEMENT_REQUIRED**. Pooling thousands of users to exploit OpenRouter's free community quota circumvents per-account rate limits (§7.3).
6. **Architecture F — Paid Subscription Bundling Model Access**:
   - *Data Path*: User pays CodeForge $20/mo; CodeForge covers OpenRouter model costs.
   - *Status*: **RESTRICTED / ENTERPRISE_AGREEMENT_REQUIRED**. Direct resale of inference under standard terms.
7. **Architecture G — 8-Bit Qualification / Benchmarking**:
   - *Data Path*: `packages/eight-bit` runs synthetic tests across free models.
   - *Status*: **AMBIGUOUS / ATTORNEY_REVIEW_REQUIRED**. Local developer testing is routine API usage. Continuous automated fleet-wide probing of free models risks triggering §7.5 (scraping) or §8 (adversarial evaluation).
8. **Architecture H — Negotiated Enterprise Agreement**:
   - *Data Path*: Formal commercial contract executed with OpenRouter Inc.
   - *Status*: **PERMITTED_BY_CONTRACT**. Overrides standard ToS restrictions for Architectures D, E, and F.

---

## Detailed Investigation 4: GDPR Article 17 (Local vs. Hosted)

### Primary Statutory Authority (`STATUTORY_FACT`)
- **GDPR Art. 4(7)**: "'controller' means the natural or legal person... which, alone or jointly with others, determines the purposes and means of the processing of personal data."
- **GDPR Art. 17**: Right to erasure ("right to be forgotten") requires the controller to erase personal data without undue delay where statutory grounds apply.

### Architectural Reality (`REPOSITORY_FACT`)
- **Local Desktop**: CodeForge is a downloadable desktop application. The local SQLite database (`sessions.db`) is created on the user's local filesystem (`packages/sessions/src/persistence.ts`). CodeForge (Forger Digital Solutions) does not operate a sync server for local sessions, does not receive telemetry containing session data, and has no remote administrative access to user hard drives.
- **Hosted Cloud API**: CodeForge operates PostgreSQL databases (`apps/cloud-api`) storing user account records, device tokens, session metadata, and payment records.

### Pass 3 Reconciliation
1. **Local Desktop**: CodeForge/FDS does not determine the purposes and means of local session processing, nor does it hold or process the data. The *user* is the controller of their own local workstation. CodeForge has no statutory obligation or technical capability under GDPR Art. 17 to remotely delete local SQLite files. Local session deletion is a product usability feature, not a statutory DSR compliance pipeline.
2. **Cloud API**: CodeForge/FDS IS the data controller for accounts registered in the Cloud API. The lack of a `DELETE /api/account` endpoint and cascading DB purge in `packages/cloud-db` is a **CONFIRMED P0 BLOCKER for commercial Cloud API launch in the EEA**.

---

## Detailed Investigation 5: CCPA / CPRA Applicability

### Statutory Thresholds (`STATUTORY_FACT`)
Under Cal. Civ. Code § 1798.140(c), the CCPA/CPRA applies only to for-profit businesses doing business in California that meet at least ONE of:
1. Gross annual revenue exceeding **$25,000,000**;
2. Annually buys, sells, or shares the personal information of **100,000 or more consumers or households**;
3. Derives **50% or more of annual revenue** from selling or sharing consumers' personal information.

### Business Reality (`REPOSITORY_FACT` / `BUSINESS_DECISION`)
- CodeForge is pre-commercial software with zero gross revenue.
- CodeForge has zero active commercial customers and does not buy, sell, or share consumer data.
- CodeForge does not derive revenue from data brokerage.

### Pass 3 Reconciliation
Pass 1 erroneously claimed CCPA compliance was an existential P0 launch blocker. Pass 2 correctly downgraded this claim. Pass 3 confirms: **CCPA statutory obligations do NOT legally apply to CodeForge today.**
However, because CodeForge aspires to scale commercially, implementing CCPA-compatible privacy policy disclosures and self-service account deletion is retained as an **ENGINEERING_RECOMMENDATION (P3)**.

---

## Detailed Investigation 6: Internal Package License Count

### Reproduction of Package Count (`REPOSITORY_FACT`)
An exhaustive scan of the repository manifests revealed:
- `packages/*`: Exactly **39 directories**, each containing a `package.json`.
- `apps/*`: Exactly **3 directories** (`cloud-api`, `desktop`, `web`), each containing a `package.json`.
- Missing `"license"` field: **All 39 packages in `packages/` and all 3 apps in `apps/`** lack a `"license"` property.
- Pass 1 claimed: 20 packages. (Pass 1 undercounted by 19 packages due to an incomplete directory glob).
- Pass 2 claimed: 39 packages. (Pass 2 correctly counted `packages/*`).

### Package Classification Breakdown
1. **38 Internal Workspace Packages (`packages/[a-z]*`)**:
   - All 38 have `"private": true`.
   - None are published to npm.
   - Missing `"license"` is an internal metadata hygiene defect (`ENGINEERING_METADATA_FIX`), not an external legal risk.
2. **1 VS Code Extension Package (`packages/vscode`)**:
   - Manifest name: `codeforge-vscode`, version `0.2.0`.
   - Lacks `"private": true`.
   - Lacks `"license"` field.
   - Lacks a bundled `LICENSE` file.
   - **Current Status**: The extension has NOT been published to the Visual Studio Marketplace. It is an internal development artifact. Therefore, it does NOT block the Desktop binary release today. However, adding an explicit license is a mandatory prerequisite prior to running `vsce publish` (`LEGAL-P2-PRE-MARKETPLACE`).

---

## Detailed Investigation 7: Autonomous Process Execution & Sandbox Claims

### Architectural Inspection (`REPOSITORY_FACT`)
CodeForge executes agent commands via `ToolBroker` in `packages/tools/src/index.ts`.
1. **Confinement**: `resolveWithinWorkspace(workspacePath, targetPath)` rigorously checks path resolution and rejects any target path that traverses outside the workspace root (`escapesBoundary()`).
2. **Execution Primitive**: Spawns `cmd.exe /d /c <cmd>` (Windows) or `/bin/sh -c <cmd>` (Unix) as a hidden child process (`windowsHide: true`).
3. **Environment**: `getSanitizedEnvForChild()` strips sensitive environment variables.
4. **Guardrails**: Hard 60-second timeout, cancellation abort signal listeners, secret redaction (`redactSecrets()`), and output bounding (64 KB / 500 lines).
5. **Approval Gates**: Write tools and commands check `permissions[permKey]` and workflow approval rules.
6. **Isolation Deficit**: Commands execute directly on the user's host operating system with the user's ambient privileges. There is no OCI container (Docker), Linux cgroup, AppContainer, or hypervisor microVM enclosing the execution.

### Pass 3 Reconciliation
- Pass 1 / Pass 2 calling the runtime "completely unsandboxed" was imprecise because meaningful path confinement, environment stripping, and approval gates exist.
- However, calling it "sandboxed" in public marketing would be misleading.
- **Reconciled Truthful Disclosure**:
  *"CodeForge executes terminal commands directly in the user's local operating system environment via managed child processes. While workspace directory traversal boundaries, environment sanitization, execution timeouts, secret redaction, and approval gates are enforced, commands run with the ambient privileges of the host user account and are not isolated inside a mandatory virtual machine or container sandbox."*

---

## Detailed Investigation 8: Stripe Test Mode Status

### Repository Inspection (`REPOSITORY_FACT`)
In `apps/cloud-api/src/config.ts:251-253`:
```typescript
if (e.STRIPE_SECRET_KEY && /^(sk|rk)_live_/.test(e.STRIPE_SECRET_KEY)) {
  throw new CloudConfigError("Live Stripe keys (sk_live_/rk_live_) are refused. CodeForge Cloud runs in Stripe TEST MODE only.");
}
```
And in `apps/cloud-api/src/config.ts:267-270`:
In staging/production, Stripe configuration is completely omitted unless explicitly supplied by the operator. If supplied, only `sk_test_` keys are accepted.
- Live Stripe keys are rejected at boot by design.
- No commercial billing is enabled.
- No customer funds are processed.

### Pass 3 Reconciliation
Pass 1 classified Stripe test mode as a P1 legal issue. Pass 2 maintained this. Pass 3 firmly **DOWNGRADES** this finding to an **ENGINEERING / BUSINESS READINESS REQUIREMENT (P3)**. Operating in test mode during pre-commercial development is safe, standard, and legally compliant. It only becomes a blocker when leadership makes the business decision to activate commercial monetization.
