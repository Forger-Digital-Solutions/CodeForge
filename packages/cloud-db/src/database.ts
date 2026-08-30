import { SQLiteCloudDatabase, type SQLiteCloudDatabaseOptions } from "./sqlite.js";
import { PostgresCloudDatabase, type PostgresCloudDatabaseOptions } from "./postgres.js";
import type { ICloudDatabase } from "./interface.js";

export type CloudDatabaseDriver = "sqlite" | "postgres";

export interface CloudDatabaseConfig {
  driver?: CloudDatabaseDriver;
  dbPath?: string;
  databaseUrl?: string;
}

export class CloudDatabase extends SQLiteCloudDatabase {
  constructor(options: SQLiteCloudDatabaseOptions = {}) {
    super(options);
  }
}

export function createCloudDatabase(config: CloudDatabaseConfig = {}): ICloudDatabase {
  const driver = config.driver ?? (process.env.CODEFORGE_CLOUD_DB_DRIVER as CloudDatabaseDriver) ?? "sqlite";
  const rawDbUrl = config.databaseUrl ?? process.env.DATABASE_URL;

  if (driver === "postgres") {
    if (!rawDbUrl) {
      throw new Error("CODEFORGE_CLOUD_DB_DRIVER is 'postgres' but DATABASE_URL is missing.");
    }
    return new PostgresCloudDatabase({ connectionString: rawDbUrl });
  }

  if (driver === "sqlite") {
    if (rawDbUrl && (rawDbUrl.startsWith("postgres://") || rawDbUrl.startsWith("postgresql://"))) {
      throw new Error("DATABASE_URL is a PostgreSQL connection string, but CODEFORGE_CLOUD_DB_DRIVER is set to 'sqlite'. Refusing to use Postgres URL as SQLite file path.");
    }
    return new SQLiteCloudDatabase({ dbPath: config.dbPath ?? (rawDbUrl || ":memory:") });
  }

  throw new Error(`Unsupported database driver: ${driver}. Valid drivers: 'sqlite' | 'postgres'.`);
}
