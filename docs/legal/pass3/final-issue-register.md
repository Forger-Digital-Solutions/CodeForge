# Final Legal & Compliance Issue Register — Pass 3 Reconciliation

<!-- PASS 3 FINAL RECONCILIATION — NOT LEGAL ADVICE — DRAFT ONLY -->

**Date**: 2026-09-11
**Status**: Authoritative Final Issue Register for CodeForge
**Classification Standard**:
- **LEGAL-P0**: Hard Launch Blocker for the specified deployment mode. Must be resolved before public release.
- **LEGAL-P1**: High Legal / Contractual Risk. Must be resolved before commercial / general availability or active marketing.
- **LEGAL-P2**: Medium Legal / Governance Risk. Required before marketplace distribution or scaling.
- **LEGAL-P3**: Low / Hygiene / Pre-Commercial Requirement. Best practice remediation.

---

## 1. Surviving P0 Issues (Hard Launch Blockers)

| Final ID | Issue Title | Affected Mode | Evidence Standard | Root Cause | Required Remediation | Owner |
|---|---|---|---|---|---|---|
| **LEG-P0-01** | **Missing Root LICENSE File** | All Public Modes (Desktop Beta, Cloud SaaS, Open Source) | `REPOSITORY_FACT` | Repository root lacks a `LICENSE` file. Defaults to "All Rights Reserved" under copyright law, contradicting open-source and free-first marketing. | Formally decide license terms (MIT recommended) and commit canonical `LICENSE` file naming Forger Digital Solutions. | Leadership / Engineering |
| **LEG-P0-02** | **Cloud Account Deletion Deficit (GDPR Art. 17)** | Cloud API / Hosted Multi-Tenant | `REPOSITORY_FACT` & `STATUTORY_FACT` | `apps/cloud-api` has no `DELETE /api/account` route, and `packages/cloud-db` lacks cascading deletion. Violates GDPR Art. 17 for registered EEA cloud users. | Implement self-service account deletion endpoint with atomic cascading database purge for user, session, and device records. | Engineering (`cloud-api`, `cloud-db`) |
| **LEG-P0-03** | **EEA Regional Ban on Unpaid Gemini Cloud Routing** | Cloud API / Hosted Routing | `EXTERNAL_CONTRACT_FACT` | Google Gemini API Terms explicitly state: *"You may use only Paid Services when making API Clients available to users in the European Economic Area, Switzerland, or the United Kingdom."* Cloud API routes via shared keys. | Enforce IP-based geoblocking in Cloud Gateway preventing EEA/UK/CH users from routing to Gemini Unpaid tier; route EEA cloud users exclusively to Paid projects or BYOK. | Engineering (`cloud-gateway`) |

---

## 2. Surviving P1 Issues (High Risk / High Commercial Priority)

| Final ID | Issue Title | Affected Mode | Evidence Standard | Root Cause | Required Remediation | Owner |
|---|---|---|---|---|---|---|
| **LEG-P1-01** | **OpenRouter Multi-Tenant Cloud Proxying Restrictions** | Cloud API / Hosted Routing | `EXTERNAL_CONTRACT_FACT` | OpenRouter ToS §7.4 prohibits reselling API access and §7.3 prohibits account pooling to bypass limits. Cloud API routing multiple users via single CodeForge key violates standard terms if monetized or pooled. | Execute OpenRouter Commercial/Enterprise Agreement before launching multi-tenant hosted routing; otherwise restrict Cloud API to Desktop BYOK only. | Leadership / Business Development |
| **LEG-P1-02** | **Mandatory 18+ Age Gate Flow-Down** | Desktop & Cloud | `EXTERNAL_CONTRACT_FACT` | Google Gemini Terms mandate that API Clients must not be directed toward individuals under 18; OpenRouter ToS §2 requires users to be 18+. | Update Terms of Service to explicitly set minimum age at 18+ and add UI onboarding age verification acknowledgment. | Legal / Product |
| **LEG-P1-03** | **Unpaid Model Training & Proprietary Code Disclosure** | Desktop & Cloud | `EXTERNAL_CONTRACT_FACT` | Google Gemini Unpaid Terms grant Google the right to use prompts for product training and human review. Users pasting employer proprietary code risk trade secret leakage. | Implement prominent UI disclosure badge and warning dialog when routing to Unpaid tiers, advising users not to submit confidential or regulated code. | Product / Engineering (`ui`, `desktop`) |
| **LEG-P1-04** | **Unsubstantiated Environmental & Autonomy Marketing Claims** | Marketing, Docs, README | `REGULATORY_GUIDANCE` (FTC / EU Green Claims) | Documentation mentions "zero emissions", "carbon savings", and "proves correctness" without empirical measurement benchmarks. | Redline README and docs to use substantiated terms: "efficiency-aware token routing" and "runs configured test verification". | Marketing / Product |
| **LEG-P1-05** | **Absence of Host OS Execution & Autonomy Disclosures** | Desktop Distribution | `LEGAL_INTERPRETATION` | Agents execute terminal commands directly on host OS via child processes. Lack of explicit warning creates liability if an autonomous agent executes a destructive command. | Add prominent first-run EULA / Terms disclosure detailing host OS command execution, and preserve interactive human-in-the-loop approval gates. | Legal / Engineering (`desktop`) |

---

## 3. Surviving P2 Issues (Medium / Marketplace / Governance)

| Final ID | Issue Title | Affected Mode | Evidence Standard | Root Cause | Required Remediation | Owner |
|---|---|---|---|---|---|---|
| **LEG-P2-01** | **`codeforge-vscode` Missing License Declaration** | VS Code Extension Marketplace | `REPOSITORY_FACT` | `packages/vscode/package.json` lacks `"license"` field and lacks `"private": true`. Public marketplace publish requires clear licensing. | Add `"license": "MIT"` (or chosen license) and include `LICENSE` file in extension root prior to `vsce publish`. | Engineering (`vscode`) |
| **LEG-P2-02** | **Internal Package Manifest License Absence (38 pkgs)** | Monorepo Hygiene | `REPOSITORY_FACT` | 38 private workspace packages lack `"license"` property, triggering monorepo linter warnings. | Add `"license": "MIT"` (or `"license": "UNLICENSED"`) across all 38 manifests to ensure consistent metadata. | Engineering (Monorepo tooling) |
| **LEG-P2-03** | **8-Bit Synthetic Benchmarking Rate Limit Protection** | Automated Qualification | `EXTERNAL_CONTRACT_FACT` | `packages/eight-bit` runs automated qualification sweeps across free models. High-frequency loops risk provider IP blocks or scraping complaints. | Implement hard daily call budget limits and permanent `SUSPENDED` state for repeated 401/403 auth failures in `health.ts`. | Engineering (`eight-bit`) |
| **LEG-P2-04** | **Stripe Test Mode to Live Mode Cutover Gate** | Commercial Monetization | `REPOSITORY_FACT` | Cloud API explicitly rejects `sk_live_` keys at boot. Commercial launch requires formal billing terms, tax handling, and PCI compliance. | Establish formal Stripe cutover checklist; keep test mode hard-enforced until live billing terms and entity formation are complete. | Engineering / Finance |
| **LEG-P2-05** | **Third-Party Attribution Completeness** | Desktop Distribution | `PACKAGED_ARTIFACT_FACT` | Shipped binary bundles `better-sqlite3` and Electron/Chromium. Proposed third-party notices draft must accurately reference bundled notices. | Finalize `docs/legal/pass3/proposed-drafts/third-party-notices.md` linking to `LICENSES.chromium.html` and adding MIT notice for `better-sqlite3`. | Legal / Documentation |
| **LEG-P2-06** | **Trademark Clearance for "CodeForge" and "ForgeZero"** | Brand & Public Launch | `EXTERNAL_CONTRACT_FACT` (USPTO) | Preliminary search shows multiple tech uses of "CodeForge". Common law conflicts could trigger cease-and-desist. | Retain trademark counsel to perform comprehensive USPTO and common-law clearance search for "CodeForge" in Class 009/042. | Leadership / IP Counsel |

---

## 4. Surviving P3 Issues (Hygiene & Pre-Commercial Best Practices)

| Final ID | Issue Title | Affected Mode | Evidence Standard | Root Cause | Required Remediation | Owner |
|---|---|---|---|---|---|---|
| **LEG-P3-01** | **Automated Data Retention & TTL Lifecycle** | Cloud API | `REPOSITORY_FACT` | Cloud PostgreSQL tables retain sessions indefinitely; no automated TTL or pruning job exists. | Implement automated 90-day retention pruning job for inactive transient session logs. | Engineering (`cloud-db`) |
| **LEG-P3-02** | **CCPA Privacy Notice Alignment** | Cloud Scaling | `STATUTORY_FACT` | While statutory thresholds are unmet today, California users expect standard CCPA "Do Not Sell/Share" disclosures. | Include California privacy disclosures in Privacy Policy as a proactive best practice. | Legal |
| **LEG-P3-03** | **Gemini Legacy Key User Guidance** | Desktop BYOK | `EXTERNAL_CONTRACT_FACT` | Google deprecated unrestricted legacy standard keys in favor of AI Studio Auth Keys. Users entering old keys will see 401 errors. | Add clear UI helper text in the provider setup screen explaining how to generate an Auth Key in Google AI Studio. | Product / UI |
| **LEG-P3-04** | **Third-Party MCP & Plugin Boundary Disclosures** | Desktop Extensibility | `LEGAL_INTERPRETATION` | Users configuring custom Model Context Protocol (MCP) servers may transmit workspace context to untrusted third-party binaries. | Add clear UI warning dialog when enabling external MCP servers stating that third-party tools are not governed by CodeForge's terms. | Product / UI |

---

## 5. Struck / Disproved Issues (No Longer on Register)

| Original ID | Claim | Pass 3 Finding | Disposition |
|---|---|---|---|
| **Pass 2 N-02** | GitHub OAuth tokens stored unencrypted in local config (P2). | Traced end-to-end: Desktop never receives GitHub tokens (server-brokered PKCE). Cloud drops GitHub tokens immediately after fetching profile. Desktop encrypts all stored credentials with Electron `safeStorage` (DPAPI/Keychain). | **STRUCK (DISPROVED)** |
| **Pass 1 P0-02 (Desktop)** | GDPR Art. 17 requires remote deletion of local SQLite sessions (P0). | CodeForge is not the data controller for local workstation files. User controls the machine. | **STRUCK FOR DESKTOP (NARROWED TO CLOUD)** |
| **Pass 1 P1-04** | CCPA compliance is an existential launch blocker (P1). | Statutory thresholds ($25M / 100k consumers) are unmet by pre-commercial CodeForge. | **STRUCK AS BLOCKER (DOWNGRADED TO P3)** |
| **Pass 1 P1-05** | Bundling Electron `ffmpeg.dll` creates LGPL copyleft risk (P1). | Electron bundles non-LGPL stub omitting proprietary codecs; full Chromium attributions bundled. Zero copyleft risk. | **STRUCK (CONFIRMED SAFE)** |
| **Pass 1 P1-07** | Copyleft contamination in packaged node_modules (P1). | Automated crawler confirmed zero GPL/AGPL dependencies in `app.asar`. | **STRUCK (CONFIRMED SAFE)** |
