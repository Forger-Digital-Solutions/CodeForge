import { describe, expect, it, beforeEach, afterEach, afterAll } from "vitest";
import { createSessionPersistence, isWorkItem, openSqliteDatabase, SessionPersistence } from "@codeforge/sessions";
import type { SessionRecord, TurnRecord, WorkItem } from "@codeforge/sessions";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDbDir = join(tmpdir(), "codeforge-test-" + Date.now());

function ensureTestDir(): void {
  if (!existsSync(testDbDir)) {
    mkdirSync(testDbDir, { recursive: true });
  }
}

function getTestDbPath(name: string): string {
  ensureTestDir();
  return join(testDbDir, `${name}.db`);
}

function cleanupTestDir(): void {
  if (existsSync(testDbDir)) {
    rmSync(testDbDir, { recursive: true, force: true });
  }
}

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "sess-1",
    title: "Test Session",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
    ...overrides,
  };
}

function makeTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id: "turn-1",
    sessionId: "sess-1",
    seq: 0,
    userMessage: "Hello",
    status: "running",
    ...overrides,
  };
}

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    kind: "activity",
    id: "wi-1",
    sessionId: "sess-1",
    title: "Test Activity",
    status: "started",
    startedAt: new Date().toISOString(),
    ...overrides,
  } as WorkItem;
}

describe("SessionPersistence", () => {
  let db: SessionPersistence | null = null;
  let dbPath: string;

  beforeEach(() => {
    dbPath = getTestDbPath(`test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    db = createSessionPersistence({ dbPath });
  });

  afterEach(async () => {
    if (db) {
      await db.close();
      db = null;
    }
    SessionPersistence.deleteDatabase(dbPath);
  });

  afterAll(() => {
    cleanupTestDir();
  });

  it("creates and retrieves a session", async () => {
    const session = makeSession();
    await db!.upsertSession(session);

    const retrieved = await db!.getSession("sess-1");
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe("sess-1");
    expect(retrieved!.title).toBe("Test Session");
    expect(retrieved!.status).toBe("running");
  });

  it("updates existing session on upsert", async () => {
    await db!.upsertSession(makeSession());
    await db!.upsertSession(makeSession({ title: "Updated", status: "completed" }));

    const retrieved = await db!.getSession("sess-1");
    expect(retrieved!.title).toBe("Updated");
    expect(retrieved!.status).toBe("completed");
  });

  it("lists sessions ordered by updatedAt", async () => {
    await db!.upsertSession(makeSession({ id: "s1", updatedAt: "2026-01-01T00:00:00Z" }));
    await db!.upsertSession(makeSession({ id: "s2", updatedAt: "2026-01-02T00:00:00Z" }));

    const sessions = await db!.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.id).toBe("s2");
    expect(sessions[1]!.id).toBe("s1");
  });

  it("persists and retrieves turns", async () => {
    await db!.upsertSession(makeSession());
    await db!.upsertTurn(makeTurn());
    await db!.upsertTurn(makeTurn({ id: "turn-2", seq: 1 }));

    const turns = await db!.getTurns("sess-1");
    expect(turns).toHaveLength(2);
    expect(turns[0]!.id).toBe("turn-1");
    expect(turns[1]!.id).toBe("turn-2");
  });

  it("persists and retrieves work items", async () => {
    await db!.upsertSession(makeSession());
    const item = makeWorkItem();
    await db!.upsertWorkItem(item);

    const items = await db!.getWorkItems("sess-1");
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe("wi-1");
    expect(items[0]!.kind).toBe("activity");
  });

  it("persists verification policy and resolution receipts append-only and idempotently across restart", async () => {
    await db!.upsertSession(makeSession());
    const receipt = {
      kind: "verification" as const,
      id: "receipt-1",
      sessionId: "sess-1",
      runId: "run-1",
      recordType: "policy_receipt" as const,
      planId: "receipt-1",
      status: "SUFFICIENT",
      payload: {
        policyVersion: "fg5-verification-policy-1",
        decision: "SUFFICIENT",
        evidenceIds: ["evidence-1"],
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as WorkItem;

    const resReceipt = {
      kind: "verification" as const,
      id: "res-receipt-1",
      sessionId: "sess-1",
      runId: "run-1",
      recordType: "resolution_receipt" as const,
      planId: "res-receipt-1",
      status: "RESOLVED",
      payload: {
        resolverVersion: "fg6-evidence-resolution-1",
        outcome: "RESOLVED",
        dispatchesAvoidedCount: 3,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as WorkItem;

    expect(await db!.insertImmutableWorkItem(receipt)).toBe(true);
    expect(await db!.insertImmutableWorkItem({ ...receipt, status: "FAILED" })).toBe(false);
    expect(await db!.insertImmutableWorkItem(resReceipt)).toBe(true);
    expect(await db!.insertImmutableWorkItem({ ...resReceipt, status: "BLOCKED" })).toBe(false);
    expect((await db!.getWorkItems("sess-1")).find((item) => item.id === "receipt-1")?.status).toBe("SUFFICIENT");
    expect((await db!.getWorkItems("sess-1")).find((item) => item.id === "res-receipt-1")?.status).toBe("RESOLVED");

    await db!.close();
    db = null;
    const reopened = createSessionPersistence({ dbPath });
    expect((await reopened.getWorkItems("sess-1")).find((item) => item.id === "receipt-1")?.status).toBe("SUFFICIENT");
    expect((await reopened.getWorkItems("sess-1")).find((item) => item.id === "res-receipt-1")?.status).toBe("RESOLVED");
    expect(await reopened.insertImmutableWorkItem(receipt)).toBe(false);
    expect(await reopened.insertImmutableWorkItem(resReceipt)).toBe(false);
    await reopened.close();
  });

  it("persists and retrieves events with ordering", async () => {
    await db!.appendEvent({ type: "turn.started", seq: 1, sessionId: "sess-1", timestamp: "2026-01-01T00:00:00Z", payload: {} });
    await db!.appendEvent({ type: "turn.completed", seq: 2, sessionId: "sess-1", timestamp: "2026-01-01T00:00:01Z", payload: {} });

    const events = await db!.getEvents("sess-1");
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("turn.started");
    expect(events[1]!.type).toBe("turn.completed");
  });

  it("supports multiple sessions independently", async () => {
    await db!.upsertSession(makeSession({ id: "s1" }));
    await db!.upsertSession(makeSession({ id: "s2" }));
    await db!.upsertWorkItem(makeWorkItem({ sessionId: "s1" }));
    await db!.upsertWorkItem(makeWorkItem({ sessionId: "s2", id: "wi-2" }));

    expect(await db!.getWorkItems("s1")).toHaveLength(1);
    expect(await db!.getWorkItems("s2")).toHaveLength(1);
  });

  it("survives restart by reopening database file", async () => {
    const sessionData = makeSession({ id: "restart-sess", title: "Restart Test" });
    const turnData = makeTurn({ sessionId: "restart-sess", id: "restart-turn" });
    const workItemData = makeWorkItem({ sessionId: "restart-sess", id: "restart-wi" });

    await db!.upsertSession(sessionData);
    await db!.upsertTurn(turnData);
    await db!.upsertWorkItem(workItemData);
    await db!.appendEvent({ type: "test.event", sessionId: "restart-sess", data: true });
    await db!.close();
    db = null;

    const db2 = createSessionPersistence({ dbPath });

    const session = await db2.getSession("restart-sess");
    expect(session).toBeDefined();
    expect(session!.title).toBe("Restart Test");

    const turns = await db2.getTurns("restart-sess");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.id).toBe("restart-turn");

    const workItems = await db2.getWorkItems("restart-sess");
    expect(workItems).toHaveLength(1);
    expect(workItems[0]!.id).toBe("restart-wi");

    const events = await db2.getEvents("restart-sess");
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("test.event");

    await db2.close();
  });

  it("persists sessions across multiple restart cycles", async () => {
    await db!.upsertSession(makeSession({ id: "cycle-1", title: "Cycle 1" }));
    await db!.close();
    db = null;

    const db2 = createSessionPersistence({ dbPath });
    await db2.upsertSession(makeSession({ id: "cycle-2", title: "Cycle 2" }));
    await db2.close();

    const db3 = createSessionPersistence({ dbPath });
    const sessions = await db3.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.find(s => s.id === "cycle-1")).toBeDefined();
    expect(sessions.find(s => s.id === "cycle-2")).toBeDefined();
    await db3.close();
  });

  it("supports in-memory database for testing", async () => {
    const memDb = createSessionPersistence({ dbPath: ":memory:" });
    await memDb.upsertSession(makeSession({ id: "mem-sess" }));
    expect((await memDb.getSession("mem-sess"))!.id).toBe("mem-sess");
    await memDb.close();
  });

  it("handles concurrent upserts correctly", async () => {
    await db!.upsertSession(makeSession({ id: "concurrent", title: "v1" }));
    await db!.upsertSession(makeSession({ id: "concurrent", title: "v2" }));
    await db!.upsertSession(makeSession({ id: "concurrent", title: "v3" }));

    const session = await db!.getSession("concurrent");
    expect(session!.title).toBe("v3");
  });

  it("returns empty arrays when no data exists", async () => {
    await db!.upsertSession(makeSession());

    expect(await db!.getTurns("sess-1")).toEqual([]);
    expect(await db!.getWorkItems("sess-1")).toEqual([]);
    expect(await db!.getEvents("sess-1")).toEqual([]);
  });

  it("deletes session and cascades to related data", async () => {
    await db!.upsertSession(makeSession({ id: "to-delete" }));
    await db!.upsertTurn(makeTurn({ sessionId: "to-delete" }));
    await db!.upsertWorkItem(makeWorkItem({ sessionId: "to-delete" }));

    await db!.deleteSession("to-delete");

    expect(await db!.getSession("to-delete")).toBeUndefined();
    expect(await db!.getTurns("to-delete")).toEqual([]);
    expect(await db!.getWorkItems("to-delete")).toEqual([]);
  });

  it("parses and round-trips the four R55 work-item kinds across restart, with no raw credential", async () => {
    const now = new Date().toISOString();
    const items = [
      {
        kind: "forgeauto_roster",
        id: "forgeauto-roster-owner",
        ownerUserId: "alice",
        entitlement: "CUSTOM",
        slots: [{ kind: "AUTO", sourceClass: "USER_API", enabled: true }],
        lead: { mode: "NONE" },
        updatedAt: now,
      },
      {
        kind: "paid_family_catalog",
        id: "paid-family-catalog",
        versions: [{ family: "luna", version: "5.6" }],
      },
      {
        kind: "shilling_entry",
        id: "shilling:r55",
        entry: { id: "r55", sourceClass: "USER_API", userProviderSpendUsd: 0.00002, costConfidence: "OBSERVED" },
      },
      {
        kind: "user_intelligence_source",
        id: "user-intelligence-source-hash",
        ownerUserId: "alice",
        // Credential material is never persisted — only the deterministic ref.
        source: { sourceId: "s1", ownerUserId: "alice", credentialRef: "user-api-credential:0123456789abcdef01234567", modelId: "m1" },
        createdAt: now,
        updatedAt: now,
      },
      // R55 wave 2: managed-paid accounting + routing decision receipts. Money travels as
      // integer USD micros; receipts carry evidence identity only.
      {
        kind: "managed_paid_account",
        id: "managed-paid-account-alice",
        ownerUserId: "alice",
        consumedUsdMicros: 1_500,
        reservedUsdMicros: 500,
        updatedAt: now,
      },
      {
        kind: "managed_paid_reservation",
        id: "managed-paid-reservation-alice",
        reservation: {
          ownerUserId: "alice", requestId: "req-1", taskId: "task-1", role: "CODER",
          providerId: "openai", modelId: "gpt-5.6-luna", estimatedUsdMicros: 2_000,
          chargedUsdMicros: null, actualUsdMicros: null, status: "OPEN",
          priceSource: "https://developers.openai.com/pricing", createdAt: now, updatedAt: now,
        },
      },
      {
        kind: "managed_paid_receipt",
        id: "managed-paid-receipt-alice",
        receipt: {
          ownerUserId: "alice", requestId: "req-1", taskId: "task-1", role: "CODER",
          providerId: "openai", modelId: "gpt-5.6-luna", estimatedUsdMicros: 2_000,
          actualUsdMicros: 1_500, chargedUsdMicros: 1_500, confidence: "OBSERVED",
          priceSource: "https://developers.openai.com/pricing", recordedAt: now,
        },
      },
      {
        kind: "forgeauto_decision_receipt",
        id: "forgeauto-decision-1",
        decision: {
          runId: "run-1", ownerUserId: "alice", rosterUpdatedAt: now, role: "CODER",
          candidates: [{ modelId: "m1", providerId: "p1", providerModelId: "pm1", familyId: "f1", version: "v1", sourceClass: "USER_API", lifecycle: "ACTIVE" }],
          selected: { providerId: "p1", modelId: "pm1" }, reasonCodes: ["ROSTER_USER_API_EXPLICIT"], recordedAt: now,
        },
        recordedAt: now,
      },
    ];

    for (const item of items) {
      expect(isWorkItem(item)).toBe(true);
      await db!.upsertWorkItem(item as WorkItem);
    }

    await db!.close();
    db = null;
    const reopened = createSessionPersistence({ dbPath });
    for (const kind of ["forgeauto_roster", "paid_family_catalog", "shilling_entry", "user_intelligence_source", "managed_paid_account", "managed_paid_reservation", "managed_paid_receipt", "forgeauto_decision_receipt"]) {
      const stored = await reopened.getWorkItemsByKind(kind);
      expect(stored).toHaveLength(1);
      expect(isWorkItem(stored[0])).toBe(true);
      expect(JSON.stringify(stored[0])).not.toContain("sk-secret");
      expect(JSON.stringify(stored[0])).not.toContain("apiKey");
    }
    await reopened.close();
  });

  it("opens a pre-R55 database with no migration — R55 adds work-item kinds only", async () => {
    // R55 changed no DDL: the physical store is still the generic work_items(id,
    // sessionId, kind, data) table written by pre-R55 builds — there is no version
    // table or migration id. This fixture recreates that physical schema by hand and
    // seeds pre-R55 rows (a session plus a legacy "activity" work item) with raw SQL.
    const now = new Date().toISOString();
    await db!.close();
    db = null;
    SessionPersistence.deleteDatabase(dbPath);

    const raw = openSqliteDatabase(dbPath);
    try {
      // The full physical DDL a pre-R55 build writes — identical to today's schema,
      // because R55 introduced no DDL change at all.
      raw.db.exec(`
        CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, status TEXT NOT NULL, currentAgentId TEXT, currentModelId TEXT, currentProviderId TEXT, permissionMode TEXT, planMode TEXT, displayMode TEXT, branch TEXT, workspacePath TEXT, taskTitle TEXT, outcome TEXT);
        CREATE TABLE turns (id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, seq INTEGER NOT NULL, userMessage TEXT NOT NULL, status TEXT NOT NULL, agentId TEXT, startedAt TEXT, completedAt TEXT, error TEXT, FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE);
        CREATE TABLE work_items (id TEXT PRIMARY KEY, sessionId TEXT, kind TEXT NOT NULL, data TEXT NOT NULL, FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE);
        CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, sessionId TEXT NOT NULL, data TEXT NOT NULL, createdAt TEXT NOT NULL);
      `);
      raw.db.prepare("INSERT INTO sessions (id, title, createdAt, updatedAt, status) VALUES ($id, $title, $createdAt, $updatedAt, $status)")
        .run({ $id: "sess-1", $title: "Pre-R55 Session", $createdAt: now, $updatedAt: now, $status: "running" });
      raw.db.prepare("INSERT INTO work_items (id, sessionId, kind, data) VALUES ($id, $sessionId, $kind, $data)")
        .run({
          $id: "legacy-wi-1", $sessionId: "sess-1", $kind: "activity",
          $data: JSON.stringify({ kind: "activity", id: "legacy-wi-1", sessionId: "sess-1", title: "Pre-R55 Activity", status: "done" }),
        });
    } finally {
      raw.db.close();
    }

    // Reopening through the current persistence layer leaves prior data untouched and
    // accepts the R55 kinds into the same generic table — no migration ran.
    const reopened = createSessionPersistence({ dbPath });
    try {
      expect((await reopened.getSession("sess-1"))!.title).toBe("Pre-R55 Session");
      const legacy = await reopened.getWorkItemsByKind("activity");
      expect(legacy).toHaveLength(1);
      expect((legacy[0] as unknown as { title: string }).title).toBe("Pre-R55 Activity");

      await reopened.upsertWorkItem({
        kind: "forgeauto_roster", id: "r55-roster", ownerUserId: "alice",
        entitlement: "CUSTOM", slots: [{ kind: "AUTO", sourceClass: "USER_API", enabled: true }],
        lead: { mode: "NONE" }, updatedAt: now,
      } as WorkItem);
      await reopened.upsertWorkItem({
        kind: "shilling_entry", id: "r55-sh",
        entry: { id: "r55", sourceClass: "MANAGED_PAID", managedSpendUsd: 0.5, costConfidence: "OBSERVED" },
      } as WorkItem);

      expect((await reopened.getWorkItemsByKind("forgeauto_roster"))[0]).toMatchObject({ ownerUserId: "alice" });
      expect((await reopened.getWorkItemsByKind("shilling_entry"))[0]).toMatchObject({ id: "r55-sh" });
      // The pre-R55 row still reads alongside them.
      expect(await reopened.getWorkItemsByKind("activity")).toHaveLength(1);
    } finally {
      await reopened.close();
    }
  });
});

describe("SessionPersistence - dbPath resolution scenarios", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), "codeforge-persistence-scenarios-" + Date.now());
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("Electron packaged app scenario", () => {
    it("should resolve to userData directory (like Electron app.getPath('userData'))", () => {
      const userDataPath = tempDir;
      const dbPath = join(userDataPath, "codeforge.db");
      const persistence = createSessionPersistence({ dbPath });

      expect(persistence.getDbPath()).toBe(dbPath);
      persistence.close();
    });

    it("should create database in nested userData directory structure", () => {
      const nestedPath = join(tempDir, "CodeForge", "data", "codeforge.db");
      const persistence = createSessionPersistence({ dbPath: nestedPath });

      expect(persistence.getDbPath()).toBe(nestedPath);

      // Verify file was created
      expect(existsSync(nestedPath)).toBe(true);
      persistence.close();
    });

    it("should persist across app restarts with same userData path", async () => {
      const userDataPath = join(tempDir, "userData");
      const dbPath = join(userDataPath, "codeforge.db");

      // Simulate first app run
      const persistence1 = createSessionPersistence({ dbPath });
      await persistence1.upsertSession(makeSession({ id: "restart-test", title: "Before restart" }));
      await persistence1.close();

      // Simulate app restart (new instance, same userData)
      const persistence2 = createSessionPersistence({ dbPath });
      const session = await persistence2.getSession("restart-test");
      expect(session).toBeDefined();
      expect(session!.title).toBe("Before restart");
      await persistence2.close();
    });
  });

  describe("Developer mode vs packaged mode path separation", () => {
    it("should support different paths for dev and packaged modes", async () => {
      const devDbPath = join(tempDir, "dev", "codeforge.db");
      const packagedDbPath = join(tempDir, "packaged", "codeforge.db");

      // Dev mode - writes to dev path
      const devPersistence = createSessionPersistence({ dbPath: devDbPath });
      await devPersistence.upsertSession(makeSession({ id: "dev-only" }));
      await devPersistence.close();

      // Packaged mode - writes to packaged path (different)
      const packagedPersistence = createSessionPersistence({ dbPath: packagedDbPath });
      await packagedPersistence.upsertSession(makeSession({ id: "packaged-only" }));
      await packagedPersistence.close();

      // Verify isolation
      const devRead = createSessionPersistence({ dbPath: devDbPath });
      expect(await devRead.getSession("dev-only")).toBeDefined();
      expect(await devRead.getSession("packaged-only")).toBeUndefined();
      await devRead.close();

      const packagedRead = createSessionPersistence({ dbPath: packagedDbPath });
      expect(await packagedRead.getSession("packaged-only")).toBeDefined();
      expect(await packagedRead.getSession("dev-only")).toBeUndefined();
      await packagedRead.close();
    });
  });

  describe("In-memory mode for testing", () => {
    it("provides isolation between test files with :memory:", async () => {
      // Each test gets fresh in-memory DB
      const db1 = createSessionPersistence({ dbPath: ":memory:" });
      await db1.upsertSession(makeSession({ id: "isolated-1" }));
      await db1.close();

      const db2 = createSessionPersistence({ dbPath: ":memory:" });
      expect(await db2.getSession("isolated-1")).toBeUndefined();
      await db2.close();
    });
  });
});
