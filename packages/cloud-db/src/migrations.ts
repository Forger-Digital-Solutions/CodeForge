export const SCHEMA_VERSION = 1;

export const SQL_MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    primary_identity TEXT NOT NULL,
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
    event_type TEXT NOT NULL,
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
  `
];

export const DEFAULT_PLANS = [
  {
    id: "free",
    name: "CodeForge Free",
    monthlyCreditAllowance: 500_000,
    maxConcurrentTasks: 1,
    maxTaskSpendCredits: 50_000,
    features: JSON.stringify(["HOSTED_FREE", "DIRECT_PROVIDERS", "COMMUNITY_MODELS"]),
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "pro",
    name: "CodeForge Pro",
    monthlyCreditAllowance: 5_000_000,
    maxConcurrentTasks: 4,
    maxTaskSpendCredits: 500_000,
    features: JSON.stringify(["HOSTED_FREE", "HOSTED_PAID", "PREMIUM_MODELS", "DIRECT_PROVIDERS", "PRIORITY_ROUTING", "GEMS_READY"]),
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];
