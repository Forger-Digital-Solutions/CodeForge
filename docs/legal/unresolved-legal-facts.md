# Master Ledger of Unresolved Business Decisions & Operational Facts

**Audit Date**: September 10, 2026
**Auditor**: Primary Audit Agent (Pass 1)
**Status**: Action Required by Project Leadership prior to Commercial Launch.

---

## 1. Executive Summary

In accordance with strict audit governance principles, AI audit agents must never invent corporate facts, entity forms, physical addresses, governing jurisdictions, refund policies, or business strategies. This register itemizes every essential business and legal parameter that remains marked `[BUSINESS DECISION REQUIRED]` across the CodeForge draft legal package.

---

## 2. Business Decision Ledger

| # | Domain / Topic | Current Audit Baseline Placeholder | Required Business Decision | Impacted Legal Drafts | Recommended Option / Precedent |
|---|---|---|---|---|---|
| 1 | **Legal Entity & Formation** | `[BUSINESS DECISION REQUIRED: Forger Digital Solutions Entity Name]` | Select and formally establish the corporate operating entity (e.g., Delaware LLC, California C-Corp, UK Private Limited Company). | All Drafts (`terms-of-service`, `privacy-policy`, `desktop-license`). | Form Delaware LLC or C-Corp (`Forger Digital Solutions, Inc.`). |
| 2 | **Corporate Address & Registered Office** | `[BUSINESS DECISION REQUIRED: Physical Mailing Address]` | Provide a valid physical business mailing address and registered agent details. | Terms of Service, Privacy Policy, DMCA Notice. | Commercial registered agent address in state of incorporation. |
| 3 | **Governing Law & Forum** | `[BUSINESS DECISION REQUIRED: State / Country of Governing Law]` | Determine the governing state/country law and mandatory judicial forum for contractual disputes. | Terms of Service, Subscription Terms, Desktop EULA. | State of Delaware or State of California (US release standard). |
| 4 | **Dispute Resolution & Arbitration** | `[BUSINESS DECISION REQUIRED: Mandatory Arbitration vs. Courts]` | Decide whether to mandate binding individual arbitration (AAA / JAMS) with class action waiver, or rely on state/federal courts. | Terms of Service. | Require binding arbitration via AAA with a 30-day user opt-out right. |
| 5 | **Minimum Age Eligibility** | `[MINIMUM AGE / PROVIDER FLOW-DOWN DECISION REQUIRED]` | Determine whether to enforce a strict 18+ age restriction across all users, or permit 13+ with parental consent for non-restricted routes. | Terms of Service, Privacy Policy. | Adopt strict 18+ eligibility to align with upstream Google Gemini and OpenRouter terms. |
| 6 | **Root License Authorization** | `[BUSINESS DECISION REQUIRED: Root MIT License Authorization]` | Formally approve the creation of the canonical root `G:\CodeForge\LICENSE` file and package metadata updates. | Open Source Audit, Desktop EULA, README. | Formally commit standard MIT License naming Forger Digital Solutions. |
| 7 | **Commercial Cloud Pricing & Plans** | `[BUSINESS DECISION REQUIRED: Subscription Pricing & Tiers]` | Establish production retail pricing, renewal cadence, credit allowances, and Stripe Live Mode credentials. | Subscription Terms, Cloud API. | Launch Free Tier (500k credits) and Pro Tier ($15–$20/month for 5M credits) upon completing cloud readiness. |
| 8 | **Refund & Cancellation Policy** | `[BUSINESS DECISION REQUIRED: Credit Refund Policy]` | Define official refund terms for consumed vs unconsumed cloud credits, including handling EU 14-day statutory withdrawal rights. | Subscription Terms. | No refunds for consumed credits; 14-day statutory cooling-off period for EU consumers prior to credit usage. |
| 9 | **Cloud Data Retention Period (TTL)** | `[BUSINESS DECISION REQUIRED: Cloud Request TTL]` | Define exact retention period for `hosted_requests`, execution diffs, and verification evidence in PostgreSQL. | Privacy Policy, Data Flow Inventory. | Configure automated 30-day TTL for raw prompt/diff payloads. |
| 10 | **Designated DMCA Agent** | `[DMCA AGENT / REGISTRATION DECISION REQUIRED]` | Formally register a Designated Copyright Agent with the U.S. Copyright Office ($6 fee) before launching cloud content hosting. | DMCA Copyright Policy. | Complete online DMCA directory filing naming corporate copyright officer. |
| 11 | **Security Vulnerability Safe Harbor** | `[ATTORNEY REVIEW REQUIRED: Safe Harbor Scope]` | Formally approve the scope of authorization and legal safe harbor offered to independent security researchers. | Security Disclosure Policy. | Standard disclose.io or DOJ-compliant vulnerability disclosure safe harbor without cash bounty promises. |
| 12 | **Official Contact Channels** | `[BUSINESS DECISION REQUIRED: Official Email Inboxes]` | Set up and monitor official corporate email routing: `legal@`, `privacy@`, `security@`, `support@`. | All Policy Drafts. | Configure domain MX records for `@codeforge.dev` or `@forgerdigital.com`. |

---

## 3. Mandatory Workflow Next Steps
1. Project leadership reviews this ledger and records decisions in an executive sign-off sheet.
2. Draft documents in `docs/legal/drafts/` will be updated to replace placeholders with approved values during Pass 3.
3. No draft policy may be published to production with unresolved placeholders.
