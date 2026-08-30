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

export interface PostgresCloudDatabaseOptions {
  connectionString?: string;
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
      this.pool = new Pool({ connectionString });
      this.isCustomPool = false;
    }
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
      client.release();
    }
  }

  async close(): Promise<void> {
    if (!this.isCustomPool) {
      await this.pool.end();
    }
  }

  // --- Users & Identities ---

  async createUserAsync(params: { displayName: string; avatarUrl?: string; primaryIdentity: string; id?: string }): Promise<UserRecord> {
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

  createUser(params: { displayName: string; avatarUrl?: string; primaryIdentity: string; id?: string }): UserRecord {
    throw new Error("PostgreSQL operations require async execution. Use SQLiteCloudDatabase for sync embedding or await async PG methods.");
  }

  getUserById(id: string): UserRecord | undefined {
    throw new Error("PostgreSQL operations require async execution. Use SQLiteCloudDatabase for sync embedding or await async PG methods.");
  }

  getUserByPrimaryIdentity(primaryIdentity: string): UserRecord | undefined {
    throw new Error("PostgreSQL operations require async execution. Use SQLiteCloudDatabase for sync embedding or await async PG methods.");
  }

  createIdentity(params: { userId: string; provider: "github" | "email"; providerUserId: string; providerEmail?: string; id?: string }): IdentityRecord {
    throw new Error("PostgreSQL operations require async execution. Use SQLiteCloudDatabase for sync embedding or await async PG methods.");
  }

  getIdentityByProvider(provider: string, providerUserId: string): IdentityRecord | undefined {
    throw new Error("PostgreSQL operations require async execution. Use SQLiteCloudDatabase for sync embedding or await async PG methods.");
  }

  createDeviceSession(params: { userId: string; deviceName?: string; refreshTokenHash: string; ipAddress?: string; userAgent?: string; expiresInSeconds?: number }): DeviceSessionRecord {
    throw new Error("PostgreSQL operations require async execution.");
  }

  getDeviceSessionByTokenHash(refreshTokenHash: string): DeviceSessionRecord | undefined {
    throw new Error("PostgreSQL operations require async execution.");
  }

  updateDeviceSessionLastSeen(id: string): void {
    throw new Error("PostgreSQL operations require async execution.");
  }

  revokeDeviceSession(id: string): void {
    throw new Error("PostgreSQL operations require async execution.");
  }

  revokeAllUserDeviceSessions(userId: string): void {
    throw new Error("PostgreSQL operations require async execution.");
  }

  rotateDeviceSession(params: { oldTokenHash: string; newRefreshTokenHash: string; deviceName?: string; ipAddress?: string; userAgent?: string; expiresInSeconds?: number }): { user: UserRecord; session: DeviceSessionRecord } {
    throw new Error("PostgreSQL operations require async execution.");
  }

  getPlan(id: string): PlanRecord | undefined {
    throw new Error("PostgreSQL operations require async execution.");
  }

  listPlans(): PlanRecord[] {
    throw new Error("PostgreSQL operations require async execution.");
  }

  getSubscriptionByUserId(userId: string): SubscriptionRecord | undefined {
    throw new Error("PostgreSQL operations require async execution.");
  }

  getSubscriptionByStripeCustomerId(stripeCustomerId: string): SubscriptionRecord | undefined {
    throw new Error("PostgreSQL operations require async execution.");
  }

  getSubscriptionByStripeSubscriptionId(stripeSubscriptionId: string): SubscriptionRecord | undefined {
    throw new Error("PostgreSQL operations require async execution.");
  }

  upsertSubscription(sub: Omit<SubscriptionRecord, "id" | "createdAt" | "updatedAt"> & { id?: string }): SubscriptionRecord {
    throw new Error("PostgreSQL operations require async execution.");
  }

  getEntitlements(userId: string): EntitlementRecord[] {
    throw new Error("PostgreSQL operations require async execution.");
  }

  hasEntitlement(userId: string, featureKey: FeatureKey | string): boolean {
    throw new Error("PostgreSQL operations require async execution.");
  }

  setEntitlement(userId: string, featureKey: FeatureKey | string, grantedValue?: string, expiresAt?: string | null): EntitlementRecord {
    throw new Error("PostgreSQL operations require async execution.");
  }

  removeEntitlement(userId: string, featureKey: FeatureKey | string): void {
    throw new Error("PostgreSQL operations require async execution.");
  }

  getCreditBalance(userId: string): number {
    throw new Error("PostgreSQL operations require async execution.");
  }

  appendLedgerEvent(params: { userId: string; amount: number; eventType: CreditEventType; requestId?: string; description?: string; metadata?: Record<string, unknown> }): CreditLedgerRecord {
    throw new Error("PostgreSQL operations require async execution.");
  }

  listLedgerEvents(userId: string, limit?: number): CreditLedgerRecord[] {
    throw new Error("PostgreSQL operations require async execution.");
  }

  recordUsageEvent(event: Omit<UsageEventRecord, "id" | "createdAt"> & { id?: string }): UsageEventRecord {
    throw new Error("PostgreSQL operations require async execution.");
  }

  listUsageEvents(userId: string, limit?: number): UsageEventRecord[] {
    throw new Error("PostgreSQL operations require async execution.");
  }

  getDailyProviderSpendUsd(sinceIsoString?: string): number {
    throw new Error("PostgreSQL operations require async execution.");
  }

  getUserBillingPeriodSpendUsd(userId: string, sinceIsoString?: string): number {
    throw new Error("PostgreSQL operations require async execution.");
  }

  createReservation(params: { id?: string; requestId: string; userId: string; providerId: string; modelId: string; reservedCredits: number }): ReservationRecord {
    throw new Error("PostgreSQL operations require async execution.");
  }

  getReservationByRequestId(requestId: string): ReservationRecord | undefined {
    throw new Error("PostgreSQL operations require async execution.");
  }

  commitReservation(requestId: string, userId: string, actualCredits: number): ReservationRecord {
    throw new Error("PostgreSQL operations require async execution.");
  }

  releaseReservation(requestId: string, userId: string): ReservationRecord {
    throw new Error("PostgreSQL operations require async execution.");
  }

  listStaleReservations(cutoffIso: string): ReservationRecord[] {
    throw new Error("PostgreSQL operations require async execution.");
  }

  createHostedRequest(req: { id: string; userId: string; providerId: string; modelId: string; estimatedCredits: number }): HostedRequestRecord {
    throw new Error("PostgreSQL operations require async execution.");
  }

  getHostedRequest(id: string): HostedRequestRecord | undefined {
    throw new Error("PostgreSQL operations require async execution.");
  }

  updateHostedRequest(id: string, status: HostedRequestRecord["status"], actualCredits?: number): void {
    throw new Error("PostgreSQL operations require async execution.");
  }

  getOrCreateCurrentUsagePeriod(userId: string, allowanceAmount?: number, now?: Date): { period: UsagePeriodRecord; grantedNewAllowance: boolean } {
    throw new Error("PostgreSQL operations require async execution.");
  }

  createOAuthTransaction(params: { state: string; codeChallenge: string; redirectUri: string; deviceName?: string; expiresInSeconds?: number }): OAuthTransactionRecord {
    throw new Error("PostgreSQL operations require async execution.");
  }

  getOAuthTransaction(state: string): OAuthTransactionRecord | undefined {
    throw new Error("PostgreSQL operations require async execution.");
  }

  consumeOAuthTransaction(state: string): OAuthTransactionRecord {
    throw new Error("PostgreSQL operations require async execution.");
  }

  isWebhookProcessed(stripeEventId: string): boolean {
    throw new Error("PostgreSQL operations require async execution.");
  }

  recordWebhookEvent(params: { stripeEventId: string; eventType: string; status: "processed" | "failed" | "ignored"; payload?: Record<string, unknown> }): BillingWebhookEventRecord {
    throw new Error("PostgreSQL operations require async execution.");
  }

  getAccountSettings(userId: string): AccountSettingsRecord {
    throw new Error("PostgreSQL operations require async execution.");
  }

  upsertAccountSettings(settings: Partial<AccountSettingsRecord> & { userId: string }): AccountSettingsRecord {
    throw new Error("PostgreSQL operations require async execution.");
  }

  recordAbuseEvent(params: { userId?: string; ipAddress?: string; eventType: string; details?: string }): AbuseEventRecord {
    throw new Error("PostgreSQL operations require async execution.");
  }
}
