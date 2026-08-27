// SQLite driver selection for CodeForge persistence.
//
// node:sqlite is the preferred backend (zero native dependencies, zero install
// scripts). It only exists on Node.js >= 22.5, and the packaged Electron
// runtime currently bundles Node 20.x where `require("node:sqlite")` fails, so
// we transparently fall back to better-sqlite3. better-sqlite3 is an
// optionalDependency compiled ONCE on the CI build machine (electron-rebuild
// on a windows-latest runner); the end user never needs Python/MSVC/node-gyp.
//
// The driver can be forced for tests via options or CODEFORGE_SQLITE_DRIVER.
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

export type SQLiteValue = null | number | bigint | string | Uint8Array;

export interface SQLiteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

/** Minimal statement surface shared by node:sqlite and better-sqlite3. */
export interface SQLiteStatement {
  run(params?: Record<string, SQLiteValue>): SQLiteRunResult;
  get(params?: Record<string, SQLiteValue>): unknown;
  all(params?: Record<string, SQLiteValue>): unknown[];
}

/** Minimal database surface shared by node:sqlite and better-sqlite3. */
export interface SQLiteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SQLiteStatement;
  close(): void;
}

export type SqliteDriverName = "node:sqlite" | "better-sqlite3";
export type SqliteDriverPreference = SqliteDriverName | "auto";

export function detectAvailableSqliteDrivers(): SqliteDriverName[] {
  const available: SqliteDriverName[] = [];
  try {
    require_("node:sqlite");
    available.push("node:sqlite");
  } catch {
    // Node < 22.5 (e.g. Electron's bundled Node 20)
  }
  try {
    require_.resolve("better-sqlite3");
    available.push("better-sqlite3");
  } catch {
    // Optional dependency not installed
  }
  return available;
}

function openNodeSqlite(dbPath: string): SQLiteDatabase {
  const { DatabaseSync } = require_("node:sqlite");
  const raw = new DatabaseSync(dbPath);
  return {
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => {
      const stmt = raw.prepare(sql);
      return {
        run: (params) => stmt.run(params),
        get: (params) => stmt.get(params),
        all: (params) => stmt.all(params),
      };
    },
    close: () => raw.close(),
  };
}

/**
 * node:sqlite binds named parameters by their "$name" key; better-sqlite3
 * expects the bare name. Normalize to bare keys for better-sqlite3.
 */
function toBetterParams(params?: Record<string, SQLiteValue>): Record<string, SQLiteValue> | undefined {
  if (!params) return params;
  let hasPrefixed = false;
  for (const key of Object.keys(params)) {
    if (key.startsWith("$")) {
      hasPrefixed = true;
      break;
    }
  }
  if (!hasPrefixed) return params;
  const out: Record<string, SQLiteValue> = {};
  for (const [key, value] of Object.entries(params)) {
    out[key.startsWith("$") ? key.slice(1) : key] = value;
  }
  return out;
}

function openBetterSqlite3(dbPath: string): SQLiteDatabase {
  const BetterSqlite3 = require_("better-sqlite3");
  const raw = new BetterSqlite3(dbPath);
  return {
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => {
      const stmt = raw.prepare(sql);
      return {
        run: (params) => stmt.run(toBetterParams(params)),
        get: (params) => stmt.get(toBetterParams(params)) as Record<string, SQLiteValue> | undefined,
        all: (params) => stmt.all(toBetterParams(params)) as Array<Record<string, SQLiteValue>>,
      };
    },
    close: () => raw.close(),
  };
}

export function openSqliteDatabase(
  dbPath: string,
  options: { driver?: SqliteDriverPreference } = {},
): { db: SQLiteDatabase; driver: SqliteDriverName } {
  const envPreference = process.env.CODEFORGE_SQLITE_DRIVER as SqliteDriverPreference | undefined;
  const preference = options.driver && options.driver !== "auto"
    ? options.driver
    : (envPreference === "node:sqlite" || envPreference === "better-sqlite3" ? envPreference : "auto");

  if (preference === "node:sqlite") {
    return { db: openNodeSqlite(dbPath), driver: "node:sqlite" };
  }
  if (preference === "better-sqlite3") {
    return { db: openBetterSqlite3(dbPath), driver: "better-sqlite3" };
  }

  try {
    return { db: openNodeSqlite(dbPath), driver: "node:sqlite" };
  } catch (nodeError) {
    try {
      return { db: openBetterSqlite3(dbPath), driver: "better-sqlite3" };
    } catch {
      throw nodeError;
    }
  }
}
