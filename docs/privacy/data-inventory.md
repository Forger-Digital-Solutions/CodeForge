# Privacy Data Inventory

The personal-data view of CodeForge, derived from the engineering classification in
[`docs/security/data-classification.md`](../security/data-classification.md) and the flow map in
[`docs/security/data-flow.md`](../security/data-flow.md). This is the factual basis for the
Privacy Policy draft; it is not itself legal advice and makes no compliance claim.

## Who is the controller / processor?

- CodeForge is offered by Forger Digital Solutions (FDS) — the legal entity details are pending owner input (`docs/legal/OWNER-LEGAL-INPUTS.md`).
- For the optional CodeForge Cloud account, FDS determines the purposes below.
- For repository content and prompts sent to a model provider, the provider processes that content under its own terms; with BYOK the user has a direct relationship with the provider.

## Personal data categories

| Category | Data elements | Collected when | Purpose | Legal-basis candidates (counsel to confirm) | Where stored | Recipients | Retention |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Account identity | GitHub numeric id, login, display name, avatar URL, primary verified email you authorize | Signing in to CodeForge Cloud | Create and identify your account; show who is signed in | Contract (providing the account) | Cloud PostgreSQL (`users`, `identities`) | GitHub (source); no onward sharing | Until account deletion |
| Session and device data | Device name, IP address, user-agent, session timestamps; hashed session tokens | Signing in, refreshing, using the API | Keep you signed in; detect token replay and abuse | Contract; legitimate interest (security) | Cloud PostgreSQL (`device_sessions`, `browser_sessions`) | None | Session life ≤30 d; revoked rows purged after 30 d |
| Security audit events | Event type/outcome, opaque user id, IP, small redacted details | Security-relevant actions (login, logout, failures, billing events) | Detect and investigate abuse; incident evidence | Legitimate interest (security) | Cloud PostgreSQL (`security_audit_events`, `abuse_events`); redacted stdout log | Platform log storage (Render) | Retained after deletion with the user link severed; duration pending owner decision |
| Account settings | Privacy routing mode, spend limit | When you change settings | Apply your routing preferences and caps | Contract | Cloud PostgreSQL | None | Until account deletion |
| Usage and credits | Provider/model ids, token counts, cost estimates, credits reserved/used, request ids | Hosted Free / Paid inference | Enforce allowances and caps; show usage | Contract | Cloud PostgreSQL | None | Until account deletion (billing-related retention pending decision) |
| Billing metadata | Stripe customer id, subscription id, plan, status, period dates; minimized webhook records (ids, amounts, statuses) | Starting a checkout, Stripe webhooks | Provide paid plans; reconcile payments | Contract; legal obligation (financial records) | Cloud PostgreSQL; Stripe | Stripe | Subscription rows until deletion; webhook records retained (period pending decision) |
| Payment card data | **Not collected by CodeForge.** Entered on Stripe-hosted pages | Checkout | Payment | — | Stripe only | Stripe | Stripe's policy |
| GitHub App authorization | Installation id, account login/type, selected repository ids/names/private flag | Installing the CodeForge GitHub App | Publish commits/PRs to the repositories you chose | Contract | Cloud PostgreSQL | GitHub | Until revocation or account deletion |
| Publication records | Publication id, commit/tree SHAs, target branch, PR number/URL, error codes | Publishing | Show publication status; retries | Contract | Cloud PostgreSQL | GitHub (the push itself) | Until account deletion |
| Publication bundles (source code) | The git bundle of certified commits | Publishing | Push to GitHub | Contract | Cloud disk, transiently | GitHub | Deleted after the push; purged on failure/deletion |
| Prompts and code context | The text sent to a model | Every model request | Provide the AI service | Contract | **Not stored by CodeForge Cloud**; stored locally in your task history | The selected model provider | Local history until you clear it; provider retention per its terms |
| Hosted workflow content (API capability) | Task text, worker outputs | Only if a client uses `/v1/workflows` (the shipping desktop does not) | Server-authoritative workflows | Contract | Cloud PostgreSQL | None | Until account deletion |
| Local desktop data | Task history, verification evidence, recent projects, settings, sealed credentials | Using the app | Provide the app | — (on your device) | Your machine (`userData`) | None | Until you clear it |
| Support communications | Whatever you send to the support/security contact | Contacting FDS | Respond to you | Legitimate interest / contract | Mailbox (outside this repository) | None | Owner policy pending |

## What CodeForge does not collect

- No product telemetry, analytics identifiers, advertising identifiers, session replay, or crash reports.
- No passwords.
- No card numbers, CVV, or bank details.
- No repository contents on CodeForge servers except the transient publication bundle and the transient hosted-inference request.
- No precise geolocation (IP addresses are stored for security; no geolocation lookup is performed by CodeForge; a trusted edge may supply a country code for provider-policy decisions, and it is not persisted).

## Cookies and local storage

See [cookies-and-tracking.md](./cookies-and-tracking.md): one strictly necessary session cookie on the FDS sign-in flow; no tracking cookies; desktop `localStorage` is used for UI preferences only.

## Sub-processors

See [`docs/legal/subprocessor-list.md`](../legal/subprocessor-list.md).
