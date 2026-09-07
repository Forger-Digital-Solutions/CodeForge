import {
  openSqliteDatabase,
  type SQLiteValue,
  type SQLiteDatabase,
  type SQLiteStatement,
  type SqliteDriverName,
} from "./sqlite.js";
import type { SessionRecord, TurnRecord, WorkItem } from "./session-state.js";
import type { ISessionPersistence, SessionPersistenceTx } from "./interface.js";
import { mkdirSync, existsSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { redactSecrets } from "@codeforge/secrets";

export interface PersistenceOptions {
  dbPath?: string;
  driver?: SqliteDriverName | "auto";
}

interface StoredSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  currentAgentId: string | null;
  currentModelId: string | null;
  currentProviderId: string | null;
  permissionMode: string | null;
  displayMode: string | null;
  branch: string | null;
  workspacePath: string | null;
  taskTitle: string | null;
}

interface StoredTurn {
  id: string;
  sessionId: string;
  seq: number;
  userMessage: string;
  status: string;
  agentId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

interface StoredWorkItem {
  id: string;
  sessionId: string;
  kind: string;
  data: string;
}

interface StoredEvent {
  id: number;
  sessionId: string;
  data: string;
  createdAt: string;
}

function sanitizeForPersistence<T>(value: T): T {
  return JSON.parse(redactSecrets(JSON.stringify(value))) as T;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  status TEXT NOT NULL,
  currentAgentId TEXT,
  currentModelId TEXT,
  currentProviderId TEXT,
  permissionMode TEXT,
  displayMode TEXT,
  branch TEXT,
  workspacePath TEXT,
  taskTitle TEXT
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL,
  seq INTEGER NOT NULL,
  userMessage TEXT NOT NULL,
  status TEXT NOT NULL,
  agentId TEXT,
  startedAt TEXT,
  completedAt TEXT,
  error TEXT,
  FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_turns_sessionId ON turns(sessionId);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  sessionId TEXT,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_work_items_sessionId ON work_items(sessionId);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId TEXT NOT NULL,
  data TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_sessionId ON events(sessionId);
`;

function parseSession(row: StoredSession): SessionRecord {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: row.status as SessionRecord["status"],
    ...(row.currentAgentId && { currentAgentId: row.currentAgentId }),
    ...(row.currentModelId && { currentModelId: row.currentModelId }),
    ...(row.currentProviderId && { currentProviderId: row.currentProviderId }),
    ...(row.permissionMode && { permissionMode: row.permissionMode as SessionRecord["permissionMode"] }),
    ...(row.displayMode && { displayMode: row.displayMode as SessionRecord["displayMode"] }),
    ...(row.branch && { branch: row.branch }),
    ...(row.workspacePath && { workspacePath: row.workspacePath }),
    ...(row.taskTitle && { taskTitle: row.taskTitle }),
  };
}

function serializeSession(session: SessionRecord): StoredSession {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    status: session.status,
    currentAgentId: session.currentAgentId ?? null,
    currentModelId: session.currentModelId ?? null,
    currentProviderId: session.currentProviderId ?? null,
    permissionMode: session.permissionMode ?? null,
    displayMode: session.displayMode ?? null,
    branch: session.branch ?? null,
    workspacePath: session.workspacePath ?? null,
    taskTitle: session.taskTitle ?? null,
  };
}

function parseTurn(row: StoredTurn): TurnRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    seq: row.seq,
    userMessage: row.userMessage,
    status: row.status as TurnRecord["status"],
    ...(row.agentId && { agentId: row.agentId }),
    ...(row.startedAt && { startedAt: row.startedAt }),
    ...(row.completedAt && { completedAt: row.completedAt }),
    ...(row.error && { error: row.error }),
  };
}

function serializeTurn(turn: TurnRecord): StoredTurn {
  return {
    id: turn.id,
    sessionId: turn.sessionId,
    seq: turn.seq,
    userMessage: turn.userMessage,
    status: turn.status,
    agentId: turn.agentId ?? null,
    startedAt: turn.startedAt ?? null,
    completedAt: turn.completedAt ?? null,
    error: turn.error ?? null,
  };
}

/**
 * SQLite-backed implementation of {@link ISessionPersistence}. Every method body below is
 * synchronous under the hood (a single blocking better-sqlite3/node:sqlite call) — identical
 * behavior to the pre-CF-17R5 implementation — but wrapped in `async` so callers use one
 * driver-neutral awaited contract regardless of whether SQLite or PostgreSQL backs a given
 * server process. This mirrors @codeforge/cloud-db's SQLiteCloudDatabase, whose own doc comment
 * explains the same rationale: nothing actually awaits mid-body, so each call remains atomic.
 */
export class SqliteSessionPersistence implements ISessionPersistence {
  private db: SQLiteDatabase;
  private dbPath: string;
  private driverName: SqliteDriverName;
  private statements: Map<string, SQLiteStatement> = new Map();
  private inTransaction = false;

  constructor(options: PersistenceOptions = {}) {
    this.dbPath = options.dbPath ?? ":memory:";
    const absolutePath = this.dbPath === ":memory:" ? this.dbPath : resolve(this.dbPath);

    if (absolutePath !== ":memory:") {
      const dir = dirname(absolutePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    const opened = openSqliteDatabase(absolutePath, { driver: options.driver ?? "auto" });
    this.db = opened.db;
    this.driverName = opened.driver;
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec(SCHEMA);

      this.statement("upsertSession", `
      INSERT INTO sessions (id, title, createdAt, updatedAt, status, currentAgentId, currentModelId, currentProviderId, permissionMode, displayMode, branch, workspacePath, taskTitle)
      VALUES ($id, $title, $createdAt, $updatedAt, $status, $currentAgentId, $currentModelId, $currentProviderId, $permissionMode, $displayMode, $branch, $workspacePath, $taskTitle)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        updatedAt = excluded.updatedAt,
        status = excluded.status,
        currentAgentId = excluded.currentAgentId,
        currentModelId = excluded.currentModelId,
        currentProviderId = excluded.currentProviderId,
        permissionMode = excluded.permissionMode,
        displayMode = excluded.displayMode,
        branch = excluded.branch,
        workspacePath = excluded.workspacePath,
        taskTitle = excluded.taskTitle
    `);

      this.statement("getSession", "SELECT * FROM sessions WHERE id = $id");
      this.statement("listSessions", "SELECT * FROM sessions ORDER BY updatedAt DESC");
      this.statement("deleteSession", "DELETE FROM sessions WHERE id = $id");

      this.statement("upsertTurn", `
      INSERT INTO turns (id, sessionId, seq, userMessage, status, agentId, startedAt, completedAt, error)
      VALUES ($id, $sessionId, $seq, $userMessage, $status, $agentId, $startedAt, $completedAt, $error)
      ON CONFLICT(id) DO UPDATE SET
        seq = excluded.seq,
        userMessage = excluded.userMessage,
        status = excluded.status,
        agentId = excluded.agentId,
        startedAt = excluded.startedAt,
        completedAt = excluded.completedAt,
        error = excluded.error
    `);
      this.statement("getTurns", "SELECT * FROM turns WHERE sessionId = $sessionId ORDER BY seq ASC");
      this.statement("getTurn", "SELECT * FROM turns WHERE id = $id");

      this.statement("upsertWorkItem", `
      INSERT INTO work_items (id, sessionId, kind, data)
      VALUES ($id, $sessionId, $kind, $data)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        data = excluded.data
    `);
      this.statement("insertImmutableWorkItem", `
      INSERT INTO work_items (id, sessionId, kind, data)
      VALUES ($id, $sessionId, $kind, $data)
      ON CONFLICT(id) DO NOTHING
    `);
      this.statement("insertIfAbsent", `
      INSERT INTO work_items (id, sessionId, kind, data)
      VALUES ($id, $sessionId, $kind, $data)
      ON CONFLICT(id) DO NOTHING
    `);
      this.statement("getWorkItems", "SELECT * FROM work_items WHERE sessionId = $sessionId");
      this.statement("getWorkItem", "SELECT * FROM work_items WHERE id = $id");
      this.statement("getWorkItemsByKind", "SELECT * FROM work_items WHERE kind = $kind");
      this.statement("getAllWorkItems", "SELECT * FROM work_items");

      this.statement("appendEvent", `
      INSERT INTO events (sessionId, data, createdAt)
      VALUES ($sessionId, $data, $createdAt)
    `);
      this.statement("getEvents", "SELECT * FROM events WHERE sessionId = $sessionId ORDER BY id ASC");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /** No-op: the SQLite schema is already created synchronously by the constructor. */
  async init(): Promise<void> {}

  private statement(name: string, sql: string): SQLiteStatement {
    const stmt = this.db.prepare(sql);
    this.statements.set(name, stmt);
    return stmt;
  }

  private run(name: string, params: Record<string, SQLiteValue>): void {
    this.statements.get(name)!.run(params);
  }

  private get<T>(name: string, params: Record<string, SQLiteValue>): T | undefined {
    return this.statements.get(name)!.get(params) as T | undefined;
  }

  private all<T>(name: string, params: Record<string, SQLiteValue> = {}): T[] {
    return this.statements.get(name)!.all(params) as T[];
  }

  async upsertSession(session: SessionRecord): Promise<void> {
    const safeSession = sanitizeForPersistence(session);
    this.run("upsertSession", {
      $id: safeSession.id,
      $title: safeSession.title,
      $createdAt: safeSession.createdAt,
      $updatedAt: safeSession.updatedAt,
      $status: safeSession.status,
      $currentAgentId: safeSession.currentAgentId ?? null,
      $currentModelId: safeSession.currentModelId ?? null,
      $currentProviderId: safeSession.currentProviderId ?? null,
      $permissionMode: safeSession.permissionMode ?? null,
      $displayMode: safeSession.displayMode ?? null,
      $branch: safeSession.branch ?? null,
      $workspacePath: safeSession.workspacePath ?? null,
      $taskTitle: safeSession.taskTitle ?? null,
    });
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const row = this.get<StoredSession>("getSession", { $id: id });
    return row ? parseSession(row) : undefined;
  }

  async listSessions(): Promise<SessionRecord[]> {
    const rows = this.all<StoredSession>("listSessions", {});
    return rows.map(parseSession);
  }

  async deleteSession(id: string): Promise<void> {
    this.run("deleteSession", { $id: id });
  }

  async upsertTurn(turn: TurnRecord): Promise<void> {
    const safeTurn = sanitizeForPersistence(turn);
    this.run("upsertTurn", {
      $id: safeTurn.id,
      $sessionId: safeTurn.sessionId,
      $seq: safeTurn.seq,
      $userMessage: safeTurn.userMessage,
      $status: safeTurn.status,
      $agentId: safeTurn.agentId ?? null,
      $startedAt: safeTurn.startedAt ?? null,
      $completedAt: safeTurn.completedAt ?? null,
      $error: safeTurn.error ?? null,
    });
  }

  async getTurns(sessionId: string): Promise<TurnRecord[]> {
    const rows = this.all<StoredTurn>("getTurns", { $sessionId: sessionId });
    return rows.map(parseTurn);
  }

  async getTurn(id: string): Promise<TurnRecord | undefined> {
    const row = this.get<StoredTurn>("getTurn", { $id: id });
    return row ? parseTurn(row) : undefined;
  }

  async upsertWorkItem(item: WorkItem): Promise<void> {
    const safeItem = sanitizeForPersistence(item);
    this.run("upsertWorkItem", {
      $id: safeItem.id,
      $sessionId: safeItem.sessionId ?? null,
      $kind: safeItem.kind,
      $data: JSON.stringify(safeItem),
    });
  }

  /** Terminal audit records are append-only; duplicate persistence is idempotent rather than mutable. */
  async insertImmutableWorkItem(item: WorkItem): Promise<boolean> {
    if (item.kind !== "verification" || (item.recordType !== "plan" && item.recordType !== "evidence" && item.recordType !== "policy_receipt" && item.recordType !== "resolution_receipt")) {
      throw new Error("Only immutable ForgeVerify plan, evidence, policy receipt, or resolution receipt records may use append-only persistence.");
    }
    const safeItem = sanitizeForPersistence(item);
    const result = this.statements.get("insertImmutableWorkItem")!.run({
      $id: safeItem.id,
      $sessionId: safeItem.sessionId,
      $kind: safeItem.kind,
      $data: JSON.stringify(safeItem),
    });
    return Number(result.changes) === 1;
  }

  async insertIfAbsent(item: WorkItem): Promise<boolean> {
    const safeItem = sanitizeForPersistence(item);
    const result = this.statements.get("insertIfAbsent")!.run({
      $id: safeItem.id,
      $sessionId: safeItem.sessionId ?? null,
      $kind: safeItem.kind,
      $data: JSON.stringify(safeItem),
    });
    return Number(result.changes) === 1;
  }

  async getWorkItems(sessionId: string): Promise<WorkItem[]> {
    const rows = this.all<StoredWorkItem>("getWorkItems", { $sessionId: sessionId });
    return rows.map((row) => JSON.parse(row.data) as WorkItem);
  }

  async getWorkItem(id: string): Promise<WorkItem | undefined> {
    const row = this.get<StoredWorkItem>("getWorkItem", { $id: id });
    return row ? (JSON.parse(row.data) as WorkItem) : undefined;
  }

  async getWorkItemsByKind(kind: string): Promise<WorkItem[]> {
    const rows = this.all<StoredWorkItem>("getWorkItemsByKind", { $kind: kind });
    return rows.map((row) => JSON.parse(row.data) as WorkItem);
  }

  async getAllWorkItems(): Promise<WorkItem[]> {
    const rows = this.all<StoredWorkItem>("getAllWorkItems", {});
    return rows.map((row) => JSON.parse(row.data) as WorkItem);
  }

  async appendEvent(event: unknown): Promise<void> {
    const safeEvent = sanitizeForPersistence(event) as { sessionId?: string };
    this.run("appendEvent", {
      $sessionId: safeEvent.sessionId ?? "",
      $data: JSON.stringify(safeEvent),
      $createdAt: new Date().toISOString(),
    });
  }

  async getEvents(sessionId: string): Promise<unknown[]> {
    const rows = this.all<StoredEvent>("getEvents", { $sessionId: sessionId });
    return rows.map((row) => JSON.parse(row.data));
  }

  /**
   * better-sqlite3/node:sqlite hold exactly one connection, so a transaction is simply BEGIN/COMMIT
   * bracketing calls made through `this` on that same connection — no separate connection handle is
   * needed the way PostgreSQL requires one. Nesting is rejected rather than silently flattened so a
   * caller cannot mistake an inner scope for an independent atomic unit.
   */
  async withTransaction<T>(fn: (tx: SessionPersistenceTx) => Promise<T>): Promise<T> {
    if (this.inTransaction) {
      throw new Error("SqliteSessionPersistence.withTransaction does not support nesting.");
    }
    this.inTransaction = true;
    this.db.exec("BEGIN");
    try {
      const result = await fn(this);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Best-effort: if COMMIT already partially applied there is nothing further to roll back.
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }

  getDbPath(): string {
    return this.dbPath;
  }

  getDriver(): SqliteDriverName {
    return this.driverName;
  }

  async clearAll(): Promise<void> {
    this.db.exec("DELETE FROM events");
    this.db.exec("DELETE FROM work_items");
    this.db.exec("DELETE FROM turns");
    this.db.exec("DELETE FROM sessions");
  }

  static deleteDatabase(dbPath: string): void {
    const absolutePath = resolve(dbPath);
    if (existsSync(absolutePath)) {
      unlinkSync(absolutePath);
    }
    const walPath = absolutePath + "-wal";
    const shmPath = absolutePath + "-shm";
    if (existsSync(walPath)) unlinkSync(walPath);
    if (existsSync(shmPath)) unlinkSync(shmPath);
  }
}

/** @deprecated Use {@link SqliteSessionPersistence} or the driver-neutral {@link ISessionPersistence} type. */
export const SessionPersistence = SqliteSessionPersistence;

export function createSqliteSessionPersistence(options?: PersistenceOptions): SqliteSessionPersistence {
  return new SqliteSessionPersistence(options);
}
