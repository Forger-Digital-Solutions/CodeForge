# Final Policy Redline Findings — Pass 3 Reconciliation

<!-- PASS 3 FINAL RECONCILIATION — NOT LEGAL ADVICE — DRAFT ONLY -->

**Date**: 2026-09-11
**Author**: Pass 3 Independent Reviewer
**Methodology**: Review of Pass-1 drafts in `docs/legal/drafts/` against verified architectural realities and Pass-2/3 findings.

---

## 1. Summary of Policy Redlines

| Policy Draft | Action | Key Required Redlines | Decision / Review Markers |
|---|---|---|---|
| `terms-of-service.md` | **MODIFY HEAVILY** | Bifurcate Desktop BYOK vs. Cloud API; enforce 18+ minimum age; disclaim secondary liability for employer code; disclose host-OS execution. | `[BUSINESS DECISION: Entity Name]`, `[ATTORNEY REVIEW: Governing Law & Arbitration]` |
| `privacy-policy.md` | **MODIFY HEAVILY** | Clarify local SQLite is user-controlled (not CodeForge-controlled); detail third-party AI provider egress; disclose Google Gemini Unpaid training; document retention schedule. | `[BUSINESS DECISION: Privacy Contact Email]` |
| `acceptable-use-policy.md` | **MODIFY** | Remove "reverse engineering" prohibition if released under MIT; align prohibited AI uses with provider AUPs (OpenRouter, Google); prohibit automated scraping. | `[ATTORNEY REVIEW: Scope of AI Misuse]` |
| `ai-output-disclaimer.md` | **KEEP WITH MINOR EDITS** | Emphasize human-in-the-loop review; clarify that generated code has no warranties of non-infringement or bug-free execution. | None (Ready for review) |
| `subscription-billing-terms.md` | **MODIFY** | Explicitly label as "PRE-COMMERCIAL DRAFT"; reflect Stripe test mode; add standard auto-renewal, refund, and chargeback terms. | `[BUSINESS DECISION: Pricing & Refund Window]` |
| `desktop-software-license.md` | **MODIFY** | Ensure text perfectly reflects chosen root license (MIT recommended); remove SaaS terms conflated into client license. | `[BUSINESS DECISION: MIT vs. Commercial EULA]` |
| `third-party-notices.md` | **MODIFY** | Add MIT notice for `better-sqlite3`; incorporate explicit cross-reference to bundled `LICENSES.chromium.html`. | None (Ready for review) |
| `security-disclosure.md` | **MODIFY** | Correctly describe Electron `safeStorage` (DPAPI/Keychain) credential encryption; define responsible vulnerability disclosure SLA. | `[BUSINESS DECISION: Security Contact & PGP Key]` |
| `dmca-copyright-policy.md` | **MODIFY** | Add statutory safe harbor notice requirements (17 U.S.C. § 512(c)); specify DMCA agent registration requirement with US Copyright Office. | `[BUSINESS DECISION: Designated DMCA Agent]` |

---

## 2. Granular Policy-by-Policy Redlines

### 1. Terms of Service (`terms-of-service.md`)
- **Flaw in Pass 1 Draft**: Treated CodeForge as a pure web service. It demanded a broad IP license grant from the user to CodeForge for "all User Content submitted to the Service".
- **Required Redline**:
  - **Desktop Carve-Out**: Explicitly state that CodeForge has no possession of, and claims no license to, code or prompts processed strictly locally within the Desktop client via user-provided API keys.
  - **Cloud Scope**: Restrict the IP license grant solely to content transmitted to CodeForge Cloud API infrastructure for the purpose of delivering the service.
  - **18+ Age Requirement**: Insert mandatory clause: *"You must be at least 18 years old to access or use CodeForge. If you are under 18, you may not use the Service."* (Flow-down from Google & OpenRouter).
  - **Host OS Execution**: Disclose: *"CodeForge executes terminal commands and modifies files directly in your local environment via managed processes. You are solely responsible for reviewing agent actions before granting approval."*
  - **Arbitration & Governing Law**: Retain explicit `[BUSINESS DECISION REQUIRED]` and `[ATTORNEY REVIEW REQUIRED]` markers rather than fabricating a mandatory binding arbitration clause without corporate authorization.

---

### 2. Privacy Policy (`privacy-policy.md`)
- **Flaw in Pass 1 Draft**: Conflated local SQLite logs with cloud databases, falsely claiming CodeForge acts as a GDPR data controller for all desktop sessions.
- **Required Redline**:
  - **Bifurcated Structure**:
    - *Section A: Local Desktop App*: Explicitly state that session histories, workspace paths, and local files reside on the user's workstation. CodeForge servers do not collect, receive, or store local desktop sessions.
    - *Section B: CodeForge Cloud Service*: Disclose collection of GitHub profile information (ID, username, email), device session tokens, and billing records for registered cloud users.
  - **Zero Telemetry Truth**: Confirm that CodeForge bundles zero analytics or tracking telemetry. Clarify that network egress occurs strictly to external AI providers (OpenRouter, Google, Groq) during active inference.
  - **Third-Party AI Training Disclosure**: Explicitly warn: *"If you configure or route to the Google Gemini Unpaid tier, Google's Terms of Service permit Google to use submitted prompts and outputs for model training, and data may be reviewed by human annotators. Do not submit confidential employer code or regulated personal data to unpaid tiers."*
  - **Data Retention**: Incorporate the approved retention schedule (account data until deleted, device tokens 30 days, billing records 7 years).

---

### 3. Acceptable Use Policy (`acceptable-use-policy.md`)
- **Flaw in Pass 1 Draft**: Contained a blanket prohibition against "reverse engineering, decompiling, or disassembling the software".
- **Required Redline**:
  - If CodeForge is released under the MIT Open Source License, prohibiting reverse engineering contradicts the MIT License grant. Strike this clause for open-source releases, or restrict it strictly to the proprietary Cloud API infrastructure.
  - Add explicit prohibitions against using CodeForge to:
    - Circumvent provider rate limits or terms of service (e.g., using multi-accounting to exploit free tier allowances).
    - Generate malicious code, malware, exploits, or automated cyberattacks.
    - Conduct high-frequency automated scraping or denial-of-service against model providers.

---

### 4. AI Output Disclaimer (`ai-output-disclaimer.md`)
- **Pass 1 Draft Assessment**: Substantively solid.
- **Required Redline**:
  - Add explicit language addressing AI-generated hallucinations, security vulnerabilities in generated code, and open-source license infringement in generated snippets.
  - Reiterate that the developer retains sole professional responsibility for reviewing, testing, compiling, and deploying any code authored or modified by CodeForge agents.

---

### 5. Subscription & Billing Terms (`subscription-billing-terms.md`)
- **Flaw in Pass 1 Draft**: Drafted as if commercial billing were active and operational.
- **Required Redline**:
  - Prepend bold notice: `DRAFT — PRE-COMMERCIAL BILLING TERMS. CODEFORGE CURRENTLY OPERATES IN DEVELOPMENT / TEST MODE ONLY.`
  - Detail credit allowance policies, recurring monthly billing, Stripe payment processing, statutory refund rights (e.g., EU 14-day statutory right of withdrawal), and dispute mechanisms.
  - Keep pricing, plan tiers, and refund windows as `[BUSINESS DECISION REQUIRED]`.

---

### 6. Desktop Software License (`desktop-software-license.md`)
- **Flaw in Pass 1 Draft**: Attempted to combine a SaaS Terms of Service with a desktop software license.
- **Required Redline**:
  - If MIT Open Source is selected: Replace this document with the standard, canonical MIT License text.
  - If a Commercial Proprietary EULA is selected: Retain explicit grant of rights (single-user workstation install), restrictions on redistribution, warranty disclaimers, and limitation of liability.

---

### 7. Third-Party Notices (`third-party-notices.md`)
- **Flaw in Pass 1 Draft**: Incomplete attribution. Missed `better-sqlite3` and did not provide clear directions to bundled Chromium notices.
- **Required Redline**:
  - Add full MIT License copyright notice for `better-sqlite3` (`Copyright (c) 2017 Joshua Wise`).
  - Add full MIT License copyright notice for Electron (`Copyright (c) OpenJS Foundation and Electron contributors`).
  - Direct users to `LICENSES.chromium.html` (bundled in the installation directory) for third-party notices covering Chromium, V8, ANGLE, and SwiftShader.

---

### 8. Security Disclosure Policy (`security-disclosure.md`)
- **Flaw in Pass 1 Draft**: Implied end-to-end encryption without documenting local storage mechanisms.
- **Required Redline**:
  - Accurately document that local credentials (provider API keys and CodeForge Cloud JWT tokens) are encrypted at rest using operating system-backed hardware/user keys via Electron's `safeStorage` API (DPAPI on Windows, Keychain on macOS, Secret Service on Linux).
  - Provide a dedicated security contact email (`security@forgerdigitalsolutions.com`) and standard 90-day responsible vulnerability disclosure guidelines.

---

### 9. DMCA & Copyright Policy (`dmca-copyright-policy.md`)
- **Flaw in Pass 1 Draft**: Inserted boilerplate text without identifying a registered DMCA agent.
- **Required Redline**:
  - Under 17 U.S.C. § 512(c)(2), to claim DMCA safe harbor for user-uploaded cloud content, a service provider must register a designated agent with the U.S. Copyright Office.
  - Retain prominent marker: `[BUSINESS DECISION REQUIRED: Designate and register DMCA agent with US Copyright Office before hosting public user content]`.
  - Provide complete statutory notice requirements (identification of copyrighted work, contact info, statement under penalty of perjury).
