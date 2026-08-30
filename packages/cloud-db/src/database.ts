import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { SQL_MIGRATIONS, DEFAULT_PLANS } from "./migrations.js";
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
  HostedRequestRecord,
  BillingWebhookEventRecord,
  AccountSettingsRecord,
  AbuseEventRecord,
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

export interface CloudDatabaseOptions {
  dbPath?: string;
}

export class CloudDatabase {
  private readonly db: SQLiteDatabase;

  constructor(options: CloudDatabaseOptions = {}) {
    this.db = openDatabase(options.dbPath ?? ":memory:");
    this.initSchema();
  }

  private initSchema(): void {
    for (const sql of SQL_MIGRATIONS) {
      this.db.exec(sql);
    }
    for (const plan of DEFAULT_PLANS) {
      this.db.prepare(`
        INSERT OR REPLACE INTO plans (id, name, monthly_credit_allowance, max_concurrent_tasks, max_task_spend_credits, features, created_at)
        VALUES (@id, @name, @monthlyCreditAllowance, @maxConcurrentTasks, @maxTaskSpendCredits, @features, @createdAt)
      `).run(plan);
    }
  }

  close(): void {
    this.db.close();
  }

  // --- Users & Identities ---

  createUser(params: { displayName: string; avatarUrl?: string; primaryIdentity: string; id?: string }): UserRecord {
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

  getUserById(id: string): UserRecord | undefined {
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

  getUserByPrimaryIdentity(primaryIdentity: string): UserRecord | undefined {
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

  createIdentity(params: { userId: string; provider: "github" | "email"; providerUserId: string; providerEmail?: string; id?: string }): IdentityRecord {
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

  getIdentityByProvider(provider: string, providerUserId: string): IdentityRecord | undefined {
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

  // --- Device Sessions ---

  createDeviceSession(params: { userId: string; deviceName?: string; refreshTokenHash: string; ipAddress?: string; userAgent?: string; expiresInSeconds?: number }): DeviceSessionRecord {
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

  getDeviceSessionByTokenHash(refreshTokenHash: string): DeviceSessionRecord | undefined {
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

  updateDeviceSessionLastSeen(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE device_sessions SET last_seen_at = @now WHERE id = @id`).run({ id, now });
  }

  revokeDeviceSession(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE device_sessions SET revoked_at = @now WHERE id = @id`).run({ id, now });
  }

  revokeAllUserDeviceSessions(userId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE device_sessions SET revoked_at = @now WHERE user_id = @userId AND revoked_at IS NULL`).run({ userId, now });
  }

  // --- Plans & Subscriptions ---

  getPlan(id: string): PlanRecord | undefined {
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

  listPlans(): PlanRecord[] {
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

  getSubscriptionByUserId(userId: string): SubscriptionRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM subscriptions WHERE user_id = @userId`).get({ userId }) as Record<string, unknown> | undefined;
    if (!row) return undefined;
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

  getSubscriptionByStripeCustomerId(stripeCustomerId: string): SubscriptionRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM subscriptions WHERE stripe_customer_id = @stripeCustomerId`).get({ stripeCustomerId }) as Record<string, unknown> | undefined;
    if (!row) return undefined;
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

  getSubscriptionByStripeSubscriptionId(stripeSubscriptionId: string): SubscriptionRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM subscriptions WHERE stripe_subscription_id = @stripeSubscriptionId`).get({ stripeSubscriptionId }) as Record<string, unknown> | undefined;
    if (!row) return undefined;
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

  upsertSubscription(sub: Omit<SubscriptionRecord, "id" | "createdAt" | "updatedAt"> & { id?: string }): SubscriptionRecord {
    const now = new Date().toISOString();
    const existing = this.getSubscriptionByUserId(sub.userId);
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
    return record;
  }

  // --- Entitlements ---

  getEntitlements(userId: string): EntitlementRecord[] {
    const rows = this.db.prepare(`SELECT * FROM entitlements WHERE user_id = @userId`).all({ userId }) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      featureKey: String(row.feature_key),
      grantedValue: String(row.granted_value),
      expiresAt: row.expires_at ? String(row.expires_at) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  hasEntitlement(userId: string, featureKey: string): boolean {
    const row = this.db.prepare(`
      SELECT * FROM entitlements 
      WHERE user_id = @userId AND feature_key = @featureKey AND (expires_at IS NULL OR expires_at > @now)
    `).get({ userId, featureKey, now: new Date().toISOString() });
    return !!row;
  }

  setEntitlement(userId: string, featureKey: string, grantedValue = "true", expiresAt?: string | null): EntitlementRecord {
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
    return {
      id,
      userId,
      featureKey,
      grantedValue,
      expiresAt: expiresAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }

  removeEntitlement(userId: string, featureKey: string): void {
    this.db.prepare(`DELETE FROM entitlements WHERE user_id = @userId AND feature_key = @featureKey`).run({ userId, featureKey });
  }

  // --- Credit Ledger ---

  getCreditBalance(userId: string): number {
    const row = this.db.prepare(`
      SELECT balance_after FROM credit_ledger 
      WHERE user_id = @userId 
      ORDER BY rowid DESC 
      LIMIT 1
    `).get({ userId }) as { balance_after?: number } | undefined;
    return row?.balance_after ?? 0;
  }

  appendLedgerEvent(params: {
    userId: string;
    amount: number;
    eventType: CreditEventType;
    requestId?: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }): CreditLedgerRecord {
    // Atomically compute new balance and insert into ledger
    const currentBalance = this.getCreditBalance(params.userId);
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
      INSERT INTO credit_ledger (id, user_id, amount, balance_after, event_type, request_id, description, metadata, created_at)
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

  listLedgerEvents(userId: string, limit = 50): CreditLedgerRecord[] {
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
      eventType: row.event_type as CreditEventType,
      requestId: row.request_id ? String(row.request_id) : undefined,
      description: row.description ? String(row.description) : undefined,
      metadata: row.metadata ? JSON.parse(String(row.metadata)) : undefined,
      createdAt: String(row.created_at),
    }));
  }

  // --- Usage Events ---

  recordUsageEvent(event: Omit<UsageEventRecord, "id" | "createdAt"> & { id?: string }): UsageEventRecord {
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

  listUsageEvents(userId: string, limit = 50): UsageEventRecord[] {
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

  // --- Hosted Requests ---

  createHostedRequest(req: { id: string; userId: string; providerId: string; modelId: string; estimatedCredits: number }): HostedRequestRecord {
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

  getHostedRequest(id: string): HostedRequestRecord | undefined {
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

  updateHostedRequest(id: string, status: HostedRequestRecord["status"], actualCredits = 0): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE hosted_requests 
      SET status = @status, actual_credits = @actualCredits, completed_at = @now 
      WHERE id = @id
    `).run({ id, status, actualCredits, now });
  }

  // --- Webhook Events ---

  isWebhookProcessed(stripeEventId: string): boolean {
    const row = this.db.prepare(`SELECT * FROM billing_webhook_events WHERE stripe_event_id = @stripeEventId AND status = 'processed'`).get({ stripeEventId });
    return !!row;
  }

  recordWebhookEvent(params: { stripeEventId: string; eventType: string; status: "processed" | "failed" | "ignored"; payload?: Record<string, unknown> }): BillingWebhookEventRecord {
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

  getAccountSettings(userId: string): AccountSettingsRecord {
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

  upsertAccountSettings(settings: Partial<AccountSettingsRecord> & { userId: string }): AccountSettingsRecord {
    const current = this.getAccountSettings(settings.userId);
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
    return updated;
  }

  // --- Abuse Events ---

  recordAbuseEvent(params: { userId?: string; ipAddress?: string; eventType: string; details?: string }): AbuseEventRecord {
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
}
