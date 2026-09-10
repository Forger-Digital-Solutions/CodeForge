# PostgreSQL test harness

CodeForge's real-PostgreSQL integration tests run through `scripts/postgres-test-harness.mjs`.
The harness is test infrastructure only; it does not replace PostgreSQL with SQLite, mocks, or an
in-memory adapter.

On Windows with the repository-managed WSL Ubuntu PostgreSQL fixture, run:

```powershell
npm.cmd run test:postgres
npm.cmd run test:postgres:full
```

The local harness uses the stable Windows endpoint `127.0.0.1:5432` and the explicit disposable
`codeforge_test_db` database. It starts a short-lived WSL keeper before invoking the existing
`scripts/setup-local-pg.mjs` bootstrap. The keeper prevents WSL from shutting PostgreSQL down when
the bootstrap process exits. Before starting tests, the harness uses bounded retry and an actual
`SELECT 1, current_database()` query; an open port alone is never treated as ready.

The harness passes the resolved endpoint to its child as `CODEFORGE_TEST_POSTGRES_URL` and removes
its keeper when that child finishes. Existing test suites retain their own database/schema lifecycle:
the integration command intentionally runs them in parallel to expose migration, cleanup, or
connection-pool races.

For CI or an externally managed database, set `CODEFORGE_TEST_POSTGRES_URL` before invocation.
That path never launches WSL or changes database configuration; it only verifies the supplied
endpoint and database before running the requested test command.

On a readiness failure, the harness reports the redacted endpoint, WSL status when applicable,
the Windows TCP probe, and the final SQL-readiness error. It fails before Vitest starts rather than
allowing several unrelated suites to time out later.
