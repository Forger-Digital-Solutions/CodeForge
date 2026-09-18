# Privacy Rights Workflow

How a person can exercise privacy rights over the data CodeForge holds, and how FDS fulfils each
request (Phase 32). Which rights apply to whom is a legal determination that depends on
jurisdiction (GDPR, UK GDPR, CCPA/CPRA, other US state laws) — this workflow is built so any
applicable request can be fulfilled reliably; it does not assert that every right applies
universally.

## Channels

| Channel | Status |
| --- | --- |
| In-product self-service (desktop) | Available today for access (view account/usage) and deletion |
| Email to the privacy contact | `[PRIVACY CONTACT — OWNER INPUT REQUIRED]` (see `docs/legal/OWNER-LEGAL-INPUTS.md`) |
| Postal | `[MAILING ADDRESS — OWNER INPUT REQUIRED]` |

Identity verification for emailed requests: the request must come from the email address
linked to the GitHub identity on the account, or the requester must sign in and use the in-product
control. FDS never asks for a password (there is none) or for API keys.

## Requests and fulfilment

| Right | What CodeForge holds | How it is fulfilled | Timing target |
| --- | --- | --- | --- |
| **Access / know** | Account identity, sessions metadata, settings, usage, billing metadata, GitHub App authorizations, publication records, audit events keyed to the user | Self-service: Settings › Profile (account), Settings › Usage (usage); API: `GET /v1/account`, `GET /v1/usage`. For a complete export FDS runs `listSecurityAuditEvents({userId})` and the per-table queries in the classification matrix and returns JSON | Self-service immediate; manual export `[OWNER DECISION: e.g. 30 days]` |
| **Portability** | Same, in JSON | Same manual export (no bulk export endpoint yet — PARTIAL) | Same |
| **Rectification** | Identity fields mirror GitHub | Change on GitHub, sign in again (identity metadata refreshes at login); settings editable in-app | Immediate |
| **Deletion / erasure** | Everything listed in [retention-and-deletion.md](./retention-and-deletion.md) | Self-service: Settings › Profile › Delete account (`DELETE /v1/account` with explicit confirmation). Receipt returned. Backups age out per provider retention; GitHub/Stripe/provider-side data are outside CodeForge's deletion | Immediate for the live database |
| **Consent withdrawal** | No processing is based on consent today (no marketing, no analytics) | Disconnect providers, change privacy mode, or delete the account | Immediate |
| **Object / restrict** | Legitimate-interest processing is limited to security audit/abuse prevention | Handled case by case by the privacy contact with counsel | `[OWNER DECISION]` |
| **Opt out of sale/sharing** | No sale or sharing occurs | Not applicable; stated in the privacy policy | — |
| **Provider / integration disconnection** | GitHub App installation; BYOK keys | Uninstall the App on GitHub; delete keys in Settings › Providers; revoke the OAuth App on GitHub | Immediate |
| **Complaint / appeal** | — | Privacy contact; supervisory authority information per jurisdiction (counsel) | — |

## Internal procedure for a manual request

1. Log the request (date, channel, right, verification method) in the privacy request register (outside the repository; owner to create).
2. Verify identity as above.
3. Fulfil using the self-service path where possible; otherwise run the export/deletion against the production database with the receipt saved to the register.
4. Respond within the target window; include what was excluded (backups, third parties) and why.
5. Keep the register entry per the SECURITY_AUDIT retention decision.

## What is prepared vs. pending

| Item | Status |
| --- | --- |
| Deletion endpoint, receipt, artifact purge, session revocation | IMPLEMENTED / TESTED |
| Access to own account/usage | IMPLEMENTED |
| Full JSON export endpoint | NOT IMPLEMENTED (manual export documented) |
| Privacy contact and postal address | OWNER INPUT REQUIRED |
| Response-time commitments | OWNER DECISION |
| Jurisdictional applicability statements in the policy | REQUIRES LEGAL COUNSEL |
