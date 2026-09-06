import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createSessionPersistence, type ISessionPersistence, type WorkItem } from "@codeforge/sessions";
import { createForgeGreenLedgerCollector } from "@codeforge/forge-green";

const TEST_PG = process.env.CODEFORGE_TEST_POSTGRES_URL || process.env.DATABASE_URL;

function urlForDatabase(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

// A fixed disposable database, created and dropped by this test, with access scoped through
// the repository-managed pg_hba rule written by scripts/setup-local-pg.mjs (same pattern as
// the CF-17 restart E2E). Fresh databases migrate cleanly with the current checksums.
const E2E_DB_NAME = "fg1_ledger_e2e";
let admin: pg.Client | undefined;
let persistence: ISessionPersistence | undefined;

/**
 * FG-1E against real PostgreSQL: the observational efficiency ledger is durable across the
 * driver boundary, is exactly-once under retry, and a missing ledger can never affect
 * correctness (a cold ledger is indistinguishable from "no efficiency events occurred").
 */
describe.skipIf(!TEST_PG?.startsWith("postgres"))("FG-1 efficiency ledger against real PostgreSQL", () => {
  afterAll(async () => {
    await persistence?.close().catch(() => undefined);
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${E2E_DB_NAME}`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });

  it("persists forgegreen_ledger work items exactly once and replays them after reconnect", async () => {
    admin = new pg.Client({ connectionString: urlForDatabase(TEST_PG!, "postgres") });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${E2E_DB_NAME}`);
    await admin.query(`CREATE DATABASE ${E2E_DB_NAME}`);
    const dbUrl = urlForDatabase(TEST_PG!, E2E_DB_NAME);

    const sessionId = `fg1-pg-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    const ledgerId = `forgegreen-ledger-${runId}`;

    persistence = createSessionPersistence({ driver: "postgres", databaseUrl: dbUrl });
    await persistence.init();

    await persistence.upsertSession({
      id: sessionId,
      title: "fg1 ledger",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "completed",
    });

    const ledger = createForgeGreenLedgerCollector({
      runId,
      operation: "agent_run",
      namespace: "ws-pg",
      sessionId,
      agentId: "coder",
      workstreamScope: "alpha",
    });
    ledger.recordToolCompression(50000, 8000, true);
    ledger.recordProviderPromptCache(4096, 512);
    ledger.recordDuplicateSuppressed();
    ledger.recordCanonicalCacheHit();
    const record = ledger.snapshot();

    const item = {
      kind: "forgegreen_ledger",
      id: ledgerId,
      sessionId,
      runId,
      record: record as unknown as Record<string, unknown>,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as WorkItem;

    const first = await persistence.insertIfAbsent(item);
    const retry = await persistence.insertIfAbsent(item);
    expect(first).toBe(true);
    expect(retry).toBe(false);

    const stored = (await persistence.getWorkItemsByKind("forgegreen_ledger")).filter(
      (entry) => (entry as unknown as { runId?: string }).runId === runId,
    );
    expect(stored).toHaveLength(1);
    const persistedRecord = (stored[0] as unknown as { record: typeof record }).record;
    expect(persistedRecord.totals.bytesAvoidedMeasured).toBe(42000);
    expect(persistedRecord.totals.tokensAvoidedMeasured).toBe(4096);
    expect(persistedRecord.totals.duplicateActionsSuppressed).toBe(1);
    expect(persistedRecord.totals.canonicalCacheHits).toBe(1);
    expect(persistedRecord.identity.workstreamScope).toBe("alpha");

    // Restart path: a fresh persistence instance against the same database replays the ledger.
    await persistence.close();
    const reopened = createSessionPersistence({ driver: "postgres", databaseUrl: dbUrl });
    await reopened.init();
    try {
      const replayed = (await reopened.getWorkItemsByKind("forgegreen_ledger")).filter(
        (entry) => (entry as unknown as { runId?: string }).runId === runId,
      );
      expect(replayed).toHaveLength(1);
      // Missing ledger work item = cold ledger = correctness unaffected.
      expect(await reopened.getWorkItem("forgegreen-ledger-never-existed")).toBeUndefined();
    } finally {
      await reopened.close();
    }
  });
});
