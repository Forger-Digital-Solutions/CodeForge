# R13 PostgreSQL certification status

Recorded: 2026-09-18

Verdict: `POSTGRESQL_CERTIFICATION_ENVIRONMENT_BLOCKED`.

No PostgreSQL connection string or host/port configuration was present in the local environment. Docker was unavailable because its daemon pipe was absent; `wsl.exe -l -q` was denied with `WsL/EnumerateDistros/Service/E_ACCESS_DENIED`; `psql` and `pg_isready` were not installed. The R13 runner therefore did not create, modify, or point tests at any database.

Local SQLite-backed evidence did pass: the R13 focused shadow, telemetry, paid-evaluation ledger, session-isolation, malformed-input, idempotence, and 100-concurrent-reservation tests passed, followed by the clean full Vitest suite. These prove the shared persistence contract under its local backend, not PostgreSQL behavior.

The following production-persistence properties remain unproven on PostgreSQL: migration/schema creation, indexes, transaction and restart durability, concurrent writes, telemetry and lineage/artifact persistence, malformed-input rejection, duplicate/idempotent writes, and tenant isolation through the PostgreSQL implementation.

When a disposable test-only PostgreSQL URL is supplied, run:

```text
npm.cmd run test:postgres
npm.cmd run test:postgres:full
```

The repository harness (`scripts/postgres-test-harness.mjs`) creates and uses the named isolated `codeforge_test_db`; it must receive a non-production test URL. Do not replace this blocked result with SQLite evidence or use the active hosted database for destructive local certification.
