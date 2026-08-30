import { randomUUID } from "node:crypto";
import pg from "pg";
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

const { Pool } = pg;
const MIGRATION_LOCK_NAMESPACE = 1_807_468_221;
const MIGRATION_LOCK_KEY = 1_247_271_903;

export interface PostgresCloudDatabaseOptions {
  connectionString?: string;
  /** Enables certificate-validated TLS for remote PostgreSQL connections. */
  ssl?: boolean;
  pool?: pg.Pool;
}

export class PostgresCloudDatabase implements ICloudDatabase {
  private readonly pool: pg.Pool;
  private readonly isCustomPool: boolean;
  private initialized = false;
  private initPromise?: Promise<void>;

  constructor(options: PostgresCloudDatabaseOptions = {}) {
    const connectionString = options.connectionString || process.env.DATABASE_URL;
    if (!connectionString && !options.pool) {
      throw new Error("PostgresCloudDatabase requires a valid connectionString or DATABASE_URL");
    }
    if (options.pool) {
      this.pool = options.pool;
      this.isCustomPool = true;
    } else {
      this.pool = new Pool({
        connectionString,
        ssl: options.ssl === undefined ? undefined : options.ssl ? { rejectUnauthorized: true } : false,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      });
      this.isCustomPool = false;
    }

    // An idle connection error is emitted by pg's pool; leaving it unhandled terminates Node.
    // Individual operations still fail closed and readiness reports the database as unavailable.
    this.pool.on?.("error", () => {});
  }

  /**
   * Public boot hook (ICloudDatabase.init). Runs the async schema migration exactly once, even under
   * concurrent callers. Without this a fresh Postgres database would have no tables and every query
   * would fail — the server MUST await this before it starts listening.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = this.initSchema().then(() => {
        this.initialized = true;
      });
    }
    return this.initPromise;
  }

  async initSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Multiple Cloud instances can boot against a brand-new database at once. PostgreSQL's
      // IF NOT EXISTS is not sufficient for concurrent CREATE TABLE statements, so serialize the
      // whole migration + seed pass with a transaction-independent advisory lock on this session.
      await client.query("SELECT pg_advisory_lock($1, $2)", [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_KEY]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          checksum VARCHAR(64) NOT NULL,
          applied_at VARCHAR(64) NOT NULL
        );
      `);

      for (const migration of MIGRATIONS) {
        const res = await client.query(`SELECT checksum FROM schema_migrations WHERE version = $1`, [migration.version]);
        if (res.rows.length > 0) {
          if (res.rows[0].checksum !== migration.checksum) {
            throw new Error(`Database migration checksum mismatch for version ${migration.version} (${migration.name}). Database integrity compromised.`);
          }
        } else {
          await client.query(migration.postgresUp);
          await client.query(
            `INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES ($1, $2, $3, $4)`,
            [migration.version, migration.name, migration.checksum, new Date().toISOString()],
          );
        }
      }

      for (const plan of DEFAULT_PLANS) {
        await client.query(
          `INSERT INTO plans (id, name, monthly_credit_allowance, max_concurrent_tasks, max_task_spend_credits, features, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT(id) DO UPDATE SET
             name = EXCLUDED.name,
             monthly_credit_allowance = EXCLUDED.monthly_credit_allowance,
             max_concurrent_tasks = EXCLUDED.max_concurrent_tasks,
             max_task_spend_credits = EXCLUDED.max_task_spend_credits,
             features = EXCLUDED.features`,
          [plan.id, plan.name, plan.monthlyCreditAllowance, plan.maxConcurrentTasks, plan.maxTaskSpendCredits, plan.features, plan.createdAt],
        );
      }
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1, $2)", [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_KEY]);
      } finally {
        client.release();
      }
    }
  }

  async close(): Promise<void> {
    if (!this.isCustomPool) {
      await this.pool.end();
    }
  }

  /**
   * Helper to execute a sequence of queries within a dedicated connection transaction.
   * Automatically executes BEGIN, COMMIT, and ROLLBACK upon error.
   */
  async withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  // --- Row Mappers ---

  private mapUserRow(row: Record<string, unknown>): UserRecord {
    return {
      id: String(row.id),
      displayName: String(row.display_name),
      avatarUrl: row.avatar_url ? String(row.avatar_url) : undefined,
      primaryIdentity: String(row.primary_identity),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapIdentityRow(row: Record<string, unknown>): IdentityRecord {
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

  private mapDeviceSessionRow(row: Record<string, unknown>): DeviceSessionRecord {
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

  private mapPlanRow(row: Record<string, unknown>): PlanRecord {
    return {
      id: String(row.id),
      name: String(row.name),
      monthlyCreditAllowance: Number(row.monthly_credit_allowance),
      maxConcurrentTasks: Number(row.max_concurrent_tasks),
      maxTaskSpendCredits: Number(row.max_task_spend_credits),
      features: typeof row.features === "string" ? JSON.parse(row.features) : row.features,
      createdAt: String(row.created_at),
    };
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

  private mapEntitlementRow(row: Record<string, unknown>): EntitlementRecord {
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

  private mapCreditLedgerRow(row: Record<string, unknown>): CreditLedgerRecord {
    const rawMetadata = row.metadata;
    let metadata: Record<string, unknown> | undefined;
    if (rawMetadata) {
      metadata = typeof rawMetadata === "string" ? JSON.parse(rawMetadata) : (rawMetadata as Record<string, unknown>);
    }
    return {
      id: String(row.id),
      userId: String(row.user_id),
      amount: Number(row.amount),
      balanceAfter: Number(row.balance_after),
      eventType: (row.eventtype ?? row.eventType) as CreditEventType,
      requestId: row.request_id ? String(row.request_id) : undefined,
      description: row.description ? String(row.description) : undefined,
      metadata,
      createdAt: String(row.created_at),
    };
  }

  private mapUsageEventRow(row: Record<string, unknown>): UsageEventRecord {
    return {
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
    };
  }

  private mapUsagePeriodRow(row: Record<string, unknown>): UsagePeriodRecord {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      periodStart: String(row.period_start),
      periodEnd: String(row.period_end),
      freeAllowanceGranted: Number(row.free_allowance_granted),
      creditsUsed: Number(row.credits_used),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
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

  private mapHostedRequestRow(row: Record<string, unknown>): HostedRequestRecord {
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

  private mapOAuthTransactionRow(row: Record<string, unknown>): OAuthTransactionRecord {
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

  private mapBillingWebhookRow(row: Record<string, unknown>): BillingWebhookEventRecord {
    const rawPayload = row.payload;
    let payload: Record<string, unknown> | undefined;
    if (rawPayload) {
      payload = typeof rawPayload === "string" ? JSON.parse(rawPayload) : (rawPayload as Record<string, unknown>);
    }
    return {
      id: String(row.id),
      stripeEventId: String(row.stripe_event_id),
      eventType: String(row.event_type),
      processedAt: String(row.processed_at),
      status: row.status as BillingWebhookEventRecord["status"],
      payload,
      createdAt: String(row.created_at),
    };
  }

  private mapAccountSettingsRow(row: Record<string, unknown>): AccountSettingsRecord {
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
    await this.pool.query(
      `INSERT INTO users (id, display_name, avatar_url, primary_identity, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [user.id, user.displayName, user.avatarUrl ?? null, user.primaryIdentity, user.createdAt, user.updatedAt],
    );
    return user;
  }

  async getUserById(id: string): Promise<UserRecord | undefined> {
    const res = await this.pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
    if (res.rows.length === 0) return undefined;
    return this.mapUserRow(res.rows[0]);
  }

  async getUserByPrimaryIdentity(primaryIdentity: string): Promise<UserRecord | undefined> {
    const res = await this.pool.query(`SELECT * FROM users WHERE primary_identity = $1`, [primaryIdentity]);
    if (res.rows.length === 0) return undefined;
    return this.mapUserRow(res.rows[0]);
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
    await this.pool.query(
      `INSERT INTO identities (id, user_id, provider, provider_user_id, provider_email, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [identity.id, identity.userId, identity.provider, identity.providerUserId, identity.providerEmail ?? null, identity.createdAt, identity.updatedAt],
    );
    return identity;
  }

  async getIdentityByProvider(provider: string, providerUserId: string): Promise<IdentityRecord | undefined> {
    const res = await this.pool.query(`SELECT * FROM identities WHERE provider = $1 AND provider_user_id = $2`, [provider, providerUserId]);
    if (res.rows.length === 0) return undefined;
    return this.mapIdentityRow(res.rows[0]);
  }

  // --- Device Sessions ---

  private async createDeviceSessionWithClient(client: pg.PoolClient | pg.Pool, params: {
    userId: string;
    deviceName?: string;
    refreshTokenHash: string;
    ipAddress?: string;
    userAgent?: string;
    expiresInSeconds?: number;
  }): Promise<DeviceSessionRecord> {
    const now = new Date();
    const expires = new Date(now.getTime() + (params.expiresInSeconds ?? 30 * 24 * 60 * 60) * 1000);
    const session: DeviceSessionRecord = {
      id: randomUUID(),
      userId: params.userId,
      deviceName: params.deviceName ?? "Unknown Device",
      refreshTokenHash: params.refreshTokenHash,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      expiresAt: expires.toISOString(),
      revokedAt: null,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
    };
    await client.query(
      `INSERT INTO device_sessions (id, user_id, device_name, refresh_token_hash, ip_address, user_agent, expires_at, revoked_at, created_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        session.id,
        session.userId,
        session.deviceName,
        session.refreshTokenHash,
        session.ipAddress ?? null,
        session.userAgent ?? null,
        session.expiresAt,
        null,
        session.createdAt,
        session.lastSeenAt,
      ],
    );
    return session;
  }

  async createDeviceSession(params: {
    userId: string;
    deviceName?: string;
    refreshTokenHash: string;
    ipAddress?: string;
    userAgent?: string;
    expiresInSeconds?: number;
  }): Promise<DeviceSessionRecord> {
    return this.createDeviceSessionWithClient(this.pool, params);
  }

  async getDeviceSessionByTokenHash(refreshTokenHash: string): Promise<DeviceSessionRecord | undefined> {
    const res = await this.pool.query(`SELECT * FROM device_sessions WHERE refresh_token_hash = $1`, [refreshTokenHash]);
    if (res.rows.length === 0) return undefined;
    return this.mapDeviceSessionRow(res.rows[0]);
  }

  async updateDeviceSessionLastSeen(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.pool.query(`UPDATE device_sessions SET last_seen_at = $1 WHERE id = $2`, [now, id]);
  }

  async revokeDeviceSession(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.pool.query(`UPDATE device_sessions SET revoked_at = $1 WHERE id = $2`, [now, id]);
  }

  async revokeAllUserDeviceSessions(userId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.pool.query(`UPDATE device_sessions SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL`, [now, userId]);
  }

  async rotateDeviceSession(params: {
    oldTokenHash: string;
    newRefreshTokenHash: string;
    deviceName?: string;
    ipAddress?: string;
    userAgent?: string;
    expiresInSeconds?: number;
  }): Promise<{ user: UserRecord; session: DeviceSessionRecord }> {
    return this.withTx(async (client) => {
      const sessionRes = await client.query(`SELECT * FROM device_sessions WHERE refresh_token_hash = $1 FOR UPDATE`, [params.oldTokenHash]);
      if (sessionRes.rows.length === 0) {
        throw new Error("Invalid refresh token");
      }
      const session = this.mapDeviceSessionRow(sessionRes.rows[0]);
      if (session.revokedAt) {
        // Token reuse / replay detected: revoke all sessions for this user
        const now = new Date().toISOString();
        await client.query(`UPDATE device_sessions SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL`, [now, session.userId]);
        throw new Error("Device session has been revoked (replay detected)");
      }
      if (new Date(session.expiresAt).getTime() < Date.now()) {
        throw new Error("Device session has expired");
      }

      const userRes = await client.query(`SELECT * FROM users WHERE id = $1`, [session.userId]);
      if (userRes.rows.length === 0) {
        throw new Error("User associated with session not found");
      }
      const user = this.mapUserRow(userRes.rows[0]);

      const now = new Date().toISOString();
      const revokeRes = await client.query(`UPDATE device_sessions SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL`, [now, session.id]);
      if (revokeRes.rowCount === 0) {
        throw new Error("Device session has been revoked (replay detected)");
      }

      const newSession = await this.createDeviceSessionWithClient(client, {
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
    const res = await this.pool.query(`SELECT * FROM plans WHERE id = $1`, [id]);
    if (res.rows.length === 0) return undefined;
    return this.mapPlanRow(res.rows[0]);
  }

  async listPlans(): Promise<PlanRecord[]> {
    const res = await this.pool.query(`SELECT * FROM plans`);
    return res.rows.map((row) => this.mapPlanRow(row));
  }

  async getSubscriptionByUserId(userId: string): Promise<SubscriptionRecord | undefined> {
    const res = await this.pool.query(`SELECT * FROM subscriptions WHERE user_id = $1`, [userId]);
    if (res.rows.length === 0) return undefined;
    return this.mapSubscriptionRow(res.rows[0]);
  }

  async getSubscriptionByStripeCustomerId(stripeCustomerId: string): Promise<SubscriptionRecord | undefined> {
    const res = await this.pool.query(`SELECT * FROM subscriptions WHERE stripe_customer_id = $1`, [stripeCustomerId]);
    if (res.rows.length === 0) return undefined;
    return this.mapSubscriptionRow(res.rows[0]);
  }

  async getSubscriptionByStripeSubscriptionId(stripeSubscriptionId: string): Promise<SubscriptionRecord | undefined> {
    const res = await this.pool.query(`SELECT * FROM subscriptions WHERE stripe_subscription_id = $1`, [stripeSubscriptionId]);
    if (res.rows.length === 0) return undefined;
    return this.mapSubscriptionRow(res.rows[0]);
  }

  async upsertSubscription(sub: Omit<SubscriptionRecord, "id" | "createdAt" | "updatedAt"> & { id?: string }): Promise<SubscriptionRecord> {
    const existing = await this.getSubscriptionByUserId(sub.userId);
    const now = new Date().toISOString();
    const id = existing?.id ?? sub.id ?? randomUUID();
    const createdAt = existing?.createdAt ?? now;

    await this.pool.query(
      `INSERT INTO subscriptions (id, user_id, plan_id, stripe_customer_id, stripe_subscription_id, status, current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (user_id) DO UPDATE SET
         plan_id = EXCLUDED.plan_id,
         stripe_customer_id = EXCLUDED.stripe_customer_id,
         stripe_subscription_id = EXCLUDED.stripe_subscription_id,
         status = EXCLUDED.status,
         current_period_start = EXCLUDED.current_period_start,
         current_period_end = EXCLUDED.current_period_end,
         cancel_at_period_end = EXCLUDED.cancel_at_period_end,
         updated_at = EXCLUDED.updated_at`,
      [
        id,
        sub.userId,
        sub.planId,
        sub.stripeCustomerId ?? null,
        sub.stripeSubscriptionId ?? null,
        sub.status,
        sub.currentPeriodStart,
        sub.currentPeriodEnd,
        sub.cancelAtPeriodEnd ? 1 : 0,
        createdAt,
        now,
      ],
    );

    const saved = await this.getSubscriptionByUserId(sub.userId);
    return saved!;
  }

  // --- Entitlements ---

  async getEntitlements(userId: string): Promise<EntitlementRecord[]> {
    const res = await this.pool.query(`SELECT * FROM entitlements WHERE user_id = $1`, [userId]);
    return res.rows.map((row) => this.mapEntitlementRow(row));
  }

  async hasEntitlement(userId: string, featureKey: FeatureKey | string): Promise<boolean> {
    const now = new Date().toISOString();
    const res = await this.pool.query(
      `SELECT id FROM entitlements
       WHERE user_id = $1 AND feature_key = $2 AND (expires_at IS NULL OR expires_at > $3)`,
      [userId, featureKey, now],
    );
    return res.rows.length > 0;
  }

  async setEntitlement(userId: string, featureKey: FeatureKey | string, grantedValue = "true", expiresAt?: string | null): Promise<EntitlementRecord> {
    const now = new Date().toISOString();
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO entitlements (id, user_id, feature_key, granted_value, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, feature_key) DO UPDATE SET
         granted_value = EXCLUDED.granted_value,
         expires_at = EXCLUDED.expires_at,
         updated_at = EXCLUDED.updated_at`,
      [id, userId, featureKey, grantedValue, expiresAt ?? null, now, now],
    );

    const res = await this.pool.query(`SELECT * FROM entitlements WHERE user_id = $1 AND feature_key = $2`, [userId, featureKey]);
    return this.mapEntitlementRow(res.rows[0]);
  }

  async removeEntitlement(userId: string, featureKey: FeatureKey | string): Promise<void> {
    await this.pool.query(`DELETE FROM entitlements WHERE user_id = $1 AND feature_key = $2`, [userId, featureKey]);
  }

  // --- Credit Ledger ---

  private async getCreditBalanceWithClient(client: pg.PoolClient | pg.Pool, userId: string): Promise<number> {
    const res = await client.query(
      `SELECT balance_after FROM credit_ledger
       WHERE user_id = $1
       ORDER BY seq DESC
       LIMIT 1`,
      [userId],
    );
    if (res.rows.length === 0) return 0;
    return Number(res.rows[0].balance_after);
  }

  async getCreditBalance(userId: string): Promise<number> {
    return this.getCreditBalanceWithClient(this.pool, userId);
  }

  private async appendLedgerWithClient(
    client: pg.PoolClient,
    params: {
      userId: string;
      amount: number;
      eventType: CreditEventType;
      requestId?: string;
      description?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<CreditLedgerRecord> {
    const currentBalance = await this.getCreditBalanceWithClient(client, params.userId);
    const newBalance = currentBalance + params.amount;
    if (newBalance < 0) {
      throw new Error(`Insufficient credit balance. Current: ${currentBalance}, required: ${Math.abs(params.amount)}`);
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    const res = await client.query(
      `INSERT INTO credit_ledger (id, user_id, amount, balance_after, eventType, request_id, description, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        id,
        params.userId,
        params.amount,
        newBalance,
        params.eventType,
        params.requestId ?? null,
        params.description ?? null,
        params.metadata ? JSON.stringify(params.metadata) : null,
        now,
      ],
    );

    return this.mapCreditLedgerRow(res.rows[0]);
  }

  async appendLedgerEvent(params: {
    userId: string;
    amount: number;
    eventType: CreditEventType;
    requestId?: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }): Promise<CreditLedgerRecord> {
    return this.withTx(async (client) => {
      // Lock user row for update
      await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [params.userId]);
      return this.appendLedgerWithClient(client, params);
    });
  }

  async listLedgerEvents(userId: string, limit = 50): Promise<CreditLedgerRecord[]> {
    const res = await this.pool.query(
      `SELECT * FROM credit_ledger
       WHERE user_id = $1
       ORDER BY seq DESC
       LIMIT $2`,
      [userId, limit],
    );
    return res.rows.map((row) => this.mapCreditLedgerRow(row));
  }

  // --- Usage Events ---

  async recordUsageEvent(event: Omit<UsageEventRecord, "id" | "createdAt"> & { id?: string }): Promise<UsageEventRecord> {
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
      cachedTokens: event.cachedTokens ?? 0,
      providerCostUsd: event.providerCostUsd,
      creditsConsumed: event.creditsConsumed,
      latencyMs: event.latencyMs,
      status: event.status,
      createdAt: now,
    };

    await this.pool.query(
      `INSERT INTO usage_events (id, request_id, user_id, session_id, turn_id, provider_id, model_id, access_class, input_tokens, output_tokens, cached_tokens, provider_cost_usd, credits_consumed, latency_ms, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        record.id,
        record.requestId,
        record.userId,
        record.sessionId ?? null,
        record.turnId ?? null,
        record.providerId,
        record.modelId,
        record.accessClass ?? null,
        record.inputTokens,
        record.outputTokens,
        record.cachedTokens,
        record.providerCostUsd,
        record.creditsConsumed,
        record.latencyMs,
        record.status,
        record.createdAt,
      ],
    );

    return record;
  }

  async listUsageEvents(userId: string, limit = 50): Promise<UsageEventRecord[]> {
    const res = await this.pool.query(
      `SELECT * FROM usage_events
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit],
    );
    return res.rows.map((row) => this.mapUsageEventRow(row));
  }

  async getDailyProviderSpendUsd(sinceIsoString?: string): Promise<number> {
    const since = sinceIsoString ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const res = await this.pool.query(
      `SELECT COALESCE(SUM(provider_cost_usd), 0) as total_spend FROM usage_events
       WHERE created_at >= $1`,
      [since],
    );
    return Number(res.rows[0]?.total_spend ?? 0);
  }

  async getUserBillingPeriodSpendUsd(userId: string, sinceIsoString?: string): Promise<number> {
    const since = sinceIsoString ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const res = await this.pool.query(
      `SELECT COALESCE(SUM(provider_cost_usd), 0) as total_spend FROM usage_events
       WHERE user_id = $1 AND created_at >= $2`,
      [userId, since],
    );
    return Number(res.rows[0]?.total_spend ?? 0);
  }

  // --- Authoritative Reservations (low-level) ---

  private async getReservationByRequestIdWithClient(client: pg.PoolClient | pg.Pool, requestId: string): Promise<ReservationRecord | undefined> {
    const res = await client.query(`SELECT * FROM reservations WHERE request_id = $1`, [requestId]);
    if (res.rows.length === 0) return undefined;
    return this.mapReservationRow(res.rows[0]);
  }

  async getReservationByRequestId(requestId: string): Promise<ReservationRecord | undefined> {
    return this.getReservationByRequestIdWithClient(this.pool, requestId);
  }

  private async insertReservationWithClient(
    client: pg.PoolClient | pg.Pool,
    params: { id?: string; requestId: string; userId: string; providerId: string; modelId: string; reservedCredits: number },
  ): Promise<ReservationRecord> {
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

    await client.query(
      `INSERT INTO reservations (id, request_id, user_id, provider_id, model_id, reserved_credits, actual_credits, status, created_at, committed_at, released_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        record.id,
        record.requestId,
        record.userId,
        record.providerId,
        record.modelId,
        record.reservedCredits,
        record.actualCredits,
        record.status,
        record.createdAt,
        null,
        null,
      ],
    );

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
    const existing = await this.getReservationByRequestId(params.requestId);
    if (existing) {
      if (existing.userId !== params.userId) {
        throw new Error("Request ID is already associated with another user account");
      }
      return existing;
    }
    return this.insertReservationWithClient(this.pool, params);
  }

  async commitReservation(requestId: string, userId: string, actualCredits: number): Promise<ReservationRecord> {
    return this.withTx(async (client) => {
      const resRes = await client.query(`SELECT * FROM reservations WHERE request_id = $1 FOR UPDATE`, [requestId]);
      if (resRes.rows.length === 0) {
        throw new Error(`Reservation for request ${requestId} not found`);
      }
      const res = this.mapReservationRow(resRes.rows[0]);
      if (res.userId !== userId) {
        throw new Error("Unauthorized access to reservation from different user");
      }
      if (res.status === "committed") {
        return res;
      }
      if (res.status === "released") {
        throw new Error(`Cannot commit reservation ${requestId} because it has already been released`);
      }

      const now = new Date().toISOString();
      const updateRes = await client.query(
        `UPDATE reservations
         SET status = 'committed', actual_credits = $1, committed_at = $2
         WHERE request_id = $3 AND status = 'reserved'
         RETURNING *`,
        [actualCredits, now, requestId],
      );

      if (updateRes.rows.length === 0) {
        const current = await this.getReservationByRequestIdWithClient(client, requestId);
        return current!;
      }

      return this.mapReservationRow(updateRes.rows[0]);
    });
  }

  async releaseReservation(requestId: string, userId: string): Promise<ReservationRecord> {
    return this.withTx(async (client) => {
      const resRes = await client.query(`SELECT * FROM reservations WHERE request_id = $1 FOR UPDATE`, [requestId]);
      if (resRes.rows.length === 0) {
        throw new Error(`Reservation for request ${requestId} not found`);
      }
      const res = this.mapReservationRow(resRes.rows[0]);
      if (res.userId !== userId) {
        throw new Error("Unauthorized access to reservation from different user");
      }
      if (res.status === "released") {
        return res;
      }
      if (res.status === "committed") {
        throw new Error(`Cannot release reservation ${requestId} because it has already been committed`);
      }

      const now = new Date().toISOString();
      const updateRes = await client.query(
        `UPDATE reservations
         SET status = 'released', released_at = $1
         WHERE request_id = $2 AND status = 'reserved'
         RETURNING *`,
        [now, requestId],
      );

      if (updateRes.rows.length === 0) {
        const current = await this.getReservationByRequestIdWithClient(client, requestId);
        return current!;
      }

      return this.mapReservationRow(updateRes.rows[0]);
    });
  }

  async listStaleReservations(cutoffIso: string): Promise<ReservationRecord[]> {
    const res = await this.pool.query(
      `SELECT * FROM reservations
       WHERE status = 'reserved' AND created_at < $1
       ORDER BY created_at ASC`,
      [cutoffIso],
    );
    return res.rows.map((row) => this.mapReservationRow(row));
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
    const existing = await this.getReservationByRequestId(params.requestId);
    if (existing) {
      if (existing.userId !== params.userId) {
        throw new Error("Request ID is already associated with another user account");
      }
      const currentBalance = await this.getCreditBalance(params.userId);
      return { reservation: existing, balanceAfter: currentBalance, created: false };
    }

    return this.withTx(async (client) => {
      // Lock the user row to serialize ledger operations per user and prevent concurrent overspend / race conditions
      await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [params.userId]);

      const existingInTx = await this.getReservationByRequestIdWithClient(client, params.requestId);
      if (existingInTx) {
        if (existingInTx.userId !== params.userId) {
          throw new Error("Request ID is already associated with another user account");
        }
        const balance = await this.getCreditBalanceWithClient(client, params.userId);
        return { reservation: existingInTx, balanceAfter: balance, created: false };
      }

      if (params.maxConcurrentTasks !== undefined && params.maxConcurrentTasks > 0) {
        const activeRes = await client.query(
          `SELECT COUNT(*) FROM reservations WHERE user_id = $1 AND status = 'reserved'`,
          [params.userId],
        );
        const activeCount = Number(activeRes.rows[0].count);
        if (activeCount >= params.maxConcurrentTasks) {
          throw new Error(`Concurrent task limit reached (active: ${activeCount}, limit: ${params.maxConcurrentTasks})`);
        }
      }

      const reservation = await this.insertReservationWithClient(client, params);
      const ledger = await this.appendLedgerWithClient(client, {
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
    return this.withTx(async (client) => {
      const resRes = await client.query(`SELECT * FROM reservations WHERE request_id = $1 FOR UPDATE`, [params.requestId]);
      if (resRes.rows.length === 0) {
        throw new Error(`Reservation for request ${params.requestId} not found`);
      }
      const res = this.mapReservationRow(resRes.rows[0]);
      if (res.userId !== params.userId) {
        throw new Error("Unauthorized access to reservation from different user");
      }
      if (res.status === "released") {
        throw new Error(`Cannot commit reservation ${params.requestId} because it has already been released`);
      }
      if (res.status === "committed") {
        const balance = await this.getCreditBalanceWithClient(client, params.userId);
        return { reservation: res, transitioned: false, balanceAfter: balance };
      }

      await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [params.userId]);

      const now = new Date().toISOString();
      const updateRes = await client.query(
        `UPDATE reservations
         SET status = 'committed', actual_credits = $1, committed_at = $2
         WHERE request_id = $3 AND status = 'reserved'
         RETURNING *`,
        [params.actualCredits, now, params.requestId],
      );

      if (updateRes.rows.length === 0) {
        const currentRes = await this.getReservationByRequestIdWithClient(client, params.requestId);
        const balance = await this.getCreditBalanceWithClient(client, params.userId);
        return { reservation: currentRes!, transitioned: false, balanceAfter: balance };
      }

      const updatedReservation = this.mapReservationRow(updateRes.rows[0]);
      const diff = updatedReservation.reservedCredits - params.actualCredits;
      let balanceAfter = await this.getCreditBalanceWithClient(client, params.userId);

      if (diff > 0) {
        const release = await this.appendLedgerWithClient(client, {
          userId: params.userId,
          amount: diff,
          eventType: "CREDIT_RELEASED",
          requestId: params.requestId,
          description: params.settleDescription ?? `Release unused reservation for ${params.requestId}`,
          metadata: { reservedCredits: updatedReservation.reservedCredits, actualCredits: params.actualCredits },
        });
        balanceAfter = release.balanceAfter;
      } else if (diff < 0) {
        const extraCharge = Math.min(Math.abs(diff), balanceAfter);
        if (extraCharge > 0) {
          const charge = await this.appendLedgerWithClient(client, {
            userId: params.userId,
            amount: -extraCharge,
            eventType: "CREDIT_USED",
            requestId: params.requestId,
            description: `Additional usage settlement for ${params.requestId}`,
            metadata: { reservedCredits: updatedReservation.reservedCredits, actualCredits: params.actualCredits },
          });
          balanceAfter = charge.balanceAfter;
        }
      }

      return { reservation: updatedReservation, transitioned: true, balanceAfter };
    });
  }

  async releaseReservationCredits(params: {
    requestId: string;
    userId: string;
    reason?: string;
  }): Promise<{ reservation: ReservationRecord; transitioned: boolean; refundedCredits: number; balanceAfter: number }> {
    return this.withTx(async (client) => {
      const resRes = await client.query(`SELECT * FROM reservations WHERE request_id = $1 FOR UPDATE`, [params.requestId]);
      if (resRes.rows.length === 0) {
        throw new Error(`Reservation for request ${params.requestId} not found`);
      }
      const res = this.mapReservationRow(resRes.rows[0]);
      if (res.userId !== params.userId) {
        throw new Error("Unauthorized access to reservation from different user");
      }
      if (res.status === "committed") {
        throw new Error(`Cannot release reservation ${params.requestId} because it has already been committed`);
      }
      if (res.status === "released") {
        const balance = await this.getCreditBalanceWithClient(client, params.userId);
        return { reservation: res, transitioned: false, refundedCredits: res.reservedCredits, balanceAfter: balance };
      }

      await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [params.userId]);

      const now = new Date().toISOString();
      const updateRes = await client.query(
        `UPDATE reservations
         SET status = 'released', released_at = $1
         WHERE request_id = $2 AND status = 'reserved'
         RETURNING *`,
        [now, params.requestId],
      );

      if (updateRes.rows.length === 0) {
        const currentRes = await this.getReservationByRequestIdWithClient(client, params.requestId);
        const balance = await this.getCreditBalanceWithClient(client, params.userId);
        return { reservation: currentRes!, transitioned: false, refundedCredits: currentRes?.reservedCredits ?? res.reservedCredits, balanceAfter: balance };
      }

      const updatedReservation = this.mapReservationRow(updateRes.rows[0]);
      const release = await this.appendLedgerWithClient(client, {
        userId: params.userId,
        amount: updatedReservation.reservedCredits,
        eventType: "CREDIT_RELEASED",
        requestId: params.requestId,
        description: `Cancel and release reservation: ${params.reason ?? "Request failed"}`,
      });

      return { reservation: updatedReservation, transitioned: true, refundedCredits: updatedReservation.reservedCredits, balanceAfter: release.balanceAfter };
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
    await this.pool.query(
      `INSERT INTO hosted_requests (id, user_id, status, estimated_credits, actual_credits, provider_id, model_id, created_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [record.id, record.userId, record.status, record.estimatedCredits, record.actualCredits, record.providerId, record.modelId, record.createdAt, null],
    );

    return record;
  }

  async getHostedRequest(id: string): Promise<HostedRequestRecord | undefined> {
    const res = await this.pool.query(`SELECT * FROM hosted_requests WHERE id = $1`, [id]);
    if (res.rows.length === 0) return undefined;
    return this.mapHostedRequestRow(res.rows[0]);
  }

  async updateHostedRequest(id: string, status: HostedRequestRecord["status"], actualCredits?: number): Promise<void> {
    const now = new Date().toISOString();
    if (actualCredits !== undefined) {
      await this.pool.query(
        `UPDATE hosted_requests
         SET status = $1, actual_credits = $2, completed_at = $3
         WHERE id = $4`,
        [status, actualCredits, now, id],
      );
    } else {
      await this.pool.query(
        `UPDATE hosted_requests
         SET status = $1, completed_at = $2
         WHERE id = $3`,
        [status, now, id],
      );
    }
  }

  // --- Usage Periods ---

  async getOrCreateCurrentUsagePeriod(
    userId: string,
    allowanceAmount = 500_000,
    now = new Date(),
  ): Promise<{ period: UsagePeriodRecord; grantedNewAllowance: boolean }> {
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

    return this.withTx(async (client) => {
      await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);

      const existingRes = await client.query(
        `SELECT * FROM usage_periods WHERE user_id = $1 AND period_start = $2`,
        [userId, periodStart],
      );

      if (existingRes.rows.length > 0) {
        return {
          period: this.mapUsagePeriodRow(existingRes.rows[0]),
          grantedNewAllowance: false,
        };
      }

      const id = randomUUID();
      const nowIso = now.toISOString();
      const insertRes = await client.query(
        `INSERT INTO usage_periods (id, user_id, period_start, period_end, free_allowance_granted, credits_used, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 0, $6, $7)
         ON CONFLICT (user_id, period_start) DO NOTHING
         RETURNING *`,
        [id, userId, periodStart, periodEnd, allowanceAmount, nowIso, nowIso],
      );

      if (insertRes.rows.length === 0) {
        const racedRes = await client.query(
          `SELECT * FROM usage_periods WHERE user_id = $1 AND period_start = $2`,
          [userId, periodStart],
        );
        return {
          period: this.mapUsagePeriodRow(racedRes.rows[0]),
          grantedNewAllowance: false,
        };
      }

      if (allowanceAmount > 0) {
        await this.appendLedgerWithClient(client, {
          userId,
          amount: allowanceAmount,
          eventType: "FREE_ALLOWANCE_GRANTED",
          description: `Monthly Free Tier Allowance for period ${periodStart.slice(0, 10)} to ${periodEnd.slice(0, 10)}`,
          metadata: { usagePeriodId: id },
        });
      }

      return {
        period: this.mapUsagePeriodRow(insertRes.rows[0]),
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
    await this.pool.query(
      `INSERT INTO oauth_transactions (id, state, code_challenge, redirect_uri, device_name, expires_at, used_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [record.id, record.state, record.codeChallenge, record.redirectUri, record.deviceName ?? null, record.expiresAt, null, record.createdAt],
    );
    return record;
  }

  async getOAuthTransaction(state: string): Promise<OAuthTransactionRecord | undefined> {
    const res = await this.pool.query(`SELECT * FROM oauth_transactions WHERE state = $1`, [state]);
    if (res.rows.length === 0) return undefined;
    return this.mapOAuthTransactionRow(res.rows[0]);
  }

  async consumeOAuthTransaction(state: string): Promise<OAuthTransactionRecord> {
    const tx = await this.getOAuthTransaction(state);
    if (!tx) {
      throw new Error("OAuth transaction not found");
    }
    if (new Date(tx.expiresAt).getTime() < Date.now()) {
      throw new Error("OAuth transaction expired");
    }

    const now = new Date().toISOString();
    const res = await this.pool.query(
      `UPDATE oauth_transactions
       SET used_at = $1
       WHERE state = $2 AND used_at IS NULL
       RETURNING *`,
      [now, state],
    );
    if (res.rows.length === 0) {
      throw new Error("OAuth transaction already consumed (replay detected)");
    }
    return this.mapOAuthTransactionRow(res.rows[0]);
  }

  // --- Billing Webhook Events ---

  async isWebhookProcessed(stripeEventId: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT id FROM billing_webhook_events WHERE stripe_event_id = $1 AND status = 'processed'`,
      [stripeEventId],
    );
    return res.rows.length > 0;
  }

  async claimWebhookEvent(params: { stripeEventId: string; eventType: string }): Promise<{ claimed: boolean }> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const res = await this.pool.query(
      `INSERT INTO billing_webhook_events (id, stripe_event_id, event_type, processed_at, status, payload, created_at)
       VALUES ($1, $2, $3, $4, 'processed', NULL, $5)
       ON CONFLICT (stripe_event_id) DO NOTHING
       RETURNING id`,
      [id, params.stripeEventId, params.eventType, now, now],
    );
    return { claimed: res.rows.length > 0 };
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

    await this.pool.query(
      `INSERT INTO billing_webhook_events (id, stripe_event_id, event_type, processed_at, status, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (stripe_event_id) DO UPDATE SET
         processed_at = EXCLUDED.processed_at,
         status = EXCLUDED.status,
         payload = EXCLUDED.payload`,
      [
        record.id,
        record.stripeEventId,
        record.eventType,
        record.processedAt,
        record.status,
        record.payload ? JSON.stringify(record.payload) : null,
        record.createdAt,
      ],
    );

    return record;
  }

  // --- Account Settings ---

  async getAccountSettings(userId: string): Promise<AccountSettingsRecord> {
    const res = await this.pool.query(`SELECT * FROM account_settings WHERE user_id = $1`, [userId]);
    if (res.rows.length > 0) {
      return this.mapAccountSettingsRow(res.rows[0]);
    }

    const now = new Date().toISOString();
    const record: AccountSettingsRecord = {
      id: randomUUID(),
      userId,
      privacyMode: "STANDARD",
      autoTopUpEnabled: false,
      spendLimitUsd: 0.0,
      createdAt: now,
      updatedAt: now,
    };
    await this.pool.query(
      `INSERT INTO account_settings (id, user_id, privacy_mode, auto_top_up_enabled, spend_limit_usd, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id) DO NOTHING`,
      [record.id, record.userId, record.privacyMode, 0, record.spendLimitUsd, record.createdAt, record.updatedAt],
    );
    const existing = await this.pool.query(`SELECT * FROM account_settings WHERE user_id = $1`, [userId]);
    return this.mapAccountSettingsRow(existing.rows[0]);
  }

  async upsertAccountSettings(settings: Partial<AccountSettingsRecord> & { userId: string }): Promise<AccountSettingsRecord> {
    const current = await this.getAccountSettings(settings.userId);
    const now = new Date().toISOString();
    const updated: AccountSettingsRecord = {
      ...current,
      ...settings,
      updatedAt: now,
    };

    await this.pool.query(
      `INSERT INTO account_settings (id, user_id, privacy_mode, auto_top_up_enabled, spend_limit_usd, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id) DO UPDATE SET
         privacy_mode = EXCLUDED.privacy_mode,
         auto_top_up_enabled = EXCLUDED.auto_top_up_enabled,
         spend_limit_usd = EXCLUDED.spend_limit_usd,
         updated_at = EXCLUDED.updated_at`,
      [
        updated.id,
        updated.userId,
        updated.privacyMode,
        updated.autoTopUpEnabled ? 1 : 0,
        updated.spendLimitUsd,
        updated.createdAt,
        updated.updatedAt,
      ],
    );

    return this.getAccountSettings(settings.userId);
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
    await this.pool.query(
      `INSERT INTO abuse_events (id, user_id, ip_address, event_type, details, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [record.id, record.userId ?? null, record.ipAddress ?? null, record.eventType, record.details ?? null, record.createdAt],
    );
    return record;
  }

  // --- Health & Concurrency ---

  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async getActiveReservationCount(userId: string): Promise<number> {
    const res = await this.pool.query(
      `SELECT COUNT(*) as count FROM reservations WHERE user_id = $1 AND status = 'reserved'`,
      [userId],
    );
    return parseInt(res.rows[0]?.count ?? "0", 10);
  }
}
