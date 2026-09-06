import type { ISessionPersistence } from "./interface.js";
import { SqliteSessionPersistence } from "./persistence.js";
import { PostgresSessionPersistence } from "./postgres-persistence.js";
import type { SqliteDriverName } from "./sqlite.js";

export type SessionDatabaseDriver = "sqlite" | "postgres";

export interface SessionPersistenceConfig {
  /** SQLite file path (or ":memory:"). Ignored when `driver` resolves to "postgres". */
  dbPath?: string;
  /** node:sqlite vs better-sqlite3 native binding choice — unrelated to `driver` below. */
  sqliteDriver?: SqliteDriverName | "auto";
  /** Explicit backend selection. Falls back to CODEFORGE_SESSIONS_DB_DRIVER, then URL sniffing. */
  driver?: SessionDatabaseDriver;
  /** PostgreSQL connection string. Falls back to CODEFORGE_SESSIONS_DATABASE_URL, then DATABASE_URL. */
  databaseUrl?: string;
  /** Certificate-validated TLS for a non-loopback PostgreSQL connection. */
  databaseSsl?: boolean;
}

/**
 * Canonical CF-17R5 driver-selection factory for session/runtime persistence, mirroring
 * @codeforge/cloud-db's `createCloudDatabase(config)`: an explicit `driver` option wins, then the
 * dedicated env var, then URL sniffing — never a bare "does a Postgres-looking string exist
 * anywhere" heuristic that could silently pick the wrong backend.
 */
export function createSessionPersistence(config: SessionPersistenceConfig = {}): ISessionPersistence {
  const rawUrl = config.databaseUrl ?? process.env.CODEFORGE_SESSIONS_DATABASE_URL ?? process.env.DATABASE_URL;
  const looksLikePostgres = (url: string | undefined): boolean =>
    typeof url === "string" && (url.startsWith("postgres://") || url.startsWith("postgresql://"));

  const driver: SessionDatabaseDriver =
    config.driver
    ?? (process.env.CODEFORGE_SESSIONS_DB_DRIVER as SessionDatabaseDriver | undefined)
    ?? (looksLikePostgres(rawUrl) ? "postgres" : "sqlite");

  if (driver === "postgres") {
    if (!looksLikePostgres(rawUrl)) {
      throw new Error(
        "Session persistence driver is 'postgres' but no PostgreSQL connection string was provided " +
        "(databaseUrl / CODEFORGE_SESSIONS_DATABASE_URL / DATABASE_URL).",
      );
    }
    return new PostgresSessionPersistence({ connectionString: rawUrl, ssl: config.databaseSsl });
  }

  if (driver !== "sqlite") {
    throw new Error(`Unsupported session persistence driver: ${driver}. Valid drivers: 'sqlite' | 'postgres'.`);
  }
  if (looksLikePostgres(config.dbPath)) {
    throw new Error("dbPath is a PostgreSQL connection string, but the resolved driver is 'sqlite'. Refusing to use a Postgres URL as a SQLite file path.");
  }
  return new SqliteSessionPersistence({ dbPath: config.dbPath, driver: config.sqliteDriver });
}
