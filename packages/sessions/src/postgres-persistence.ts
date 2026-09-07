import pg from "pg";
import { redactSecrets } from "@codeforge/secrets";
import type { SessionRecord, TurnRecord, WorkItem } from "./session-state.js";
import type { ISessionPersistence, SessionPersistenceTx } from "./interface.js";
import { SESSIONS_MIGRATIONS } from "./postgres-migrations.js";

const { Pool } = pg;

// Distinct from @codeforge/cloud-db's advisory lock constants so the two migration systems can
// never collide even if a deployment ever pointed both at the same physical PostgreSQL cluster.
const MIGRATION_LOCK_NAMESPACE = 2_045_909_113;
const MIGRATION_LOCK_KEY = 771_034_889;

// Namespaced migration-history table for this package. Earlier builds of both
// @codeforge/sessions and @codeforge/cloud-db tracked migrations in an identically named
// `schema_migrations` table — harmless in normal deployment topology (each service has its own
// physical database) but a real collision when both are pointed at one shared database (e.g. a
// local test database used by both suites). See adoptLegacyMigrationsTableIfOwned below for the
// backward-compatible upgrade path for a database that already has the legacy table.
const MIGRATIONS_TABLE = "sessions_schema_migrations";
const LEGACY_MIGRATIONS_TABLE = "schema_migrations";

export interface PostgresPersistenceOptions {
  connectionString?: string;
  ssl?: boolean;
  pool?: pg.Pool;
}

function sanitizeForPersistence<T>(value: T): T {
  return JSON.parse(redactSecrets(JSON.stringify(value))) as T;
}

interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

interface SessionRow {
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

function parseSession(row: SessionRow): SessionRecord {
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

interface TurnRow {
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

function parseTurn(row: TurnRow): TurnRecord {
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

/**
 * Executes the driver-neutral persistence contract against a given `Queryable` (either the pool,
 * for ordinary calls, or one checked-out `PoolClient`, for calls made inside `withTransaction`).
 * Factoring the SQL out of the class this way means `PostgresSessionPersistence` and its
 * transaction handle share one implementation instead of two copies that could drift apart.
 */
class PostgresQueryOps implements SessionPersistenceTx {
  constructor(private readonly q: Queryable) {}

  async upsertSession(session: SessionRecord): Promise<void> {
    const s = sanitizeForPersistence(session);
    await this.q.query(
      `INSERT INTO sessions (id, title, "createdAt", "updatedAt", status, "currentAgentId", "currentModelId", "currentProviderId", "permissionMode", "displayMode", branch, "workspacePath", "taskTitle")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET
         title = excluded.title, "updatedAt" = excluded."updatedAt", status = excluded.status,
         "currentAgentId" = excluded."currentAgentId", "currentModelId" = excluded."currentModelId",
         "currentProviderId" = excluded."currentProviderId", "permissionMode" = excluded."permissionMode",
         "displayMode" = excluded."displayMode", branch = excluded.branch,
         "workspacePath" = excluded."workspacePath", "taskTitle" = excluded."taskTitle"`,
      [
        s.id, s.title, s.createdAt, s.updatedAt, s.status,
        s.currentAgentId ?? null, s.currentModelId ?? null, s.currentProviderId ?? null,
        s.permissionMode ?? null, s.displayMode ?? null, s.branch ?? null, s.workspacePath ?? null, s.taskTitle ?? null,
      ],
    );
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const res = await this.q.query(`SELECT * FROM sessions WHERE id = $1`, [id]);
    return res.rows[0] ? parseSession(res.rows[0]) : undefined;
  }

  async listSessions(): Promise<SessionRecord[]> {
    const res = await this.q.query(`SELECT * FROM sessions ORDER BY "updatedAt" DESC`);
    return res.rows.map(parseSession);
  }

  async deleteSession(id: string): Promise<void> {
    await this.q.query(`DELETE FROM sessions WHERE id = $1`, [id]);
  }

  async upsertTurn(turn: TurnRecord): Promise<void> {
    const t = sanitizeForPersistence(turn);
    await this.q.query(
      `INSERT INTO turns (id, "sessionId", seq, "userMessage", status, "agentId", "startedAt", "completedAt", error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         seq = excluded.seq, "userMessage" = excluded."userMessage", status = excluded.status,
         "agentId" = excluded."agentId", "startedAt" = excluded."startedAt",
         "completedAt" = excluded."completedAt", error = excluded.error`,
      [t.id, t.sessionId, t.seq, t.userMessage, t.status, t.agentId ?? null, t.startedAt ?? null, t.completedAt ?? null, t.error ?? null],
    );
  }

  async getTurns(sessionId: string): Promise<TurnRecord[]> {
    const res = await this.q.query(`SELECT * FROM turns WHERE "sessionId" = $1 ORDER BY seq ASC`, [sessionId]);
    return res.rows.map(parseTurn);
  }

  async getTurn(id: string): Promise<TurnRecord | undefined> {
    const res = await this.q.query(`SELECT * FROM turns WHERE id = $1`, [id]);
    return res.rows[0] ? parseTurn(res.rows[0]) : undefined;
  }

  async upsertWorkItem(item: WorkItem): Promise<void> {
    const safe = sanitizeForPersistence(item);
    await this.q.query(
      `INSERT INTO work_items (id, "sessionId", kind, data) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, data = excluded.data`,
      [safe.id, safe.sessionId ?? null, safe.kind, JSON.stringify(safe)],
    );
  }

  async insertImmutableWorkItem(item: WorkItem): Promise<boolean> {
    if (item.kind !== "verification" || (item.recordType !== "plan" && item.recordType !== "evidence" && item.recordType !== "policy_receipt" && item.recordType !== "resolution_receipt")) {
      throw new Error("Only immutable ForgeVerify plan, evidence, policy receipt, or resolution receipt records may use append-only persistence.");
    }
    return this.insertIfAbsent(item);
  }

  async insertIfAbsent(item: WorkItem): Promise<boolean> {
    const safe = sanitizeForPersistence(item);
    const res = await this.q.query(
      `INSERT INTO work_items (id, "sessionId", kind, data) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [safe.id, safe.sessionId ?? null, safe.kind, JSON.stringify(safe)],
    );
    return res.rows.length === 1;
  }

  async getWorkItems(sessionId: string): Promise<WorkItem[]> {
    const res = await this.q.query(`SELECT * FROM work_items WHERE "sessionId" = $1`, [sessionId]);
    return res.rows.map((row) => row.data as WorkItem);
  }

  async getWorkItem(id: string): Promise<WorkItem | undefined> {
    const res = await this.q.query(`SELECT * FROM work_items WHERE id = $1`, [id]);
    return res.rows[0] ? (res.rows[0].data as WorkItem) : undefined;
  }

  async getWorkItemsByKind(kind: string): Promise<WorkItem[]> {
    const res = await this.q.query(`SELECT * FROM work_items WHERE kind = $1`, [kind]);
    return res.rows.map((row) => row.data as WorkItem);
  }

  async getAllWorkItems(): Promise<WorkItem[]> {
    const res = await this.q.query(`SELECT * FROM work_items`);
    return res.rows.map((row) => row.data as WorkItem);
  }

  async appendEvent(event: unknown): Promise<void> {
    const safe = sanitizeForPersistence(event) as { sessionId?: string };
    await this.q.query(
      `INSERT INTO events ("sessionId", data, "createdAt") VALUES ($1,$2,$3)`,
      [safe.sessionId ?? "", JSON.stringify(safe), new Date().toISOString()],
    );
  }

  async getEvents(sessionId: string): Promise<unknown[]> {
    const res = await this.q.query(`SELECT * FROM events WHERE "sessionId" = $1 ORDER BY id ASC`, [sessionId]);
    return res.rows.map((row) => row.data);
  }
}

/**
 * PostgreSQL-backed implementation of {@link ISessionPersistence}. PostgreSQL is the authoritative
 * durable store when this class is used — there is no SQLite file anywhere in the loop, no blob
 * mirroring, and every write commits to the real database before the call resolves. Multi-write
 * transitions (steer consumption + plan revision, terminal cleanup + queue drain, etc.) use
 * {@link withTransaction} for real ACID atomicity via a dedicated checked-out connection.
 */
export class PostgresSessionPersistence implements ISessionPersistence {
  private readonly pool: pg.Pool;
  private readonly isCustomPool: boolean;
  private readonly ops: PostgresQueryOps;
  private initialized = false;
  private initPromise?: Promise<void>;

  constructor(options: PostgresPersistenceOptions = {}) {
    const connectionString = options.connectionString || process.env.DATABASE_URL;
    if (!connectionString && !options.pool) {
      throw new Error("PostgresSessionPersistence requires a connectionString, DATABASE_URL, or an injected pool.");
    }
    if (options.pool) {
      this.pool = options.pool;
      this.isCustomPool = true;
    } else {
      this.pool = new Pool({
        connectionString,
        ssl: options.ssl === undefined ? undefined : options.ssl ? { rejectUnauthorized: true } : false,
        max: 20,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
      });
      this.isCustomPool = false;
    }
    // An idle-connection error is emitted by pg's pool; leaving it unhandled would crash the process.
    this.pool.on?.("error", () => {});
    this.ops = new PostgresQueryOps(this.pool);
  }

  /** Must be awaited once before first use — runs migrations under a cross-process advisory lock. */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = this.initSchema().then(() => {
        this.initialized = true;
      });
    }
    return this.initPromise;
  }

  private async initSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1, $2)", [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_KEY]);
      await this.adoptLegacyMigrationsTableIfOwned(client);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
          version INTEGER PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          checksum VARCHAR(64) NOT NULL,
          applied_at VARCHAR(64) NOT NULL
        );
      `);
      for (const migration of SESSIONS_MIGRATIONS) {
        const res = await client.query(`SELECT checksum FROM ${MIGRATIONS_TABLE} WHERE version = $1`, [migration.version]);
        if (res.rows.length > 0) {
          if (res.rows[0].checksum !== migration.checksum) {
            throw new Error(`Sessions database migration checksum mismatch for version ${migration.version} (${migration.name}). Database integrity compromised.`);
          }
        } else {
          await client.query(migration.postgresUp);
          await client.query(
            `INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum, applied_at) VALUES ($1,$2,$3,$4)`,
            [migration.version, migration.name, migration.checksum, new Date().toISOString()],
          );
        }
      }
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1, $2)", [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_KEY]);
      } finally {
        client.release();
      }
    }
  }

  /**
   * Backward-compatible, ownership-safe upgrade path for a database created before this
   * package's migration table was namespaced. Runs under the same advisory lock as the rest of
   * `initSchema`, so it is race-free even across concurrently booting processes.
   *
   * - If the namespaced table already exists, this is a no-op (already upgraded).
   * - If no legacy `schema_migrations` table exists, this is a no-op (a genuinely fresh database
   *   — the CREATE TABLE IF NOT EXISTS right after this call creates the namespaced table).
   * - If a legacy table exists, its version-1 migration name is compared against this package's
   *   own ("initial_schema"). An exact match means the legacy table is this package's own prior
   *   history: it is renamed in place (every row preserved, zero data loss) to the namespaced
   *   name. Any other name (or none) means the legacy table belongs to another package (most
   *   likely @codeforge/cloud-db) or is unrecognized — it is left completely untouched, and this
   *   package simply starts its own namespaced table fresh. Ownership is never guessed from
   *   anything but this exact, unambiguous name match.
   */
  private async adoptLegacyMigrationsTableIfOwned(client: pg.PoolClient): Promise<void> {
    const namespaced = await client.query(`SELECT to_regclass($1) IS NOT NULL AS exists`, [MIGRATIONS_TABLE]);
    if (namespaced.rows[0]?.exists) return;

    const legacy = await client.query(`SELECT to_regclass($1) IS NOT NULL AS exists`, [LEGACY_MIGRATIONS_TABLE]);
    if (!legacy.rows[0]?.exists) return;

    const ownMigrationOne = SESSIONS_MIGRATIONS.find((m) => m.version === 1);
    const legacyOwner = await client.query(`SELECT name FROM ${LEGACY_MIGRATIONS_TABLE} WHERE version = 1`);
    if (!ownMigrationOne || legacyOwner.rows[0]?.name !== ownMigrationOne.name) return;

    try {
      await client.query(`ALTER TABLE ${LEGACY_MIGRATIONS_TABLE} RENAME TO ${MIGRATIONS_TABLE}`);
    } catch {
      // A concurrent process already claimed/renamed it under its own advisory-locked pass;
      // the namespaced table it created is picked up normally by the CREATE TABLE IF NOT EXISTS
      // that follows this call.
    }
  }

  upsertSession(session: SessionRecord): Promise<void> { return this.ops.upsertSession(session); }
  getSession(id: string): Promise<SessionRecord | undefined> { return this.ops.getSession(id); }
  listSessions(): Promise<SessionRecord[]> { return this.ops.listSessions(); }
  deleteSession(id: string): Promise<void> { return this.ops.deleteSession(id); }
  upsertTurn(turn: TurnRecord): Promise<void> { return this.ops.upsertTurn(turn); }
  getTurns(sessionId: string): Promise<TurnRecord[]> { return this.ops.getTurns(sessionId); }
  getTurn(id: string): Promise<TurnRecord | undefined> { return this.ops.getTurn(id); }
  upsertWorkItem(item: WorkItem): Promise<void> { return this.ops.upsertWorkItem(item); }
  insertImmutableWorkItem(item: WorkItem): Promise<boolean> { return this.ops.insertImmutableWorkItem(item); }
  insertIfAbsent(item: WorkItem): Promise<boolean> { return this.ops.insertIfAbsent(item); }
  getWorkItems(sessionId: string): Promise<WorkItem[]> { return this.ops.getWorkItems(sessionId); }
  getWorkItem(id: string): Promise<WorkItem | undefined> { return this.ops.getWorkItem(id); }
  getWorkItemsByKind(kind: string): Promise<WorkItem[]> { return this.ops.getWorkItemsByKind(kind); }
  getAllWorkItems(): Promise<WorkItem[]> { return this.ops.getAllWorkItems(); }
  appendEvent(event: unknown): Promise<void> { return this.ops.appendEvent(event); }
  getEvents(sessionId: string): Promise<unknown[]> { return this.ops.getEvents(sessionId); }

  async withTransaction<T>(fn: (tx: SessionPersistenceTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const tx = new PostgresQueryOps(client);
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Connection is already broken; nothing further to roll back.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (!this.isCustomPool) {
      await this.pool.end();
    }
  }

  getDriver(): string {
    return "postgres";
  }

  async clearAll(): Promise<void> {
    await this.pool.query("DELETE FROM events");
    await this.pool.query("DELETE FROM work_items");
    await this.pool.query("DELETE FROM turns");
    await this.pool.query("DELETE FROM sessions");
  }
}
