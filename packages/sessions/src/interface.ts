// The canonical, driver-neutral contract for CodeForge's session/runtime persistence.
//
// There is exactly ONE contract. Both the SQLite-backed implementation and the
// PostgreSQL-backed implementation satisfy this same async surface, so callers
// never branch on which durable backend is active. This mirrors the design of
// @codeforge/cloud-db's ICloudDatabase: SQLite's method bodies stay synchronous
// under the hood (a single blocking native call per statement, exactly like
// better-sqlite3 already behaves today) but are wrapped in `async` so a real,
// network-bound PostgreSQL implementation can share the same call sites.
import type { SessionRecord, TurnRecord, WorkItem } from "./session-state.js";

/**
 * The subset of the persistence surface usable inside `withTransaction`. Lifecycle
 * methods (`close`, driver introspection, `clearAll`, nested transactions) are
 * intentionally excluded — a transaction callback should only read/write records.
 */
export interface SessionPersistenceTx {
  upsertSession(session: SessionRecord): Promise<void>;
  getSession(id: string): Promise<SessionRecord | undefined>;
  listSessions(): Promise<SessionRecord[]>;
  deleteSession(id: string): Promise<void>;
  /** events has no FK/cascade back to sessions (unlike turns and work_items) — deleteSession()
   *  alone leaves it orphaned. Callers that need a session's data fully gone (e.g. GDPR account
   *  erasure) must call this explicitly, ideally in the same withTransaction as deleteSession. */
  deleteEventsForSession(sessionId: string): Promise<void>;

  upsertTurn(turn: TurnRecord): Promise<void>;
  getTurns(sessionId: string): Promise<TurnRecord[]>;
  getTurn(id: string): Promise<TurnRecord | undefined>;

  upsertWorkItem(item: WorkItem): Promise<void>;
  insertImmutableWorkItem(item: WorkItem): Promise<boolean>;
  /**
   * Append-only insert-if-absent for ANY work item kind (not just ForgeVerify plan/evidence).
   * Returns true iff this call performed the insert (a genuinely new id), false iff a row with
   * this id already existed (a duplicate delivery). Backed by the `work_items.id` primary-key
   * uniqueness constraint on both drivers — this is the durable idempotency mechanism for public
   * steer submission (CF-17R5 §12): a retried steerId must never create a second logical steer,
   * and that guarantee must not depend solely on an in-memory map.
   */
  insertIfAbsent(item: WorkItem): Promise<boolean>;
  getWorkItems(sessionId: string): Promise<WorkItem[]>;
  getWorkItem(id: string): Promise<WorkItem | undefined>;
  getWorkItemsByKind(kind: string): Promise<WorkItem[]>;
  getAllWorkItems(): Promise<WorkItem[]>;
  lockWorkItem(id: string): Promise<void>;

  appendEvent(event: unknown): Promise<void>;
  getEvents(sessionId: string): Promise<unknown[]>;
}

/**
 * The full driver-neutral persistence contract. `SqliteSessionPersistence` and
 * `PostgresSessionPersistence` both implement this; `createSessionPersistence`
 * returns one or the other based on configuration.
 */
export interface ISessionPersistence extends SessionPersistenceTx {
  /**
   * Runs `fn` inside one durable transaction. All writes performed through the
   * `tx` handle either all become visible or none do — used for compound
   * transitions where CF-17 requires atomicity (e.g. "steer consumed" must never
   * be observed without the plan revision it produced; "terminal" must never be
   * observed with a queued steer still live).
   */
  withTransaction<T>(fn: (tx: SessionPersistenceTx) => Promise<T>): Promise<T>;

  /**
   * Must be awaited once before first use. A no-op for SQLite (schema is created synchronously by
   * the constructor, as before); for PostgreSQL this runs migrations under an advisory lock so
   * concurrent server processes booting against a brand-new database never race each other.
   */
  init(): Promise<void>;

  close(): Promise<void>;
  getDriver(): string;
  clearAll(): Promise<void>;
}
