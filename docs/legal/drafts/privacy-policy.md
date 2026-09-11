# CodeForge Privacy Policy

**Status**: REVIEW DRAFT (PASS 1)
**Notice**: This document is a non-binding draft prepared for licensed attorney review and executive business determination. It contains mandatory placeholders (`[BUSINESS DECISION REQUIRED]`, `[ATTORNEY REVIEW REQUIRED]`) that must be resolved prior to commercial adoption or public publication.

---

**Last Updated**: [BUSINESS DECISION REQUIRED: Effective Date]

[BUSINESS DECISION REQUIRED: Forger Digital Solutions Operating Entity Name] ("CodeForge," "we," "us," or "our") respects your privacy and is committed to protecting your personal data. This Privacy Policy explains how information is processed when you use the CodeForge desktop application, command-line interface, website, and hosted cloud services (collectively, the "Services").

---

## 1. Core Architectural Privacy Principle: Local-First Processing

CodeForge Desktop is engineered with a **local-first privacy architecture**:
1. **Local Code & Sessions**: Your repository files, source code, abstract syntax trees (ASTs), git histories, and local session transcripts are stored directly on your local workstation (in a local SQLite database). They are never mirrored or streamed to CodeForge servers during standard offline or BYOK desktop operation.
2. **Zero In-App Behavioral Tracking**: The CodeForge desktop application contains **zero** third-party tracking or behavioral telemetry software (such as Google Analytics, PostHog, Mixpanel, Segment, or Datadog). Diagnostic logs are written exclusively to local log files on your machine.
3. **Local Credential Encryption**: API keys and tokens you enter are encrypted at rest using the Windows Data Protection API (`safeStorage` / DPAPI) with keys tied to your local operating system user profile.

---

## 2. Information We Process & How It Leaves Your Machine

### A. Direct Upstream AI Model Requests (BYOK Egress)
When you prompt CodeForge to edit code or explain a problem, relevant code context and your instructions are packaged and transmitted via direct HTTPS (TLS 1.3) from your machine to the third-party artificial intelligence provider you selected:
- **Recipients**: OpenRouter, Google Gemini, Groq, Anthropic, OpenAI, or Cloudflare Workers AI.
- **Provider Data Policies**: Data transmitted directly to upstream providers is subject to that provider's privacy terms.
  - **Google Gemini Unpaid Services Disclosure**: Under Google's Gemini API Additional Terms, prompts and outputs submitted using unpaid API keys may be reviewed by human reviewers and used to train Google products. You can avoid this by enabling **Strict Privacy Mode** in CodeForge Settings, which automatically filters out providers that log prompt data for training.

### B. Cloud Account Information (Optional Cloud Mode)
If you choose to sign in to CodeForge Cloud via GitHub OAuth, we collect and store:
- **Identity Data**: GitHub User ID, GitHub handle, and primary email address.
- **Device & Session Data**: Cryptographic device session tokens, client version, and IP address.
- **Billing Data**: Stripe Customer ID, active subscription status, and credit transaction ledger. (Raw payment card numbers are processed directly by Stripe and are never received or stored by CodeForge).
- **Hosted Execution Data**: If you run tasks on hosted cloud runners, prompt payloads and verification diffs are persisted in our secure cloud database to fulfill execution and enforce credit limits.

---

## 3. Data Retention & Deletion

3.1 **Local Desktop Storage**: Session records and turn history remain in your local SQLite database indefinitely until you manually clear your history or delete the application data directory (`%APPDATA%/CodeForge`). [A native "Clear Local History" button and `DELETE /api/sessions/:id` endpoint are currently under deployment.]

3.2 **Cloud Hosted Data Retention**:
[BUSINESS DECISION REQUIRED: Hosted request payloads and execution traces are retained in our cloud database for thirty (30) days from execution to enable debugging, abuse prevention, and credit reconciliation, after which they are automatically purged.]

3.3 **Your Deletion Rights**:
- You have the right to request deletion of your cloud account and associated personal data at any time.
- Upon receipt of a verified deletion request sent to `privacy@codeforge.dev` [or via the account settings deletion interface], we will permanently erase your account, identity records, and hosted session logs from our production databases within thirty (30) days, except where retention is strictly required by statutory tax, accounting, or anti-fraud laws.

---

## 4. Legal Bases for Processing (GDPR / UK GDPR)

If you are an individual located in the European Economic Area (EEA) or United Kingdom, we process your personal data under the following legal bases:
- **Contractual Necessity (Art. 6(1)(b))**: To provide, maintain, and deliver the Services you requested.
- **Legitimate Interests (Art. 6(1)(f))**: To secure our infrastructure, prevent fraudulent credit consumption, and debug platform errors.
- **Consent (Art. 6(1)(a))**: Where you have explicitly opted into specific experimental features or marketing updates.

---

## 5. Your Privacy Rights (GDPR, CCPA/CPRA & Global Rights)

Depending on your jurisdiction, you may exercise the following rights:
- **Right to Access & Portability**: Request a copy of the personal data we hold about you in a structured, machine-readable format.
- **Right to Rectification**: Correct inaccurate or incomplete account information.
- **Right to Erasure ("Right to be Forgotten")**: Request deletion of your personal data.
- **Right to Restrict or Object**: Object to or restrict certain processing activities.
- **Non-Discrimination**: California consumers will not face discriminatory pricing or service degradation for exercising CCPA/CPRA rights.

To exercise any of these rights, email us at `privacy@codeforge.dev`.

---

## 6. Cross-Border Data Transfers

Our cloud services and database servers are located in the United States. If you access the Services from outside the United States, your information will be transferred to and processed in the United States pursuant to appropriate legal safeguards, such as Standard Contractual Clauses (SCCs).

---

## 7. Children's Privacy

[MINIMUM AGE / PROVIDER FLOW-DOWN DECISION REQUIRED: The Services are not directed to individuals under eighteen (18) years of age, and we do not knowingly collect personal data from minors. If you become aware that a minor has provided us with personal information, contact us immediately at `privacy@codeforge.dev`.]

---

## 8. Contact Our Privacy Team

If you have questions, complaints, or wish to contact our Data Protection Officer, reach out to:
**Entity**: [BUSINESS DECISION REQUIRED: Forger Digital Solutions Operating Entity Name]
**Address**: [BUSINESS DECISION REQUIRED: Physical Mailing Address]
**Privacy Officer**: `privacy@codeforge.dev`
