# Production database lifecycle plan

## Authoritative resources

R11 identifies the Virginia Render PostgreSQL 16 instance as the authoritative production database and a separate Supabase-backed database for staging. Production uses TLS and the externally validated Render connection path because Render’s internal certificate chain did not satisfy CodeForge’s verify-ca/verify-full policy.

The Render free PostgreSQL instance has a documented deletion deadline of **2026-10-07**. This is a release-critical owner decision, not a reason to make an unverified migration during this pass.

## Decision matrix

| Path | Benefits | Risks / required proof | R12 status |
|---|---|---|---|
| Upgrade the existing Render Postgres | Lowest application change; preserves endpoint and data | Paid DB decision; export/restore proof still required | `BLOCKED_OWNER_DECISION` |
| Migrate production to the already-proven Supabase Postgres path | Removes Render expiry dependency; known staging architecture | Requires production export, schema/row-count/migration/auth/billing/session/OAuth validation and rollback window | `BLOCKED_OWNER_DECISION` |
| Do nothing | No immediate change | Render may delete production data on 2026-10-07 | `FAIL` if deadline is reached without action |

## Required runbook before execution

1. Freeze and record the Render DB identifier, current schema/migration version, row counts, extensions, roles, TLS mode, connection-string source, and application health.
2. Produce an owner-controlled export and verify that it can be read back; retain the old database.
3. Provision or select the target only after the owner chooses Render upgrade or Supabase migration.
4. Apply migrations idempotently and compare schema, row counts, auth/account identities, billing/usage records, sessions, OAuth linkage, and audit records.
5. Run production health, authenticated flow, Hosted Free inference, persistence, restart, and TLS checks against the target.
6. Switch the connection secret through the approved deployment path, observe, and keep the old DB untouched until rollback validation passes.
7. Record the final target and only then schedule old-resource retirement.

No migration, database deletion, or connection-string replacement was performed in R12.
