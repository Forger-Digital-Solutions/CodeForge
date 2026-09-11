# Policy Redline Findings — Pass 2 Independent Review

<!-- PASS 2 ADVERSARIAL REVIEW — NOT LEGAL ADVICE — DRAFT ONLY -->

## Overview
Pass 1 generated 9 draft policy documents (Terms of Service, Privacy Policy, Acceptable Use, etc.) and placed them in `docs/legal/drafts/`. Pass 2 conducted an adversarial review of these drafts, leaving the original files untouched while logging required redlines and structural flaws here.

## General Critique of Pass-1 Drafts
The Pass 1 drafts suffer from the same architectural misunderstanding as the Pass 1 audit: they treat CodeForge uniformly as a centralized SaaS platform, failing to legally distinguish between the local Desktop application (where the user controls the data/compute) and the Cloud API (where CodeForge controls the data/compute).

## 1. Terms of Service (`terms-of-service.md`)
- **Flaw:** Grants CodeForge a broad license to "User Content" (prompts/code).
- **Redline Required:** Must explicitly carve out Desktop BYOK usage. CodeForge has no technical access to, and therefore requires no license for, local SQLite session data. The license grant must apply *only* to data synced to the Cloud API.
- **Flaw:** Arbitration clause was auto-inserted by Pass 1.
- **Redline Required:** Re-insert `[BUSINESS DECISION REQUIRED]` for binding arbitration and class-action waivers.

## 2. Privacy Policy (`privacy-policy.md`)
- **Flaw:** Claims CodeForge processes "all chat logs" and promises GDPR compliance for them.
- **Redline Required:** 
  1. Clearly state that local sessions are stored on the user's device and CodeForge cannot delete them remotely.
  2. Clarify that GDPR Data Subject Requests (DSRs) apply *only* to Cloud Accounts and telemetry (if ever enabled).
- **Flaw:** Fails to disclose Google's Unpaid Tier training practices.
- **Redline Required:** Must add explicit disclosure: "If you utilize the Unpaid Google Gemini tier, Google's Terms of Service state that your inputs may be reviewed by humans and used to train Google's models. Do not submit sensitive proprietary code."

## 3. Third-Party Notices (`third-party-notices.md`)
- **Flaw:** Missed `better-sqlite3`.
- **Redline Required:** Add MIT license attribution for `better-sqlite3` and explicitly reference the bundled `LICENSES.chromium.html` for Chromium/V8/Node attributions.

## 4. Acceptable Use Policy (`acceptable-use.md`)
- **Flaw:** Prohibits "reverse engineering."
- **Redline Required:** If CodeForge leadership decides to release the client as Open Source (MIT), the prohibition on reverse engineering must be struck from the AUP, as it contradicts open-source licensing.

## 5. Security Policy (`security.md`)
- **Flaw:** Implies end-to-end encryption or secure storage of credentials.
- **Redline Required:** Pass 2 found no evidence of `safeStorage` implementation for GitHub OAuth tokens. Until fixed, the Security Policy must not falsely claim that local credentials are encrypted at rest by the operating system keychain.

## 6. End User License Agreement (EULA)
- **Flaw:** Pass 1 did not draft a distinct EULA, attempting to merge software licensing into the SaaS Terms of Service.
- **Redline Required:** CodeForge needs a bifurcated legal structure:
  - **EULA / Open Source License:** Governs the download, installation, and modification of the Desktop client.
  - **Terms of Service:** Governs the usage of the CodeForge Cloud API, ForgeZero routing, and billing.

## Disposition
Do not publish the Pass 1 drafts. They require heavy revision by legal counsel to accurately reflect the hybrid Desktop/Cloud architecture.
