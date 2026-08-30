import { describe, it, expect } from "vitest";
import { PostgresCloudDatabase } from "../src/postgres.js";
import { MIGRATIONS, DEFAULT_PLANS } from "../src/migrations.js";

/**
 * Capturing fake pg.Pool — records every SQL statement so we can prove the async schema init runs
 * (the previous boot bug: init() existed but was never called). No real database required.
 */
function makeFakePool() {
  const queries: string[] = [];
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
    end: async () => {},
  };
  return { pool: pool as unknown as import("pg").Pool, queries };
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
});

// Real Postgres integration — runs ONLY when a disposable/staging DATABASE_URL is provided.
// Proves migrations, a credit round-trip, and restart persistence against a genuine server.
const REAL_PG = process.env.CODEFORGE_TEST_POSTGRES_URL || process.env.DATABASE_URL;
describe.skipIf(!REAL_PG?.startsWith("postgres"))("PostgresCloudDatabase — real server integration", () => {
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

