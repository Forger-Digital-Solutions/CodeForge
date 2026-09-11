# CodeForge Legal Readiness — Pass 3 Final Reconciliation Report

<!-- PASS 3 FINAL RECONCILIATION — NOT LEGAL ADVICE — DRAFT ONLY -->

**Milestone**: Pass 3 Final Independent AI Reconciliation
**Date**: 2026-09-11
**Repository**: `G:\CodeForge`
**Git Commit**: `6b8159d3d30116c972511bcfef6a32cb3a1d4822` (Pass 2 commit)
**Branch**: `feat/codeforge-cloud`

---

## 1. Final AI Legal-Readiness Verdict

### Verdict: `CODEFORGE_LEGAL_PASS3_READY_FOR_REMEDIATION_AND_COUNSEL`

**Explicit Legal Governance Boundaries**:
- This report **DOES NOT** declare CodeForge legally compliant.
- This report **DOES NOT** claim attorney approval.
- This report **DOES NOT** certify any commercial release.
- All legal conclusions are operational AI assessments provided to assist company leadership and outside legal counsel in preparing CodeForge for lawful commercial distribution.

---

## 2. Pass-1 Findings Retained

1. **Missing Root LICENSE File**: Pass 1 correctly flagged the absence of a `LICENSE` file at the repository root as a fundamental barrier to open-source collaboration and corporate procurement (`LEG-P0-01`).
2. **Open-Source Dependency Permissiveness**: Pass 1 correctly determined that external runtime dependencies bundled into the desktop release are licensed under permissive terms (MIT, Apache 2.0, BSD) with zero GPL/AGPL viral copyleft contamination.
3. **Google Gemini EEA Regional Restriction**: Pass 1 correctly identified that Google's Gemini API Terms prohibit making API clients available in the EEA/UK/CH unless Paid Services are used (`LEG-P0-03`).
4. **Agent Autonomy Disclosures**: Pass 1 correctly identified that autonomous agent actions and host command executions require clear contractual disclaimers and human approval boundaries (`LEG-P1-05`).

---

## 3. Pass-1 Findings Rejected or Narrowed

1. **GDPR Art. 17 Global Blocker (`REJECTED FOR DESKTOP / NARROWED TO CLOUD`)**: Pass 1 asserted that GDPR Art. 17 required automated deletion across all sessions. Pass 3 rejected this for local desktop SQLite files (CodeForge is not the data controller for local workstation files; the user controls the hardware). The erasure requirement is retained solely for Cloud API user accounts.
2. **CCPA/CPRA as P1 Blocker (`REJECTED`)**: Pass 1 failed to conduct a statutory threshold analysis. CodeForge does not meet the $25M revenue or 100k consumer thresholds. CCPA obligations do not legally attach today.
3. **OpenRouter Integration Illegality (`REJECTED`)**: Pass 1 implied that OpenRouter integration was broadly barred under Section 7. Pass 3 proved that Desktop BYOK is clearly permitted under standard terms.
4. **Internal Package License Count (`CORRECTED`)**: Pass 1 reported 20 missing package licenses. Pass 3 reproduced the exact number: 39 packages.

---

## 4. Pass-2 Findings Retained

1. **39 Internal Package Count**: Pass 2 correctly counted the 39 internal packages in `packages/*` lacking a `"license"` field.
2. **`codeforge-vscode` License Gap**: Pass 2 correctly identified that `codeforge-vscode` is not marked private and lacks a license.
3. **Electron FFmpeg Safety**: Pass 2 correctly identified that Electron ships a non-LGPL stub build omitting proprietary codecs, and that full Chromium attribution is bundled in `LICENSES.chromium.html`.
4. **Stripe Test Mode Downgrade**: Pass 2 correctly downgraded Stripe test mode from a legal violation to a development/pre-commercial readiness state.

---

## 5. Pass-2 Findings Rejected or Corrected

1. **GitHub OAuth Credential Storage Flaw (`COMPLETELY DISPROVED`)**:
   - Pass 2 claimed GitHub OAuth tokens were "likely stored unencrypted" based on a negative search.
   - Pass 3 traced the lifecycle end-to-end and proved:
     - Desktop NEVER receives or stores a GitHub OAuth token (server-brokered PKCE).
     - Cloud NEVER stores the GitHub token in Postgres (dropped immediately after fetching user profile).
     - Desktop EXPLICITLY uses Electron's native `safeStorage.encryptString()` API (DPAPI on Windows, Keychain on macOS) to encrypt all local credentials.
     - Pass 2's finding (LEGAL-P2-NEW-03 / N-02) is **STRUCK FROM THE REGISTER**.
2. **Google Gemini Authentication Deprecation (`CONFIRMED WITH CRITICAL CORRECTION`)**:
   - Pass 2 claimed Google deprecated standard keys and asserted CodeForge must rewrite its provider layer to require raw Service Account JSON uploads or OAuth2.
   - Pass 3 verified current Google documentation: Google deprecated unrestricted legacy keys (`AIza...`), but Google AI Studio automatically issues "Auth Keys" bound to service accounts that are **still standard API key strings** passed via `Authorization: Bearer <key>`. Desktop BYOK does NOT require Service Account JSON uploads.

---

## 6. Final P0 Blockers (Hard Launch Blockers)

| Final ID | Issue Title | Affected Mode | Required Remediation |
|---|---|---|---|
| **LEG-P0-01** | **Missing Root LICENSE** | All Public Modes | Formally commit canonical MIT License text to `G:\CodeForge\LICENSE` naming Forger Digital Solutions. |
| **LEG-P0-02** | **Cloud Account Deletion Deficit** | Cloud API (EEA Users) | Implement `DELETE /v1/account` route in `apps/cloud-api` with transactional cascading database purge in `packages/cloud-db`. |
| **LEG-P0-03** | **EEA Ban on Unpaid Gemini Cloud Routing** | Cloud API (Hosted Routing) | Implement GeoIP filtering in `packages/cloud-gateway` to prevent routing EEA/UK/CH IP requests to Gemini Unpaid tier. |

---

## 7. Final P1 Risks (High Priority Commercial / Contractual)

1. **LEG-P1-01 (OpenRouter Multi-Tenant Cloud Proxying)**: Pooling multiple users on a single shared key via Cloud Gateway requires an OpenRouter Enterprise Agreement.
2. **LEG-P1-02 (Mandatory 18+ Age Gate Flow-Down)**: Flow-down requirement from Google and OpenRouter terms; must be enforced in Terms of Service and onboarding UI.
3. **LEG-P1-03 (Unpaid Model Training Disclosure)**: Google Gemini Unpaid tier uses prompts for model training; UI must prominently warn users not to submit proprietary employer code.
4. **LEG-P1-04 (Marketing Claim Substantiation)**: Documentation redlines required to replace overbroad claims ("zero emissions", "proves correctness") with substantiated technical descriptions.
5. **LEG-P1-05 (Host OS Execution Disclosures)**: Disclose that agent commands execute directly in the host OS environment with ambient user privileges.

---

## 8. Final P2 and P3 Issues

- **LEG-P2-01**: Add `"license": "MIT"` to `packages/vscode/package.json` prior to VS Code Marketplace publication.
- **LEG-P2-02**: Normalize `"license": "MIT"` across all 38 private workspace manifests for monorepo hygiene.
- **LEG-P2-03**: Implement circuit-breaker capping for 8-Bit qualification loops in `health.ts` upon repeated 401/403 errors.
- **LEG-P2-04**: Establish formal Stripe Live cutover checklist prior to commercial billing activation.
- **LEG-P2-05**: Finalize third-party attribution notices linking to `LICENSES.chromium.html` and `better-sqlite3`.
- **LEG-P2-06**: Retain trademark counsel for professional clearance of "CodeForge" in USPTO Classes 009 and 042.
- **LEG-P3-01**: Implement automated 30-day device token and 90-day log retention pruning in Cloud DB.
- **LEG-P3-02**: Adopt proactive California privacy disclosures.
- **LEG-P3-03**: Add UI onboarding helper text explaining how to generate Google AI Studio Auth Keys.
- **LEG-P3-04**: Add warning dialog when users configure third-party Model Context Protocol (MCP) servers.

---

## 9. Provider Contract Dispositions

- **OpenRouter**: Desktop BYOK is **PERMITTED** under standard terms. Cloud multi-tenant proxying is **RESTRICTED** and requires an **Enterprise Agreement**.
- **Google Gemini**: Desktop BYOK is **PERMITTED** globally using AI Studio Auth Keys (with EEA legal ambiguity reserved for attorney review). Cloud hosted routing to Gemini Unpaid tier in the EEA is **STRICTLY PROHIBITED** and must be geoblocked.
- **Groq & Cloudflare**: Desktop BYOK and Cloud Gateway routing are **PERMITTED** within published developer limits.
- **GitHub**: Server-brokered OAuth flow is **PERMITTED & FULLY COMPLIANT**.
- **Stripe**: Test mode is **SAFE & ENFORCED**. Live activation deferred until commercial launch.

---

## 10. Privacy & Data Protection Disposition

- **Local Workstation Data**: Resides on user hard drive. CodeForge is NOT a data controller under GDPR Art. 4(7). GDPR Art. 17 erasure does not apply to local SQLite files.
- **Cloud Hosted Data**: CodeForge IS a data controller. GDPR Art. 17 applies in full. Account deletion endpoint is a mandatory P0 for Cloud launch.
- **CCPA/CPRA**: Statutory thresholds ($25M revenue, 100k consumers) are unmet. CCPA does not legally attach today.
- **Telemetry Egress**: Verified ZERO product analytics, tracking, or crash telemetry SDKs. Network egress occurs strictly to user-configured AI providers, GitHub OAuth, and Cloud API.

---

## 11. Credential Security Disposition

- Desktop credentials (provider API keys and Cloud JWT tokens) are **fully encrypted at rest** using operating system-backed hardware keys via Electron `safeStorage` (DPAPI / Keychain / Secret Service).
- GitHub OAuth tokens are **never stored** on either Desktop or Cloud.
- All credential security alarms raised in Pass 2 are **RESOLVED AND CLOSED**.

---

## 12. Open Source & Packaging Disposition

- **Root License**: Missing. Blocks public distribution until MIT text is committed.
- **Shipping npm Dependencies**: Scanned 47 runtime packages in `app.asar`. Confirmed **ZERO copyleft (GPL/AGPL/LGPL) contamination**. All packages are permissive (MIT, Apache 2.0, BSD).
- **Electron FFmpeg**: Confirmed default non-LGPL stub. Chromium attribution is present and complete (`LICENSES.chromium.html`).
- **Native Modules**: Only `better-sqlite3` (MIT).

---

## 13. Policy Redline Status

All 9 legal policy drafts have been completely overhauled and placed in `docs/legal/pass3/proposed-drafts/`:
1. `terms-of-service.md` — Bifurcated Desktop BYOK vs. Cloud; 18+ age gate; host OS execution disclosures.
2. `privacy-policy.md` — Clear local vs. hosted data separation; zero-telemetry confirmation; Gemini training disclosure.
3. `acceptable-use-policy.md` — Stripped reverse engineering ban; prohibited provider abuse & multi-accounting.
4. `ai-output-disclaimer.md` — Professional human review requirement; hallucination and IP disclaimers.
5. `subscription-billing-terms.md` — Labeled pre-commercial draft; Stripe test mode; auto-renewal and refund terms.
6. `desktop-software-license.md` — Canonical MIT License text.
7. `third-party-notices.md` — Attributions for `better-sqlite3`, Electron, and Chromium.
8. `security-disclosure.md` — Accurate `safeStorage` encryption disclosures and 90-day vulnerability SLA.
9. `dmca-copyright-policy.md` — Statutory DMCA notice/counter-notice terms; designated agent placeholder.

---

## 14. Launch Readiness Summary

```
LAUNCH READINESS BY ARCHITECTURE:
  Mode A (Private Internal Development):  READY NOW
  Mode B (Public Free Desktop Beta):      READY IN 2 DAYS (Commit LICENSE + UI Age Gate)
  Mode C (Public Free Cloud Beta):        BLOCKED (2-4 Weeks for Cloud Deletion + Geoblock)
  Mode D (Paid Desktop Subscription):     BLOCKED (Commercial Entity & Live Stripe Required)
  Mode E (Paid Hosted Cloud SaaS):        BLOCKED (Full Enterprise Contracts & DPAs Required)
  Mode F (Enterprise On-Premises):        BLOCKED (Custom Enterprise MSA Required)
```

---

## 15. Next Remediation Milestone

The audit phase is complete. The project is now ready for the **Engineering Remediation & Legal Counsel Review Milestone**:
1. **Engineering**: Implement `ENG-P0-01` (Root LICENSE), `ENG-P1-01` (Unpaid Warning), and `ENG-P1-02` (Age Gate) to immediately clear **Mode B (Public Desktop Beta)**.
2. **Counsel**: Review [`final-attorney-review-packet.md`](file:///g:/CodeForge/docs/legal/pass3/final-attorney-review-packet.md) to answer the 7 focused legal questions.
3. **Leadership**: Authorize business decisions in [`final-business-decisions.md`](file:///g:/CodeForge/docs/legal/pass3/final-business-decisions.md).
