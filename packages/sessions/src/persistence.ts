import {
  openSqliteDatabase,
  type SQLiteValue,
  type SQLiteDatabase,
  type SQLiteStatement,
  type SqliteDriverName,
} from "./sqlite.js";
import type { SessionRecord, TurnRecord, WorkItem } from "./session-state.js";
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
  sessionId TEXT NOT NULL,
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

export class SessionPersistence {
  private db: SQLiteDatabase;
  private dbPath: string;
  private driverName: SqliteDriverName;
  private statements: Map<string, SQLiteStatement> = new Map();

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

      this.statement("upsertWorkItem", `
      INSERT INTO work_items (id, sessionId, kind, data)
      VALUES ($id, $sessionId, $kind, $data)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        data = excluded.data
    `);
      this.statement("getWorkItems", "SELECT * FROM work_items WHERE sessionId = $sessionId");

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

  upsertSession(session: SessionRecord): void {
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

  getSession(id: string): SessionRecord | undefined {
    const row = this.get<StoredSession>("getSession", { $id: id });
    return row ? parseSession(row) : undefined;
  }

  listSessions(): SessionRecord[] {
    const rows = this.all<StoredSession>("listSessions", {});
    return rows.map(parseSession);
  }

  deleteSession(id: string): void {
    this.run("deleteSession", { $id: id });
  }

  upsertTurn(turn: TurnRecord): void {
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

  getTurns(sessionId: string): TurnRecord[] {
    const rows = this.all<StoredTurn>("getTurns", { $sessionId: sessionId });
    return rows.map(parseTurn);
  }

  upsertWorkItem(item: WorkItem): void {
    const safeItem = sanitizeForPersistence(item);
    this.run("upsertWorkItem", {
      $id: safeItem.id,
      $sessionId: safeItem.sessionId,
      $kind: safeItem.kind,
      $data: JSON.stringify(safeItem),
    });
  }

  getWorkItems(sessionId: string): WorkItem[] {
    const rows = this.all<StoredWorkItem>("getWorkItems", { $sessionId: sessionId });
    return rows.map((row) => JSON.parse(row.data) as WorkItem);
  }

  appendEvent(event: unknown): void {
    const safeEvent = sanitizeForPersistence(event) as { sessionId?: string };
    this.run("appendEvent", {
      $sessionId: safeEvent.sessionId ?? "",
      $data: JSON.stringify(safeEvent),
      $createdAt: new Date().toISOString(),
    });
  }

  getEvents(sessionId: string): unknown[] {
    const rows = this.all<StoredEvent>("getEvents", { $sessionId: sessionId });
    return rows.map((row) => JSON.parse(row.data));
  }

  close(): void {
    this.db.close();
  }

  getDbPath(): string {
    return this.dbPath;
  }

  getDriver(): SqliteDriverName {
    return this.driverName;
  }

  clearAll(): void {
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

export function createSessionPersistence(options?: PersistenceOptions): SessionPersistence {
  return new SessionPersistence(options);
}
