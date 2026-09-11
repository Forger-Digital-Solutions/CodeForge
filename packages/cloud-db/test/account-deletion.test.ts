import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import { describe, it, expect, afterEach } from "vitest";
import { CloudDatabase } from "../src/index.js";
import { PostgresCloudDatabase } from "../src/postgres.js";
import type { ICloudDatabase } from "../src/interface.js";

/**
 * Populates one user with at least one row in every table this package's schema links to a user
 * (per the migration DDL in src/migrations.ts), so deleteUserAccount() has a real, full graph to
 * prove it clears — not just the couple of tables an ad hoc test happens to touch.
 */
async function seedFullAccountGraph(db: ICloudDatabase, tag: string) {
  const user = await db.createUser({ displayName: `Deletion Test ${tag}`, primaryIdentity: `github:del-${tag}` });
  await db.createIdentity({ userId: user.id, provider: "github", providerUserId: `del-${tag}`, providerEmail: `${tag}@example.com` });
  await db.createDeviceSession({ userId: user.id, deviceName: "Test Device", refreshTokenHash: `hash-${tag}` });

  const plans = await db.listPlans();
  const planId = plans[0]!.id;
  await db.upsertSubscription({ userId: user.id, planId, status: "active", currentPeriodStart: new Date().toISOString(), currentPeriodEnd: new Date().toISOString(), cancelAtPeriodEnd: false });
  await db.setEntitlement(user.id, "HOSTED_FREE", "true");
  await db.getOrCreateCurrentUsagePeriod(user.id, 500_000); // seeds usage_periods + a credit_ledger grant
  await db.recordUsageEvent({ requestId: `req-${tag}`, userId: user.id, providerId: "groq", modelId: "test-model", inputTokens: 10, outputTokens: 10, cachedTokens: 0, providerCostUsd: 0, creditsConsumed: 100, latencyMs: 50, status: "completed" });
  await db.createReservation({ requestId: `resv-${tag}`, userId: user.id, providerId: "groq", modelId: "test-model", reservedCredits: 50 });
  await db.createHostedRequest({ id: `hosted-${tag}`, userId: user.id, providerId: "groq", modelId: "test-model", estimatedCredits: 50 });
  await db.upsertAccountSettings({ userId: user.id, privacyMode: "STANDARD" });
  await db.createDesktopAuthCode({ codeHash: `code-hash-${tag}`, userId: user.id, codeChallenge: "x".repeat(43), redirectUri: "http://127.0.0.1:9999/cb" });
  await db.createBrowserSession({ userId: user.id, sessionTokenHash: `browser-hash-${tag}` });
  await db.recordAbuseEvent({ userId: user.id, ipAddress: "203.0.113.1", eventType: "rate_limit_warning", details: "test fixture" });

  const installation = await db.createGitHubInstallation({
    installationId: Math.floor(Math.random() * 1_000_000),
    githubAccountId: Math.floor(Math.random() * 1_000_000),
    accountLogin: `del-${tag}`,
    accountType: "User",
    codeForgeUserId: user.id,
    repositorySelection: "all",
  });
  await db.createGitHubRepositoryAuthorization({
    installationId: installation.id,
    repositoryId: Math.floor(Math.random() * 1_000_000),
    owner: `del-${tag}`,
    name: "repo",
    fullName: `del-${tag}/repo`,
    private: false,
  });
  await db.createGitHubAppCallbackState({ state: `state-${tag}`, codeForgeUserId: user.id });
  await db.createPublication({
    deliveryId: `delivery-${tag}`,
    userId: user.id,
    repositoryId: Math.floor(Math.random() * 1_000_000),
    installationId: installation.id,
    targetBranch: "main",
    baseSha: "a".repeat(40),
    targetSha: "b".repeat(40),
    certifiedHead: "c".repeat(40),
    certifiedTree: "d".repeat(40),
    artifactSha256: "e".repeat(64),
    artifactBytes: 1024,
  });

  return user;
}

const DELETION_GRAPH_TABLES = [
  "identities",
  "device_sessions",
  "subscriptions",
  "entitlements",
  "credit_ledger",
  "usage_events",
  "usage_periods",
  "reservations",
  "hosted_requests",
  "account_settings",
  "desktop_auth_codes",
  "browser_sessions",
  "github_installations",
  "github_repository_authorizations",
  "github_app_callback_states",
  "publications",
];

describe("CloudDatabase — account deletion (SQLite, R1 spec §54)", () => {
  let dbPath: string;
  let db: CloudDatabase;

  afterEach(() => {
    db?.close();
    if (dbPath && existsSync(dbPath)) unlinkSync(dbPath);
  });

  function openRawSqlite() {
    // Match whatever engine src/sqlite.ts's openDatabase() actually picked (node:sqlite when
    // available, better-sqlite3 otherwise) — a raw better-sqlite3 require() here would fail on a
    // Node runtime whose prebuilt native binary doesn't match, independent of which engine wrote
    // the file.
    const require_ = require;
    try {
      const { DatabaseSync } = require_("node:sqlite");
      const raw = new DatabaseSync(dbPath, { readOnly: true });
      return {
        prepare: (sql: string) => {
          const stmt = raw.prepare(sql);
          return {
            get: (params?: unknown) => (params !== undefined ? stmt.get(params) : stmt.get()),
            all: (params?: unknown) => (params !== undefined ? stmt.all(params) : stmt.all()),
          };
        },
        close: () => raw.close(),
      };
    } catch {
      const Database = require_("better-sqlite3");
      const raw = new Database(dbPath, { readonly: true });
      return {
        prepare: (sql: string) => raw.prepare(sql),
        close: () => raw.close(),
      };
    }
  }

  it("deletes every linked row for the target user and leaves an unrelated user untouched", async () => {
    dbPath = join(tmpdir(), `codeforge-deletion-test-${randomUUID()}.db`);
    db = new CloudDatabase({ dbPath });

    const target = await seedFullAccountGraph(db, "target");
    const bystander = await seedFullAccountGraph(db, "bystander");

    const result = await db.deleteUserAccount(target.id);
    expect(result.userId).toBe(target.id);
    expect(result.abuseEventsAnonymized).toBe(1);
    for (const summary of result.tables) {
      expect(summary.rowsDeleted, summary.table).toBe(1);
    }

    expect(await db.getUserById(target.id)).toBeUndefined();

    const raw = openRawSqlite();
    try {
      // github_repository_authorizations has no user-identifying column at all (verified via its
      // parent installation below instead of in this generic per-table loop).
      const userColumn: Record<string, string> = {
        github_installations: "codeforge_user_id",
        github_app_callback_states: "codeforge_user_id",
      };
      for (const table of DELETION_GRAPH_TABLES) {
        if (table === "github_repository_authorizations") continue;
        const column = userColumn[table] ?? "user_id";
        const targetRows = raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(target.id) as { n: number };
        expect(targetRows.n, `${table} for deleted user`).toBe(0);
      }
      const orphanRepoAuths = raw
        .prepare(`SELECT COUNT(*) AS n FROM github_repository_authorizations WHERE owner = ?`)
        .get(`del-target`) as { n: number };
      expect(orphanRepoAuths.n, "orphaned github_repository_authorizations").toBe(0);

      const abuse = raw.prepare(`SELECT user_id FROM abuse_events WHERE details = 'test fixture' AND ip_address = '203.0.113.1'`).all() as Array<{ user_id: string | null }>;
      expect(abuse.length).toBe(2); // both fixtures' rows still exist...
      expect(abuse.filter((r) => r.user_id === target.id)).toHaveLength(0); // ...but the target's link is severed, not the row

      // The bystander's data must be completely untouched.
      const bystanderUser = raw.prepare(`SELECT id FROM users WHERE id = ?`).get(bystander.id);
      expect(bystanderUser).toBeDefined();
      const bystanderIdentities = raw.prepare(`SELECT COUNT(*) AS n FROM identities WHERE user_id = ?`).get(bystander.id) as { n: number };
      expect(bystanderIdentities.n).toBe(1);
    } finally {
      raw.close();
    }
  });

  it("is idempotent — deleting an already-deleted (or unknown) userId is a safe no-op, not an error", async () => {
    dbPath = join(tmpdir(), `codeforge-deletion-test-${randomUUID()}.db`);
    db = new CloudDatabase({ dbPath });
    const user = await seedFullAccountGraph(db, "retry");

    const first = await db.deleteUserAccount(user.id);
    expect(first.tables.find((t) => t.table === "users")?.rowsDeleted).toBe(1);

    const second = await db.deleteUserAccount(user.id);
    for (const summary of second.tables) {
      expect(summary.rowsDeleted, summary.table).toBe(0);
    }
    expect(second.abuseEventsAnonymized).toBe(0);

    const unknown = await db.deleteUserAccount(randomUUID());
    expect(unknown.tables.every((t) => t.rowsDeleted === 0)).toBe(true);
  });
});

// Real PostgreSQL integration (R1 spec §55): a fresh, disposable schema per run, following the
// same isolation pattern as postgres.test.ts's "real server integration" suite — this sidesteps
// the pre-existing cloud-db/sessions shared schema_migrations table-name collision entirely,
// since each test run gets its own schema and never touches @codeforge/sessions' tables.
const REAL_PG = process.env.CODEFORGE_TEST_POSTGRES_URL || process.env.DATABASE_URL;
describe.skipIf(!REAL_PG?.startsWith("postgres"))("CloudDatabase — account deletion (real PostgreSQL, R1 spec §55)", () => {
  it("proves cascade-equivalent completeness and transactional rollback against a real server", async () => {
    const schema = `codeforge_deletion_${randomUUID().replaceAll("-", "")}`;
    const pgModule = await import("pg");
    const adminPool = new pgModule.default.Pool({ connectionString: REAL_PG });
    const safeSchema = `"${schema}"`;
    const schemaUrl = new URL(REAL_PG!);
    schemaUrl.searchParams.set("options", `-c search_path=${schema}`);

    let db: PostgresCloudDatabase | undefined;
    try {
      await adminPool.query(`CREATE SCHEMA ${safeSchema}`);
      db = new PostgresCloudDatabase({ connectionString: schemaUrl.toString() });
      await db.init();

      const target = await seedFullAccountGraph(db, "pg-target");
      const bystander = await seedFullAccountGraph(db, "pg-bystander");

      const result = await db.deleteUserAccount(target.id);
      expect(result.abuseEventsAnonymized).toBe(1);
      expect(await db.getUserById(target.id)).toBeUndefined();

      const userColumn: Record<string, string> = {
        github_installations: "codeforge_user_id",
        github_app_callback_states: "codeforge_user_id",
      };
      for (const table of DELETION_GRAPH_TABLES) {
        // github_repository_authorizations has no user-identifying column — verified via its
        // parent installation in the join-based check below instead.
        if (table === "github_repository_authorizations") continue;
        const column = userColumn[table] ?? "user_id";
        const { rows } = await adminPool.query(`SELECT COUNT(*)::int AS n FROM ${safeSchema}.${table} WHERE ${column} = $1`, [target.id]);
        expect(rows[0].n, `${table} orphan count for deleted user`).toBe(0);
      }
      const { rows: orphanRepoAuths } = await adminPool.query(
        `SELECT COUNT(*)::int AS n FROM ${safeSchema}.github_repository_authorizations gra
         LEFT JOIN ${safeSchema}.github_installations gi ON gi.id = gra.installation_id
         WHERE gi.id IS NULL`,
      );
      expect(orphanRepoAuths[0].n, "github_repository_authorizations orphaned from a deleted installation").toBe(0);

      const { rows: bystanderRows } = await adminPool.query(`SELECT id FROM ${safeSchema}.users WHERE id = $1`, [bystander.id]);
      expect(bystanderRows).toHaveLength(1);
      const { rows: bystanderIdentities } = await adminPool.query(`SELECT COUNT(*)::int AS n FROM ${safeSchema}.identities WHERE user_id = $1`, [bystander.id]);
      expect(bystanderIdentities[0].n).toBe(1);

      // Transactional rollback: the same withTx() primitive deleteUserAccount uses must roll back
      // fully on a mid-transaction throw, proven directly against a real connection.
      const rollbackUser = await db.createUser({ displayName: "Rollback Probe", primaryIdentity: "github:rollback-probe" });
      await expect(
        db.withTx(async (client) => {
          await client.query(`DELETE FROM ${safeSchema}.users WHERE id = $1`, [rollbackUser.id]);
          throw new Error("forced failure after a real delete, to prove rollback");
        }),
      ).rejects.toThrow("forced failure");
      const survived = await db.getUserById(rollbackUser.id);
      expect(survived, "row deleted inside a transaction that later threw must be rolled back, not committed").toBeDefined();
    } finally {
      await db?.close();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${safeSchema} CASCADE`);
      await adminPool.end();
    }
  });
});
