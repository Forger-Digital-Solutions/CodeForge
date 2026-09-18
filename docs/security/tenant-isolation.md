# Tenant Isolation

CodeForge Cloud is multi-tenant at the account level. This document states how one account is kept
from another and which tests prove it (Phase 14, 53).

## Principle

Authorization is derived from the **verified token**, never from request parameters. Every
authenticated route does:

```ts
const userId = await this.authenticateRequest(req);   // JWT signature + expiry + LIVE session
...service.method(userId, ...)                         // userId is the only tenant key ever used
```

There is no route that accepts a user id, and no route that lists resources across users. UUID
unpredictability is not relied on: a guessed or leaked id of another user's resource yields the
same `404` as an unknown id, before any privileged side effect (publication HTTP tests call this
"indistinguishable before every privileged side effect").

## Resource-by-resource

| Resource | Scoping mechanism | Cross-tenant test |
| --- | --- | --- |
| Account, identity, settings | `/v1/account*` use the token's `sub`; settings upsert is keyed by `userId` from the token; `DELETE /v1/account` has no target parameter | `apps/cloud-api/test/account-deletion.test.ts` ("userId comes only from the verified token") |
| Usage, ledger, reservations | `UsageEngine`/`ICloudDatabase` methods take `userId`; reservations are settled with `(requestId, userId)` pairs | `tests/cloud-adversarial-security.test.ts` ("rejects cross-user reservation spoofing"), `tests/cloud-concurrency-ledger.test.ts` |
| Hosted inference | Reservation and spend are charged to the token's user; privacy mode is that user's | `tests/two-client-authority.test.ts` |
| Hosted workflows / worker actions | `HostedWorkflowAuthority.get(id, ownerUserId)` returns only owner-matching items; `pending`/`result` are filtered by owner and bound worker | `apps/cloud-api/test/hosted-workflow-authority.test.ts`, ATTACK-003 |
| GitHub App installations and repository authorizations | Installation rows carry `codeforge_user_id`; callback rejects `INSTALLATION_OWNED_BY_OTHER_USER` / `AUTHORIZATION_USER_MISMATCH`; repository lookups are joined through the user's installations | `packages/cloud-auth/test/github-app.test.ts` |
| Publications and artifacts | Rows carry `user_id`; every route resolves `(userId, publicationId)`; a foreign id is a 404 before upload, execute, retry, or status; artifact keys are derived from the publication id so a foreign upload cannot target another user's file | `apps/cloud-api/test/publication-http.e2e.test.ts` ("makes cross-user and unknown publication IDs indistinguishable…") |
| Sealed secrets | Envelopes are AAD-bound to `{purpose, leg, state}`; a sealed value copied into another transaction's row fails authentication | ATTACK-003 |
| Sessions | Access tokens name a `sid` that must belong to `sub`; a valid signature over a foreign `sid` is refused | `AuthService.verifyAccessSession` |
| Billing | Checkout sessions are created with `client_reference_id = userId` from the token; a webhook whose subscription already belongs to another user is rejected (`rejected_subscription_owned_by_other_user`); a client cannot name a plan, price, or balance | `packages/cloud-billing/test/billing.test.ts`, ATTACK-009/010 |
| BYOK keys | Not multi-tenant: they never leave the device (no server-side data exists to isolate) | design; [provider-security.md](./provider-security.md) |
| Local task history, worktrees, files | Per OS user on the device; the local control plane is single-user by construction (loopback + per-process bearer) | `packages/server/test/network-exposure.test.ts` |

## Enumeration resistance

- No endpoint returns lists across users. `GET /v1/workflows`, `/v1/github-app/installations`, `/v1/github-app/repositories` list only the caller's rows.
- 404 responses for foreign ids are byte-identical to unknown-id 404s (no "exists but forbidden" 403 that would confirm existence).
- Rate limiting (120/min/IP) bounds guessing; ids are UUIDv4 / 256-bit states, but that is defense in depth, not the authorization.

## Database-level isolation (honest status)

- The Cloud connects with a single application role; PostgreSQL Row Level Security is **not** used (`NOT IMPLEMENTED`). Isolation is enforced in the application layer through `ICloudDatabase` methods that all take the tenant key. Adding RLS with `SET LOCAL app.user_id` per request is a contained follow-up and is listed in the compliance matrix as PARTIAL.
- Both drivers (SQLite for tests/dev, PostgreSQL for production) implement the same interface; the parity suite (`packages/cloud-db/test/parity.test.ts`) and the real-PostgreSQL adversarial suite (`tests/cloud-postgres-adversarial.test.ts`, run in `cloud-ci.yml` against a live database) keep them behaviorally identical.

## Adversarial checklist (Phase 53) → test

| Attempt | Expected | Test |
| --- | --- | --- |
| Direct id replacement (workflow/publication) | 404 | ATTACK-003, publication-http.e2e |
| Guessed resource id | 404 | same |
| Stale session (logged out) | 401 | ATTACK-014 |
| Mismatched repository (publication for a repository another user authorized) | `REPOSITORY_NOT_AUTHORIZED` | publication-service e2e |
| Wrong secret record (sealed verifier moved between rows) | Callback fails, no session | ATTACK-003 |
| Wrong billing receipt (subscription owned by another user) | `rejected_subscription_owned_by_other_user` | `grantCheckoutSession` |
| Wrong GitHub connection (installation owned by another user) | 403 `INSTALLATION_OWNED_BY_OTHER_USER` | github-app tests |
| Crafted IPC/API payload (extra fields naming plan/balance/user) | Stripped by Zod; ignored | ATTACK-010 |
| Forged bearer for a nonexistent session | 401 | `tests/production-auth-bypass-guard.test.ts`, helpers/session-token |
