import { createHash } from "node:crypto";

export interface SessionsMigrationDefinition {
  version: number;
  name: string;
  postgresUp: string;
  checksum: string;
}

function computeChecksum(content: string): string {
  return createHash("sha256").update(content.trim()).digest("hex");
}

// Column names are quoted camelCase to stay byte-for-byte compatible with the SQLite schema in
// persistence.ts (same table/column names), so parity tests can assert identical row shapes across
// both drivers without a translation layer.
const MIGRATION_1_POSTGRES = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  status TEXT NOT NULL,
  "currentAgentId" TEXT,
  "currentModelId" TEXT,
  "currentProviderId" TEXT,
  "permissionMode" TEXT,
  "displayMode" TEXT,
  branch TEXT,
  "workspacePath" TEXT,
  "taskTitle" TEXT
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  "sessionId" TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  "userMessage" TEXT NOT NULL,
  status TEXT NOT NULL,
  "agentId" TEXT,
  "startedAt" TEXT,
  "completedAt" TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_turns_sessionId ON turns("sessionId");

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  "sessionId" TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  data JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_work_items_sessionId ON work_items("sessionId");
CREATE INDEX IF NOT EXISTS idx_work_items_kind ON work_items(kind);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  "sessionId" TEXT NOT NULL,
  data JSONB NOT NULL,
  "createdAt" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_sessionId ON events("sessionId");
`;

export const SESSIONS_MIGRATIONS: SessionsMigrationDefinition[] = [
  {
    version: 1,
    name: "initial_schema",
    postgresUp: MIGRATION_1_POSTGRES,
    checksum: computeChecksum(MIGRATION_1_POSTGRES),
  },
];
