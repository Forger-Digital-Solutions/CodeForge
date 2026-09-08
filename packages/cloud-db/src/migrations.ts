import { createHash } from "node:crypto";
import type { FeatureKey } from "./types.js";

export interface MigrationDefinition {
  version: number;
  name: string;
  sqliteUp: string;
  postgresUp: string;
  checksum: string;
}

function computeChecksum(content: string): string {
  return createHash("sha256").update(content.trim()).digest("hex");
}

const MIGRATION_1_SQLITE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  primary_identity TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_primary_identity ON users(primary_identity);

CREATE TABLE IF NOT EXISTS identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  provider_email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS idx_identities_user_id ON identities(user_id);

CREATE TABLE IF NOT EXISTS device_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name TEXT NOT NULL,
  refresh_token_hash TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_sessions_user_id ON device_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_device_sessions_token_hash ON device_sessions(refresh_token_hash);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  monthly_credit_allowance INTEGER NOT NULL,
  max_concurrent_tasks INTEGER NOT NULL,
  max_task_spend_credits INTEGER NOT NULL,
  features TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  status TEXT NOT NULL,
  current_period_start TEXT NOT NULL,
  current_period_end TEXT NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id)
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub ON subscriptions(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_cust ON subscriptions(stripe_customer_id);

CREATE TABLE IF NOT EXISTS entitlements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature_key TEXT NOT NULL,
  granted_value TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, feature_key)
);
CREATE INDEX IF NOT EXISTS idx_entitlements_user_id ON entitlements(user_id);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  eventType TEXT NOT NULL,
  request_id TEXT,
  description TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_id ON credit_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_request_id ON credit_ledger(request_id);

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT,
  turn_id TEXT,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  access_class TEXT,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  provider_cost_usd REAL NOT NULL DEFAULT 0.0,
  credits_consumed INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_events_user_id ON usage_events(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_events_request_id ON usage_events(request_id);

CREATE TABLE IF NOT EXISTS usage_periods (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  free_allowance_granted INTEGER NOT NULL DEFAULT 0,
  credits_used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, period_start)
);
CREATE INDEX IF NOT EXISTS idx_usage_periods_user_id ON usage_periods(user_id);

CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  reserved_credits INTEGER NOT NULL,
  actual_credits INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  committed_at TEXT,
  released_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reservations_user_id ON reservations(user_id);
CREATE INDEX IF NOT EXISTS idx_reservations_request_id ON reservations(request_id);

CREATE TABLE IF NOT EXISTS hosted_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  estimated_credits INTEGER NOT NULL,
  actual_credits INTEGER NOT NULL DEFAULT 0,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_hosted_requests_user_id ON hosted_requests(user_id);

CREATE TABLE IF NOT EXISTS billing_webhook_events (
  id TEXT PRIMARY KEY,
  stripe_event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  status TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_billing_webhook_stripe_id ON billing_webhook_events(stripe_event_id);

CREATE TABLE IF NOT EXISTS account_settings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  privacy_mode TEXT NOT NULL DEFAULT 'STANDARD',
  auto_top_up_enabled INTEGER NOT NULL DEFAULT 0,
  spend_limit_usd REAL NOT NULL DEFAULT 0.0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS abuse_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  ip_address TEXT,
  event_type TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_abuse_events_user_id ON abuse_events(user_id);

CREATE TABLE IF NOT EXISTS oauth_transactions (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL UNIQUE,
  code_challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  device_name TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_transactions_state ON oauth_transactions(state);
`;

const MIGRATION_1_POSTGRES = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  checksum VARCHAR(64) NOT NULL,
  applied_at VARCHAR(64) NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) PRIMARY KEY,
  display_name VARCHAR(255) NOT NULL,
  avatar_url TEXT,
  primary_identity VARCHAR(255) NOT NULL UNIQUE,
  created_at VARCHAR(64) NOT NULL,
  updated_at VARCHAR(64) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_primary_identity ON users(primary_identity);

CREATE TABLE IF NOT EXISTS identities (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(64) NOT NULL,
  provider_user_id VARCHAR(255) NOT NULL,
  provider_email VARCHAR(255),
  created_at VARCHAR(64) NOT NULL,
  updated_at VARCHAR(64) NOT NULL,
  UNIQUE(provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS idx_identities_user_id ON identities(user_id);

CREATE TABLE IF NOT EXISTS device_sessions (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name VARCHAR(255) NOT NULL,
  refresh_token_hash VARCHAR(255) NOT NULL,
  ip_address VARCHAR(128),
  user_agent TEXT,
  expires_at VARCHAR(64) NOT NULL,
  revoked_at VARCHAR(64),
  created_at VARCHAR(64) NOT NULL,
  last_seen_at VARCHAR(64) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_sessions_user_id ON device_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_device_sessions_token_hash ON device_sessions(refresh_token_hash);

CREATE TABLE IF NOT EXISTS plans (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  monthly_credit_allowance BIGINT NOT NULL,
  max_concurrent_tasks INTEGER NOT NULL,
  max_task_spend_credits BIGINT NOT NULL,
  features TEXT NOT NULL,
  created_at VARCHAR(64) NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id VARCHAR(64) NOT NULL REFERENCES plans(id),
  stripe_customer_id VARCHAR(255),
  stripe_subscription_id VARCHAR(255),
  status VARCHAR(64) NOT NULL,
  current_period_start VARCHAR(64) NOT NULL,
  current_period_end VARCHAR(64) NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  created_at VARCHAR(64) NOT NULL,
  updated_at VARCHAR(64) NOT NULL,
  UNIQUE(user_id)
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub ON subscriptions(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_cust ON subscriptions(stripe_customer_id);

CREATE TABLE IF NOT EXISTS entitlements (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature_key VARCHAR(128) NOT NULL,
  granted_value VARCHAR(255) NOT NULL,
  expires_at VARCHAR(64),
  created_at VARCHAR(64) NOT NULL,
  updated_at VARCHAR(64) NOT NULL,
  UNIQUE(user_id, feature_key)
);
CREATE INDEX IF NOT EXISTS idx_entitlements_user_id ON entitlements(user_id);

CREATE TABLE IF NOT EXISTS credit_ledger (
  -- seq is a Postgres-only monotonic ordering column standing in for SQLite's implicit rowid, so the
  -- authoritative "latest balance" read is unambiguous even when two events share a millisecond
  -- timestamp. It does not exist in the SQLite schema and does not affect the migration checksum
  -- (which is computed from the SQLite DDL), so existing SQLite databases are unaffected.
  seq BIGSERIAL,
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  eventType VARCHAR(128) NOT NULL,
  request_id VARCHAR(255),
  description TEXT,
  metadata TEXT,
  created_at VARCHAR(64) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_id ON credit_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_seq ON credit_ledger(user_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_request_id ON credit_ledger(request_id);

CREATE TABLE IF NOT EXISTS usage_events (
  id VARCHAR(64) PRIMARY KEY,
  request_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id VARCHAR(255),
  turn_id VARCHAR(255),
  provider_id VARCHAR(128) NOT NULL,
  model_id VARCHAR(255) NOT NULL,
  access_class VARCHAR(128),
  input_tokens BIGINT NOT NULL,
  output_tokens BIGINT NOT NULL,
  cached_tokens BIGINT NOT NULL DEFAULT 0,
  provider_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  credits_consumed BIGINT NOT NULL,
  latency_ms BIGINT NOT NULL DEFAULT 0,
  status VARCHAR(64) NOT NULL,
  created_at VARCHAR(64) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_events_user_id ON usage_events(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_events_request_id ON usage_events(request_id);

CREATE TABLE IF NOT EXISTS usage_periods (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start VARCHAR(64) NOT NULL,
  period_end VARCHAR(64) NOT NULL,
  free_allowance_granted BIGINT NOT NULL DEFAULT 0,
  credits_used BIGINT NOT NULL DEFAULT 0,
  created_at VARCHAR(64) NOT NULL,
  updated_at VARCHAR(64) NOT NULL,
  UNIQUE(user_id, period_start)
);
CREATE INDEX IF NOT EXISTS idx_usage_periods_user_id ON usage_periods(user_id);

CREATE TABLE IF NOT EXISTS reservations (
  id VARCHAR(64) PRIMARY KEY,
  request_id VARCHAR(255) NOT NULL UNIQUE,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id VARCHAR(128) NOT NULL,
  model_id VARCHAR(255) NOT NULL,
  reserved_credits BIGINT NOT NULL,
  actual_credits BIGINT NOT NULL DEFAULT 0,
  status VARCHAR(64) NOT NULL,
  created_at VARCHAR(64) NOT NULL,
  committed_at VARCHAR(64),
  released_at VARCHAR(64)
);
CREATE INDEX IF NOT EXISTS idx_reservations_user_id ON reservations(user_id);
CREATE INDEX IF NOT EXISTS idx_reservations_request_id ON reservations(request_id);

CREATE TABLE IF NOT EXISTS hosted_requests (
  id VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(64) NOT NULL,
  estimated_credits BIGINT NOT NULL,
  actual_credits BIGINT NOT NULL DEFAULT 0,
  provider_id VARCHAR(128) NOT NULL,
  model_id VARCHAR(255) NOT NULL,
  created_at VARCHAR(64) NOT NULL,
  completed_at VARCHAR(64)
);
CREATE INDEX IF NOT EXISTS idx_hosted_requests_user_id ON hosted_requests(user_id);

CREATE TABLE IF NOT EXISTS billing_webhook_events (
  id VARCHAR(64) PRIMARY KEY,
  stripe_event_id VARCHAR(255) NOT NULL UNIQUE,
  event_type VARCHAR(128) NOT NULL,
  processed_at VARCHAR(64) NOT NULL,
  status VARCHAR(64) NOT NULL,
  payload TEXT,
  created_at VARCHAR(64) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_billing_webhook_stripe_id ON billing_webhook_events(stripe_event_id);

CREATE TABLE IF NOT EXISTS account_settings (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  privacy_mode VARCHAR(64) NOT NULL DEFAULT 'STANDARD',
  auto_top_up_enabled INTEGER NOT NULL DEFAULT 0,
  spend_limit_usd DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  created_at VARCHAR(64) NOT NULL,
  updated_at VARCHAR(64) NOT NULL
);

CREATE TABLE IF NOT EXISTS abuse_events (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64),
  ip_address VARCHAR(128),
  event_type VARCHAR(128) NOT NULL,
  details TEXT,
  created_at VARCHAR(64) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_abuse_events_user_id ON abuse_events(user_id);

CREATE TABLE IF NOT EXISTS oauth_transactions (
  id VARCHAR(64) PRIMARY KEY,
  state VARCHAR(255) NOT NULL UNIQUE,
  code_challenge VARCHAR(255) NOT NULL,
  redirect_uri TEXT NOT NULL,
  device_name VARCHAR(255),
  expires_at VARCHAR(64) NOT NULL,
  used_at VARCHAR(64),
  created_at VARCHAR(64) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_transactions_state ON oauth_transactions(state);
`;

const MIGRATION_2_SQLITE = `
-- SQLite utilizes implicit rowid for monotonic ordering.
-- No-op statement for migration version parity.
SELECT 1;
`;

const MIGRATION_2_POSTGRES = `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'credit_ledger' AND column_name = 'seq'
  ) THEN
    CREATE SEQUENCE IF NOT EXISTS credit_ledger_seq_seq;
    ALTER TABLE credit_ledger ADD COLUMN seq BIGINT DEFAULT nextval('credit_ledger_seq_seq');
    CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_seq ON credit_ledger(user_id, seq DESC);
  END IF;
END $$;
`;


// Migration 003 completes the server-brokered OAuth architecture:
//   * oauth_transactions.github_code_verifier holds the SERVER-owned GitHub PKCE verifier, which is
//     never handed to a client. The pre-existing code_challenge column now unambiguously holds the
//     DESKTOP client's PKCE challenge.
//   * desktop_auth_codes stores single-use, PKCE-bound, short-lived handoff codes (hashed, never in
//     plaintext) so a successful GitHub authorization is redirected back to the desktop loopback as a
//     valueless one-time code instead of a reusable session token in a URL.
//   * device_sessions.revoked_reason distinguishes a session that was ROTATED (whose reuse means the
//     token was stolen, and must revoke the whole family) from one the user explicitly LOGGED OUT
//     (whose reuse is just a stale client, and must revoke nothing else). Without that distinction a
//     logout on one machine silently signs the account out everywhere.
const MIGRATION_3_SQLITE = `
ALTER TABLE oauth_transactions ADD COLUMN github_code_verifier TEXT;

ALTER TABLE device_sessions ADD COLUMN revoked_reason TEXT;

CREATE TABLE IF NOT EXISTS desktop_auth_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  device_name TEXT,
  is_new_user INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_desktop_auth_codes_hash ON desktop_auth_codes(code_hash);
CREATE INDEX IF NOT EXISTS idx_desktop_auth_codes_user_id ON desktop_auth_codes(user_id);
`;

const MIGRATION_3_POSTGRES = `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'oauth_transactions' AND column_name = 'github_code_verifier'
  ) THEN
    ALTER TABLE oauth_transactions ADD COLUMN github_code_verifier TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'device_sessions' AND column_name = 'revoked_reason'
  ) THEN
    ALTER TABLE device_sessions ADD COLUMN revoked_reason VARCHAR(32);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS desktop_auth_codes (
  id VARCHAR(64) PRIMARY KEY,
  code_hash VARCHAR(128) NOT NULL UNIQUE,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_challenge VARCHAR(255) NOT NULL,
  redirect_uri TEXT NOT NULL,
  device_name VARCHAR(255),
  is_new_user INTEGER NOT NULL DEFAULT 0,
  expires_at VARCHAR(64) NOT NULL,
  used_at VARCHAR(64),
  created_at VARCHAR(64) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_desktop_auth_codes_hash ON desktop_auth_codes(code_hash);
CREATE INDEX IF NOT EXISTS idx_desktop_auth_codes_user_id ON desktop_auth_codes(user_id);
`;

// Migration 004 adds CF-11B: GitHub App installation, repository authorization keyed on GitHub's
// immutable numeric repository id, one-time callback state, and publication records carrying a
// fencing token so a stale executor can never finalize over a newer one.
const MIGRATION_4_SQLITE = `
CREATE TABLE IF NOT EXISTS github_installations (
  id TEXT PRIMARY KEY,
  installation_id INTEGER NOT NULL UNIQUE,
  github_account_id INTEGER NOT NULL,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK(account_type IN ('User', 'Organization')),
  codeforge_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_selection TEXT NOT NULL CHECK(repository_selection IN ('all', 'selected')),
  status TEXT NOT NULL CHECK(status IN ('active', 'suspended', 'revoked')) DEFAULT 'active',
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_github_installations_codeforge_user_id ON github_installations(codeforge_user_id);

CREATE TABLE IF NOT EXISTS github_repository_authorizations (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
  repository_id INTEGER NOT NULL UNIQUE,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  private INTEGER NOT NULL DEFAULT 0,
  authorization_state TEXT NOT NULL CHECK(authorization_state IN ('authorized', 'revoked', 'deleted')) DEFAULT 'authorized',
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_github_repo_auth_installation_id ON github_repository_authorizations(installation_id);

CREATE TABLE IF NOT EXISTS github_app_callback_states (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL UNIQUE,
  codeforge_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_session_id TEXT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_github_callback_states_expires_at ON github_app_callback_states(expires_at);

CREATE TABLE IF NOT EXISTS publications (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id INTEGER NOT NULL,
  installation_id TEXT NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
  target_branch TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  target_sha TEXT NOT NULL,
  certified_head TEXT NOT NULL,
  certified_tree TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  artifact_bytes INTEGER NOT NULL,
  artifact_state TEXT NOT NULL CHECK(artifact_state IN ('pending', 'stored')) DEFAULT 'pending',
  artifact_key TEXT,
  state TEXT NOT NULL CHECK(state IN ('awaiting_artifact', 'artifact_uploaded', 'validating', 'validated', 'waiting_for_lease', 'authorizing', 'checking_target', 'pushing', 'pushed', 'creating_pr', 'pr_created', 'completed', 'failed_retryable', 'failed_permanent', 'authorization_revoked', 'target_diverged')) DEFAULT 'awaiting_artifact',
  lease_owner TEXT,
  lease_expires_at TEXT,
  lease_fence INTEGER NOT NULL DEFAULT 0,
  push_ref TEXT,
  pull_request_number INTEGER,
  pull_request_url TEXT,
  pull_request_node_id TEXT,
  error_code TEXT,
  failure_reason TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_publications_user_delivery ON publications(user_id, delivery_id);
CREATE INDEX IF NOT EXISTS idx_publications_user_id ON publications(user_id);
CREATE INDEX IF NOT EXISTS idx_publications_repository_id ON publications(repository_id);
CREATE INDEX IF NOT EXISTS idx_publications_installation_id ON publications(installation_id);
CREATE INDEX IF NOT EXISTS idx_publications_state ON publications(state);
`;

const MIGRATION_4_POSTGRES = `
CREATE TABLE IF NOT EXISTS github_installations (
  id VARCHAR(64) PRIMARY KEY,
  installation_id BIGINT NOT NULL UNIQUE,
  github_account_id BIGINT NOT NULL,
  account_login VARCHAR(255) NOT NULL,
  account_type VARCHAR(32) NOT NULL CHECK(account_type IN ('User', 'Organization')),
  codeforge_user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_selection VARCHAR(32) NOT NULL CHECK(repository_selection IN ('all', 'selected')),
  status VARCHAR(32) NOT NULL CHECK(status IN ('active', 'suspended', 'revoked')) DEFAULT 'active',
  revoked_at VARCHAR(64),
  created_at VARCHAR(64) NOT NULL,
  updated_at VARCHAR(64) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_github_installations_codeforge_user_id ON github_installations(codeforge_user_id);

CREATE TABLE IF NOT EXISTS github_repository_authorizations (
  id VARCHAR(64) PRIMARY KEY,
  installation_id VARCHAR(64) NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
  repository_id BIGINT NOT NULL UNIQUE,
  owner VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  full_name VARCHAR(511) NOT NULL,
  private BOOLEAN NOT NULL DEFAULT false,
  authorization_state VARCHAR(32) NOT NULL CHECK(authorization_state IN ('authorized', 'revoked', 'deleted')) DEFAULT 'authorized',
  observed_at VARCHAR(64) NOT NULL,
  created_at VARCHAR(64) NOT NULL,
  updated_at VARCHAR(64) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_github_repo_auth_installation_id ON github_repository_authorizations(installation_id);

CREATE TABLE IF NOT EXISTS github_app_callback_states (
  id VARCHAR(64) PRIMARY KEY,
  state VARCHAR(255) NOT NULL UNIQUE,
  codeforge_user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_session_id VARCHAR(64),
  expires_at VARCHAR(64) NOT NULL,
  consumed_at VARCHAR(64),
  created_at VARCHAR(64) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_github_callback_states_expires_at ON github_app_callback_states(expires_at);

CREATE TABLE IF NOT EXISTS publications (
  id VARCHAR(64) PRIMARY KEY,
  delivery_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id BIGINT NOT NULL,
  installation_id VARCHAR(64) NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
  target_branch VARCHAR(255) NOT NULL,
  base_sha VARCHAR(64) NOT NULL,
  target_sha VARCHAR(64) NOT NULL,
  certified_head VARCHAR(64) NOT NULL,
  certified_tree VARCHAR(64) NOT NULL,
  artifact_sha256 VARCHAR(64) NOT NULL,
  artifact_bytes BIGINT NOT NULL,
  artifact_state VARCHAR(32) NOT NULL CHECK(artifact_state IN ('pending', 'stored')) DEFAULT 'pending',
  artifact_key VARCHAR(255),
  state VARCHAR(64) NOT NULL CHECK(state IN ('awaiting_artifact', 'artifact_uploaded', 'validating', 'validated', 'waiting_for_lease', 'authorizing', 'checking_target', 'pushing', 'pushed', 'creating_pr', 'pr_created', 'completed', 'failed_retryable', 'failed_permanent', 'authorization_revoked', 'target_diverged')) DEFAULT 'awaiting_artifact',
  lease_owner VARCHAR(255),
  lease_expires_at VARCHAR(64),
  lease_fence BIGINT NOT NULL DEFAULT 0,
  push_ref VARCHAR(511),
  pull_request_number INTEGER,
  pull_request_url TEXT,
  pull_request_node_id VARCHAR(255),
  error_code VARCHAR(128),
  failure_reason TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at VARCHAR(64) NOT NULL,
  updated_at VARCHAR(64) NOT NULL,
  completed_at VARCHAR(64)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_publications_user_delivery ON publications(user_id, delivery_id);
CREATE INDEX IF NOT EXISTS idx_publications_user_id ON publications(user_id);
CREATE INDEX IF NOT EXISTS idx_publications_repository_id ON publications(repository_id);
CREATE INDEX IF NOT EXISTS idx_publications_installation_id ON publications(installation_id);
CREATE INDEX IF NOT EXISTS idx_publications_state ON publications(state);
`;

// Migration 003 shipped before these two columns were present in every deployed
// migration body. A stamped database must be repaired by a new, idempotent migration;
// rewriting migration 003 would let the migration ledger mask the missing schema.
const MIGRATION_5_SQLITE = `
SELECT 1;
`;

const MIGRATION_5_POSTGRES = `
ALTER TABLE oauth_transactions ADD COLUMN IF NOT EXISTS github_code_verifier TEXT;
ALTER TABLE device_sessions ADD COLUMN IF NOT EXISTS revoked_reason VARCHAR(32);
`;

const MIGRATION_6_SQLITE = `
CREATE TABLE IF NOT EXISTS verification_plans (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  input_state_hash TEXT NOT NULL,
  scope TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS verification_attempts (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES verification_plans(id),
  run_id TEXT NOT NULL,
  verifier_id TEXT NOT NULL,
  verifier_version TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  exit_code INTEGER,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS verification_evidence (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES verification_attempts(id),
  plan_id TEXT NOT NULL REFERENCES verification_plans(id),
  run_id TEXT NOT NULL,
  verifier_id TEXT NOT NULL,
  verifier_version TEXT NOT NULL,
  input_state_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  output_digest TEXT NOT NULL,
  output_truncated INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verification_attempts_plan ON verification_attempts(plan_id);
CREATE INDEX IF NOT EXISTS idx_verification_evidence_plan ON verification_evidence(plan_id);
`;

const MIGRATION_6_POSTGRES = `
CREATE TABLE IF NOT EXISTS verification_plans (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  input_state_hash TEXT NOT NULL,
  scope TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS verification_attempts (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES verification_plans(id),
  run_id TEXT NOT NULL,
  verifier_id TEXT NOT NULL,
  verifier_version TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  exit_code INTEGER,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS verification_evidence (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES verification_attempts(id),
  plan_id TEXT NOT NULL REFERENCES verification_plans(id),
  run_id TEXT NOT NULL,
  verifier_id TEXT NOT NULL,
  verifier_version TEXT NOT NULL,
  input_state_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  output_digest TEXT NOT NULL,
  output_truncated BOOLEAN NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verification_attempts_plan ON verification_attempts(plan_id);
CREATE INDEX IF NOT EXISTS idx_verification_evidence_plan ON verification_evidence(plan_id);
`;

const MIGRATION_7_SQLITE = `
ALTER TABLE identities ADD COLUMN provider_login TEXT;
ALTER TABLE identities ADD COLUMN provider_avatar_url TEXT;

CREATE TABLE IF NOT EXISTS browser_oauth_transactions (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL UNIQUE,
  github_code_verifier TEXT NOT NULL,
  return_target TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_browser_oauth_transactions_state ON browser_oauth_transactions(state);

CREATE TABLE IF NOT EXISTS browser_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_browser_sessions_token_hash ON browser_sessions(session_token_hash);
CREATE INDEX IF NOT EXISTS idx_browser_sessions_user_id ON browser_sessions(user_id);
`;

const MIGRATION_7_POSTGRES = `
ALTER TABLE identities ADD COLUMN IF NOT EXISTS provider_login VARCHAR(255);
ALTER TABLE identities ADD COLUMN IF NOT EXISTS provider_avatar_url TEXT;

CREATE TABLE IF NOT EXISTS browser_oauth_transactions (
  id VARCHAR(64) PRIMARY KEY,
  state VARCHAR(512) NOT NULL UNIQUE,
  github_code_verifier VARCHAR(128) NOT NULL,
  return_target TEXT NOT NULL,
  expires_at VARCHAR(64) NOT NULL,
  used_at VARCHAR(64),
  created_at VARCHAR(64) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_browser_oauth_transactions_state ON browser_oauth_transactions(state);

CREATE TABLE IF NOT EXISTS browser_sessions (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_token_hash VARCHAR(128) NOT NULL UNIQUE,
  expires_at VARCHAR(64) NOT NULL,
  revoked_at VARCHAR(64),
  created_at VARCHAR(64) NOT NULL,
  last_seen_at VARCHAR(64) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_browser_sessions_token_hash ON browser_sessions(session_token_hash);
CREATE INDEX IF NOT EXISTS idx_browser_sessions_user_id ON browser_sessions(user_id);
`;

export const MIGRATIONS: MigrationDefinition[] = [
  {
    version: 1,
    name: "001_initial_cloud_schema",
    sqliteUp: MIGRATION_1_SQLITE,
    postgresUp: MIGRATION_1_POSTGRES,
    checksum: computeChecksum(MIGRATION_1_SQLITE),
  },
  {
    version: 2,
    name: "002_credit_ledger_monotonic_seq",
    sqliteUp: MIGRATION_2_SQLITE,
    postgresUp: MIGRATION_2_POSTGRES,
    checksum: computeChecksum(MIGRATION_2_SQLITE),
  },
  {
    version: 3,
    name: "003_server_brokered_oauth",
    sqliteUp: MIGRATION_3_SQLITE,
    postgresUp: MIGRATION_3_POSTGRES,
    checksum: computeChecksum(MIGRATION_3_SQLITE),
  },
  {
    version: 4,
    name: "004_cf11b_publication_github_app",
    sqliteUp: MIGRATION_4_SQLITE,
    postgresUp: MIGRATION_4_POSTGRES,
    checksum: computeChecksum(MIGRATION_4_SQLITE),
  },
  {
    version: 5,
    name: "005_repair_server_brokered_oauth_columns",
    sqliteUp: MIGRATION_5_SQLITE,
    postgresUp: MIGRATION_5_POSTGRES,
    checksum: computeChecksum(MIGRATION_5_SQLITE),
  },
  {
    version: 6,
    name: "006_cf16r2_forgeverify_evidence",
    sqliteUp: MIGRATION_6_SQLITE,
    postgresUp: MIGRATION_6_POSTGRES,
    checksum: computeChecksum(MIGRATION_6_SQLITE),
  },
  {
    version: 7,
    name: "007_fds_browser_github_identity",
    sqliteUp: MIGRATION_7_SQLITE,
    postgresUp: MIGRATION_7_POSTGRES,
    checksum: computeChecksum(MIGRATION_7_SQLITE),
  },
];


export const CANONICAL_FREE_FEATURES: FeatureKey[] = ["HOSTED_FREE", "DIRECT_PROVIDERS", "COMMUNITY_MODELS"];
export const CANONICAL_PRO_FEATURES: FeatureKey[] = [
  "HOSTED_FREE",
  "HOSTED_PAID",
  "PREMIUM_MODELS",
  "DIRECT_PROVIDERS",
  "PRIORITY_ROUTING",
  "GEMS_READY",
  "HIGH_CONCURRENCY",
  "HIGH_CONTEXT",
  "CLOUD_JOBS",
];

export const DEFAULT_PLANS = [
  {
    id: "free",
    name: "CodeForge Free",
    monthlyCreditAllowance: 500_000,
    maxConcurrentTasks: 1,
    maxTaskSpendCredits: 50_000,
    features: JSON.stringify(CANONICAL_FREE_FEATURES),
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "pro",
    name: "CodeForge Pro",
    monthlyCreditAllowance: 5_000_000,
    maxConcurrentTasks: 4,
    maxTaskSpendCredits: 500_000,
    features: JSON.stringify(CANONICAL_PRO_FEATURES),
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];
