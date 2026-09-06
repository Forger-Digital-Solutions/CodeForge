import { describe, expect, it, beforeEach, afterEach, afterAll } from "vitest";
import { createSessionPersistence, SessionPersistence } from "@codeforge/sessions";
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
