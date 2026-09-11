# Final Business & Governance Decisions Register — Pass 3 Reconciliation

<!-- PASS 3 FINAL RECONCILIATION — NOT LEGAL ADVICE — DRAFT ONLY -->

**Date**: 2026-09-11
**Author**: Pass 3 Independent Reviewer
**Rule**: This document contains ONLY decisions requiring human executive or business leadership determination. Technical facts and contractual imperatives have been resolved and removed.

---

## 1. Executive Decisions Summary Table

| ID | Decision Title | Options Available | Recommended Choice | Urgency |
|---|---|---|---|---|
| **BIZ-01** | **Root Software Licensing Strategy** | A: MIT Open Source<br>B: Apache 2.0<br>C: Proprietary Commercial EULA | **Option A (MIT)** | **IMMEDIATE (P0 Blocker)** |
| **BIZ-02** | **Cloud API Launch Geography** | A: Global Launch (requires GDPR deletion & geoblock)<br>B: US/Canada only initially (defers GDPR compliance) | **Option B (US/Canada initially)** | **CRITICAL (Cloud Launch)** |
| **BIZ-03** | **OpenRouter Cloud Strategy** | A: Negotiate Enterprise Agreement<br>B: Restrict OpenRouter to Desktop BYOK only | **Option B initially, then A** | **HIGH (Cloud Launch)** |
| **BIZ-04** | **Minimum Age Policy** | A: Mandate 18+ (Contractual flow-down)<br>B: 13+ with parental consent | **Option A (Mandatory 18+)** | **HIGH (Terms Publication)** |
| **BIZ-05** | **Governing Law & Jurisdiction** | A: Delaware<br>B: California | **Option A (Delaware)** | **MEDIUM (Terms Publication)** |
| **BIZ-06** | **Dispute Resolution & Arbitration** | A: Binding Individual Arbitration + Class Waiver<br>B: Judicial Forum / State Courts | **Option A (Arbitration)** | **MEDIUM (Terms Publication)** |
| **BIZ-07** | **Commercial Monetization Model** | A: 100% Free Open-Source tool<br>B: Freemium (Free Desktop BYOK + Paid Cloud SaaS) | **Option B (Freemium)** | **MEDIUM (Commercial GA)** |
| **BIZ-08** | **Subscription Refund Window** | A: Strict No-Refunds for partial months<br>B: 14-day money-back guarantee | **Option B (14-Day Guarantee)** | **MEDIUM (Commercial GA)** |
| **BIZ-09** | **Trademark Clearance Strategy** | A: Retain counsel for Class 009/042 clearance<br>B: Launch under common law | **Option A (Professional Clearance)** | **MEDIUM (Brand Protection)** |
| **BIZ-10** | **Designated DMCA Agent Registration** | A: Register with US Copyright Office Directory ($6)<br>B: Forgo registration (loss of safe harbor) | **Option A (Register Agent)** | **LOW (Cloud UGC Launch)** |
| **BIZ-11** | **Corporate Contact Identifiers** | Define official contact emails (`legal@`, `privacy@`, `security@`, `dmca@`) | **Approve standard domain aliases** | **IMMEDIATE** |
| **BIZ-12** | **Stripe Live Activation Timeline** | A: Activate Stripe immediately<br>B: Keep test mode enforced through Beta | **Option B (Test Mode through Beta)** | **LOW (Pre-Commercial)** |

---

## 2. Granular Decision Briefs

### [BIZ-01] Root Software Licensing Strategy
- **Context**: The repository currently lacks a `LICENSE` file. All public distribution is blocked until resolved.
- **Decision**: Does Forger Digital Solutions want CodeForge to be an open-source platform under the permissive MIT License, or a closed-source proprietary application?
- **Analysis**: CodeForge's marketing, architecture, and `AGENTS.md` explicitly describe it as a "free-first autonomous software engineering agent". Adopting the MIT License aligns with developer community expectations and enables immediate adoption.
- **Action**: Approve committing the MIT License naming `Forger Digital Solutions`.

---

### [BIZ-02] Cloud API Launch Geography
- **Context**: Google's Terms strictly prohibit Unpaid Gemini routing in the EEA, and GDPR Art. 17 mandates an account deletion pipeline for EU data subjects.
- **Decision**: Should the initial CodeForge Cloud beta be launched globally, or geoblocked to the United States and Canada?
- **Analysis**: Launching in US/Canada first allows the team to validate core product workflows without immediately triggering EU GDPR regulatory overhead or complex regional provider geoblocking.
- **Action**: Select geographic launch perimeter for Cloud API Beta.

---

### [BIZ-03] OpenRouter Cloud Strategy
- **Context**: Operating a multi-tenant Cloud proxy using OpenRouter standard API keys violates OpenRouter ToS §7.3 and §7.4.
- **Decision**: Should leadership initiate enterprise negotiations with OpenRouter Inc., or simply limit OpenRouter integration to Desktop BYOK?
- **Analysis**: Desktop BYOK satisfies 90% of power users with zero legal overhead. Cloud routing can rely on direct provider relationships (Google Cloud Paid, Groq, Cloudflare) until volume warrants an OpenRouter Enterprise Agreement.
- **Action**: Direct business development whether to pursue an OpenRouter commercial contract.

---

### [BIZ-04] Minimum Age Policy
- **Context**: Google Gemini API Terms explicitly mandate that applications must not be directed toward individuals under 18; OpenRouter ToS §2 mandates users must be 18+.
- **Decision**: Formally confirm that CodeForge Terms of Service and onboarding will enforce an 18+ age requirement.
- **Action**: Approve 18+ policy wording across all legal drafts.

---

### [BIZ-05 & BIZ-06] Governing Law & Dispute Resolution
- **Context**: The draft Terms of Service currently hold placeholders for governing law and dispute mechanisms.
- **Decision**: Select corporate legal jurisdiction (Delaware recommended) and decide whether to include a mandatory binding arbitration clause with a class-action waiver.
- **Action**: Authorize legal counsel to insert approved governing law and arbitration clauses.

---

### [BIZ-07 & BIZ-08] Commercial Pricing & Refund Strategy
- **Context**: CodeForge Cloud includes scaffolding for a $20/month Pro tier and $10 credit packs.
- **Decision**: Confirm proposed pricing tiers, monthly credit allowance caps, and the refund policy (e.g., standard 14-day satisfaction guarantee).
- **Action**: Formalize pricing schedule for `subscription-billing-terms.md`.

---

### [BIZ-09] Trademark Clearance Strategy
- **Context**: Preliminary searches show multiple software and tech references to "CodeForge".
- **Decision**: Authorize trademark counsel to perform an official knock-out and comprehensive clearance search for "CodeForge" and "ForgeZero" in US Classes 009 (software) and 042 (SaaS).
- **Action**: Retain trademark counsel before major public marketing campaigns.

---

### [BIZ-10] DMCA Designated Agent Registration
- **Context**: 17 U.S.C. § 512(c) safe harbor protection requires registering a designated copyright agent with the U.S. Copyright Office directory ($6 statutory filing fee).
- **Decision**: Appoint an individual or corporate office as the Designated DMCA Agent and complete the online registration.
- **Action**: File registration with the Copyright Office before enabling public cloud session sharing.

---

### [BIZ-11] Corporate Legal Contact Identifiers
- **Context**: Legal policies require valid contact email addresses.
- **Decision**: Authorize provisioning the following domain aliases:
  - `legal@forgerdigitalsolutions.com`
  - `privacy@forgerdigitalsolutions.com`
  - `security@forgerdigitalsolutions.com`
  - `dmca@forgerdigitalsolutions.com`
- **Action**: Configure mail routing.
