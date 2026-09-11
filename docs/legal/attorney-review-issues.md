# High-Priority Issues for Outside Legal Counsel Review

**Audit Date**: September 10, 2026
**Auditor**: Primary Audit Agent (Pass 1)
**Target Audience**: Outside Legal Counsel (Technology Transactions, Privacy, Regulatory, and Intellectual Property Practice Groups).

---

## 1. Executive Briefing

This packet highlights the highest-risk legal, regulatory, and contractual issues identified during Pass 1 of the CodeForge commercial-release audit. Each issue presents the factual codebase baseline, the governing legal framework, and structured decision options for counsel's advice.

---

## 2. Structured Issue Briefings

### Issue 1: OpenRouter Standard Terms § 7(4) vs. Hosted Commercial Routing
- **Status Classification**: `OPENROUTER_STANDARD_TERMS_COMMERCIAL_ROUTING_REVIEW_REQUIRED` (Pre-commercial launch blocker for hosted multi-tenant cloud).
- **Factual Background**:
  - CodeForge Desktop uses a BYOK model where the user provides their own OpenRouter API key via direct OAuth PKCE (`apps/desktop/src/openrouter-oauth-flow.ts`).
  - CodeForge Cloud (`apps/cloud-api`) is engineered to support cloud subscriptions (Free: 500k credits/mo, Pro: 5M credits/mo) with hosted execution.
- **Contractual & Legal Risk**:
  - OpenRouter Standard Terms (August 31, 2026) Section 7(4) prohibits accessing the service "for purposes of reselling API access to Models or otherwise developing a competing service."
  - While Desktop BYOK is clearly compliant (the end user is OpenRouter's customer), any hosted multi-tenant cloud routing using a CodeForge-owned master key directly implicates the resale prohibition under standard consumer terms.
- **Questions for Counsel**:
  1. Does routing requests through a CodeForge-managed multi-tenant cloud infrastructure constitute prohibited "reselling" under OpenRouter standard terms?
  2. Does CodeForge require a formal OpenRouter Enterprise / Partner Agreement prior to enabling hosted cloud model execution?
- **Decision Options**:
  - **Option A (Low Risk / Recommended)**: Maintain Desktop as pure BYOK; restrict Cloud API launch until a formal Enterprise Reseller Agreement is executed with OpenRouter.
  - **Option B (Moderate Risk)**: Structure Cloud API as a BYOK credential orchestrator where users link their personal OpenRouter keys to their cloud account, avoiding master key resale.

---

### Issue 2: Google Gemini Unpaid Services Regional Restriction & Privacy Disclosures
- **Factual Background**:
  - CodeForge allows users to connect Google Gemini via direct API keys (`GEMINI_API_KEY`).
  - By default, users leverage Google's free quota tiers (Unpaid Services).
- **Contractual & Regulatory Risk**:
  - Under Google's Gemini API Additional Terms (March 23, 2026), prompts and responses submitted to Unpaid Services are used to train Google products and may be reviewed by human reviewers.
  - Furthermore, Google's Additional Terms explicitly mandate that when making an API Client available to end users in the **EEA, Switzerland, or the United Kingdom**, developers **must only use Paid Services**. User consent cannot override this contractual requirement.
- **Questions for Counsel**:
  1. What technical mechanisms (e.g., Geo-IP gating, user billing assertions) are sufficient to satisfy Google's regional Paid Services restriction?
  2. What level of specific consent/disclosure is required under GDPR Art. 13/14 when an application routes user source code to a provider that uses prompts for foundational model training?
- **Decision Options**:
  - **Option A**: Implement hard geo-blocking disabling Google Gemini free routes for end users declared or detected in the EEA, UK, and Switzerland.
  - **Option B**: Require users in those jurisdictions to enter a Google Cloud project key linked to a paid billing account.

---

### Issue 3: Absence of Data Deletion & Retention Mechanisms (`RETENTION_POLICY_UNDEFINED`)
- **Factual Background**:
  - Local SQLite persistence stores session transcripts, code diffs, and prompts indefinitely with no TTL or local deletion endpoint (`packages/sessions/src/persistence.ts`).
  - Cloud PostgreSQL database (`packages/cloud-db`) lacks automated data retention policies, log purging jobs, or an account deletion cascade.
- **Statutory Risk**:
  - **GDPR Art. 17 / UK GDPR**: Grants data subjects the absolute "Right to Erasure" ("right to be forgotten"). Operating a cloud account system without an automated or operational deletion path is an immediate regulatory violation.
  - **CCPA/CPRA § 1798.105**: Grants California consumers the right to delete personal information.
- **Questions for Counsel**:
  1. Does unauthenticated, local-only desktop storage fall within the GDPR purely personal/internal business exemption, insulating the open-source distributor from Art. 17 obligations?
  2. What statutory data retention requirements (e.g., tax, anti-fraud) limit the immediate deletion of Stripe billing ledger records?
- **Decision Options**:
  - **Remediation Plan**: Add `DELETE /api/sessions/:id` to local server; build `POST /api/account/delete` with transactional database cascades prior to public cloud launch.

---

### Issue 4: Autonomous Agent Execution Liability & Safe Harbor Disclaimers
- **Factual Background**:
  - CodeForge's 8-Bit engine and Full-Auto mode (`packages/agent/src/loop.ts`) autonomously run shell commands, file modifications, and git commits on the user's host operating system without per-action confirmation.
- **Legal Risk**:
  - Risk of tort liability, property damage, or lost work if an autonomous loop executes destructive commands (e.g., accidental file deletion, broken builds, unintended git push).
- **Questions for Counsel**:
  1. Are the warranty disclaimers (UCC § 2-316) and limitations of liability in the draft Terms of Service sufficient to insulate Forger Digital Solutions from claims arising from autonomous shell execution?
  2. Does the EU AI Act (2024/1689) categorize autonomous coding agents as "High-Risk AI Systems" requiring formal conformity assessments?
- **Recommended Action**: Retain prominent, all-caps AI Output Disclaimer and require clickwrap/onboarding acknowledgment before enabling Full-Auto mode.

---

### Issue 5: Dispute Resolution, Mandatory Arbitration & Class Action Waiver
- **Factual Background**:
  - The preliminary implementation plan proposed standard mandatory arbitration and class action waivers.
  - In accordance with mandatory review corrections, this has been marked `[BUSINESS DECISION REQUIRED]` and `[ATTORNEY REVIEW REQUIRED]`.
- **Legal Considerations**:
  - Enforceability of consumer arbitration clauses varies significantly between jurisdictions (highly enforceable in US under FAA; largely unenforceable or restricted against consumers in the EU, UK, and California for certain public injunctive relief).
- **Questions for Counsel**:
  1. Does counsel recommend AAA or JAMS arbitration rules for US commercial users?
  2. Should CodeForge implement a 30-day arbitration opt-out mechanism to preserve enforceability under recent Ninth Circuit precedents?

---

### Issue 6: Age Gate & Minimum Age Policy (18+ Requirement)
- **Factual Background**:
  - Upstream providers (OpenRouter Terms § 2; Google Gemini API Additional Terms) legally require users to be at least 18 years old.
  - Many open-source developer tools are used by students aged 13–17.
- **Questions for Counsel**:
  1. Given upstream provider flow-down covenants, can CodeForge permit users aged 13–17 to use the desktop client if they route strictly to non-restricted providers, or must CodeForge adopt an across-the-board 18+ eligibility requirement?
- **Recommended Decision**: Adopt a provisional 18+ requirement in the Terms of Service to ensure strict alignment with upstream provider covenants.
