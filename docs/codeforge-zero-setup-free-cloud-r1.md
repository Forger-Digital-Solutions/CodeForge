# CodeForge Zero-Setup Free Cloud R1

Status: `IN_PROGRESS`

## Free allowance policy

CodeForge Free grants a per-user monthly allowance on UTC calendar boundaries. The server creates
the current period on first use, exposes its exact `periodEnd` as the reset timestamp, and records
actual settled usage inside that period. SQLite and PostgreSQL use the same calendar-month boundary.
Reservations reduce available balance while active; release, idempotency, and failover use the same
logical request identifier so one task cannot double-charge.

This is a CodeForge user entitlement. It is not an upstream provider quota: upstream capacity may
degrade service availability but never changes another user's allowance.

## Deterministic fixture certification

The local rig uses a development-only IdP on a loopback port and a `devpool` scripted provider.
It exercises real CodeForge auth, PKCE, entitlement, usage reservation/settlement, ForgeZero route
admission, and hosted gateway code. It is labeled `FIXTURE` and cannot establish real managed-free
capacity, real model quality, or production provider authorization.

## Current evidence

- per-user usage isolation, exhaustion, reset, concurrent reservation, release, failover
  idempotency, and cross-user request identity: focused automated tests
- development IdP endpoint overrides: explicit server configuration only; insecure overrides fail
  closed in staging and production
- isolated local cloud API: connected SQLite ledger and one fixture-only managed route
- two-user HTTP probe on the isolated loopback rig: distinct OAuth identities and bearer-bound
  accounts; a settled fixture usage event changed User A's balance/event count and left User B's
  balance/event count unchanged

## Remaining certification gate

`REAL_MANAGED_FREE_PROVIDER_CAPACITY_BLOCKED` remains unresolved until a current provider is shown
to permit CodeForge-managed downstream use at zero cost and passes a real 8-Bit qualification.
