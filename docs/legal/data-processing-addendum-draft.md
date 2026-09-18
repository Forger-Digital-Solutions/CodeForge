# Data Processing Addendum (DPA) — DRAFT

<!-- DRAFT — REQUIRES LEGAL COUNSEL. Not executable. Placeholders are deliberate. -->

This Data Processing Addendum ("DPA") forms part of the agreement between
**[LEGAL ENTITY NAME — OWNER INPUT REQUIRED]** ("CodeForge", "Processor") and the customer
accepting the CodeForge Terms of Service ("Customer", "Controller") and governs the processing
of Personal Data by CodeForge on the Customer's behalf in connection with the CodeForge Cloud
service. It is offered for customers that require a processor agreement (for example under
GDPR Article 28 or UK GDPR); counsel must confirm applicability, the transfer mechanism, and the
governing terms before this draft is used.

## 1. Definitions

"Personal Data", "processing", "controller", "processor", "sub-processor", and "data subject"
have the meanings given in the applicable data-protection law. "Service" means the CodeForge
Cloud API and the CodeForge desktop features that rely on it. "Customer Data" means data the
Customer or its users submit to the Service.

## 2. Roles and scope

- For Customer Data processed by the Service (account identity, session metadata, usage, billing metadata, GitHub App authorizations, publication records, and — transiently — prompts and code context relayed to model providers), CodeForge acts as **processor** and the Customer as **controller**.
- CodeForge acts as an **independent controller** for its own security audit trail and abuse-prevention records, and for the processing of its own contractual relationship with the Customer, as described in the Privacy Policy.
- Content sent by the Customer directly to a model provider under the Customer's own account (BYOK / direct routes) is not processed by CodeForge and is outside this DPA.

## 3. Details of processing (Annex I)

| Item | Description |
| --- | --- |
| Subject matter | Provision of an autonomous coding-agent service with optional hosted model routing and repository publication |
| Duration | The term of the agreement, plus the retention periods in `docs/privacy/retention-and-deletion.md` |
| Nature and purpose | Authentication; routing model requests to providers; usage accounting; publication of commits to the Customer's repositories; billing; security |
| Categories of data subjects | The Customer's users (developers) |
| Categories of Personal Data | GitHub identity (id, login, display name, avatar, authorized email); IP address and user-agent; usage and billing metadata; repository names; content of prompts and code context (may incidentally contain personal data) |
| Special categories | None intended; the Service is not designed for special-category data |
| Retention | See `docs/privacy/retention-and-deletion.md` |

## 4. Processor obligations

CodeForge shall:

1. process Personal Data only on the Customer's documented instructions (the agreement, the Customer's configuration such as privacy routing mode and connected providers, and the use of Service features), unless required by law;
2. ensure persons authorized to process Personal Data are bound by confidentiality;
3. implement the technical and organizational measures in Annex II;
4. engage sub-processors only as set out in Section 6;
5. assist the Customer, taking into account the nature of processing, in responding to data-subject requests using the mechanisms in `docs/privacy/privacy-rights-workflow.md`;
6. assist the Customer with security-of-processing, breach-notification, and impact-assessment obligations, providing the information in `docs/security/` on request;
7. delete Personal Data at the end of the Service (account deletion) subject to the retention exceptions in Annex III;
8. make available the information necessary to demonstrate compliance and allow audits under Section 8.

## 5. Security measures (Annex II — as implemented)

| Measure | Implementation |
| --- | --- |
| Encryption in transit | HTTPS to the Service; TLS with certificate validation to the database |
| Encryption at rest | Server-side secrets sealed with AES-256-GCM envelopes under a versioned key ring; session credentials stored as SHA-256 hashes; provider-managed storage encryption for the database (see `docs/security/backups-and-recovery.md`) |
| Access control | Every request authenticated by a signed token whose session must be live; per-tenant scoping of every record; no administrative API; operator access limited to the deployment platform and database provider |
| Least privilege to third parties | GitHub identity scope limited to profile/email; repository access only via a per-repository, one-hour GitHub App token |
| Logging and audit | Redacting logger; append-only security audit trail without credentials |
| Data minimization | No storage of prompt/completion text; minimized payment records; credential files excluded from model context |
| Secure development | Automated security regression gate (crypto, secrets, tenant isolation, OAuth, payments, Electron), dependency vulnerability gate, repository secret scanning |
| Incident response | `docs/security/incident-response.md` |
| Business continuity | Provider-managed database backups; restore procedure documented (drill pending — see OWNER-ACTIONS OA-12) |

## 6. Sub-processors

The current list is `docs/legal/subprocessor-list.md`. CodeForge will give the Customer
`[NOTICE PERIOD — OWNER/COUNSEL INPUT REQUIRED]` notice of intended changes and the opportunity
to object. Sub-processor DPAs: `[OWNER INPUT: confirm executed DPAs with Render, the database
provider, GitHub, Stripe, and Tier-2 model providers]`.

## 7. International transfers

CodeForge's infrastructure and Tier-1/Tier-2 sub-processors are located in the United States.
For Personal Data originating in the EEA, UK, or Switzerland the parties will rely on
`[TRANSFER MECHANISM — LEGAL REVIEW REQUIRED: e.g. EU Standard Contractual Clauses (Module 2),
UK Addendum, Swiss addendum]`. Model providers may process data in other regions per their terms.

## 8. Audits

On reasonable notice and no more than `[FREQUENCY — OWNER INPUT]` per year, CodeForge will make
available its security documentation, test evidence (`docs/evidence/`), and answers to a
reasonable security questionnaire. CodeForge holds no third-party certification (SOC 2, ISO 27001)
at this time; an on-site or independent audit is subject to `[TERMS — LEGAL REVIEW REQUIRED]`.

## 9. Personal-data breach

CodeForge will notify the Customer without undue delay, and in any case within
`[HOURS — LEGAL REVIEW REQUIRED, e.g. 72 hours]` after becoming aware of a Personal Data Breach
affecting Customer Data, with the information available at the time and updates as the
investigation proceeds, following `docs/security/incident-response.md`.

## 10. Deletion and return (Annex III)

On account deletion the Service deletes Customer Data in the live database and staged
publication artifacts and revokes sessions, returning a receipt. Exceptions: (a) records the
Service must retain for security/abuse prevention (with the user link severed) and for billing,
for the periods decided per OA-06; (b) provider snapshots, which age out per the database
provider's retention; (c) data already transferred to model providers or GitHub, which is
governed by those parties' terms.

## 11. Liability and precedence

`[LEGAL REVIEW REQUIRED — align with the Terms of Service limitation of liability and governing law]`

## Signature blocks

`[LEGAL ENTITY NAME — OWNER INPUT REQUIRED]` / `[MAILING ADDRESS — OWNER INPUT REQUIRED]` /
`[LEGAL CONTACT — OWNER INPUT REQUIRED]`
