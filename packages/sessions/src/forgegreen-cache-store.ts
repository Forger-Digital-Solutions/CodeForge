import fs from "node:fs";
import path from "node:path";
import { containsSecret } from "@codeforge/secrets";
import { openSqliteDatabase, type SQLiteDatabase, type SqliteDriverPreference } from "./sqlite.js";

/**
 * FG-1D persistent canonical analysis cache.
 *
 * A disposable efficiency store backed by the established CodeForge SQLite driver-selection
 * architecture. It lives in the application data directory (never inside a user repository or
 * `.git`) and is namespaced: every read and write is scoped to the caller's security namespace,
 * so no user/workspace can observe another's repository existence, cache hits, file names,
 * symbols, or prompts.
 *
 * The cache is correctness-optional by design: a missing, corrupt, or empty cache is a cache
 * miss and the analysis is recomputed. Entries are rejected when they exceed the size bound or
 * contain secret-shaped content (defense in depth — callers must redact upstream anyway).
 */

export interface ForgeGreenCacheStoreOptions {
  maxEntries?: number;
  maxEntryBytes?: number;
}

export interface ForgeGreenCacheHit {
  value: string;
  createdAt: string;
}

const DEFAULT_MAX_ENTRIES = 2048;
const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024;

export class ForgeGreenCacheStore {
  private readonly db: SQLiteDatabase;
  private readonly maxEntries: number;
  private readonly maxEntryBytes: number;

  private constructor(db: SQLiteDatabase, options: ForgeGreenCacheStoreOptions) {
    this.db = db;
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.maxEntryBytes = Math.max(1, options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS forgegreen_cache (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_access_at TEXT NOT NULL,
        PRIMARY KEY (namespace, key)
      );
    `);
  }

  static async open(databasePath: string, options: ForgeGreenCacheStoreOptions = {}): Promise<ForgeGreenCacheStore> {
    const dir = path.dirname(databasePath);
    await fs.promises.mkdir(dir, { recursive: true });
    const { db } = openSqliteDatabase(databasePath, {
      driver: process.env.CODEFORGE_SQLITE_DRIVER === "node:sqlite" || process.env.CODEFORGE_SQLITE_DRIVER === "better-sqlite3"
        ? process.env.CODEFORGE_SQLITE_DRIVER
        : "auto",
    });
    return new ForgeGreenCacheStore(db, options);
  }

  async get(namespace: string, key: string): Promise<ForgeGreenCacheHit | undefined> {
    if (!namespace || !key) return undefined;
    const row = this.db
      .prepare("SELECT value, created_at FROM forgegreen_cache WHERE namespace = $namespace AND key = $key")
      .get({ namespace, key }) as { value?: string; created_at?: string } | undefined;
    if (!row || typeof row.value !== "string" || typeof row.created_at !== "string") return undefined;
    this.db
      .prepare("UPDATE forgegreen_cache SET last_access_at = $now WHERE namespace = $namespace AND key = $key")
      .run({ now: new Date().toISOString(), namespace, key });
    return { value: row.value, createdAt: row.created_at };
  }

  async put(namespace: string, key: string, value: string): Promise<boolean> {
    if (!namespace || !key) return false;
    if (Buffer.byteLength(value, "utf8") > this.maxEntryBytes) return false;
    if (containsSecret(value)) return false;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO forgegreen_cache (namespace, key, value, created_at, last_access_at)
         VALUES ($namespace, $key, $value, $now, $now)
         ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, last_access_at = excluded.last_access_at`,
      )
      .run({ namespace, key, value, now });
    this.bounded(namespace);
    return true;
  }

  /** Invalidate every entry for one namespace. Returns the number of removed entries. */
  async invalidateNamespace(namespace: string): Promise<number> {
    const before = this.countNamespace(namespace);
    this.db.prepare("DELETE FROM forgegreen_cache WHERE namespace = $namespace").run({ namespace });
    return before;
  }

  async invalidate(namespace: string, key: string): Promise<void> {
    this.db.prepare("DELETE FROM forgegreen_cache WHERE namespace = $namespace AND key = $key").run({ namespace, key });
  }

  private countNamespace(namespace: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM forgegreen_cache WHERE namespace = $namespace").get({ namespace }) as { n?: number } | undefined;
    return typeof row?.n === "number" ? row.n : 0;
  }

  private bounded(namespace: string): void {
    let count = this.countNamespace(namespace);
    while (count > this.maxEntries) {
      const oldest = this.db
        .prepare("SELECT key FROM forgegreen_cache WHERE namespace = $namespace ORDER BY last_access_at ASC LIMIT 1")
        .get({ namespace }) as { key?: string } | undefined;
      if (!oldest?.key) return;
      this.db.prepare("DELETE FROM forgegreen_cache WHERE namespace = $namespace AND key = $key").run({ namespace, key: oldest.key });
      count--;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export async function createForgeGreenCacheStore(databasePath: string, options?: ForgeGreenCacheStoreOptions): Promise<ForgeGreenCacheStore> {
  return ForgeGreenCacheStore.open(databasePath, options);
}
