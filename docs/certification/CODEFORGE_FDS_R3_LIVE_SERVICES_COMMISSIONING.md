# CodeForge / FDS R3 Live Services Commissioning Record

## Scope

This record covers the local hardening pass for the authoritative CodeForge Cloud
implementation on `feat/codeforge-cloud`. It is a deployment-candidate record, not
evidence that a remote staging environment has been deployed or certified.

The local branch is `codex/r3-live-services-hardening`. The work intentionally keeps
Stripe in TEST mode and does not create a hosting service, database, OAuth application,
Stripe product, Stripe price, webhook endpoint, or production billing configuration.

## Authority and safety boundaries

- CodeForge Cloud in this repository is the only authoritative commerce/backend path.
- The website remains preview-only for commercial checkout until a remote Cloud URL and
  authenticated browser/session integration are certified.
- Prices, allowances, limits, and entitlements remain database/configuration authority;
  this pass does not approve final commercial values.
- Live Stripe keys (`sk_live_` / `rk_live_`) are rejected at configuration time.
- Client requests cannot supply Stripe price IDs or redirect URLs.
- Stripe webhook processing is retryable after failure, idempotent after success, and
  binds customer/subscription identifiers to the authenticated CodeForge account.
- Paid execution fails closed after an authoritative subscription period end, including
  a scheduled cancellation whose terminal webhook has not yet arrived.

## Implemented hardening

- Server-owned TEST-mode Stripe checkout, portal, price, and redirect configuration.
- Explicit plan validation: only the existing registered `pro` plan can be upgraded.
- Webhook metadata/status/period validation and Stripe subscription fallback retrieval.
- Subscription status mapping and entitlement synchronization for active, trialing,
  payment-failure, cancellation, and terminal states.
- Retry-safe webhook claims and Stripe allowance ledger grants.
- Additive PostgreSQL/SQLite uniqueness indexes for non-null Stripe customer and
  subscription references.
- Desktop checkout and portal calls no longer send client-controlled pricing or return
  URLs.
- Updated deterministic cloud billing, database, entitlement, API, desktop, and cloud
  E2E fixtures/tests.

## External activation prerequisites

The current launch checklist reports these five required staging inputs as absent:

1. Public HTTPS Cloud URL
2. Durable TLS PostgreSQL `DATABASE_URL`
3. GitHub OAuth client ID
4. GitHub OAuth client secret
5. 32+ character session `JWT_SECRET`

Hosted Free provider capacity is present locally. Stripe TEST billing remains optional
and is not configured. A human must provision/authorize the free-tier hosting/database
and GitHub OAuth application before remote certification can begin. No payment details or
live charging are permitted for this record.

## Evidence commands

```text
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
npm.cmd run cloud:launch:checklist
```

The full test suite must be rerun after any subsequent change. The launch checklist is
expected to exit non-zero until the five external staging prerequisites are supplied.
