import { describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { PostgresCloudDatabase } from "@codeforge/cloud-db";
import { PostgresSessionPersistence, SESSIONS_MIGRATIONS } from "@codeforge/sessions";

/**
 * Reproduces and proves the fix for the shared-database migration-table collision discovered
 * during the 8-Bit clean-baseline reconciliation: @codeforge/sessions and @codeforge/cloud-db
 * both used an identically named `schema_migrations` table. When both are pointed at the same
 * physical PostgreSQL database (as they legitimately can be, e.g. one shared local test
 * database, or any deployment that consolidates services onto one database), the second
 * package to boot failed with a checksum mismatch against the FIRST package's migration 1 row.
 *
 * Real PostgreSQL is required — this is exactly the class of defect a mock cannot catch (both
 * packages' unit tests mock the pool and never observe a real shared migrations table).
 */
const TEST_PG = process.env.CODEFORGE_TEST_POSTGRES_URL || process.env.DATABASE_URL;

function urlForDatabase(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

// A single fixed, pre-registered disposable database name (rather than one randomly generated
// per test) so this file needs exactly one pg_hba.conf entry, consistent with the existing
// narrowly-scoped, non-widening access pattern this environment's local PostgreSQL setup uses
// (see scripts/setup-local-pg.mjs). Tests run sequentially within a file, so reusing one name
// with a drop+recreate at the top of each is safe and requires no new wildcard/broad grant.
const FIXED_DB_NAME = "migration_ns_test";

describe.skipIf(!TEST_PG?.startsWith("postgres"))("Migration namespace collision — sessions vs cloud-db (real PostgreSQL)", () => {
  async function withFreshDatabase<T>(fn: (dbUrl: string, admin: pg.Client) => Promise<T>): Promise<T> {
    const dbName = FIXED_DB_NAME;
    const admin = new pg.Client({ connectionString: urlForDatabase(TEST_PG!, "postgres") });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${dbName} OWNER codeforge_test`);
    try {
      return await fn(urlForDatabase(TEST_PG!, dbName), admin);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
    }
  }

  async function tableExists(admin: pg.Client, dbName: string, table: string): Promise<boolean> {
    const conn = new pg.Client({ connectionString: urlForDatabase(TEST_PG!, dbName) });
    await conn.connect();
    try {
      const res = await conn.query(`SELECT to_regclass($1) IS NOT NULL AS exists`, [table]);
      return Boolean(res.rows[0]?.exists);
    } finally {
      await conn.end();
    }
  }

  it("[PASS] sessions migrations alone create the namespaced sessions_schema_migrations table", async () => {
    await withFreshDatabase(async (dbUrl, admin) => {
      const dbName = new URL(dbUrl).pathname.slice(1);
      const sessions = new PostgresSessionPersistence({ connectionString: dbUrl });
      await sessions.init();
      await sessions.close();
      expect(await tableExists(admin, dbName, "sessions_schema_migrations")).toBe(true);
      expect(await tableExists(admin, dbName, "schema_migrations")).toBe(false);
    });
  });

  it("[PASS] cloud-db migrations alone create the namespaced cloud_schema_migrations table", async () => {
    await withFreshDatabase(async (dbUrl, admin) => {
      const dbName = new URL(dbUrl).pathname.slice(1);
      const cloud = new PostgresCloudDatabase({ connectionString: dbUrl });
      await cloud.init();
      await cloud.close();
      expect(await tableExists(admin, dbName, "cloud_schema_migrations")).toBe(true);
      // cloud-db's own MIGRATION_1_POSTGRES SQL content (packages/cloud-db/src/migrations.ts)
      // redundantly creates a plain `schema_migrations` table as part of its migration body — a
      // pre-existing quirk left unmodified here since editing that SQL would change the
      // migration's checksum. The namespaced-table fix never writes to it, so it exists but stays
      // empty; it must not be mistaken for the real (populated) migration-history table.
      expect(await tableExists(admin, dbName, "schema_migrations")).toBe(true);
      const conn = new pg.Client({ connectionString: dbUrl });
      await conn.connect();
      try {
        const orphanRows = await conn.query(`SELECT COUNT(*)::int AS n FROM schema_migrations`);
        expect(orphanRows.rows[0].n).toBe(0);
      } finally {
        await conn.end();
      }
    });
  });

  it("[PASS] sessions then cloud-db against the SAME shared database — no collision, both succeed", async () => {
    await withFreshDatabase(async (dbUrl) => {
      const sessions = new PostgresSessionPersistence({ connectionString: dbUrl });
      await expect(sessions.init()).resolves.not.toThrow();
      await sessions.close();

      const cloud = new PostgresCloudDatabase({ connectionString: dbUrl });
      await expect(cloud.init()).resolves.not.toThrow();
      const user = await cloud.createUser({ displayName: "Shared DB Tester", primaryIdentity: `github:${randomUUID()}` });
      expect(user.id).toBeTruthy();
      await cloud.close();
    });
  });

  it("[PASS] cloud-db then sessions against the SAME shared database — no collision, both succeed", async () => {
    await withFreshDatabase(async (dbUrl) => {
      const cloud = new PostgresCloudDatabase({ connectionString: dbUrl });
      await expect(cloud.init()).resolves.not.toThrow();
      await cloud.close();

      const sessions = new PostgresSessionPersistence({ connectionString: dbUrl });
      await expect(sessions.init()).resolves.not.toThrow();
      await sessions.upsertSession({ id: "s1", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });
      expect(await sessions.getSession("s1")).toBeTruthy();
      await sessions.close();
    });
  });

  it("[PASS] restart / second init() pass is idempotent for both packages against a shared database — no duplicate rows, no re-run", async () => {
    await withFreshDatabase(async (dbUrl) => {
      const sessions1 = new PostgresSessionPersistence({ connectionString: dbUrl });
      await sessions1.init();
      await sessions1.close();
      const cloud1 = new PostgresCloudDatabase({ connectionString: dbUrl });
      await cloud1.init();
      await cloud1.close();

      // Second pass over the same database: both packages re-init without error.
      const sessions2 = new PostgresSessionPersistence({ connectionString: dbUrl });
      await expect(sessions2.init()).resolves.not.toThrow();
      await sessions2.close();
      const cloud2 = new PostgresCloudDatabase({ connectionString: dbUrl });
      await expect(cloud2.init()).resolves.not.toThrow();
      await cloud2.close();

      const conn = new pg.Client({ connectionString: dbUrl });
      await conn.connect();
      try {
        const sessionsRows = await conn.query(`SELECT version FROM sessions_schema_migrations`);
        expect(sessionsRows.rows).toHaveLength(1); // one migration defined today — no duplicates
        const cloudRows = await conn.query(`SELECT COUNT(*)::int AS n FROM cloud_schema_migrations`);
        expect(cloudRows.rows[0].n).toBeGreaterThan(0);
      } finally {
        await conn.end();
      }
    });
  });

  it("[PASS] existing-database upgrade path: a legacy schema_migrations table owned by sessions is adopted (renamed, zero data loss) rather than colliding", async () => {
    await withFreshDatabase(async (dbUrl, admin) => {
      const dbName = new URL(dbUrl).pathname.slice(1);
      // Simulate a database from before the namespaced-table fix: sessions boots first using
      // the OLD generic table name directly (bypassing the fix, to reproduce the legacy shape).
      const conn = new pg.Client({ connectionString: dbUrl });
      await conn.connect();
      await conn.query(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name VARCHAR(255) NOT NULL, checksum VARCHAR(64) NOT NULL, applied_at VARCHAR(64) NOT NULL)`);
      await conn.query(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL, status TEXT NOT NULL, "currentAgentId" TEXT, "currentModelId" TEXT, "currentProviderId" TEXT, "permissionMode" TEXT, "displayMode" TEXT, branch TEXT, "workspacePath" TEXT, "taskTitle" TEXT)`);
      await conn.query(`INSERT INTO sessions (id, title, "createdAt", "updatedAt", status) VALUES ('legacy-session', 'pre-existing', now()::text, now()::text, 'completed')`);
      // Use the REAL checksum sessions' own migration 1 computes (not a placeholder) — the
      // adoption path renames the table in place rather than re-running migration content, so the
      // post-adoption checksum-verification step compares against this row exactly as written.
      // A fake checksum here would make checksum verification correctly reject the row, which
      // would test fixture realism, not the adoption logic this test exists to prove.
      const realMigrationOne = SESSIONS_MIGRATIONS.find((m) => m.version === 1)!;
      await conn.query(`INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (1, $1, $2, now()::text)`, [
        realMigrationOne.name,
        realMigrationOne.checksum,
      ]);
      await conn.end();

      // A fresh sessions instance boots against this "already deployed" database. It must adopt
      // (rename) the legacy table rather than trying to re-run/insert version 1 into it — proven
      // by NOT throwing a duplicate-key or checksum error, and the pre-existing row surviving.
      const sessions = new PostgresSessionPersistence({ connectionString: dbUrl });
      await expect(sessions.init()).resolves.not.toThrow();
      const preExisting = await sessions.getSession("legacy-session");
      expect(preExisting?.title).toBe("pre-existing");
      await sessions.close();

      expect(await tableExists(admin, dbName, "sessions_schema_migrations")).toBe(true);
      expect(await tableExists(admin, dbName, "schema_migrations")).toBe(false); // renamed, not duplicated

      // cloud-db booting against the SAME database afterward must NOT try to adopt that
      // (already-renamed-away) table, and must not collide with it either — it gets its own.
      const cloud = new PostgresCloudDatabase({ connectionString: dbUrl });
      await expect(cloud.init()).resolves.not.toThrow();
      await cloud.close();
      expect(await tableExists(admin, dbName, "cloud_schema_migrations")).toBe(true);
    });
  });

  it("[PASS] a legacy schema_migrations table NOT owned by this package (unrecognized name) is left completely untouched", async () => {
    await withFreshDatabase(async (dbUrl, admin) => {
      const dbName = new URL(dbUrl).pathname.slice(1);
      const conn = new pg.Client({ connectionString: dbUrl });
      await conn.connect();
      await conn.query(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name VARCHAR(255) NOT NULL, checksum VARCHAR(64) NOT NULL, applied_at VARCHAR(64) NOT NULL)`);
      await conn.query(`INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (1, 'some_unrelated_owner', 'x', now()::text)`);
      await conn.end();

      // Sessions does not recognize this owner name — it must leave the legacy table alone and
      // create its own namespaced table fresh, rather than guessing ownership.
      const sessions = new PostgresSessionPersistence({ connectionString: dbUrl });
      await expect(sessions.init()).resolves.not.toThrow();
      await sessions.close();

      expect(await tableExists(admin, dbName, "sessions_schema_migrations")).toBe(true);
      expect(await tableExists(admin, dbName, "schema_migrations")).toBe(true); // untouched, not renamed

      const verify = new pg.Client({ connectionString: dbUrl });
      await verify.connect();
      const legacyRows = await verify.query(`SELECT name FROM schema_migrations`);
      expect(legacyRows.rows).toEqual([{ name: "some_unrelated_owner" }]); // unmodified
      await verify.end();
    });
  });
});
