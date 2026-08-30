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

export const MIGRATIONS: MigrationDefinition[] = [
  {
    version: 1,
    name: "001_initial_cloud_schema",
    sqliteUp: MIGRATION_1_SQLITE,
    postgresUp: MIGRATION_1_POSTGRES,
    checksum: computeChecksum(MIGRATION_1_SQLITE),
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
