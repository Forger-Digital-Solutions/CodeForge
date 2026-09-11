# Privacy Law Applicability Analysis — Pass 2 Independent Review

<!-- PASS 2 ADVERSARIAL REVIEW — NOT LEGAL ADVICE — DRAFT ONLY -->

## Audit Scope and Methodology
Pass 2 independently verified the application architecture against global privacy frameworks (GDPR, CCPA), challenging Pass 1's assertion that GDPR Article 17 (Right to Erasure) applies uniformly to all data components, and reviewing the pre-commercial thresholds for CCPA.

## Evidence Standard Applied
Conclusions rely strictly on:
- Codebase architecture (local SQLite vs. Cloud PostgreSQL)
- Telemetry egress (or lack thereof)
- Statutory thresholds in GDPR and CCPA

## 1. What Personal Data Does CodeForge Process?
Based on code review, CodeForge processes the following potentially personal data:
- **Local desktop sessions (SQLite):** User prompts, chat histories, logs, local git paths.
- **Cloud sessions and accounts (PostgreSQL):** User accounts, billing IDs, potentially synced sessions.
- **GitHub OAuth tokens:** Stored locally/in-memory for repository access.
- **API keys (BYOK):** Handled in memory, stored locally or passed via API.
- **Prompt content:** Code, proprietary architecture, potential PII sent to LLM providers.
- **Telemetry:** NO telemetry data is sent. `@codeforge/telemetry` is an empty stub.

## 2. Controller/Processor Role Analysis
- **Local desktop (SQLite):** CodeForge acts solely as the software author. The *user* is the controller of data residing on their own physical hardware.
- **Cloud (PostgreSQL):** CodeForge acts as the *Controller* for any user accounts, billing data, and cloud-synced sessions.
- **Provider routing:** CodeForge acts as a router/processor (or independent controller, depending on Terms of Service) when transmitting data to OpenAI, Anthropic, Gemini, etc.

## 3. GDPR Applicability Assessment
- **Territorial scope (Art. 3):** GDPR applies if CodeForge offers services to data subjects in the EEA, or monitors their behavior.
- **Local-only software:** If a user merely downloads the desktop app and uses it locally, CodeForge does not "process" their session data.
- **Cloud service:** If EEA users create Cloud API accounts, GDPR applies to CodeForge.
- **Does local SQLite storage create a GDPR controller obligation?** No. [LEGAL INTERPRETATION]
- **Does cloud PostgreSQL?** Yes. [LEGAL INTERPRETATION]
- **Pass-1 claim:** "GDPR Art. 17 triggered for all sessions."
- **Pass-2 Disposition:** **CONFIRMED WITH NARROWER SCOPE**. Article 17 is only triggered for data in the CodeForge Cloud PostgreSQL database, not local SQLite.

## 4. CCPA Applicability Assessment
- **Statutory Thresholds:** CCPA applies to a for-profit business doing business in California that meets ONE of: (A) Gross annual revenue > $25M; (B) Buys/sells/shares personal info of >100,000 consumers; (C) Derives >50% revenue from selling personal info.
- **Threshold analysis:** CodeForge is pre-commercial. It almost certainly does NOT meet the $25M revenue threshold. Reaching 100,000 California users is unlikely at launch.
- **Pass-1 claim:** CCPA is a P0 blocker.
- **Pass-2 Disposition:** **DOWNGRADED**. CCPA is legally inapplicable at this stage. However, [ENGINEERING RECOMMENDATION] building CCPA-compliant deletion mechanisms is highly recommended before scale.

## 5. Local SQLite Erasure Question (from Pass-1 handoff)
- **[REPOSITORY FACT]** Local SQLite (`packages/sessions/src/sqlite.ts`) is on the user's own device. No remote CodeForge access exists.
- **[LEGAL INTERPRETATION]** A user asking CodeForge to delete local sessions is a *product feature request* (e.g., "clear history button"), not a statutory GDPR Article 17 Data Subject Request. CodeForge has no legal obligation to perform this deletion on the user's behalf via statutory mechanisms, because CodeForge does not possess the data.
- **BUT:** If CodeForge introduces Cloud Sync, that synced data becomes CodeForge-controlled and the erasure obligation attaches.

## 6. Cloud Erasure Gap — CONFIRMED P0 (Narrowed)
- **[REPOSITORY FACT]** There is no `DELETE /api/sessions` route in `apps/cloud-api`.
- **[REPOSITORY FACT]** There is no `CASCADE DELETE` or `TTL` implemented in `packages/cloud-db/src/migrations.ts`.
- **[LEGAL INTERPRETATION]** If CodeForge launches the Cloud API to EEA users, the GDPR Article 17 erasure right strictly applies to that cloud account data.
- **[CONCLUSION]** This is a true **LEGAL-P0** for the *Cloud API commercial launch to EEA users*. It is **NOT** a P0 for the desktop-only local product.

## 7. Sensitive Data Questions
- Prompt content may inadvertently contain employer-owned code, Protected Health Information (PHI), financial data, or PII.
- **[LEGAL INTERPRETATION]** CodeForge's Terms of Service and Privacy Policy must clearly disclaim liability for users pasting sensitive data into the agent, shifting the responsibility to the user.

## 8. Provider Data Flows
- **Google Gemini Unpaid:** Prompts *are* used for training. [DISCLOSURE REQUIRED]
- **Google Gemini Paid (Cloud Billing):** Processor DPA applies — prompts are *not* used for training.
- **OpenRouter:** Forwards to model providers per their respective policies; OpenRouter claims not to train on data, but downstream providers might.
- **[ENGINEERING RECOMMENDATION]** The UI should clearly delineate between "Training Enabled" (free) and "Zero Data Retention" (paid/enterprise) routing paths.

## 9. Recommendations
1. **Cloud Deletion:** Implement `/api/account/delete` with full cascading deletion in PostgreSQL before launching Cloud features to the public.
2. **Local Feature:** Add a simple "Clear Local History" button to the UI to satisfy user expectations, separate from legal DSR compliance.
3. **Telemetry:** Maintain the `@codeforge/telemetry` stub as a zero-egress mechanism unless explicitly updated and covered by a revised Privacy Policy.

## 10. Unresolved Questions
- **[BUSINESS DECISION REQUIRED]** Will the Cloud API be geoblocked for EEA users at launch to avoid immediate GDPR compliance overhead?
- **[ATTORNEY REVIEW REQUIRED]** Does providing BYOK (Bring Your Own Key) access to Gemini Unpaid create an obligation for CodeForge to warn users about Google's training practices?
