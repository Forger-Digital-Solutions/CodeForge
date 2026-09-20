import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSessionPersistence, PostgresSessionPersistence, SessionPersistence } from "../src/index.js";
import type { ISessionPersistence, WorkItem } from "../src/index.js";

/**
 * R21: terminal ForgeVerify records are immutable at the STORAGE layer, not just at the API
 * layer. `insertImmutableWorkItem` was already append-only, but the generic `upsertWorkItem`
 * shares the same table and could overwrite an evidence row — flipping a failed verifier to
 * passed in place. A BEFORE UPDATE trigger (SQLite schema / PostgreSQL migration 4) now refuses
 * any content change to plan, evidence and receipt rows, while attempt rows (running → terminal)
 * stay mutable and identical re-writes stay idempotent.
 */

const TEST_DIR = join(tmpdir(), "codeforge-r21-immutability");
const TEST_PG = process.env.CODEFORGE_TEST_POSTGRES_URL || process.env.DATABASE_URL;

function dbPath(): string {
  if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  return join(TEST_DIR, `r21-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function evidenceItem(sessionId: string, id: string, status: "failed" | "passed"): WorkItem {
  const now = new Date().toISOString();
  return {
    kind: "verification",
    id,
    sessionId,
    runId: "run-1",
    recordType: "evidence",
    planId: "plan-1",
    verifierId: "test",
    status,
    payload: { evidenceId: id, verifierId: "test", status, exitCode: status === "passed" ? 0 : 1, inputStateHash: "abc", evidenceHash: "deadbeef" },
    createdAt: now,
    updatedAt: now,
  } as WorkItem;
}

function attemptItem(sessionId: string, id: string, status: "running" | "passed"): WorkItem {
  const now = new Date().toISOString();
  return { kind: "verification", id, sessionId, runId: "run-1", recordType: "attempt", planId: "plan-1", verifierId: "test", status, payload: { attemptId: id, status }, createdAt: now, updatedAt: now } as WorkItem;
}

async function exercise(db: ISessionPersistence, sessionId: string): Promise<void> {
  await db.upsertSession({ id: sessionId, title: "r21", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });

  // A failed evidence record is persisted through the append-only path.
  const failed = evidenceItem(sessionId, `${sessionId}-ev-1`, "failed");
  expect(await db.insertImmutableWorkItem(failed)).toBe(true);

  // 1. The generic upsert must NOT be able to rewrite it into a pass.
  const forged = evidenceItem(sessionId, `${sessionId}-ev-1`, "passed");
  await expect(db.upsertWorkItem(forged)).rejects.toThrow(/FORGEVERIFY_RECORD_IMMUTABLE/);
  const stored = await db.getWorkItem(`${sessionId}-ev-1`);
  expect(stored?.status).toBe("failed");
  expect((stored as { payload?: { status?: string } })?.payload?.status).toBe("failed");

  // 2. An identical re-write is idempotent, not an error (restart replay safety).
  await expect(db.upsertWorkItem(await db.getWorkItem(`${sessionId}-ev-1`) as WorkItem)).resolves.toBeUndefined();

  // 3. The append-only path still refuses to replace it silently.
  expect(await db.insertImmutableWorkItem(forged)).toBe(false);
  expect((await db.getWorkItem(`${sessionId}-ev-1`))?.status).toBe("failed");

  // 4. Attempt records remain mutable: running → terminal is the legitimate lifecycle.
  await db.upsertWorkItem(attemptItem(sessionId, `${sessionId}-at-1`, "running"));
  await db.upsertWorkItem(attemptItem(sessionId, `${sessionId}-at-1`, "passed"));
  expect((await db.getWorkItem(`${sessionId}-at-1`))?.status).toBe("passed");

  // 5. Plans and receipts are protected the same way.
  const plan = { ...evidenceItem(sessionId, `${sessionId}-plan-1`, "passed"), recordType: "plan", planId: `${sessionId}-plan-1`, payload: { planId: `${sessionId}-plan-1`, inputStateHash: "abc" } } as WorkItem;
  expect(await db.insertImmutableWorkItem(plan)).toBe(true);
  await expect(db.upsertWorkItem({ ...plan, payload: { planId: `${sessionId}-plan-1`, inputStateHash: "zzz" } } as WorkItem)).rejects.toThrow(/FORGEVERIFY_RECORD_IMMUTABLE/);
}

describe("R21 ForgeVerify record immutability — SQLite", () => {
  let db: SessionPersistence | null = null;
  let file = "";
  afterEach(async () => {
    if (db) { await db.close(); db = null; }
    if (file) SessionPersistence.deleteDatabase(file);
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("refuses to overwrite terminal ForgeVerify records through the generic upsert", async () => {
    file = dbPath();
    db = createSessionPersistence({ dbPath: file });
    await exercise(db, "sess-r21-sqlite");
  });

  it("keeps the protection after reopening the database (schema is idempotent)", async () => {
    file = dbPath();
    db = createSessionPersistence({ dbPath: file });
    await db.upsertSession({ id: "sess-reopen", title: "r21", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });
    expect(await db.insertImmutableWorkItem(evidenceItem("sess-reopen", "ev-reopen", "failed"))).toBe(true);
    await db.close();
    db = createSessionPersistence({ dbPath: file });
    await expect(db.upsertWorkItem(evidenceItem("sess-reopen", "ev-reopen", "passed"))).rejects.toThrow(/FORGEVERIFY_RECORD_IMMUTABLE/);
    expect((await db.getWorkItem("ev-reopen"))?.status).toBe("failed");
  });
});

describe.skipIf(!TEST_PG)("R21 ForgeVerify record immutability — real PostgreSQL", () => {
  it("refuses to overwrite terminal ForgeVerify records through the generic upsert (migration 4 trigger)", async () => {
    const db = new PostgresSessionPersistence({ connectionString: TEST_PG! });
    try {
      await db.init();
      await exercise(db, `sess-r21-pg-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    } finally {
      await db.close();
    }
  }, 30_000);
});
