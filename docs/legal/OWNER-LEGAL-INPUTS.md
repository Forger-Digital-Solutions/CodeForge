# Owner Legal Inputs — Remaining Facts Only

<!-- Security / Legal / Trust R1, 2026-09-18. Supersedes the "official contact channels" and
"data retention" rows of unresolved-legal-facts.md where they overlap; other rows there stay open. -->

Everything an engineer could do for the legal package has been done: the drafts describe the
real architecture, the security controls are documented and tested, and every technical claim
in the drafts has been reconciled with the code. What remains is the short list of facts and
decisions that only the owner or licensed counsel can supply. Nothing in this list should be
guessed; each placeholder below is used verbatim in the drafts so a search finds every
occurrence.

## A. Corporate facts (owner)

| # | Placeholder | Needed for | Notes |
| --- | --- | --- | --- |
| L-01 | `[LEGAL ENTITY NAME — OWNER INPUT REQUIRED]` | Terms, Privacy Policy, DPA, EULA, security.txt canonical | The drafts say "Forger Digital Solutions (FDS)"; the registered legal name and entity type are unknown to the repository |
| L-02 | `[MAILING ADDRESS — OWNER INPUT REQUIRED]` | Privacy Policy, DMCA, DPA signature block, privacy-rights workflow | A registered-agent address is acceptable |
| L-03 | `[LEGAL CONTACT — OWNER INPUT REQUIRED]` | DPA, ToS notices | Mailbox or counsel address |
| L-04 | `[PRIVACY CONTACT — OWNER INPUT REQUIRED]` | Privacy Policy §8, privacy-rights workflow | Monitored mailbox (e.g. `privacy@` on the FDS domain) |
| L-05 | `TODO_OWNER_SECURITY_CONTACT` | SECURITY.md, security.txt, security-disclosure draft, `CODEFORGE_SECURITY_CONTACT` env | Monitored mailbox or GitHub private vulnerability reporting; see `docs/security/OWNER-ACTIONS.md` OA-02 |
| L-06 | Abuse/DMCA contact and designated agent registration | AUP, DMCA policy | Only if content hosting warrants a DMCA agent (counsel) |

## B. Legal determinations (counsel)

| # | Placeholder | Where | Decision needed |
| --- | --- | --- | --- |
| L-07 | `[GOVERNING LAW — LEGAL REVIEW REQUIRED]` | Terms §"Governing Law", DPA §11 | Jurisdiction and venue |
| L-08 | `[DISPUTE RESOLUTION — LEGAL REVIEW REQUIRED]` | Terms | Arbitration vs. courts; class-action terms |
| L-09 | `[TRANSFER MECHANISM — LEGAL REVIEW REQUIRED]` | DPA §7 | SCCs/UK addendum for EEA/UK personal data (infrastructure is US-based) |
| L-10 | Applicability statements | Privacy Policy (GDPR/CCPA/state-law sections), privacy-rights workflow | Which rights apply to which users; supervisory-authority information |
| L-11 | Breach-notification windows | DPA §9, incident response | Contractual and statutory windows |
| L-12 | Vulnerability-disclosure safe-harbor scope | SECURITY.md, security-disclosure draft | Whether to offer safe-harbor language and its wording (the current draft offers a good-faith statement only, no legal promise) |
| L-13 | Minimum age | Terms, Privacy Policy, first-run acknowledgement | The app currently asks users to confirm they are 18+; counsel confirms the policy |
| L-14 | Limitation of liability / indemnity wording | Terms | Flagged in the draft as counsel-review clauses |

## C. Business decisions (owner)

| # | Placeholder | Where | Decision needed |
| --- | --- | --- | --- |
| L-15 | Retention periods for BILLING_RECORD and SECURITY_AUDIT classes | Privacy Policy §7, `packages/legal-policy/src/retention.ts`, deletion receipts | e.g. "billing records N years; security audit N months" (OWNER-ACTIONS OA-06) |
| L-16 | Pricing, renewal cadence, allowances, and refund terms | Subscription/billing terms | Stripe remains in TEST mode until decided (OA-08); the draft states mechanics only |
| L-17 | Privacy-request response windows | Privacy-rights workflow | e.g. 30/45 days |
| L-18 | Sub-processor change notice period | DPA §6 | e.g. 30 days |
| L-19 | Audit terms and frequency | DPA §8 | — |
| L-20 | Whether to publish `security.txt` on the website domain and which domain is canonical | security.txt, OA-14 | — |
| L-21 | Which database provider/region is live (Supabase vs Neon) | Sub-processor list, DPA Annex | Deployment fact the owner knows |

## D. Already resolved by engineering (no owner input needed)

- What data exists, where it lives, how it is protected, how long it lives, and how it is deleted (`docs/security/data-classification.md`, `docs/privacy/*`).
- Which third parties actually process data (`docs/legal/subprocessor-list.md`).
- The truthful security description for public copy (`docs/security/`, `SECURITY.md`).
- Technical inaccuracies in the Pass-3 drafts (hardware encryption, "servers never host source", hashed customer ids, invented 7-year retention and 30-day token purge, unregistered `DELETE /api/account` path) — corrected in the drafts on 2026-09-18.
- Invented disclosure SLAs in the security-disclosure draft — replaced with non-binding targets marked as such.
