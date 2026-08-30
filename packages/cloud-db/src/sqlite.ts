import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { MIGRATIONS, DEFAULT_PLANS } from "./migrations.js";
import type { ICloudDatabase } from "./interface.js";
import type {
  UserRecord,
  IdentityRecord,
  DeviceSessionRecord,
  PlanRecord,
  SubscriptionRecord,
  EntitlementRecord,
  CreditLedgerRecord,
  CreditEventType,
  UsageEventRecord,
  UsagePeriodRecord,
  ReservationRecord,
  HostedRequestRecord,
  BillingWebhookEventRecord,
  AccountSettingsRecord,
  AbuseEventRecord,
  OAuthTransactionRecord,
  FeatureKey,
} from "./types.js";

const require_ = createRequire(import.meta.url);

export interface SQLiteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface SQLiteStatement {
  run(params?: Record<string, unknown>): SQLiteRunResult;
  get(params?: Record<string, unknown>): unknown;
  all(params?: Record<string, unknown>): unknown[];
}

export interface SQLiteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SQLiteStatement;
  close(): void;
}

function openDatabase(dbPath = ":memory:"): SQLiteDatabase {
  try {
    const { DatabaseSync } = require_("node:sqlite");
    const raw = new DatabaseSync(dbPath);
    return {
      exec: (sql) => raw.exec(sql),
      prepare: (sql) => {
        const stmt = raw.prepare(sql);
        return {
          run: (params) => (params ? stmt.run(params) : stmt.run()),
          get: (params) => (params ? stmt.get(params) : stmt.get()),
          all: (params) => (params ? stmt.all(params) : stmt.all()),
        };
      },
      close: () => raw.close(),
    };
  } catch {
    const BetterSqlite = require_("better-sqlite3");
    const raw = new BetterSqlite(dbPath);
    return {
      exec: (sql) => raw.exec(sql),
      prepare: (sql) => {
        const stmt = raw.prepare(sql);
        return {
          run: (params) => (params ? stmt.run(params) : stmt.run()),
          get: (params) => (params ? stmt.get(params) : stmt.get()),
          all: (params) => (params ? stmt.all(params) : stmt.all()),
        };
      },
      close: () => raw.close(),
    };
  }
}

export interface SQLiteCloudDatabaseOptions {
  dbPath?: string;
}

/**
 * Embedded synchronous backend. Implements the async {@link ICloudDatabase} contract with fully
 * synchronous method bodies wrapped in resolved promises. Because a body never awaits, each public
 * operation runs to completion in a single event-loop tick — so it stays atomic with respect to every
 * other operation even though callers `await` it, which is exactly what keeps the credit ledger and
 * reservation state machine race-free without a server round-trip.
 */
export class SQLiteCloudDatabase implements ICloudDatabase {
  private readonly db: SQLiteDatabase;

  constructor(options: SQLiteCloudDatabaseOptions = {}) {
    this.db = openDatabase(options.dbPath ?? ":memory:");
    this.initSchema();
  }

  /**
   * Idempotent no-op: SQLite schema is created synchronously in the constructor. Present so callers
   * can uniformly `await db.init()` across drivers before serving traffic (Postgres does real work here).
   */
  async init(): Promise<void> {
    // no-op — schema already initialized in constructor
  }

  private initSchema(): void {
    // 1. Run migrations with checksum validation
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    for (const migration of MIGRATIONS) {
      const existing = this.db.prepare(`SELECT checksum FROM schema_migrations WHERE version = @version`).get({ version: migration.version }) as { checksum?: string } | undefined;
      if (existing) {
        if (existing.checksum !== migration.checksum) {
          throw new Error(`Database migration checksum mismatch for version ${migration.version} (${migration.name}). Database integrity compromised.`);
        }
      } else {
        this.db.exec(migration.sqliteUp);
        this.db.prepare(`
          INSERT INTO schema_migrations (version, name, checksum, applied_at)
          VALUES (@version, @name, @checksum, @appliedAt)
        `).run({
          version: migration.version,
          name: migration.name,
          checksum: migration.checksum,
          appliedAt: new Date().toISOString(),
        });
      }
    }

    // 2. Upsert default plans
    for (const plan of DEFAULT_PLANS) {
      this.db.prepare(`
        INSERT OR REPLACE INTO plans (id, name, monthly_credit_allowance, max_concurrent_tasks, max_task_spend_credits, features, created_at)
        VALUES (@id, @name, @monthlyCreditAllowance, @maxConcurrentTasks, @maxTaskSpendCredits, @features, @createdAt)
      `).run(plan);
    }
  }

  async close(): Promise<void> {
    try {
      this.db.close();
    } catch {}
  }

  /** Synchronous transaction wrapper — makes a multi-statement mutation atomic (rolls back on throw). */
  private txSync<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw e;
    }
  }

  // --- Users & Identities ---

  async createUser(params: { displayName: string; avatarUrl?: string; primaryIdentity: string; id?: string }): Promise<UserRecord> {
    const now = new Date().toISOString();
    const id = params.id ?? randomUUID();
    const user: UserRecord = {
      id,
      displayName: params.displayName,
      avatarUrl: params.avatarUrl,
      primaryIdentity: params.primaryIdentity,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO users (id, display_name, avatar_url, primary_identity, created_at, updated_at)
      VALUES (@id, @displayName, @avatarUrl, @primaryIdentity, @createdAt, @updatedAt)
    `).run({
      id: user.id,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl ?? null,
      primaryIdentity: user.primaryIdentity,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    });
    return user;
  }

  private getUserByIdSync(id: string): UserRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM users WHERE id = @id`).get({ id }) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      displayName: String(row.display_name),
      avatarUrl: row.avatar_url ? String(row.avatar_url) : undefined,
      primaryIdentity: String(row.primary_identity),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  async getUserById(id: string): Promise<UserRecord | undefined> {
    return this.getUserByIdSync(id);
  }

  async getUserByPrimaryIdentity(primaryIdentity: string): Promise<UserRecord | undefined> {
    const row = this.db.prepare(`SELECT * FROM users WHERE primary_identity = @primaryIdentity`).get({ primaryIdentity }) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      displayName: String(row.display_name),
      avatarUrl: row.avatar_url ? String(row.avatar_url) : undefined,
      primaryIdentity: String(row.primary_identity),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  async createIdentity(params: { userId: string; provider: "github" | "email"; providerUserId: string; providerEmail?: string; id?: string }): Promise<IdentityRecord> {
    const now = new Date().toISOString();
    const id = params.id ?? randomUUID();
    const identity: IdentityRecord = {
      id,
      userId: params.userId,
      provider: params.provider,
      providerUserId: params.providerUserId,
      providerEmail: params.providerEmail,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO identities (id, user_id, provider, provider_user_id, provider_email, created_at, updated_at)
      VALUES (@id, @userId, @provider, @providerUserId, @providerEmail, @createdAt, @updatedAt)
    `).run({
      id: identity.id,
      userId: identity.userId,
      provider: identity.provider,
      providerUserId: identity.providerUserId,
      providerEmail: identity.providerEmail ?? null,
      createdAt: identity.createdAt,
      updatedAt: identity.updatedAt,
    });
    return identity;
  }

  async getIdentityByProvider(provider: string, providerUserId: string): Promise<IdentityRecord | undefined> {
    const row = this.db.prepare(`SELECT * FROM identities WHERE provider = @provider AND provider_user_id = @providerUserId`).get({ provider, providerUserId }) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      provider: row.provider as "github" | "email",
      providerUserId: String(row.provider_user_id),
      providerEmail: row.provider_email ? String(row.provider_email) : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  // --- Device Sessions & Rotation ---

  private createDeviceSessionSync(params: { userId: string; deviceName?: string; refreshTokenHash: string; ipAddress?: string; userAgent?: string; expiresInSeconds?: number }): DeviceSessionRecord {
    const now = new Date();
    const expires = new Date(now.getTime() + (params.expiresInSeconds ?? 30 * 24 * 60 * 60) * 1000);
    const session: DeviceSessionRecord = {
      id: randomUUID(),
      userId: params.userId,
      deviceName: params.deviceName ?? "CodeForge Desktop",
      refreshTokenHash: params.refreshTokenHash,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      expiresAt: expires.toISOString(),
      revokedAt: null,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
    };
    this.db.prepare(`
      INSERT INTO device_sessions (id, user_id, device_name, refresh_token_hash, ip_address, user_agent, expires_at, revoked_at, created_at, last_seen_at)
      VALUES (@id, @userId, @deviceName, @refreshTokenHash, @ipAddress, @userAgent, @expiresAt, @revokedAt, @createdAt, @lastSeenAt)
    `).run({
      id: session.id,
      userId: session.userId,
      deviceName: session.deviceName,
      refreshTokenHash: session.refreshTokenHash,
      ipAddress: session.ipAddress ?? null,
      userAgent: session.userAgent ?? null,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt ?? null,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
    });
    return session;
  }

  async createDeviceSession(params: { userId: string; deviceName?: string; refreshTokenHash: string; ipAddress?: string; userAgent?: string; expiresInSeconds?: number }): Promise<DeviceSessionRecord> {
    return this.createDeviceSessionSync(params);
  }

  private getDeviceSessionByTokenHashSync(refreshTokenHash: string): DeviceSessionRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM device_sessions WHERE refresh_token_hash = @refreshTokenHash`).get({ refreshTokenHash }) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      deviceName: String(row.device_name),
      refreshTokenHash: String(row.refresh_token_hash),
      ipAddress: row.ip_address ? String(row.ip_address) : undefined,
      userAgent: row.user_agent ? String(row.user_agent) : undefined,
      expiresAt: String(row.expires_at),
      revokedAt: row.revoked_at ? String(row.revoked_at) : null,
      createdAt: String(row.created_at),
      lastSeenAt: String(row.last_seen_at),
    };
  }

  async getDeviceSessionByTokenHash(refreshTokenHash: string): Promise<DeviceSessionRecord | undefined> {
    return this.getDeviceSessionByTokenHashSync(refreshTokenHash);
  }

  async updateDeviceSessionLastSeen(id: string): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE device_sessions SET last_seen_at = @now WHERE id = @id`).run({ id, now });
  }

  async revokeDeviceSession(id: string): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE device_sessions SET revoked_at = @now WHERE id = @id`).run({ id, now });
  }

  private revokeAllUserDeviceSessionsSync(userId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE device_sessions SET revoked_at = @now WHERE user_id = @userId AND revoked_at IS NULL`).run({ userId, now });
  }

  async revokeAllUserDeviceSessions(userId: string): Promise<void> {
    this.revokeAllUserDeviceSessionsSync(userId);
  }

  async rotateDeviceSession(params: {
    oldTokenHash: string;
    newRefreshTokenHash: string;
    deviceName?: string;
    ipAddress?: string;
    userAgent?: string;
    expiresInSeconds?: number;
  }): Promise<{ user: UserRecord; session: DeviceSessionRecord }> {
    const session = this.getDeviceSessionByTokenHashSync(params.oldTokenHash);
    if (!session) {
      throw new Error("Invalid refresh token");
    }
    if (session.revokedAt) {
      // Possible token reuse / breach: revoke all sessions for safety
      this.revokeAllUserDeviceSessionsSync(session.userId);
      throw new Error("Device session has been revoked (replay detected)");
    }
    if (new Date(session.expiresAt).getTime() < Date.now()) {
      throw new Error("Device session has expired");
    }

    const user = this.getUserByIdSync(session.userId);
    if (!user) {
      throw new Error("User associated with session not found");
    }

    // Revoke old session and insert new session atomically
    return this.txSync(() => {
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE device_sessions SET revoked_at = @now WHERE id = @id`).run({ id: session.id, now });

      const newSession = this.createDeviceSessionSync({
        userId: user.id,
        deviceName: params.deviceName ?? session.deviceName,
        refreshTokenHash: params.newRefreshTokenHash,
        ipAddress: params.ipAddress ?? session.ipAddress,
        userAgent: params.userAgent ?? session.userAgent,
        expiresInSeconds: params.expiresInSeconds,
      });

      return { user, session: newSession };
    });
  }

  // --- Plans & Subscriptions ---

  async getPlan(id: string): Promise<PlanRecord | undefined> {
    const row = this.db.prepare(`SELECT * FROM plans WHERE id = @id`).get({ id }) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      name: String(row.name),
      monthlyCreditAllowance: Number(row.monthly_credit_allowance),
      maxConcurrentTasks: Number(row.max_concurrent_tasks),
      maxTaskSpendCredits: Number(row.max_task_spend_credits),
      features: JSON.parse(String(row.features)),
      createdAt: String(row.created_at),
    };
  }

  async listPlans(): Promise<PlanRecord[]> {
    const rows = this.db.prepare(`SELECT * FROM plans`).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      monthlyCreditAllowance: Number(row.monthly_credit_allowance),
      maxConcurrentTasks: Number(row.max_concurrent_tasks),
      maxTaskSpendCredits: Number(row.max_task_spend_credits),
      features: JSON.parse(String(row.features)),
      createdAt: String(row.created_at),
    }));
  }

  private getSubscriptionByUserIdSync(userId: string): SubscriptionRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM subscriptions WHERE user_id = @userId`).get({ userId }) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.mapSubscriptionRow(row);
  }

  private mapSubscriptionRow(row: Record<string, unknown>): SubscriptionRecord {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      planId: String(row.plan_id),
      stripeCustomerId: row.stripe_customer_id ? String(row.stripe_customer_id) : undefined,
      stripeSubscriptionId: row.stripe_subscription_id ? String(row.stripe_subscription_id) : undefined,
      status: row.status as SubscriptionRecord["status"],
      currentPeriodStart: String(row.current_period_start),
      currentPeriodEnd: String(row.current_period_end),
      cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  async getSubscriptionByUserId(userId: string): Promise<SubscriptionRecord | undefined> {
    return this.getSubscriptionByUserIdSync(userId);
  }

  async getSubscriptionByStripeCustomerId(stripeCustomerId: string): Promise<SubscriptionRecord | undefined> {
    const row = this.db.prepare(`SELECT * FROM subscriptions WHERE stripe_customer_id = @stripeCustomerId`).get({ stripeCustomerId }) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.mapSubscriptionRow(row);
  }

  async getSubscriptionByStripeSubscriptionId(stripeSubscriptionId: string): Promise<SubscriptionRecord | undefined> {
    const row = this.db.prepare(`SELECT * FROM subscriptions WHERE stripe_subscription_id = @stripeSubscriptionId`).get({ stripeSubscriptionId }) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.mapSubscriptionRow(row);
  }

  async upsertSubscription(sub: Omit<SubscriptionRecord, "id" | "createdAt" | "updatedAt"> & { id?: string }): Promise<SubscriptionRecord> {
    const now = new Date().toISOString();
    const existing = this.getSubscriptionByUserIdSync(sub.userId);
    const id = existing?.id ?? sub.id ?? randomUUID();
    const record: SubscriptionRecord = {
      id,
      userId: sub.userId,
      planId: sub.planId,
      stripeCustomerId: sub.stripeCustomerId,
      stripeSubscriptionId: sub.stripeSubscriptionId,
      status: sub.status,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO subscriptions (id, user_id, plan_id, stripe_customer_id, stripe_subscription_id, status, current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at)
      VALUES (@id, @userId, @planId, @stripeCustomerId, @stripeSubscriptionId, @status, @currentPeriodStart, @currentPeriodEnd, @cancelAtPeriodEnd, @createdAt, @updatedAt)
      ON CONFLICT(user_id) DO UPDATE SET
        plan_id = excluded.plan_id,
        stripe_customer_id = excluded.stripe_customer_id,
        stripe_subscription_id = excluded.stripe_subscription_id,
        status = excluded.status,
        current_period_start = excluded.current_period_start,
        current_period_end = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        updated_at = excluded.updated_at
    `).run({
      id: record.id,
      userId: record.userId,
      planId: record.planId,
      stripeCustomerId: record.stripeCustomerId ?? null,
      stripeSubscriptionId: record.stripeSubscriptionId ?? null,
      status: record.status,
      currentPeriodStart: record.currentPeriodStart,
      currentPeriodEnd: record.currentPeriodEnd,
      cancelAtPeriodEnd: record.cancelAtPeriodEnd ? 1 : 0,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
    // Return true database row
    return this.getSubscriptionByUserIdSync(sub.userId)!;
  }

  // --- Entitlements ---

  async getEntitlements(userId: string): Promise<EntitlementRecord[]> {
    const rows = this.db.prepare(`SELECT * FROM entitlements WHERE user_id = @userId`).all({ userId }) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      featureKey: row.feature_key as FeatureKey,
      grantedValue: String(row.granted_value),
      expiresAt: row.expires_at ? String(row.expires_at) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  async hasEntitlement(userId: string, featureKey: FeatureKey | string): Promise<boolean> {
    const row = this.db.prepare(`
      SELECT * FROM entitlements
      WHERE user_id = @userId AND feature_key = @featureKey AND (expires_at IS NULL OR expires_at > @now)
    `).get({ userId, featureKey, now: new Date().toISOString() });
    return !!row;
  }

  async setEntitlement(userId: string, featureKey: FeatureKey | string, grantedValue = "true", expiresAt?: string | null): Promise<EntitlementRecord> {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO entitlements (id, user_id, feature_key, granted_value, expires_at, created_at, updated_at)
      VALUES (@id, @userId, @featureKey, @grantedValue, @expiresAt, @createdAt, @updatedAt)
      ON CONFLICT(user_id, feature_key) DO UPDATE SET
        granted_value = excluded.granted_value,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `).run({
      id,
      userId,
      featureKey,
      grantedValue,
      expiresAt: expiresAt ?? null,
      createdAt: now,
      updatedAt: now,
    });

    const row = this.db.prepare(`SELECT * FROM entitlements WHERE user_id = @userId AND feature_key = @featureKey`).get({ userId, featureKey }) as Record<string, unknown>;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      featureKey: row.feature_key as FeatureKey,
      grantedValue: String(row.granted_value),
      expiresAt: row.expires_at ? String(row.expires_at) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  async removeEntitlement(userId: string, featureKey: FeatureKey | string): Promise<void> {
    this.db.prepare(`DELETE FROM entitlements WHERE user_id = @userId AND feature_key = @featureKey`).run({ userId, featureKey });
  }

  // --- Credit Ledger ---

  private getCreditBalanceSync(userId: string): number {
    const row = this.db.prepare(`
      SELECT balance_after FROM credit_ledger
      WHERE user_id = @userId
      ORDER BY rowid DESC
      LIMIT 1
    `).get({ userId }) as { balance_after?: number } | undefined;
    return row?.balance_after ?? 0;
  }

  async getCreditBalance(userId: string): Promise<number> {
    return this.getCreditBalanceSync(userId);
  }

  private appendLedgerSync(params: {
    userId: string;
    amount: number;
    eventType: CreditEventType;
    requestId?: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }): CreditLedgerRecord {
    const currentBalance = this.getCreditBalanceSync(params.userId);
    const newBalance = currentBalance + params.amount;
    if (newBalance < 0) {
      throw new Error(`Insufficient credit balance. Current: ${currentBalance}, required: ${Math.abs(params.amount)}`);
    }

    const now = new Date().toISOString();
    const record: CreditLedgerRecord = {
      id: randomUUID(),
      userId: params.userId,
      amount: params.amount,
      balanceAfter: newBalance,
      eventType: params.eventType,
      requestId: params.requestId,
      description: params.description,
      metadata: params.metadata,
      createdAt: now,
    };

    this.db.prepare(`
      INSERT INTO credit_ledger (id, user_id, amount, balance_after, eventType, request_id, description, metadata, created_at)
      VALUES (@id, @userId, @amount, @balanceAfter, @eventType, @requestId, @description, @metadata, @createdAt)
    `).run({
      id: record.id,
      userId: record.userId,
      amount: record.amount,
      balanceAfter: record.balanceAfter,
      eventType: record.eventType,
      requestId: record.requestId ?? null,
      description: record.description ?? null,
      metadata: record.metadata ? JSON.stringify(record.metadata) : null,
      createdAt: record.createdAt,
    });

    return record;
  }

  async appendLedgerEvent(params: {
    userId: string;
    amount: number;
    eventType: CreditEventType;
    requestId?: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }): Promise<CreditLedgerRecord> {
    return this.appendLedgerSync(params);
  }

  async listLedgerEvents(userId: string, limit = 50): Promise<CreditLedgerRecord[]> {
    const rows = this.db.prepare(`
      SELECT * FROM credit_ledger
      WHERE user_id = @userId
      ORDER BY rowid DESC
      LIMIT @limit
    `).all({ userId, limit }) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      amount: Number(row.amount),
      balanceAfter: Number(row.balance_after),
      eventType: row.eventType as CreditEventType,
      requestId: row.request_id ? String(row.request_id) : undefined,
      description: row.description ? String(row.description) : undefined,
      metadata: row.metadata ? JSON.parse(String(row.metadata)) : undefined,
      createdAt: String(row.created_at),
    }));
  }

  // --- Usage Events ---

  private recordUsageEventSync(event: Omit<UsageEventRecord, "id" | "createdAt"> & { id?: string }): UsageEventRecord {
    const now = new Date().toISOString();
    const id = event.id ?? randomUUID();
    const record: UsageEventRecord = {
      id,
      requestId: event.requestId,
      userId: event.userId,
      sessionId: event.sessionId,
      turnId: event.turnId,
      providerId: event.providerId,
      modelId: event.modelId,
      accessClass: event.accessClass,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cachedTokens: event.cachedTokens,
      providerCostUsd: event.providerCostUsd,
      creditsConsumed: event.creditsConsumed,
      latencyMs: event.latencyMs,
      status: event.status,
      createdAt: now,
    };

    this.db.prepare(`
      INSERT INTO usage_events (id, request_id, user_id, session_id, turn_id, provider_id, model_id, access_class, input_tokens, output_tokens, cached_tokens, provider_cost_usd, credits_consumed, latency_ms, status, created_at)
      VALUES (@id, @requestId, @userId, @sessionId, @turnId, @providerId, @modelId, @accessClass, @inputTokens, @outputTokens, @cachedTokens, @providerCostUsd, @creditsConsumed, @latencyMs, @status, @createdAt)
    `).run({
      id: record.id,
      requestId: record.requestId,
      userId: record.userId,
      sessionId: record.sessionId ?? null,
      turnId: record.turnId ?? null,
      providerId: record.providerId,
      modelId: record.modelId,
      accessClass: record.accessClass ?? null,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cachedTokens: record.cachedTokens,
      providerCostUsd: record.providerCostUsd,
      creditsConsumed: record.creditsConsumed,
      latencyMs: record.latencyMs,
      status: record.status,
      createdAt: record.createdAt,
    });

    return record;
  }

  async recordUsageEvent(event: Omit<UsageEventRecord, "id" | "createdAt"> & { id?: string }): Promise<UsageEventRecord> {
    return this.recordUsageEventSync(event);
  }

  async listUsageEvents(userId: string, limit = 50): Promise<UsageEventRecord[]> {
    const rows = this.db.prepare(`
      SELECT * FROM usage_events
      WHERE user_id = @userId
      ORDER BY rowid DESC
      LIMIT @limit
    `).all({ userId, limit }) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      requestId: String(row.request_id),
      userId: String(row.user_id),
      sessionId: row.session_id ? String(row.session_id) : undefined,
      turnId: row.turn_id ? String(row.turn_id) : undefined,
      providerId: String(row.provider_id),
      modelId: String(row.model_id),
      accessClass: row.access_class ? String(row.access_class) : undefined,
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cachedTokens: Number(row.cached_tokens),
      providerCostUsd: Number(row.provider_cost_usd),
      creditsConsumed: Number(row.credits_consumed),
      latencyMs: Number(row.latency_ms),
      status: row.status as UsageEventRecord["status"],
      createdAt: String(row.created_at),
    }));
  }

  async getDailyProviderSpendUsd(sinceIsoString?: string): Promise<number> {
    const since = sinceIsoString ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const row = this.db.prepare(`
      SELECT SUM(provider_cost_usd) as total_spend FROM usage_events
      WHERE created_at >= @since
    `).get({ since }) as { total_spend?: number } | undefined;
    return row?.total_spend ?? 0.0;
  }

  async getUserBillingPeriodSpendUsd(userId: string, sinceIsoString?: string): Promise<number> {
    const since = sinceIsoString ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const row = this.db.prepare(`
      SELECT SUM(provider_cost_usd) as total_spend FROM usage_events
      WHERE user_id = @userId AND created_at >= @since
    `).get({ userId, since }) as { total_spend?: number } | undefined;
    return row?.total_spend ?? 0.0;
  }

  // --- Authoritative Reservations (low-level) ---

  private getReservationByRequestIdSync(requestId: string): ReservationRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM reservations WHERE request_id = @requestId`).get({ requestId }) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.mapReservationRow(row);
  }

  private mapReservationRow(row: Record<string, unknown>): ReservationRecord {
    return {
      id: String(row.id),
      requestId: String(row.request_id),
      userId: String(row.user_id),
      providerId: String(row.provider_id),
      modelId: String(row.model_id),
      reservedCredits: Number(row.reserved_credits),
      actualCredits: Number(row.actual_credits),
      status: row.status as ReservationRecord["status"],
      createdAt: String(row.created_at),
      committedAt: row.committed_at ? String(row.committed_at) : null,
      releasedAt: row.released_at ? String(row.released_at) : null,
    };
  }

  private insertReservationSync(params: { id?: string; requestId: string; userId: string; providerId: string; modelId: string; reservedCredits: number }): ReservationRecord {
    const now = new Date().toISOString();
    const id = params.id ?? randomUUID();
    const record: ReservationRecord = {
      id,
      requestId: params.requestId,
      userId: params.userId,
      providerId: params.providerId,
      modelId: params.modelId,
      reservedCredits: params.reservedCredits,
      actualCredits: 0,
      status: "reserved",
      createdAt: now,
      committedAt: null,
      releasedAt: null,
    };

    this.db.prepare(`
      INSERT INTO reservations (id, request_id, user_id, provider_id, model_id, reserved_credits, actual_credits, status, created_at, committed_at, released_at)
      VALUES (@id, @requestId, @userId, @providerId, @modelId, @reservedCredits, @actualCredits, @status, @createdAt, @committedAt, @releasedAt)
    `).run({
      id: record.id,
      requestId: record.requestId,
      userId: record.userId,
      providerId: record.providerId,
      modelId: record.modelId,
      reservedCredits: record.reservedCredits,
      actualCredits: record.actualCredits,
      status: record.status,
      createdAt: record.createdAt,
      committedAt: null,
      releasedAt: null,
    });

    return record;
  }

  async createReservation(params: {
    id?: string;
    requestId: string;
    userId: string;
    providerId: string;
    modelId: string;
    reservedCredits: number;
  }): Promise<ReservationRecord> {
    const existing = this.getReservationByRequestIdSync(params.requestId);
    if (existing) {
      if (existing.userId !== params.userId) {
        throw new Error("Request ID is already associated with another user account");
      }
      return existing;
    }
    return this.insertReservationSync(params);
  }

  async getReservationByRequestId(requestId: string): Promise<ReservationRecord | undefined> {
    return this.getReservationByRequestIdSync(requestId);
  }

  private commitReservationSync(requestId: string, userId: string, actualCredits: number): ReservationRecord {
    const res = this.getReservationByRequestIdSync(requestId);
    if (!res) {
      throw new Error(`Reservation for request ${requestId} not found`);
    }
    if (res.userId !== userId) {
      throw new Error("Unauthorized access to reservation from different user");
    }
    if (res.status === "committed") {
      return res; // Idempotent no-op
    }
    if (res.status === "released") {
      throw new Error(`Cannot commit reservation ${requestId} because it has already been released`);
    }

    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE reservations
      SET status = 'committed', actual_credits = @actualCredits, committed_at = @now
      WHERE request_id = @requestId AND status = 'reserved'
    `).run({ requestId, actualCredits, now });

    return this.getReservationByRequestIdSync(requestId)!;
  }

  async commitReservation(requestId: string, userId: string, actualCredits: number): Promise<ReservationRecord> {
    return this.commitReservationSync(requestId, userId, actualCredits);
  }

  async listStaleReservations(cutoffIso: string): Promise<ReservationRecord[]> {
    const rows = this.db
      .prepare(`SELECT * FROM reservations WHERE status = 'reserved' AND created_at < @cutoff ORDER BY created_at ASC`)
      .all({ cutoff: cutoffIso }) as Record<string, unknown>[];
    return rows.map((row) => this.mapReservationRow(row));
  }

  private releaseReservationSync(requestId: string, userId: string): ReservationRecord {
    const res = this.getReservationByRequestIdSync(requestId);
    if (!res) {
      throw new Error(`Reservation for request ${requestId} not found`);
    }
    if (res.userId !== userId) {
      throw new Error("Unauthorized access to reservation from different user");
    }
    if (res.status === "released") {
      return res; // Idempotent no-op
    }
    if (res.status === "committed") {
      throw new Error(`Cannot release reservation ${requestId} because it has already been committed`);
    }

    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE reservations
      SET status = 'released', released_at = @now
      WHERE request_id = @requestId AND status = 'reserved'
    `).run({ requestId, now });

    return this.getReservationByRequestIdSync(requestId)!;
  }

  async releaseReservation(requestId: string, userId: string): Promise<ReservationRecord> {
    return this.releaseReservationSync(requestId, userId);
  }

  // --- Authoritative Reservations (atomic compound money operations) ---

  async reserveCredits(params: {
    requestId: string;
    userId: string;
    providerId: string;
    modelId: string;
    reservedCredits: number;
    description?: string;
    metadata?: Record<string, unknown>;
    maxConcurrentTasks?: number;
  }): Promise<{ reservation: ReservationRecord; balanceAfter: number; created: boolean }> {

    const existing = this.getReservationByRequestIdSync(params.requestId);
    if (existing) {
      if (existing.userId !== params.userId) {
        throw new Error("Request ID is already associated with another user account");
      }
      return { reservation: existing, balanceAfter: this.getCreditBalanceSync(params.userId), created: false };
    }

    return this.txSync(() => {
      const existingInTx = this.getReservationByRequestIdSync(params.requestId);
      if (existingInTx) {
        if (existingInTx.userId !== params.userId) {
          throw new Error("Request ID is already associated with another user account");
        }
        return { reservation: existingInTx, balanceAfter: this.getCreditBalanceSync(params.userId), created: false };
      }

      if (params.maxConcurrentTasks !== undefined && params.maxConcurrentTasks > 0) {
        const active = this.getActiveReservationCountSync(params.userId);
        if (active >= params.maxConcurrentTasks) {
          throw new Error(`Concurrent task limit reached (active: ${active}, limit: ${params.maxConcurrentTasks})`);
        }
      }

      const balance = this.getCreditBalanceSync(params.userId);
      if (balance < params.reservedCredits) {
        throw new Error(`Insufficient credit balance for reservation (available: ${balance}, required: ${params.reservedCredits})`);
      }

      const reservation = this.insertReservationSync(params);
      const ledger = this.appendLedgerSync({
        userId: params.userId,
        amount: -params.reservedCredits,
        eventType: "CREDIT_RESERVED",
        requestId: params.requestId,
        description: params.description ?? `Budget reservation for request ${params.requestId}`,
        metadata: { reservationId: reservation.id, providerId: params.providerId, modelId: params.modelId, ...(params.metadata ?? {}) },
      });
      return { reservation, balanceAfter: ledger.balanceAfter, created: true };
    });
  }


  async settleReservation(params: {
    requestId: string;
    userId: string;
    actualCredits: number;
    settleDescription?: string;
  }): Promise<{ reservation: ReservationRecord; transitioned: boolean; balanceAfter: number }> {
    const res = this.getReservationByRequestIdSync(params.requestId);
    if (!res) {
      throw new Error(`Reservation for request ${params.requestId} not found`);
    }
    if (res.userId !== params.userId) {
      throw new Error("Unauthorized access to reservation from different user");
    }
    if (res.status === "released") {
      throw new Error(`Cannot commit reservation ${params.requestId} because it has already been released`);
    }
    if (res.status === "committed") {
      return { reservation: res, transitioned: false, balanceAfter: this.getCreditBalanceSync(params.userId) };
    }

    return this.txSync(() => {
      const reservation = this.commitReservationSync(params.requestId, params.userId, params.actualCredits);
      const diff = reservation.reservedCredits - params.actualCredits;
      let balanceAfter = this.getCreditBalanceSync(params.userId);

      if (diff > 0) {
        const release = this.appendLedgerSync({
          userId: params.userId,
          amount: diff,
          eventType: "CREDIT_RELEASED",
          requestId: params.requestId,
          description: params.settleDescription ?? `Release unused reservation for ${params.requestId}`,
          metadata: { reservedCredits: reservation.reservedCredits, actualCredits: params.actualCredits },
        });
        balanceAfter = release.balanceAfter;
      } else if (diff < 0) {
        const extraCharge = Math.min(Math.abs(diff), balanceAfter);
        if (extraCharge > 0) {
          const charge = this.appendLedgerSync({
            userId: params.userId,
            amount: -extraCharge,
            eventType: "CREDIT_USED",
            requestId: params.requestId,
            description: `Additional usage settlement for ${params.requestId}`,
            metadata: { reservedCredits: reservation.reservedCredits, actualCredits: params.actualCredits },
          });
          balanceAfter = charge.balanceAfter;
        }
      }

      return { reservation, transitioned: true, balanceAfter };
    });
  }

  async releaseReservationCredits(params: {
    requestId: string;
    userId: string;
    reason?: string;
  }): Promise<{ reservation: ReservationRecord; transitioned: boolean; refundedCredits: number; balanceAfter: number }> {
    const res = this.getReservationByRequestIdSync(params.requestId);
    if (!res) {
      throw new Error(`Reservation for request ${params.requestId} not found`);
    }
    if (res.userId !== params.userId) {
      throw new Error("Unauthorized access to reservation from different user");
    }
    if (res.status === "committed") {
      throw new Error(`Cannot release reservation ${params.requestId} because it has already been committed`);
    }
    if (res.status === "released") {
      return { reservation: res, transitioned: false, refundedCredits: res.reservedCredits, balanceAfter: this.getCreditBalanceSync(params.userId) };
    }

    return this.txSync(() => {
      const reservation = this.releaseReservationSync(params.requestId, params.userId);
      const release = this.appendLedgerSync({
        userId: params.userId,
        amount: reservation.reservedCredits,
        eventType: "CREDIT_RELEASED",
        requestId: params.requestId,
        description: `Cancel and release reservation: ${params.reason ?? "Request failed"}`,
      });
      return { reservation, transitioned: true, refundedCredits: reservation.reservedCredits, balanceAfter: release.balanceAfter };
    });
  }

  // --- Hosted Requests ---

  async createHostedRequest(req: { id: string; userId: string; providerId: string; modelId: string; estimatedCredits: number }): Promise<HostedRequestRecord> {
    const now = new Date().toISOString();
    const record: HostedRequestRecord = {
      id: req.id,
      userId: req.userId,
      status: "pending",
      estimatedCredits: req.estimatedCredits,
      actualCredits: 0,
      providerId: req.providerId,
      modelId: req.modelId,
      createdAt: now,
      completedAt: null,
    };
    this.db.prepare(`
      INSERT INTO hosted_requests (id, user_id, status, estimated_credits, actual_credits, provider_id, model_id, created_at, completed_at)
      VALUES (@id, @userId, @status, @estimatedCredits, @actualCredits, @providerId, @modelId, @createdAt, @completedAt)
      ON CONFLICT(id) DO NOTHING
    `).run({
      id: record.id,
      userId: record.userId,
      status: record.status,
      estimatedCredits: record.estimatedCredits,
      actualCredits: record.actualCredits,
      providerId: record.providerId,
      modelId: record.modelId,
      createdAt: record.createdAt,
      completedAt: null,
    });
    return record;
  }

  private getHostedRequestSync(id: string): HostedRequestRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM hosted_requests WHERE id = @id`).get({ id }) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      status: row.status as HostedRequestRecord["status"],
      estimatedCredits: Number(row.estimated_credits),
      actualCredits: Number(row.actual_credits),
      providerId: String(row.provider_id),
      modelId: String(row.model_id),
      createdAt: String(row.created_at),
      completedAt: row.completed_at ? String(row.completed_at) : null,
    };
  }

  async getHostedRequest(id: string): Promise<HostedRequestRecord | undefined> {
    return this.getHostedRequestSync(id);
  }

  async updateHostedRequest(id: string, status: HostedRequestRecord["status"], actualCredits = 0): Promise<void> {
    const existing = this.getHostedRequestSync(id);
    if (existing) {
      if (existing.status === "completed" && (status === "failed" || status === "cancelled")) {
        throw new Error(`Illegal state transition from ${existing.status} to ${status}`);
      }
      if ((existing.status === "failed" || existing.status === "cancelled") && status === "completed") {
        throw new Error(`Illegal state transition from ${existing.status} to ${status}`);
      }
    }
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE hosted_requests
      SET status = @status, actual_credits = @actualCredits, completed_at = @now
      WHERE id = @id
    `).run({ id, status, actualCredits, now });
  }

  // --- Usage Periods ---

  async getOrCreateCurrentUsagePeriod(userId: string, allowanceAmount = 500_000, now: Date = new Date()): Promise<{ period: UsagePeriodRecord; grantedNewAllowance: boolean }> {
    const nowIso = now.toISOString();
    const activeRow = this.db.prepare(`
      SELECT * FROM usage_periods
      WHERE user_id = @userId AND period_start <= @nowIso AND period_end > @nowIso
      ORDER BY period_start DESC LIMIT 1
    `).get({ userId, nowIso }) as Record<string, unknown> | undefined;

    if (activeRow) {
      return {
        period: {
          id: String(activeRow.id),
          userId: String(activeRow.user_id),
          periodStart: String(activeRow.period_start),
          periodEnd: String(activeRow.period_end),
          freeAllowanceGranted: Number(activeRow.free_allowance_granted),
          creditsUsed: Number(activeRow.credits_used),
          createdAt: String(activeRow.created_at),
          updatedAt: String(activeRow.updated_at),
        },
        grantedNewAllowance: false,
      };
    }

    return this.txSync(() => {
      // Create new usage period (e.g. 30 days) and grant recurring allowance
      const periodStart = nowIso;
      const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const id = randomUUID();

      this.db.prepare(`
        INSERT INTO usage_periods (id, user_id, period_start, period_end, free_allowance_granted, credits_used, created_at, updated_at)
        VALUES (@id, @userId, @periodStart, @periodEnd, @freeAllowanceGranted, 0, @nowIso, @nowIso)
      `).run({
        id,
        userId,
        periodStart,
        periodEnd,
        freeAllowanceGranted: allowanceAmount,
        nowIso,
      });

      if (allowanceAmount > 0) {
        this.appendLedgerSync({
          userId,
          amount: allowanceAmount,
          eventType: "FREE_ALLOWANCE_GRANTED",
          description: `Monthly Free Tier Allowance for period ${periodStart.slice(0, 10)} to ${periodEnd.slice(0, 10)}`,
          metadata: { usagePeriodId: id },
        });
      }

      const newRow = this.db.prepare(`SELECT * FROM usage_periods WHERE id = @id`).get({ id }) as Record<string, unknown>;
      return {
        period: {
          id: String(newRow.id),
          userId: String(newRow.user_id),
          periodStart: String(newRow.period_start),
          periodEnd: String(newRow.period_end),
          freeAllowanceGranted: Number(newRow.free_allowance_granted),
          creditsUsed: Number(newRow.credits_used),
          createdAt: String(newRow.created_at),
          updatedAt: String(newRow.updated_at),
        },
        grantedNewAllowance: true,
      };
    });
  }

  // --- OAuth Transactions ---

  async createOAuthTransaction(params: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
    deviceName?: string;
    expiresInSeconds?: number;
  }): Promise<OAuthTransactionRecord> {
    const now = new Date();
    const expires = new Date(now.getTime() + (params.expiresInSeconds ?? 600) * 1000);
    const record: OAuthTransactionRecord = {
      id: randomUUID(),
      state: params.state,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      deviceName: params.deviceName,
      expiresAt: expires.toISOString(),
      usedAt: null,
      createdAt: now.toISOString(),
    };

    this.db.prepare(`
      INSERT INTO oauth_transactions (id, state, code_challenge, redirect_uri, device_name, expires_at, used_at, created_at)
      VALUES (@id, @state, @codeChallenge, @redirectUri, @deviceName, @expiresAt, @usedAt, @createdAt)
    `).run({
      id: record.id,
      state: record.state,
      codeChallenge: record.codeChallenge,
      redirectUri: record.redirectUri,
      deviceName: record.deviceName ?? null,
      expiresAt: record.expiresAt,
      usedAt: null,
      createdAt: record.createdAt,
    });

    return record;
  }

  private getOAuthTransactionSync(state: string): OAuthTransactionRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM oauth_transactions WHERE state = @state`).get({ state }) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      state: String(row.state),
      codeChallenge: String(row.code_challenge),
      redirectUri: String(row.redirect_uri),
      deviceName: row.device_name ? String(row.device_name) : undefined,
      expiresAt: String(row.expires_at),
      usedAt: row.used_at ? String(row.used_at) : null,
      createdAt: String(row.created_at),
    };
  }

  async getOAuthTransaction(state: string): Promise<OAuthTransactionRecord | undefined> {
    return this.getOAuthTransactionSync(state);
  }

  async consumeOAuthTransaction(state: string): Promise<OAuthTransactionRecord> {
    const tx = this.getOAuthTransactionSync(state);
    if (!tx) {
      throw new Error("OAuth transaction not found");
    }
    if (tx.usedAt) {
      throw new Error("OAuth transaction already consumed (replay detected)");
    }
    if (new Date(tx.expiresAt).getTime() < Date.now()) {
      throw new Error("OAuth transaction expired");
    }

    // Single-use consumption: only the caller that flips used_at from NULL wins the row.
    const now = new Date().toISOString();
    const result = this.db.prepare(`UPDATE oauth_transactions SET used_at = @now WHERE state = @state AND used_at IS NULL`).run({ state, now });
    if (Number(result.changes) === 0) {
      throw new Error("OAuth transaction already consumed (replay detected)");
    }
    return { ...tx, usedAt: now };
  }

  // --- Billing Webhook Events ---

  async isWebhookProcessed(stripeEventId: string): Promise<boolean> {
    const row = this.db.prepare(`SELECT * FROM billing_webhook_events WHERE stripe_event_id = @stripeEventId AND status = 'processed'`).get({ stripeEventId });
    return !!row;
  }

  async claimWebhookEvent(params: { stripeEventId: string; eventType: string }): Promise<{ claimed: boolean }> {
    const now = new Date().toISOString();
    const id = randomUUID();
    // Atomic claim: exactly one caller inserts the row; every duplicate delivery conflicts and is skipped.
    const result = this.db.prepare(`
      INSERT INTO billing_webhook_events (id, stripe_event_id, event_type, processed_at, status, payload, created_at)
      VALUES (@id, @stripeEventId, @eventType, @processedAt, 'processed', NULL, @createdAt)
      ON CONFLICT(stripe_event_id) DO NOTHING
    `).run({
      id,
      stripeEventId: params.stripeEventId,
      eventType: params.eventType,
      processedAt: now,
      createdAt: now,
    });
    return { claimed: Number(result.changes) > 0 };
  }

  async recordWebhookEvent(params: {
    stripeEventId: string;
    eventType: string;
    status: "processed" | "failed" | "ignored";
    payload?: Record<string, unknown>;
  }): Promise<BillingWebhookEventRecord> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const record: BillingWebhookEventRecord = {
      id,
      stripeEventId: params.stripeEventId,
      eventType: params.eventType,
      processedAt: now,
      status: params.status,
      payload: params.payload,
      createdAt: now,
    };
    this.db.prepare(`
      INSERT INTO billing_webhook_events (id, stripe_event_id, event_type, processed_at, status, payload, created_at)
      VALUES (@id, @stripeEventId, @eventType, @processedAt, @status, @payload, @createdAt)
      ON CONFLICT(stripe_event_id) DO UPDATE SET
        status = excluded.status,
        processed_at = excluded.processed_at,
        payload = excluded.payload
    `).run({
      id: record.id,
      stripeEventId: record.stripeEventId,
      eventType: record.eventType,
      processedAt: record.processedAt,
      status: record.status,
      payload: record.payload ? JSON.stringify(record.payload) : null,
      createdAt: record.createdAt,
    });
    return record;
  }

  // --- Account Settings ---

  private getAccountSettingsSync(userId: string): AccountSettingsRecord {
    const row = this.db.prepare(`SELECT * FROM account_settings WHERE user_id = @userId`).get({ userId }) as Record<string, unknown> | undefined;
    if (row) {
      return {
        id: String(row.id),
        userId: String(row.user_id),
        privacyMode: row.privacy_mode as AccountSettingsRecord["privacyMode"],
        autoTopUpEnabled: Boolean(row.auto_top_up_enabled),
        spendLimitUsd: Number(row.spend_limit_usd),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      };
    }
    const now = new Date().toISOString();
    const record: AccountSettingsRecord = {
      id: randomUUID(),
      userId,
      privacyMode: "STANDARD",
      autoTopUpEnabled: false,
      spendLimitUsd: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO account_settings (id, user_id, privacy_mode, auto_top_up_enabled, spend_limit_usd, created_at, updated_at)
      VALUES (@id, @userId, @privacyMode, @autoTopUpEnabled, @spendLimitUsd, @createdAt, @updatedAt)
      ON CONFLICT(user_id) DO NOTHING
    `).run({
      id: record.id,
      userId: record.userId,
      privacyMode: record.privacyMode,
      autoTopUpEnabled: record.autoTopUpEnabled ? 1 : 0,
      spendLimitUsd: record.spendLimitUsd,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
    return record;
  }

  async getAccountSettings(userId: string): Promise<AccountSettingsRecord> {
    return this.getAccountSettingsSync(userId);
  }

  async upsertAccountSettings(settings: Partial<AccountSettingsRecord> & { userId: string }): Promise<AccountSettingsRecord> {
    const current = this.getAccountSettingsSync(settings.userId);
    const now = new Date().toISOString();
    const updated: AccountSettingsRecord = {
      ...current,
      ...settings,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO account_settings (id, user_id, privacy_mode, auto_top_up_enabled, spend_limit_usd, created_at, updated_at)
      VALUES (@id, @userId, @privacyMode, @autoTopUpEnabled, @spendLimitUsd, @createdAt, @updatedAt)
      ON CONFLICT(user_id) DO UPDATE SET
        privacy_mode = excluded.privacy_mode,
        auto_top_up_enabled = excluded.auto_top_up_enabled,
        spend_limit_usd = excluded.spend_limit_usd,
        updated_at = excluded.updated_at
    `).run({
      id: updated.id,
      userId: updated.userId,
      privacyMode: updated.privacyMode,
      autoTopUpEnabled: updated.autoTopUpEnabled ? 1 : 0,
      spendLimitUsd: updated.spendLimitUsd,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    });
    return this.getAccountSettingsSync(settings.userId);
  }

  // --- Abuse Events ---

  async recordAbuseEvent(params: { userId?: string; ipAddress?: string; eventType: string; details?: string }): Promise<AbuseEventRecord> {
    const now = new Date().toISOString();
    const record: AbuseEventRecord = {
      id: randomUUID(),
      userId: params.userId,
      ipAddress: params.ipAddress,
      eventType: params.eventType,
      details: params.details,
      createdAt: now,
    };
    this.db.prepare(`
      INSERT INTO abuse_events (id, user_id, ip_address, event_type, details, created_at)
      VALUES (@id, @userId, @ipAddress, @eventType, @details, @createdAt)
    `).run({
      id: record.id,
      userId: record.userId ?? null,
      ipAddress: record.ipAddress ?? null,
      eventType: record.eventType,
      details: record.details ?? null,
      createdAt: record.createdAt,
    });
    return record;
  }

  // --- Health & Concurrency ---

  async ping(): Promise<boolean> {
    try {
      this.db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  private getActiveReservationCountSync(userId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM reservations WHERE user_id = @userId AND status = 'reserved'`).get({ userId }) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  async getActiveReservationCount(userId: string): Promise<number> {
    return this.getActiveReservationCountSync(userId);
  }
}

