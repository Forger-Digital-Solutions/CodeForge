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

// planMode arrived after the initial schema; a separate additive migration keeps
// existing databases intact (the version-1 CREATE TABLE is immutable once applied).
const MIGRATION_2_POSTGRES = `
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS "planMode" TEXT;
`;

// The run outcome code is additive as well; see SessionRecord.outcome.
const MIGRATION_3_POSTGRES = `
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS outcome TEXT;
`;

// R21: terminal ForgeVerify records are append-only at the storage layer. A BEFORE UPDATE
// trigger refuses any content change to a plan/evidence/receipt row, so neither the generic
// upsert nor any future code path can rewrite verification evidence after the fact. Attempt
// records (running -> terminal) remain mutable. Idempotent re-writes of identical content pass.
const MIGRATION_4_POSTGRES = `
CREATE OR REPLACE FUNCTION work_items_forgeverify_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.kind = 'verification'
     AND (OLD.data->>'recordType') IN ('plan', 'evidence', 'policy_receipt', 'resolution_receipt', 'coverage_receipt', 'cost_gate_receipt')
     AND NEW.data IS DISTINCT FROM OLD.data THEN
    RAISE EXCEPTION 'FORGEVERIFY_RECORD_IMMUTABLE' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_work_items_forgeverify_immutable ON work_items;
CREATE TRIGGER trg_work_items_forgeverify_immutable BEFORE UPDATE ON work_items FOR EACH ROW EXECUTE FUNCTION work_items_forgeverify_immutable();
`;

export const SESSIONS_MIGRATIONS: SessionsMigrationDefinition[] = [
  {
    version: 1,
    name: "initial_schema",
    postgresUp: MIGRATION_1_POSTGRES,
    checksum: computeChecksum(MIGRATION_1_POSTGRES),
  },
  {
    version: 2,
    name: "session_plan_mode",
    postgresUp: MIGRATION_2_POSTGRES,
    checksum: computeChecksum(MIGRATION_2_POSTGRES),
  },
  {
    version: 3,
    name: "session_run_outcome",
    postgresUp: MIGRATION_3_POSTGRES,
    checksum: computeChecksum(MIGRATION_3_POSTGRES),
  },
  {
    version: 4,
    name: "forgeverify_records_immutable",
    postgresUp: MIGRATION_4_POSTGRES,
    checksum: computeChecksum(MIGRATION_4_POSTGRES),
  },
];
