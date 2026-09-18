# Retention and Deletion

The real lifecycle of every data category (Phase 31). Mechanisms are named; periods that are
business decisions are marked as such rather than invented. The machine-readable policy is
`packages/legal-policy/src/retention.ts`.

## Retention classes (from the code)

| Class | Purged on account deletion? | Retention after deletion | Status |
| --- | --- | --- | --- |
| USER_CONTENT (hosted workflow sessions/messages/work items; publication bundles) | Yes | 0 days | CONFIGURED |
| AUTH_DATA (identities, device/browser sessions, auth codes, OAuth transactions, sealed verifiers) | Yes (revoked immediately) | 0 days | CONFIGURED |
| OPERATIONAL_DATA (usage events, reservations, hosted requests, ledger, entitlements, subscriptions, settings, GitHub installations/authorizations, publication records) | Yes | 0 days | CONFIGURED (see billing caveat) |
| SECURITY_AUDIT (`security_audit_events`, `abuse_events`) | No — the user id is nulled, the event kept | **Undecided** (`BUSINESS_DECISION_REQUIRED`) | Owner action OA-06 |
| BILLING_RECORD (Stripe webhook records; Stripe's own records) | Webhook records are not user-keyed and are kept; Stripe keeps its own | **Undecided** (`BUSINESS_DECISION_REQUIRED`) | Owner action OA-06 |
| LEGAL_HOLD | No | Indefinite while a hold applies | Only on explicit flag; none exists today |

## Automatic expiry while the account is live

| Data | Expiry | Mechanism |
| --- | --- | --- |
| OAuth transactions, browser OAuth transactions (incl. sealed verifiers) | 10 minutes or first use | Hourly retention sweep deletes expired/consumed rows; refused after expiry regardless |
| Desktop auth codes | 120 seconds or first use | Sweep |
| GitHub App callback states | ≤10 minutes or first use | Sweep |
| Access tokens | 1 hour | Not stored server-side; session liveness enforced |
| Refresh tokens / device sessions | 30 days, rotated on use | Sweep removes expired and revoked rows 30 days after revocation |
| Browser sessions | 7 days | Sweep |
| Publication bundles | Until pushed (deleted on completion) or terminal failure (swept hourly) | `PublicationService` |
| Hosted inference request content | Not stored | — |
| Local desktop task history | Until you clear the data folder | User action (Settings › Data & Privacy › Open data folder) |
| Repository intelligence cache | Rolling, per repository | Local cache |

The sweep runs at Cloud boot and hourly (`CodeForgeCloudServer.runRetentionSweep`); it never
fails a request and logs only counts.

## Account deletion (what actually happens)

`DELETE /v1/account` with body `{"confirmation":"DELETE_MY_ACCOUNT"}` and a live bearer token
(Settings › Profile › Delete account in the desktop):

1. Staged publication bundles for the account are deleted from disk.
2. Hosted workflow sessions and their events are deleted.
3. In one database transaction: repository authorizations, publications, installations, callback states, desktop auth codes, browser sessions, identities, device sessions, subscriptions, entitlements, credit ledger, usage events, usage periods, reservations, hosted requests, account settings, and the user row are deleted; `abuse_events` and `security_audit_events` rows keep the event but lose the user id.
4. Every session of the account is revoked; any access token the desktop still holds is refused (401) on its next request, and the desktop clears its local copy.
5. A receipt is returned with category names and counts only (never an inventory of content).
6. Idempotent: a retried deletion after a lost response is refused with 401 because the account no longer exists — a safe terminal outcome, not a second deletion.

Not covered by deletion (and said so in the privacy policy):
- **GitHub-side grants** (the OAuth App authorization and the GitHub App installation) remain until you revoke them on GitHub.
- **Stripe records** remain under Stripe's policy and any financial-records obligation.
- **Provider-side data**: content already sent to a model provider is governed by that provider.
- **Backups**: the database provider's snapshots taken before deletion contain the deleted rows until they age out of the provider's retention window (see `docs/security/backups-and-recovery.md`). CodeForge cannot delete rows from a provider snapshot.
- **Local data** on your machine is yours to delete.

## Deletion of individual items

| Item | How |
| --- | --- |
| A BYOK provider key | Settings › Providers › Disconnect / delete (removes the sealed entry and the adapter) |
| GitHub App repository access | Uninstall or edit the App installation on GitHub; CodeForge marks it revoked |
| A local task session | Not yet exposed in the UI (no `DELETE /api/sessions/:id`); clear the data folder |
| Cloud sessions on other devices | Sign out on each device; a "sign out everywhere" control is prepared server-side but not yet in the UI |

## Retention of logs

Redacted audit lines on Render stdout are retained per Render's log retention (platform
setting); they contain event types, opaque ids, and IPs — no content or credentials.
