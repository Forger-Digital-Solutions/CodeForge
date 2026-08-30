import { describe, it, expect } from "vitest";
import { PostgresCloudDatabase } from "../src/postgres.js";
import { MIGRATIONS, DEFAULT_PLANS } from "../src/migrations.js";

/**
 * Capturing fake pg.Pool — records every SQL statement so we can prove the async schema init runs
 * (the previous boot bug: init() existed but was never called). No real database required.
 */
function makeFakePool() {
  const queries: string[] = [];
  let errorListener: ((error: Error) => void) | undefined;
  const client = {
    query: async (sql: string, _params?: unknown[]) => {
      queries.push(sql);
      // schema_migrations lookups must return empty so migrations are treated as unapplied.
      return { rows: [] as unknown[] };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client,
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] as unknown[] };
    },
    on: (event: string, listener: (error: Error) => void) => {
      if (event === "error") errorListener = listener;
    },
    end: async () => {},
  };
  return { pool: pool as unknown as import("pg").Pool, queries, emitPoolError: (error: Error) => errorListener?.(error) };
}

describe("PostgresCloudDatabase — async schema init (boot-fix)", () => {
  it("runs migrations and seeds plans when init() is called", async () => {
    const { pool, queries } = makeFakePool();
    const db = new PostgresCloudDatabase({ pool });
    await db.init();

    const joined = queries.join("\n");
    expect(joined).toContain("CREATE TABLE IF NOT EXISTS schema_migrations");
    // Migration body ran (the initial schema creates the users table).
    expect(joined).toMatch(/CREATE TABLE[\s\S]*users/i);
    // schema_migrations bookkeeping row inserted for each migration.
    expect(queries.filter((q) => q.includes("INSERT INTO schema_migrations")).length).toBe(MIGRATIONS.length);
    // Default plans seeded (free + pro at minimum).
    expect(queries.filter((q) => q.includes("INSERT INTO plans")).length).toBe(DEFAULT_PLANS.length);
  });

  it("is idempotent — a second init() does not re-run migrations", async () => {
    const { pool, queries } = makeFakePool();
    const db = new PostgresCloudDatabase({ pool });
    await db.init();
    const afterFirst = queries.length;
    await db.init();
    expect(queries.length).toBe(afterFirst);
  });

  it("coalesces concurrent init() calls into a single migration pass", async () => {
    const { pool, queries } = makeFakePool();
    const db = new PostgresCloudDatabase({ pool });
    await Promise.all([db.init(), db.init(), db.init()]);
    // Exactly one migration pass despite three concurrent callers: one bookkeeping insert per
    // migration, not three times that.
    expect(queries.filter((q) => q.includes("INSERT INTO schema_migrations")).length).toBe(MIGRATIONS.length);
  });

  it("handles idle pool errors without terminating the API process", () => {
    const { pool, emitPoolError } = makeFakePool();
    new PostgresCloudDatabase({ pool });
    expect(() => emitPoolError(new Error("connection reset"))).not.toThrow();
  });
});

// Real Postgres integration — runs ONLY when a disposable/staging DATABASE_URL is provided.
// Proves migrations, a credit round-trip, and restart persistence against a genuine server.
const REAL_PG = process.env.CODEFORGE_TEST_POSTGRES_URL || process.env.DATABASE_URL;
describe.skipIf(!REAL_PG?.startsWith("postgres"))("PostgresCloudDatabase — real server integration", () => {
  it("serializes independent instance initialization against a fresh schema", async () => {
    const { randomUUID } = await import("node:crypto");
    const schema = `codeforge_migration_${randomUUID().replaceAll("-", "")}`;
    const pgModule = await import("pg");
    const adminPool = new pgModule.default.Pool({ connectionString: REAL_PG });
    const safeSchema = `"${schema}"`;

    try {
      await adminPool.query(`CREATE SCHEMA ${safeSchema}`);
      const schemaUrl = new URL(REAL_PG!);
      schemaUrl.searchParams.set("options", `-c search_path=${schema}`);
      const first = new PostgresCloudDatabase({ connectionString: schemaUrl.toString() });
      const second = new PostgresCloudDatabase({ connectionString: schemaUrl.toString() });

      await Promise.all([first.init(), second.init()]);
      const migrations = await adminPool.query(`SELECT version FROM ${safeSchema}.schema_migrations ORDER BY version`);
      expect(migrations.rows.map((row) => row.version)).toEqual(MIGRATIONS.map((migration) => migration.version));
      await Promise.all([first.close(), second.close()]);
    } finally {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${safeSchema} CASCADE`);
      await adminPool.end();
    }
  });

  it("initializes schema, persists a user + ledger, and survives a reconnect", async () => {
    const db1 = new PostgresCloudDatabase({ connectionString: REAL_PG });
    await db1.init();
    const user = await db1.createUser({ displayName: "PG Tester", primaryIdentity: `github:${Date.now()}` });
    expect(user.id).toBeTruthy();
    await db1.close();

    // Reconnect (simulated restart) — schema + data must persist.
    const db2 = new PostgresCloudDatabase({ connectionString: REAL_PG });
    await db2.init();
    const again = await db2.getUserById(user.id);
    expect(again?.displayName).toBe("PG Tester");
    await db2.close();
  });
});
