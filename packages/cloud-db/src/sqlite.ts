import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
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
  DesktopAuthCodeRecord,
  BrowserOAuthTransactionRecord,
  BrowserSessionRecord,
  FeatureKey,
  GitHubInstallationRecord,
  GitHubInstallationStatus,
  GitHubRepositoryAuthorizationRecord,
  GitHubRepositoryAuthorizationState,
  GitHubAppCallbackStateRecord,
  PublicationRecord,
  PublicationState,
  PublicationLease,
  CloudVerificationPlanRecord,
  CloudVerificationAttemptRecord,
  CloudVerificationEvidenceRecord,
  AccountDeletionResult,
  SecurityAuditEventRecord,
  AccountDeletionTableSummary,
  HostedExecutionRecord,
  HostedCapacityLeaseRecord,
  HostedAdmissionReceiptRecord,
  HostedAdmissionMetrics,
  HostedExecutionStatus,
  HostedFanOutLimits,
  HostedExecutionEvent,
  HostedExecutionEventSubscription,
  HostedExecutionStreamEventRecord,
  HostedExecutionTreeStats,
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

function mapCreditLedgerRow(row: Record<string, unknown>): CreditLedgerRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    amount: Number(row.amount),
    balanceAfter: Number(row.balance_after),
    eventType: row.eventType as CreditEventType,
    requestId: row.request_id ? String(row.request_id) : undefined,
    description: row.description ? String(row.description) : undefined,
    metadata: row.metadata ? JSON.parse(String(row.metadata)) : undefined,
    createdAt: String(row.created_at),
  };
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
    this.hostedEventEmitter.removeAllListeners();
    try {
      this.db.close();
    } catch {}
  }

  async createVerificationPlan(record: CloudVerificationPlanRecord): Promise<CloudVerificationPlanRecord> {
    this.db.prepare(`INSERT INTO verification_plans (id, run_id, workspace_id, policy_version, input_state_hash, scope, payload_json, created_at) VALUES (@id,@runId,@workspaceId,@policyVersion,@inputStateHash,@scope,@payload,@createdAt) ON CONFLICT(id) DO NOTHING`).run({ id: record.id, runId: record.runId, workspaceId: record.workspaceId, policyVersion: record.policyVersion, inputStateHash: record.inputStateHash, scope: record.scope, payload: JSON.stringify(record.payload), createdAt: record.createdAt });
    return (await this.getVerificationPlan(record.id)) ?? record;
  }

  async getVerificationPlan(id: string): Promise<CloudVerificationPlanRecord | undefined> {
    const row = this.db.prepare(`SELECT * FROM verification_plans WHERE id=@id`).get({ id }) as Record<string, unknown> | undefined;
    return row ? { id: String(row.id), runId: String(row.run_id), workspaceId: String(row.workspace_id), policyVersion: String(row.policy_version), inputStateHash: String(row.input_state_hash), scope: String(row.scope), payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>, createdAt: String(row.created_at) } : undefined;
  }

  async createVerificationAttempt(record: CloudVerificationAttemptRecord): Promise<CloudVerificationAttemptRecord> {
    this.db.prepare(`INSERT INTO verification_attempts (id, plan_id, run_id, verifier_id, verifier_version, status, started_at, finished_at, exit_code, payload_json) VALUES (@id,@planId,@runId,@verifierId,@verifierVersion,@status,@startedAt,@finishedAt,@exitCode,@payload) ON CONFLICT(id) DO NOTHING`).run({ id: record.id, planId: record.planId, runId: record.runId, verifierId: record.verifierId, verifierVersion: record.verifierVersion, status: record.status, startedAt: record.startedAt, finishedAt: record.finishedAt ?? null, exitCode: record.exitCode ?? null, payload: JSON.stringify(record.payload) });
    return (await this.listVerificationAttempts(record.planId)).find((attempt) => attempt.id === record.id) ?? record;
  }

  async terminalizeVerificationAttempt(id: string, status: Exclude<CloudVerificationAttemptRecord["status"], "pending" | "running">, finishedAt: string, exitCode?: number): Promise<CloudVerificationAttemptRecord> {
    const current = this.db.prepare(`SELECT * FROM verification_attempts WHERE id=@id`).get({ id }) as Record<string, unknown> | undefined;
    if (!current) throw new Error(`Unknown verification attempt ${id}`);
    const currentStatus = String(current.status) as CloudVerificationAttemptRecord["status"];
    const terminal = new Set<CloudVerificationAttemptRecord["status"]>(["passed", "failed", "cancelled", "timed_out", "infra_error", "interrupted"]);
    if (terminal.has(currentStatus)) {
      if (currentStatus !== status) throw new Error("Terminal verification attempt is immutable");
    } else {
      this.db.prepare(`UPDATE verification_attempts SET status=@status, finished_at=@finishedAt, exit_code=@exitCode WHERE id=@id AND status IN ('pending','running')`).run({ id, status, finishedAt, exitCode: exitCode ?? null });
    }
    const row = this.db.prepare(`SELECT * FROM verification_attempts WHERE id=@id`).get({ id }) as Record<string, unknown>;
    return { id: String(row.id), planId: String(row.plan_id), runId: String(row.run_id), verifierId: String(row.verifier_id), verifierVersion: String(row.verifier_version), status: String(row.status) as CloudVerificationAttemptRecord["status"], startedAt: String(row.started_at), ...(row.finished_at ? { finishedAt: String(row.finished_at) } : {}), ...(row.exit_code !== null ? { exitCode: Number(row.exit_code) } : {}), payload: JSON.parse(String(row.payload_json)) as Record<string, unknown> };
  }

  async createVerificationEvidence(record: CloudVerificationEvidenceRecord): Promise<CloudVerificationEvidenceRecord> {
    this.db.prepare(`INSERT INTO verification_evidence (id, attempt_id, plan_id, run_id, verifier_id, verifier_version, input_state_hash, status, output_digest, output_truncated, payload_json, created_at) VALUES (@id,@attemptId,@planId,@runId,@verifierId,@verifierVersion,@inputStateHash,@status,@outputDigest,@outputTruncated,@payload,@createdAt) ON CONFLICT(attempt_id) DO NOTHING`).run({ id: record.id, attemptId: record.attemptId, planId: record.planId, runId: record.runId, verifierId: record.verifierId, verifierVersion: record.verifierVersion, inputStateHash: record.inputStateHash, status: record.status, outputDigest: record.outputDigest, outputTruncated: record.outputTruncated ? 1 : 0, payload: JSON.stringify(record.payload), createdAt: record.createdAt });
    const row = this.db.prepare(`SELECT * FROM verification_evidence WHERE attempt_id=@attemptId`).get({ attemptId: record.attemptId }) as Record<string, unknown>;
    return { id: String(row.id), attemptId: String(row.attempt_id), planId: String(row.plan_id), runId: String(row.run_id), verifierId: String(row.verifier_id), verifierVersion: String(row.verifier_version), inputStateHash: String(row.input_state_hash), status: String(row.status) as CloudVerificationEvidenceRecord["status"], outputDigest: String(row.output_digest), outputTruncated: Boolean(row.output_truncated), payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>, createdAt: String(row.created_at) };
  }

  async listVerificationAttempts(planId: string): Promise<CloudVerificationAttemptRecord[]> {
    const rows = this.db.prepare(`SELECT * FROM verification_attempts WHERE plan_id=@planId ORDER BY started_at, id`).all({ planId }) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ id: String(row.id), planId: String(row.plan_id), runId: String(row.run_id), verifierId: String(row.verifier_id), verifierVersion: String(row.verifier_version), status: String(row.status) as CloudVerificationAttemptRecord["status"], startedAt: String(row.started_at), ...(row.finished_at ? { finishedAt: String(row.finished_at) } : {}), ...(row.exit_code !== null ? { exitCode: Number(row.exit_code) } : {}), payload: JSON.parse(String(row.payload_json)) as Record<string, unknown> }));
  }

  async listVerificationEvidence(planId: string): Promise<CloudVerificationEvidenceRecord[]> {
    const rows = this.db.prepare(`SELECT * FROM verification_evidence WHERE plan_id=@planId ORDER BY created_at, id`).all({ planId }) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ id: String(row.id), attemptId: String(row.attempt_id), planId: String(row.plan_id), runId: String(row.run_id), verifierId: String(row.verifier_id), verifierVersion: String(row.verifier_version), inputStateHash: String(row.input_state_hash), status: String(row.status) as CloudVerificationEvidenceRecord["status"], outputDigest: String(row.output_digest), outputTruncated: Boolean(row.output_truncated), payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>, createdAt: String(row.created_at) }));
  }

  async recoverInterruptedVerificationAttempts(planId?: string): Promise<number> {
    const result = this.db.prepare(`UPDATE verification_attempts SET status='interrupted', finished_at=@finishedAt WHERE status='running' ${planId ? "AND plan_id=@planId" : ""}`).run(planId ? { finishedAt: new Date().toISOString(), planId } : { finishedAt: new Date().toISOString() });
    return Number(result.changes);
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

  async createIdentity(params: { userId: string; provider: "github" | "email"; providerUserId: string; providerLogin?: string; providerAvatarUrl?: string; providerEmail?: string; id?: string }): Promise<IdentityRecord> {
    const now = new Date().toISOString();
    const id = params.id ?? randomUUID();
    const identity: IdentityRecord = {
      id,
      userId: params.userId,
      provider: params.provider,
      providerUserId: params.providerUserId,
      providerLogin: params.providerLogin,
      providerAvatarUrl: params.providerAvatarUrl,
      providerEmail: params.providerEmail,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO identities (id, user_id, provider, provider_user_id, provider_login, provider_avatar_url, provider_email, created_at, updated_at)
      VALUES (@id, @userId, @provider, @providerUserId, @providerLogin, @providerAvatarUrl, @providerEmail, @createdAt, @updatedAt)
    `).run({
      id: identity.id,
      userId: identity.userId,
      provider: identity.provider,
      providerUserId: identity.providerUserId,
      providerLogin: identity.providerLogin ?? null,
      providerAvatarUrl: identity.providerAvatarUrl ?? null,
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
      providerLogin: row.provider_login ? String(row.provider_login) : undefined,
      providerAvatarUrl: row.provider_avatar_url ? String(row.provider_avatar_url) : undefined,
      providerEmail: row.provider_email ? String(row.provider_email) : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  async updateIdentityMetadata(params: { id: string; providerLogin?: string; providerAvatarUrl?: string; providerEmail?: string }): Promise<void> {
    this.db.prepare(`
      UPDATE identities
      SET provider_login = @providerLogin, provider_avatar_url = @providerAvatarUrl, provider_email = @providerEmail, updated_at = @updatedAt
      WHERE id = @id
    `).run({ id: params.id, providerLogin: params.providerLogin ?? null, providerAvatarUrl: params.providerAvatarUrl ?? null, providerEmail: params.providerEmail ?? null, updatedAt: new Date().toISOString() });
  }

  async updateUserProfile(params: { id: string; displayName: string; avatarUrl?: string }): Promise<void> {
    this.db.prepare(`UPDATE users SET display_name = @displayName, avatar_url = @avatarUrl, updated_at = @updatedAt WHERE id = @id`).run({ id: params.id, displayName: params.displayName, avatarUrl: params.avatarUrl ?? null, updatedAt: new Date().toISOString() });
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
    return row ? this.mapDeviceSessionRow(row) : undefined;
  }

  async getDeviceSessionById(id: string): Promise<DeviceSessionRecord | undefined> {
    const row = this.db.prepare(`SELECT * FROM device_sessions WHERE id = @id`).get({ id }) as Record<string, unknown> | undefined;
    return row ? this.mapDeviceSessionRow(row) : undefined;
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
      revokedReason: (row.revoked_reason ? String(row.revoked_reason) : null) as DeviceSessionRecord["revokedReason"],
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

  async revokeDeviceSession(id: string, reason: "rotated" | "logout" | "breach" = "logout"): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE device_sessions SET revoked_at = @now, revoked_reason = @reason WHERE id = @id`).run({ id, now, reason });
  }

  private revokeAllUserDeviceSessionsSync(userId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE device_sessions SET revoked_at = @now, revoked_reason = 'breach' WHERE user_id = @userId AND revoked_at IS NULL`)
      .run({ userId, now });
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
      // Reuse of a ROTATED token means a second party holds a token this device already spent —
      // that is the OAuth refresh-token replay signal, so the entire session family is revoked.
      // Reuse of a token the user explicitly LOGGED OUT is just a stale client catching up; killing
      // every other device for that would sign the account out everywhere on a benign event.
      if (session.revokedReason === "rotated") {
        this.revokeAllUserDeviceSessionsSync(session.userId);
        throw new Error("Device session has been revoked (replay detected)");
      }
      throw new Error("Device session has been revoked");
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
      this.db
        .prepare(`UPDATE device_sessions SET revoked_at = @now, revoked_reason = 'rotated' WHERE id = @id`)
        .run({ id: session.id, now });

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
    if (params.requestId) {
      const existing = this.db.prepare(`SELECT * FROM credit_ledger WHERE user_id = @userId AND request_id = @requestId AND eventType = @eventType ORDER BY rowid DESC LIMIT 1`).get({ userId: params.userId, requestId: params.requestId, eventType: params.eventType }) as Record<string, unknown> | undefined;
      if (existing) return mapCreditLedgerRow(existing);
    }
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
      usagePeriodId: row.usage_period_id ? String(row.usage_period_id) : null,
      actualCredits: Number(row.actual_credits),
      status: row.status as ReservationRecord["status"],
      createdAt: String(row.created_at),
      committedAt: row.committed_at ? String(row.committed_at) : null,
      releasedAt: row.released_at ? String(row.released_at) : null,
    };
  }

  private insertReservationSync(params: { id?: string; requestId: string; userId: string; providerId: string; modelId: string; reservedCredits: number; usagePeriodId?: string }): ReservationRecord {
    const now = new Date().toISOString();
    const id = params.id ?? randomUUID();
    const record: ReservationRecord = {
      id,
      requestId: params.requestId,
      userId: params.userId,
      providerId: params.providerId,
      modelId: params.modelId,
      reservedCredits: params.reservedCredits,
      usagePeriodId: params.usagePeriodId ?? null,
      actualCredits: 0,
      status: "reserved",
      createdAt: now,
      committedAt: null,
      releasedAt: null,
    };

    this.db.prepare(`
      INSERT INTO reservations (id, request_id, user_id, provider_id, model_id, reserved_credits, usage_period_id, actual_credits, status, created_at, committed_at, released_at)
      VALUES (@id, @requestId, @userId, @providerId, @modelId, @reservedCredits, @usagePeriodId, @actualCredits, @status, @createdAt, @committedAt, @releasedAt)
    `).run({
      id: record.id,
      requestId: record.requestId,
      userId: record.userId,
      providerId: record.providerId,
      modelId: record.modelId,
      reservedCredits: record.reservedCredits,
      usagePeriodId: record.usagePeriodId,
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
    usagePeriodId?: string;
    maxTaskSpendCredits?: number;
  }): Promise<{ reservation: ReservationRecord; balanceAfter: number; created: boolean }> {

    const existing = this.getReservationByRequestIdSync(params.requestId);
    if (existing) {
      if (existing.userId !== params.userId) {
        throw new Error("Request ID is already associated with another user account");
      }
      if (Boolean(existing.usagePeriodId) !== Boolean(params.usagePeriodId)) {
        throw new Error("Request ID is already reserved under a different allowance scope");
      }
      const balanceAfter = existing.usagePeriodId ? this.getUsagePeriodRemainingSync(existing.usagePeriodId) : this.getCreditBalanceSync(params.userId);
      return { reservation: existing, balanceAfter, created: false };
    }

    return this.txSync(() => {
      const existingInTx = this.getReservationByRequestIdSync(params.requestId);
      if (existingInTx) {
        if (existingInTx.userId !== params.userId) {
          throw new Error("Request ID is already associated with another user account");
        }
        if (Boolean(existingInTx.usagePeriodId) !== Boolean(params.usagePeriodId)) {
          throw new Error("Request ID is already reserved under a different allowance scope");
        }
        const balanceAfter = existingInTx.usagePeriodId ? this.getUsagePeriodRemainingSync(existingInTx.usagePeriodId) : this.getCreditBalanceSync(params.userId);
        return { reservation: existingInTx, balanceAfter, created: false };
      }

      if (params.maxConcurrentTasks !== undefined && params.maxConcurrentTasks > 0) {
        const active = this.getActiveReservationCountSync(params.userId);
        if (active >= params.maxConcurrentTasks) {
          throw new Error(`Concurrent task limit reached (active: ${active}, limit: ${params.maxConcurrentTasks})`);
        }
      }

      let balance: number;
      if (params.usagePeriodId) {
        const period = this.db.prepare(`SELECT * FROM usage_periods WHERE id = @periodId AND user_id = @userId`).get({ periodId: params.usagePeriodId, userId: params.userId }) as Record<string, unknown> | undefined;
        if (!period) throw new Error("Free allowance period not found for authenticated account");
        const taskLimit = params.maxTaskSpendCredits ?? 50_000;
        if (params.reservedCredits > taskLimit) throw new Error(`Free task credit limit exceeded (limit: ${taskLimit}, requested: ${params.reservedCredits})`);
        const active = this.db.prepare(`SELECT COALESCE(SUM(reserved_credits), 0) AS credits FROM reservations WHERE usage_period_id = @periodId AND status = 'reserved'`).get({ periodId: params.usagePeriodId }) as { credits?: number } | undefined;
        const used = Number(period.credits_used);
        const reserved = Number(active?.credits ?? 0);
        const allowance = Number(period.free_allowance_granted);
        if (used + reserved + params.reservedCredits > allowance) {
          throw new Error(`Free allowance exhausted (available: ${Math.max(0, allowance - used - reserved)}, required: ${params.reservedCredits})`);
        }
        balance = allowance - used - reserved - params.reservedCredits;
      } else {
        balance = this.getCreditBalanceSync(params.userId);
        if (balance < params.reservedCredits) {
          throw new Error(`Insufficient credit balance for reservation (available: ${balance}, required: ${params.reservedCredits})`);
        }
      }

      const reservation = this.insertReservationSync(params);
      if (params.usagePeriodId) {
        return { reservation, balanceAfter: balance, created: true };
      }
      const ledger = this.appendLedgerSync({
        userId: params.userId,
        amount: -params.reservedCredits,
        eventType: "CREDIT_RESERVED",
        requestId: params.requestId,
        description: params.description ?? `Budget reservation for request ${params.requestId}`,
        metadata: { reservationId: reservation.id, providerId: params.providerId, modelId: params.modelId, ...params.metadata },
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
    if (!Number.isSafeInteger(params.actualCredits) || params.actualCredits < 0) throw new Error("actualCredits must be a non-negative safe integer");
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
      return { reservation: res, transitioned: false, balanceAfter: res.usagePeriodId ? this.getUsagePeriodRemainingSync(res.usagePeriodId) : this.getCreditBalanceSync(params.userId) };
    }

    return this.txSync(() => {
      const current = this.getReservationByRequestIdSync(params.requestId);
      if (!current) throw new Error(`Reservation for request ${params.requestId} not found`);
      const additionalCredits = Math.max(0, params.actualCredits - current.reservedCredits);
      if (current.usagePeriodId && params.actualCredits > current.reservedCredits) {
        throw new Error(`Free request actual usage exceeds its reservation (${params.actualCredits} > ${current.reservedCredits})`);
      }
      const availableBalance = this.getCreditBalanceSync(params.userId);
      if (!current.usagePeriodId && additionalCredits > availableBalance) throw new Error(`Insufficient credit balance to settle request ${params.requestId}`);
      const reservation = this.commitReservationSync(params.requestId, params.userId, params.actualCredits);
      const diff = reservation.reservedCredits - params.actualCredits;
      let balanceAfter = availableBalance;

      if (reservation.usagePeriodId) {
        this.db.prepare(`UPDATE usage_periods SET credits_used = credits_used + @actualCredits, updated_at = @now WHERE id = @periodId AND user_id = @userId`).run({
          actualCredits: params.actualCredits,
          now: new Date().toISOString(),
          periodId: reservation.usagePeriodId,
          userId: params.userId,
        });
        balanceAfter = this.getUsagePeriodRemainingSync(reservation.usagePeriodId);
        return { reservation, transitioned: true, balanceAfter };
      }

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
      return { reservation: res, transitioned: false, refundedCredits: res.reservedCredits, balanceAfter: res.usagePeriodId ? this.getUsagePeriodRemainingSync(res.usagePeriodId) : this.getCreditBalanceSync(params.userId) };
    }

    return this.txSync(() => {
      const reservation = this.releaseReservationSync(params.requestId, params.userId);
      if (reservation.usagePeriodId) {
        return { reservation, transitioned: true, refundedCredits: reservation.reservedCredits, balanceAfter: this.getUsagePeriodRemainingSync(reservation.usagePeriodId) };
      }
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

  private mapHostedExecutionRow(row: Record<string, unknown>): HostedExecutionRecord {
    return {
      id: String(row.id),
      idempotencyKey: String(row.idempotency_key),
      userId: String(row.user_id),
      taskId: String(row.task_id),
      providerId: String(row.provider_id),
      modelId: String(row.model_id),
      status: row.status as HostedExecutionRecord["status"],
      priority: Number(row.priority),
      attempt: Number(row.attempt),
      eligibleAt: String(row.eligible_at),
      leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
      leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null,
      leaseToken: row.lease_token ? String(row.lease_token) : null,
      cancellationRequested: Boolean(row.cancellation_requested),
      requestPayload: row.request_payload != null ? String(row.request_payload) : null,
      resultPayload: row.result_payload != null ? String(row.result_payload) : null,
      resultError: row.result_error != null ? String(row.result_error) : null,
      dispatchedAt: row.dispatched_at ? String(row.dispatched_at) : null,
      terminalAt: row.terminal_at ? String(row.terminal_at) : null,
      parentExecutionId: row.parent_execution_id ? String(row.parent_execution_id) : null,
      rootExecutionId: row.root_execution_id ? String(row.root_execution_id) : null,
      depth: Number(row.depth ?? 0),
      providerDispatchId: row.provider_dispatch_id != null ? String(row.provider_dispatch_id) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapHostedCapacityLeaseRow(row: Record<string, unknown>): HostedCapacityLeaseRecord {
    return {
      id: String(row.id),
      executionId: String(row.execution_id),
      userId: String(row.user_id),
      providerId: String(row.provider_id),
      modelId: String(row.model_id),
      workerId: String(row.worker_id),
      state: row.state as HostedCapacityLeaseRecord["state"],
      leaseExpiresAt: String(row.lease_expires_at),
      createdAt: String(row.created_at),
      releasedAt: row.released_at ? String(row.released_at) : null,
      releaseReason: row.release_reason ? String(row.release_reason) : null,
    };
  }

  private insertHostedAdmissionReceipt(params: { executionId: string; userId: string; eventType: HostedAdmissionReceiptRecord["eventType"]; workerId?: string; details?: Record<string, string | number | boolean | null>; createdAt?: string }): void {
    this.db.prepare(`INSERT INTO hosted_admission_receipts (id, execution_id, user_id, event_type, worker_id, details, created_at) VALUES (@id, @executionId, @userId, @eventType, @workerId, @details, @createdAt)`).run({
      id: randomUUID(), executionId: params.executionId, userId: params.userId, eventType: params.eventType, workerId: params.workerId ?? null, details: params.details ? JSON.stringify(params.details) : null, createdAt: params.createdAt ?? new Date().toISOString(),
    });
  }

  async enqueueHostedExecution(params: { id: string; idempotencyKey: string; userId: string; taskId: string; providerId: string; modelId: string; priority?: number; eligibleAt?: string; requestPayload?: string; parentExecutionId?: string; rootExecutionId?: string; fanOutLimits?: HostedFanOutLimits }): Promise<{ execution: HostedExecutionRecord; created: boolean }> {
    return this.txSync(() => {
      const existing = this.db.prepare(`SELECT * FROM hosted_executions WHERE idempotency_key = @idempotencyKey`).get({ idempotencyKey: params.idempotencyKey }) as Record<string, unknown> | undefined;
      if (existing) {
        if (String(existing.user_id) !== params.userId) throw new Error("Idempotency key is already associated with another user account");
        this.insertHostedAdmissionReceipt({ executionId: String(existing.id), userId: params.userId, eventType: "DUPLICATE_SUPPRESSED" });
        return { execution: this.mapHostedExecutionRow(existing), created: false };
      }
      let rootExecutionId = params.rootExecutionId ?? null;
      let depth = 0;
      if (params.parentExecutionId) {
        const parent = this.db.prepare(`SELECT user_id, status, root_execution_id, depth FROM hosted_executions WHERE id = @id`).get({ id: params.parentExecutionId }) as Record<string, unknown> | undefined;
        if (!parent) throw new Error("Parent hosted execution not found");
        if (String(parent.user_id) !== params.userId) throw new Error("Parent hosted execution belongs to another user account");
        if (["completed", "failed", "cancelled"].includes(String(parent.status))) throw new Error("Parent hosted execution is already terminal");
        const authoritativeRoot = parent.root_execution_id ? String(parent.root_execution_id) : params.parentExecutionId;
        if (rootExecutionId !== null && rootExecutionId !== authoritativeRoot) throw new Error("rootExecutionId does not match the parent's authoritative root");
        rootExecutionId = authoritativeRoot;
        depth = Number(parent.depth ?? 0) + 1;
        // Budget authority: the synchronous body makes the whole check-then-insert atomic — the
        // same semantics the Postgres path gets from the parent/root row locks.
        const limits = params.fanOutLimits;
        if (limits) {
          if (limits.maxDepth !== undefined && depth > limits.maxDepth) {
            throw new Error(`Hosted execution fan-out budget exceeded: depth ${depth} exceeds limit ${limits.maxDepth}`);
          }
          if (limits.maxChildrenPerParent !== undefined) {
            const siblings = this.db.prepare(`SELECT COUNT(*) AS count FROM hosted_executions WHERE parent_execution_id = @parentId`).get({ parentId: params.parentExecutionId }) as { count: number };
            if (Number(siblings.count) >= limits.maxChildrenPerParent) {
              throw new Error(`Hosted execution fan-out budget exceeded: parent already has ${limits.maxChildrenPerParent} children`);
            }
          }
          if (limits.maxDescendantsPerRoot !== undefined && rootExecutionId) {
            const descendants = this.db.prepare(`SELECT COUNT(*) AS count FROM hosted_executions WHERE root_execution_id = @rootId`).get({ rootId: rootExecutionId }) as { count: number };
            if (Number(descendants.count) >= limits.maxDescendantsPerRoot) {
              throw new Error(`Hosted execution fan-out budget exceeded: root already has ${limits.maxDescendantsPerRoot} descendants`);
            }
          }
        }
      }
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO hosted_executions (id, idempotency_key, user_id, task_id, provider_id, model_id, status, priority, attempt, eligible_at, cancellation_requested, request_payload, parent_execution_id, root_execution_id, depth, created_at, updated_at) VALUES (@id, @idempotencyKey, @userId, @taskId, @providerId, @modelId, 'queued', @priority, 0, @eligibleAt, 0, @requestPayload, @parentExecutionId, @rootExecutionId, @depth, @now, @now)`).run({ id: params.id, idempotencyKey: params.idempotencyKey, userId: params.userId, taskId: params.taskId, providerId: params.providerId, modelId: params.modelId, priority: params.priority ?? 0, eligibleAt: params.eligibleAt ?? now, requestPayload: params.requestPayload ?? null, parentExecutionId: params.parentExecutionId ?? null, rootExecutionId, depth, now });
      this.insertHostedAdmissionReceipt({ executionId: params.id, userId: params.userId, eventType: "QUEUE_ENQUEUED", createdAt: now });
      const row = this.db.prepare(`SELECT * FROM hosted_executions WHERE id = @id`).get({ id: params.id }) as Record<string, unknown>;
      return { execution: this.mapHostedExecutionRow(row), created: true };
    });
  }

  async getHostedExecution(id: string, userId: string): Promise<HostedExecutionRecord | undefined> {
    const row = this.db.prepare(`SELECT * FROM hosted_executions WHERE id = @id AND user_id = @userId`).get({ id, userId }) as Record<string, unknown> | undefined;
    return row ? this.mapHostedExecutionRow(row) : undefined;
  }

  async listHostedExecutionChildren(executionId: string, userId: string): Promise<HostedExecutionRecord[]> {
    const owns = this.db.prepare(`SELECT 1 FROM hosted_executions WHERE id = @executionId AND user_id = @userId`).get({ executionId, userId });
    if (!owns) throw new Error("Hosted execution not found for user");
    return (this.db.prepare(`SELECT * FROM hosted_executions WHERE parent_execution_id = @executionId AND user_id = @userId ORDER BY created_at ASC`).all({ executionId, userId }) as Record<string, unknown>[]).map((row) => this.mapHostedExecutionRow(row));
  }

  async listHostedExecutions(userId: string, limit = 100): Promise<HostedExecutionRecord[]> {
    // Payload columns are deliberately excluded: a list is a metadata projection, and carrying up
    // to `limit` request/result bodies through every poll would make status listing a DoS vector.
    return (this.db.prepare(`SELECT id, idempotency_key, user_id, task_id, provider_id, model_id, status, priority, attempt, eligible_at, lease_owner, lease_expires_at, lease_token, cancellation_requested, dispatched_at, terminal_at, parent_execution_id, root_execution_id, created_at, updated_at FROM hosted_executions WHERE user_id = @userId ORDER BY created_at DESC LIMIT @limit`).all({ userId, limit }) as Record<string, unknown>[]).map((row) => this.mapHostedExecutionRow(row));
  }

  async setHostedProviderCapacity(params: { providerId: string; modelId: string; maxConcurrent: number }): Promise<void> {
    if (!Number.isSafeInteger(params.maxConcurrent) || params.maxConcurrent < 0) throw new Error("maxConcurrent must be a non-negative safe integer");
    this.db.prepare(`INSERT INTO hosted_provider_capacity (provider_id, model_id, max_concurrent, updated_at) VALUES (@providerId, @modelId, @maxConcurrent, @now) ON CONFLICT(provider_id, model_id) DO UPDATE SET max_concurrent = excluded.max_concurrent, updated_at = excluded.updated_at`).run({ ...params, now: new Date().toISOString() });
  }

  async ensureHostedProviderCapacity(params: { providerId: string; modelId: string; maxConcurrent: number }): Promise<void> {
    return this.txSync(() => {
      this.db.prepare(`INSERT INTO hosted_provider_capacity (provider_id, model_id, max_concurrent, updated_at) VALUES (@providerId, @modelId, @maxConcurrent, @now) ON CONFLICT(provider_id, model_id) DO NOTHING`).run({ ...params, now: new Date().toISOString() });
    });
  }

  async claimNextHostedExecution(params: { workerId: string; leaseMs: number; maxUserConcurrent: number; providerIds?: string[]; now?: Date }): Promise<{ execution: HostedExecutionRecord; lease: HostedCapacityLeaseRecord } | undefined> {
    if (!Number.isSafeInteger(params.leaseMs) || params.leaseMs < 1) throw new Error("leaseMs must be a positive safe integer");
    if (!Number.isSafeInteger(params.maxUserConcurrent) || params.maxUserConcurrent < 1) throw new Error("maxUserConcurrent must be a positive safe integer");
    return this.txSync(() => {
      const now = params.now ?? new Date();
      const nowIso = now.toISOString();
      // Capability scope: the filter applies to both the candidate and the per-user "earlier" head
      // check, so a queued row for a provider this worker cannot run never hides the user's
      // claimable work behind it.
      const scope = params.providerIds === undefined ? "" : " AND e.provider_id IN (SELECT value FROM json_each(@providerIds))";
      const earlierScope = params.providerIds === undefined ? "" : " AND earlier.provider_id IN (SELECT value FROM json_each(@providerIds))";
      const bind: Record<string, unknown> = { now: nowIso, maxUserConcurrent: params.maxUserConcurrent };
      if (params.providerIds !== undefined) bind.providerIds = JSON.stringify(params.providerIds);
      const row = this.db.prepare(`
        SELECT e.* FROM hosted_executions e
        LEFT JOIN hosted_user_admission_state uas ON uas.user_id = e.user_id
        JOIN hosted_provider_capacity pc ON pc.provider_id = e.provider_id AND pc.model_id = e.model_id
        WHERE e.status = 'queued' AND e.eligible_at <= @now${scope}
          AND NOT EXISTS (SELECT 1 FROM hosted_executions earlier WHERE earlier.user_id = e.user_id AND earlier.status = 'queued'${earlierScope} AND (earlier.priority > e.priority OR (earlier.priority = e.priority AND earlier.created_at < e.created_at)))
          AND (SELECT COUNT(*) FROM hosted_capacity_leases ul WHERE ul.user_id = e.user_id AND ul.state = 'active' AND ul.lease_expires_at > @now) < @maxUserConcurrent
          AND (SELECT COUNT(*) FROM hosted_capacity_leases rl WHERE rl.provider_id = e.provider_id AND rl.model_id = e.model_id AND rl.state = 'active' AND rl.lease_expires_at > @now) < pc.max_concurrent
        ORDER BY CASE WHEN uas.last_admitted_at IS NULL THEN 0 ELSE 1 END, uas.last_admitted_at ASC, e.priority DESC, e.created_at ASC
        LIMIT 1
      `).get(bind) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      const leaseId = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + params.leaseMs).toISOString();
      const updated = this.db.prepare(`UPDATE hosted_executions SET status = 'claimed', lease_owner = @workerId, lease_expires_at = @leaseExpiresAt, lease_token = @leaseToken, attempt = attempt + 1, updated_at = @now WHERE id = @id AND status = 'queued'`).run({ id: String(row.id), workerId: params.workerId, leaseExpiresAt, leaseToken: leaseId, now: nowIso });
      if (Number(updated.changes) !== 1) return undefined;
      this.db.prepare(`INSERT INTO hosted_capacity_leases (id, execution_id, user_id, provider_id, model_id, worker_id, state, lease_expires_at, created_at) VALUES (@id, @executionId, @userId, @providerId, @modelId, @workerId, 'active', @leaseExpiresAt, @now)`).run({ id: leaseId, executionId: String(row.id), userId: String(row.user_id), providerId: String(row.provider_id), modelId: String(row.model_id), workerId: params.workerId, leaseExpiresAt, now: nowIso });
      this.db.prepare(`INSERT INTO hosted_user_admission_state (user_id, last_admitted_at, updated_at) VALUES (@userId, @now, @now) ON CONFLICT(user_id) DO UPDATE SET last_admitted_at = excluded.last_admitted_at, updated_at = excluded.updated_at`).run({ userId: String(row.user_id), now: nowIso });
      this.insertHostedAdmissionReceipt({ executionId: String(row.id), userId: String(row.user_id), eventType: "CAPACITY_RESERVED", workerId: params.workerId, createdAt: nowIso, details: { leaseExpiresAt } });
      const executionRow = this.db.prepare(`SELECT * FROM hosted_executions WHERE id = @id`).get({ id: String(row.id) }) as Record<string, unknown>;
      const leaseRow = this.db.prepare(`SELECT * FROM hosted_capacity_leases WHERE id = @id`).get({ id: leaseId }) as Record<string, unknown>;
      return { execution: this.mapHostedExecutionRow(executionRow), lease: this.mapHostedCapacityLeaseRow(leaseRow) };
    });
  }

  async markHostedExecutionDispatching(params: { executionId: string; workerId: string; leaseToken: string; providerDispatchId?: string }): Promise<HostedExecutionRecord> {
    return this.txSync(() => {
      const row = this.db.prepare(`SELECT * FROM hosted_executions WHERE id = @executionId`).get({ executionId: params.executionId }) as Record<string, unknown> | undefined;
      if (!row || String(row.lease_owner) !== params.workerId || String(row.lease_token) !== params.leaseToken || String(row.status) !== "claimed") throw new Error("Execution is not claimed by this worker lease");
      const now = new Date().toISOString();
      const providerDispatchId = params.providerDispatchId ?? (row.provider_dispatch_id != null ? String(row.provider_dispatch_id) : null);
      this.db.prepare(`UPDATE hosted_executions SET status = 'dispatching', dispatched_at = @now, provider_dispatch_id = @providerDispatchId, updated_at = @now WHERE id = @executionId`).run({ executionId: params.executionId, now, providerDispatchId });
      this.insertHostedAdmissionReceipt({ executionId: params.executionId, userId: String(row.user_id), eventType: "DISPATCH_STARTED", workerId: params.workerId, createdAt: now });
      return this.mapHostedExecutionRow({ ...row, status: "dispatching", dispatched_at: now, provider_dispatch_id: providerDispatchId, updated_at: now });
    });
  }

  async completeHostedExecution(params: { executionId: string; userId: string; workerId: string; leaseToken: string; status: "completed" | "failed"; releaseReason?: string; resultPayload?: string; resultError?: string }): Promise<{ execution: HostedExecutionRecord; transitioned: boolean }> {
    return this.txSync(() => {
      const row = this.db.prepare(`SELECT * FROM hosted_executions WHERE id = @executionId AND user_id = @userId`).get({ executionId: params.executionId, userId: params.userId }) as Record<string, unknown> | undefined;
      if (!row) throw new Error("Hosted execution not found for user");
      if (["completed", "failed", "cancelled"].includes(String(row.status))) return { execution: this.mapHostedExecutionRow(row), transitioned: false };
      // Fencing: only the worker holding the token minted by the winning claim may terminalize a
      // live execution. A stale worker whose lease expired and was reclaimed is rejected here.
      if (String(row.lease_owner) !== params.workerId || String(row.lease_token) !== params.leaseToken) {
        throw new Error("Hosted execution lease fencing token does not match this worker");
      }
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE hosted_executions SET status = @status, lease_owner = NULL, lease_expires_at = NULL, lease_token = NULL, result_payload = @resultPayload, result_error = @resultError, terminal_at = @now, updated_at = @now WHERE id = @executionId AND user_id = @userId`).run({ executionId: params.executionId, userId: params.userId, status: params.status, resultPayload: params.resultPayload ?? null, resultError: params.resultError ?? null, now });
      this.db.prepare(`UPDATE hosted_capacity_leases SET state = 'released', released_at = @now, release_reason = @reason WHERE execution_id = @executionId AND state = 'active'`).run({ executionId: params.executionId, now, reason: params.releaseReason ?? params.status });
      this.insertHostedAdmissionReceipt({ executionId: params.executionId, userId: params.userId, eventType: "CAPACITY_RELEASED", createdAt: now, details: { status: params.status } });
      const updated = this.db.prepare(`SELECT * FROM hosted_executions WHERE id = @executionId`).get({ executionId: params.executionId }) as Record<string, unknown>;
      return { execution: this.mapHostedExecutionRow(updated), transitioned: true };
    });
  }

  async cancelHostedExecution(params: { executionId: string; userId: string }): Promise<{ execution: HostedExecutionRecord; dispatchMayHaveStarted: boolean; transitioned: boolean; cancelledChildIds: string[] }> {
    return this.txSync(() => {
      const row = this.db.prepare(`SELECT * FROM hosted_executions WHERE id = @executionId AND user_id = @userId`).get({ executionId: params.executionId, userId: params.userId }) as Record<string, unknown> | undefined;
      if (!row) throw new Error("Hosted execution not found for user");
      if (["completed", "failed", "cancelled"].includes(String(row.status))) return { execution: this.mapHostedExecutionRow(row), dispatchMayHaveStarted: String(row.status) !== "queued", transitioned: false, cancelledChildIds: [] };
      const dispatchMayHaveStarted = String(row.status) === "dispatching" || String(row.status) === "recovery_pending";
      const now = new Date().toISOString();
      const cancelOne = (executionId: string, isChild: boolean) => {
        const target = this.db.prepare(`SELECT status FROM hosted_executions WHERE id = @id`).get({ id: executionId }) as Record<string, unknown> | undefined;
        if (!target || ["completed", "failed", "cancelled"].includes(String(target.status))) return false;
        this.db.prepare(`UPDATE hosted_executions SET status = 'cancelled', cancellation_requested = 1, lease_owner = NULL, lease_expires_at = NULL, lease_token = NULL, terminal_at = @now, updated_at = @now WHERE id = @id`).run({ id: executionId, now });
        this.db.prepare(`UPDATE hosted_capacity_leases SET state = 'released', released_at = @now, release_reason = 'cancelled' WHERE execution_id = @id AND state = 'active'`).run({ id: executionId, now });
        this.insertHostedAdmissionReceipt({ executionId, userId: params.userId, eventType: "CANCELLED", createdAt: now, details: { cancelledAsChild: isChild } });
        return true;
      };
      this.insertHostedAdmissionReceipt({ executionId: params.executionId, userId: params.userId, eventType: "CANCEL_REQUESTED", createdAt: now, details: { dispatchMayHaveStarted } });
      cancelOne(params.executionId, false);
      // Cascade to every non-terminal descendant — a cancelled parent must never leave orphaned
      // subagent children queued or running against provider capacity.
      const descendants = this.db.prepare(`WITH RECURSIVE tree(id) AS (SELECT id FROM hosted_executions WHERE parent_execution_id = @root UNION ALL SELECT e.id FROM hosted_executions e JOIN tree t ON e.parent_execution_id = t.id) SELECT id FROM tree`).all({ root: params.executionId }) as Record<string, unknown>[];
      const cancelledChildIds: string[] = [];
      for (const child of descendants) {
        const childRow = this.db.prepare(`SELECT user_id FROM hosted_executions WHERE id = @id`).get({ id: String(child.id) }) as Record<string, unknown> | undefined;
        if (childRow && String(childRow.user_id) === params.userId && cancelOne(String(child.id), true)) cancelledChildIds.push(String(child.id));
      }
      const updated = this.db.prepare(`SELECT * FROM hosted_executions WHERE id = @executionId`).get({ executionId: params.executionId }) as Record<string, unknown>;
      const result = { execution: this.mapHostedExecutionRow(updated), dispatchMayHaveStarted, transitioned: true, cancelledChildIds };
      // In-process wake-up (the SQLite parity of Postgres LISTEN/NOTIFY): an embedded database has
      // exactly one owning process, so emitting after commit reaches every local subscriber. The
      // durable terminal-state check remains the fallback for anything missed.
      queueMicrotask(() => this.emitHostedEvent({ kind: "execution.cancelled", executionIds: [params.executionId, ...cancelledChildIds] }));
      return result;
    });
  }

  async renewHostedExecutionLease(params: { executionId: string; workerId: string; leaseToken: string; leaseMs: number; now?: Date }): Promise<HostedCapacityLeaseRecord> {
    return this.txSync(() => {
      const now = params.now ?? new Date();
      const leaseExpiresAt = new Date(now.getTime() + params.leaseMs).toISOString();
      const result = this.db.prepare(`UPDATE hosted_capacity_leases SET lease_expires_at = @leaseExpiresAt WHERE id = @leaseToken AND execution_id = @executionId AND worker_id = @workerId AND state = 'active'`).run({ leaseToken: params.leaseToken, executionId: params.executionId, workerId: params.workerId, leaseExpiresAt });
      if (Number(result.changes) !== 1) throw new Error("Active hosted execution lease not found for worker");
      this.db.prepare(`UPDATE hosted_executions SET lease_expires_at = @leaseExpiresAt, updated_at = @now WHERE id = @executionId AND lease_owner = @workerId AND lease_token = @leaseToken AND status IN ('claimed', 'dispatching')`).run({ executionId: params.executionId, workerId: params.workerId, leaseToken: params.leaseToken, leaseExpiresAt, now: now.toISOString() });
      const row = this.db.prepare(`SELECT * FROM hosted_capacity_leases WHERE id = @leaseToken`).get({ leaseToken: params.leaseToken }) as Record<string, unknown>;
      return this.mapHostedCapacityLeaseRow(row);
    });
  }

  async resolveHostedRecoveryPending(params: { executionId: string; workerId: string; reason?: string; resolution?: "failed" | "requeue" }): Promise<{ execution: HostedExecutionRecord; transitioned: boolean }> {
    return this.txSync(() => {
      const row = this.db.prepare(`SELECT * FROM hosted_executions WHERE id = @id`).get({ id: params.executionId }) as Record<string, unknown> | undefined;
      if (!row) throw new Error("Hosted execution not found");
      if (String(row.status) !== "recovery_pending") return { execution: this.mapHostedExecutionRow(row), transitioned: false };
      const now = new Date().toISOString();
      const resolution = params.resolution ?? "failed";
      if (resolution === "requeue") {
        // safe_retry only: the caller established the provider deduplicates the persisted dispatch
        // identity — without one the outcome is ambiguous and must resolve failed instead.
        if (row.provider_dispatch_id == null) {
          throw new Error("Cannot requeue a recovery_pending execution with no provider dispatch identity — the outcome is ambiguous, resolve failed instead");
        }
        this.db.prepare(`UPDATE hosted_executions SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, lease_token = NULL, updated_at = @now WHERE id = @id`).run({ id: params.executionId, now });
        this.db.prepare(`UPDATE hosted_capacity_leases SET state = 'expired', released_at = @now, release_reason = 'recovery_resolved' WHERE execution_id = @id AND state = 'active'`).run({ id: params.executionId, now });
        this.insertHostedAdmissionReceipt({ executionId: params.executionId, userId: String(row.user_id), eventType: "RECOVERY_RESOLVED", workerId: params.workerId, createdAt: now, details: { resolution: "requeue", providerDispatchId: String(row.provider_dispatch_id) } });
        const requeued = this.db.prepare(`SELECT * FROM hosted_executions WHERE id = @id`).get({ id: params.executionId }) as Record<string, unknown>;
        return { execution: this.mapHostedExecutionRow(requeued), transitioned: true };
      }
      // Fail closed: a post-dispatch worker loss leaves the provider outcome unknowable, so the
      // execution terminalizes as failed with an honest reason — never silently requeued into a
      // potential duplicate provider call.
      this.db.prepare(`UPDATE hosted_executions SET status = 'failed', result_error = @reason, lease_owner = NULL, lease_expires_at = NULL, lease_token = NULL, terminal_at = @now, updated_at = @now WHERE id = @id`).run({ id: params.executionId, reason: params.reason ?? "dispatch outcome ambiguous after worker loss", now });
      this.db.prepare(`UPDATE hosted_capacity_leases SET state = 'expired', released_at = @now, release_reason = 'recovery_resolved' WHERE execution_id = @id AND state = 'active'`).run({ id: params.executionId, now });
      this.insertHostedAdmissionReceipt({ executionId: params.executionId, userId: String(row.user_id), eventType: "RECOVERY_RESOLVED", workerId: params.workerId, createdAt: now, details: { resolution: "failed" } });
      const updated = this.db.prepare(`SELECT * FROM hosted_executions WHERE id = @id`).get({ id: params.executionId }) as Record<string, unknown>;
      return { execution: this.mapHostedExecutionRow(updated), transitioned: true };
    });
  }

  async recoverExpiredHostedLeases(now = new Date()): Promise<{ recovered: number; executionIds: string[] }> {
    return this.txSync(() => {
      const nowIso = now.toISOString();
      const rows = this.db.prepare(`SELECT e.id, e.user_id, e.status FROM hosted_executions e JOIN hosted_capacity_leases l ON l.execution_id = e.id WHERE l.state = 'active' AND l.lease_expires_at <= @now AND e.status IN ('claimed', 'dispatching')`).all({ now: nowIso }) as Record<string, unknown>[];
      for (const row of rows) {
        const nextStatus = String(row.status) === "claimed" ? "queued" : "recovery_pending";
        this.db.prepare(`UPDATE hosted_executions SET status = @nextStatus, lease_owner = NULL, lease_expires_at = NULL, lease_token = NULL, updated_at = @now WHERE id = @id`).run({ id: String(row.id), nextStatus, now: nowIso });
        this.db.prepare(`UPDATE hosted_capacity_leases SET state = 'expired', released_at = @now, release_reason = 'lease_expired' WHERE execution_id = @id AND state = 'active'`).run({ id: String(row.id), now: nowIso });
        this.insertHostedAdmissionReceipt({ executionId: String(row.id), userId: String(row.user_id), eventType: "LEASE_EXPIRED", createdAt: nowIso, details: { nextStatus } });
      }
      return { recovered: rows.length, executionIds: rows.map((row) => String(row.id)) };
    });
  }

  async listHostedTerminalExecutionIds(executionIds: string[]): Promise<string[]> {
    if (executionIds.length === 0) return [];
    const rows = this.db.prepare(`SELECT id FROM hosted_executions WHERE status IN ('completed','failed','cancelled') AND id IN (SELECT value FROM json_each(@ids))`).all({ ids: JSON.stringify(executionIds) }) as Record<string, unknown>[];
    return rows.map((row) => String(row.id));
  }

  async listHostedExecutionsByStatus(status: HostedExecutionStatus, limit = 200): Promise<HostedExecutionRecord[]> {
    // Metadata projection — payloads excluded; a live row is resolved by id when needed.
    const rows = this.db.prepare(`SELECT id, idempotency_key, user_id, task_id, provider_id, model_id, status, priority, attempt, eligible_at, lease_owner, lease_expires_at, lease_token, cancellation_requested, dispatched_at, terminal_at, parent_execution_id, root_execution_id, depth, provider_dispatch_id, created_at, updated_at FROM hosted_executions WHERE status = @status ORDER BY updated_at ASC LIMIT @limit`).all({ status, limit }) as Record<string, unknown>[];
    return rows.map((row) => this.mapHostedExecutionRow(row));
  }

  async getHostedExecutionTreeStats(rootExecutionId: string, userId: string): Promise<HostedExecutionTreeStats | undefined> {
    const owns = this.db.prepare(`SELECT 1 FROM hosted_executions WHERE id = @id AND user_id = @userId`).get({ id: rootExecutionId, userId });
    if (!owns) return undefined;
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS count, COALESCE(SUM(attempt),0) AS attempts, COALESCE(MAX(depth),0) AS max_depth FROM hosted_executions WHERE id = @root OR root_execution_id = @root GROUP BY status`).all({ root: rootExecutionId }) as Record<string, unknown>[];
    const byStatus: Partial<Record<HostedExecutionStatus, number>> = {};
    let totalExecutions = 0;
    let activeDescendants = 0;
    let providerDispatchAttempts = 0;
    let maxDepth = 0;
    for (const row of rows) {
      const status = String(row.status) as HostedExecutionStatus;
      const count = Number(row.count);
      byStatus[status] = count;
      totalExecutions += count;
      providerDispatchAttempts += Number(row.attempts);
      maxDepth = Math.max(maxDepth, Number(row.max_depth));
      if (!["completed", "failed", "cancelled"].includes(status)) activeDescendants += count;
    }
    // activeDescendants means "live descendants": subtract the root's own row when it is live.
    const root = this.db.prepare(`SELECT status FROM hosted_executions WHERE id = @id`).get({ id: rootExecutionId }) as Record<string, unknown> | undefined;
    if (root && !["completed", "failed", "cancelled"].includes(String(root.status))) activeDescendants -= 1;
    return { rootExecutionId, totalExecutions, byStatus, activeDescendants, providerDispatchAttempts, maxDepth };
  }

  async appendHostedExecutionStreamEvent(params: { executionId: string; userId: string; payload: string; createdAt?: string }): Promise<number> {
    if (params.payload.length > 64 * 1024) throw new Error("Hosted stream event exceeds the 64 KiB event limit");
    return this.txSync(() => {
      const owned = this.db.prepare(`SELECT 1 FROM hosted_executions WHERE id = @executionId AND user_id = @userId`).get({ executionId: params.executionId, userId: params.userId });
      if (!owned) throw new Error("Hosted execution not found for user");
      const result = this.db.prepare(`INSERT INTO hosted_execution_stream_events (execution_id, user_id, payload, created_at) VALUES (@executionId, @userId, @payload, @createdAt)`).run({ ...params, createdAt: params.createdAt ?? new Date().toISOString() });
      return Number(result.lastInsertRowid);
    });
  }

  async listHostedExecutionStreamEvents(params: { executionId: string; userId: string; afterSequence: number; limit?: number }): Promise<HostedExecutionStreamEventRecord[]> {
    const owned = this.db.prepare(`SELECT 1 FROM hosted_executions WHERE id = @executionId AND user_id = @userId`).get({ executionId: params.executionId, userId: params.userId });
    if (!owned) throw new Error("Hosted execution not found for user");
    const rows = this.db.prepare(`SELECT sequence, payload, created_at FROM hosted_execution_stream_events WHERE execution_id = @executionId AND user_id = @userId AND sequence > @afterSequence ORDER BY sequence ASC LIMIT @limit`).all({ ...params, limit: Math.min(Math.max(params.limit ?? 128, 1), 512) }) as Record<string, unknown>[];
    return rows.map((row) => ({ sequence: Number(row.sequence), payload: String(row.payload), createdAt: String(row.created_at) }));
  }

  private readonly hostedEventEmitter = new EventEmitter();

  private emitHostedEvent(event: HostedExecutionEvent): void {
    this.hostedEventEmitter.emit("hosted-execution-event", event);
  }

  /**
   * In-process parity of the Postgres LISTEN/NOTIFY channel: an embedded database has exactly one
   * owning process, which is also where cancellations commit — so a same-process emitter delivers
   * the same wake-up semantics. The durable terminal-state check remains the correctness path.
   */
  async subscribeHostedExecutionEvents(handler: (event: HostedExecutionEvent) => void): Promise<HostedExecutionEventSubscription> {
    this.hostedEventEmitter.on("hosted-execution-event", handler);
    let closed = false;
    return {
      close: async () => {
        if (closed) return;
        closed = true;
        this.hostedEventEmitter.off("hosted-execution-event", handler);
      },
    };
  }

  async listHostedAdmissionReceipts(executionId: string, userId: string): Promise<HostedAdmissionReceiptRecord[]> {
    const owns = this.db.prepare(`SELECT 1 FROM hosted_executions WHERE id = @executionId AND user_id = @userId`).get({ executionId, userId });
    if (!owns) throw new Error("Hosted execution not found for user");
    return (this.db.prepare(`SELECT * FROM hosted_admission_receipts WHERE execution_id = @executionId AND user_id = @userId ORDER BY created_at ASC`).all({ executionId, userId }) as Record<string, unknown>[]).map((row) => ({ id: String(row.id), executionId: String(row.execution_id), userId: String(row.user_id), eventType: row.event_type as HostedAdmissionReceiptRecord["eventType"], workerId: row.worker_id ? String(row.worker_id) : undefined, details: row.details ? JSON.parse(String(row.details)) : undefined, createdAt: String(row.created_at) }));
  }

  async getHostedAdmissionMetrics(): Promise<HostedAdmissionMetrics> {
    const count = (sql: string) => Number((this.db.prepare(sql).get() as { count?: number } | undefined)?.count ?? 0);
    return {
      queueDepth: count(`SELECT COUNT(*) AS count FROM hosted_executions WHERE status = 'queued'`),
      queuedUsers: count(`SELECT COUNT(DISTINCT user_id) AS count FROM hosted_executions WHERE status = 'queued'`),
      activeUsers: count(`SELECT COUNT(DISTINCT user_id) AS count FROM hosted_capacity_leases WHERE state = 'active'`),
      activeReservations: count(`SELECT COUNT(*) AS count FROM hosted_capacity_leases WHERE state = 'active'`),
      reservationExpirations: count(`SELECT COUNT(*) AS count FROM hosted_capacity_leases WHERE state = 'expired'`),
      duplicateRequestSuppressions: count(`SELECT COUNT(*) AS count FROM hosted_admission_receipts WHERE event_type = 'DUPLICATE_SUPPRESSED'`),
      cancellations: count(`SELECT COUNT(*) AS count FROM hosted_executions WHERE status = 'cancelled'`),
    };
  }

  // --- Usage Periods ---

  async getOrCreateCurrentUsagePeriod(userId: string, allowanceAmount = 500_000, now: Date = new Date()): Promise<{ period: UsagePeriodRecord; grantedNewAllowance: boolean }> {
    const nowIso = now.toISOString();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
    const activeRow = this.db.prepare(`
      SELECT * FROM usage_periods
      WHERE user_id = @userId AND period_start = @periodStart
      LIMIT 1
    `).get({ userId, periodStart }) as Record<string, unknown> | undefined;

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
      const existingPeriod = this.db.prepare(`SELECT * FROM usage_periods WHERE user_id = @userId AND period_start = @periodStart LIMIT 1`).get({ userId, periodStart }) as Record<string, unknown> | undefined;
      if (existingPeriod) {
        return {
          period: {
            id: String(existingPeriod.id),
            userId: String(existingPeriod.user_id),
            periodStart: String(existingPeriod.period_start),
            periodEnd: String(existingPeriod.period_end),
            freeAllowanceGranted: Number(existingPeriod.free_allowance_granted),
            creditsUsed: Number(existingPeriod.credits_used),
            createdAt: String(existingPeriod.created_at),
            updatedAt: String(existingPeriod.updated_at),
          },
          grantedNewAllowance: false,
        };
      }

      // Carry forward only usage already consumed during this UTC month, never unused grants.
      const historicalUsage = this.db.prepare(`
        SELECT COALESCE(SUM(credits_consumed), 0) AS credits
        FROM usage_events
        WHERE user_id = @userId AND access_class = 'free' AND created_at >= @periodStart AND created_at < @periodEnd
      `).get({ userId, periodStart, periodEnd }) as { credits?: number } | undefined;
      const creditsUsed = Number(historicalUsage?.credits ?? 0);
      const id = randomUUID();

      this.db.prepare(`
        INSERT INTO usage_periods (id, user_id, period_start, period_end, free_allowance_granted, credits_used, created_at, updated_at)
        VALUES (@id, @userId, @periodStart, @periodEnd, @freeAllowanceGranted, @creditsUsed, @nowIso, @nowIso)
      `).run({
        id,
        userId,
        periodStart,
        periodEnd,
        freeAllowanceGranted: allowanceAmount,
        creditsUsed,
        nowIso,
      });

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

  private getUsagePeriodRemainingSync(periodId: string): number {
    const period = this.db.prepare(`SELECT free_allowance_granted, credits_used FROM usage_periods WHERE id = @periodId`).get({ periodId }) as { free_allowance_granted?: number; credits_used?: number } | undefined;
    if (!period) return 0;
    const active = this.db.prepare(`SELECT COALESCE(SUM(reserved_credits), 0) AS credits FROM reservations WHERE usage_period_id = @periodId AND status = 'reserved'`).get({ periodId }) as { credits?: number } | undefined;
    return Math.max(0, Number(period.free_allowance_granted ?? 0) - Number(period.credits_used ?? 0) - Number(active?.credits ?? 0));
  }

  async getUsagePeriodReservedCredits(periodId: string): Promise<number> {
    const row = this.db.prepare(`SELECT COALESCE(SUM(reserved_credits), 0) AS credits FROM reservations WHERE usage_period_id = @periodId AND status = 'reserved'`).get({ periodId }) as { credits?: number } | undefined;
    return Number(row?.credits ?? 0);
  }

  // --- OAuth Transactions ---

  async createOAuthTransaction(params: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
    deviceName?: string;
    gitHubCodeVerifier?: string;
    expiresInSeconds?: number;
  }): Promise<OAuthTransactionRecord> {
    const now = new Date();
    const expires = new Date(now.getTime() + (params.expiresInSeconds ?? 600) * 1000);
    const record: OAuthTransactionRecord = {
      id: randomUUID(),
      state: params.state,
      codeChallenge: params.codeChallenge,
      gitHubCodeVerifier: params.gitHubCodeVerifier,
      redirectUri: params.redirectUri,
      deviceName: params.deviceName,
      expiresAt: expires.toISOString(),
      usedAt: null,
      createdAt: now.toISOString(),
    };

    this.db.prepare(`
      INSERT INTO oauth_transactions (id, state, code_challenge, github_code_verifier, redirect_uri, device_name, expires_at, used_at, created_at)
      VALUES (@id, @state, @codeChallenge, @gitHubCodeVerifier, @redirectUri, @deviceName, @expiresAt, @usedAt, @createdAt)
    `).run({
      id: record.id,
      state: record.state,
      codeChallenge: record.codeChallenge,
      gitHubCodeVerifier: record.gitHubCodeVerifier ?? null,
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
      gitHubCodeVerifier: row.github_code_verifier ? String(row.github_code_verifier) : undefined,
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

  // --- Desktop Authorization Codes (single-use OAuth→desktop handoff) ---

  async createDesktopAuthCode(params: {
    codeHash: string;
    userId: string;
    codeChallenge: string;
    redirectUri: string;
    deviceName?: string;
    isNewUser?: boolean;
    expiresInSeconds?: number;
  }): Promise<DesktopAuthCodeRecord> {
    const now = new Date();
    const expires = new Date(now.getTime() + (params.expiresInSeconds ?? 120) * 1000);
    const record: DesktopAuthCodeRecord = {
      id: randomUUID(),
      codeHash: params.codeHash,
      userId: params.userId,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      deviceName: params.deviceName,
      isNewUser: params.isNewUser ?? false,
      expiresAt: expires.toISOString(),
      usedAt: null,
      createdAt: now.toISOString(),
    };

    this.db.prepare(`
      INSERT INTO desktop_auth_codes (id, code_hash, user_id, code_challenge, redirect_uri, device_name, is_new_user, expires_at, used_at, created_at)
      VALUES (@id, @codeHash, @userId, @codeChallenge, @redirectUri, @deviceName, @isNewUser, @expiresAt, NULL, @createdAt)
    `).run({
      id: record.id,
      codeHash: record.codeHash,
      userId: record.userId,
      codeChallenge: record.codeChallenge,
      redirectUri: record.redirectUri,
      deviceName: record.deviceName ?? null,
      isNewUser: record.isNewUser ? 1 : 0,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
    });

    return record;
  }

  private mapDesktopAuthCodeRow(row: Record<string, unknown>): DesktopAuthCodeRecord {
    return {
      id: String(row.id),
      codeHash: String(row.code_hash),
      userId: String(row.user_id),
      codeChallenge: String(row.code_challenge),
      redirectUri: String(row.redirect_uri),
      deviceName: row.device_name ? String(row.device_name) : undefined,
      isNewUser: Number(row.is_new_user) === 1,
      expiresAt: String(row.expires_at),
      usedAt: row.used_at ? String(row.used_at) : null,
      createdAt: String(row.created_at),
    };
  }

  async getDesktopAuthCode(codeHash: string): Promise<DesktopAuthCodeRecord | undefined> {
    const row = this.db.prepare(`SELECT * FROM desktop_auth_codes WHERE code_hash = @codeHash`).get({ codeHash }) as Record<string, unknown> | undefined;
    return row ? this.mapDesktopAuthCodeRow(row) : undefined;
  }

  async consumeDesktopAuthCode(codeHash: string): Promise<DesktopAuthCodeRecord> {
    const row = this.db.prepare(`SELECT * FROM desktop_auth_codes WHERE code_hash = @codeHash`).get({ codeHash }) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error("Desktop authorization code not found");
    }
    const record = this.mapDesktopAuthCodeRow(row);
    if (record.usedAt) {
      throw new Error("Desktop authorization code already consumed (replay detected)");
    }
    if (new Date(record.expiresAt).getTime() < Date.now()) {
      throw new Error("Desktop authorization code expired");
    }

    // Single-use: only the caller that flips used_at from NULL wins the row.
    const now = new Date().toISOString();
    const result = this.db.prepare(`UPDATE desktop_auth_codes SET used_at = @now WHERE code_hash = @codeHash AND used_at IS NULL`).run({ codeHash, now });
    if (Number(result.changes) === 0) {
      throw new Error("Desktop authorization code already consumed (replay detected)");
    }
    return { ...record, usedAt: now };
  }

  // --- Browser OAuth and opaque server-side sessions ---

  async createBrowserOAuthTransaction(params: { state: string; gitHubCodeVerifier: string; returnTarget: string; expiresInSeconds?: number }): Promise<BrowserOAuthTransactionRecord> {
    const now = new Date();
    const record: BrowserOAuthTransactionRecord = {
      id: randomUUID(),
      state: params.state,
      gitHubCodeVerifier: params.gitHubCodeVerifier,
      returnTarget: params.returnTarget,
      expiresAt: new Date(now.getTime() + (params.expiresInSeconds ?? 600) * 1000).toISOString(),
      usedAt: null,
      createdAt: now.toISOString(),
    };
    this.db.prepare(`
      INSERT INTO browser_oauth_transactions (id, state, github_code_verifier, return_target, expires_at, used_at, created_at)
      VALUES (@id, @state, @gitHubCodeVerifier, @returnTarget, @expiresAt, NULL, @createdAt)
    `).run({
      id: record.id,
      state: record.state,
      gitHubCodeVerifier: record.gitHubCodeVerifier,
      returnTarget: record.returnTarget,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
    });
    return record;
  }

  private mapBrowserOAuthTransactionRow(row: Record<string, unknown>): BrowserOAuthTransactionRecord {
    return {
      id: String(row.id),
      state: String(row.state),
      gitHubCodeVerifier: String(row.github_code_verifier),
      returnTarget: String(row.return_target),
      expiresAt: String(row.expires_at),
      usedAt: row.used_at ? String(row.used_at) : null,
      createdAt: String(row.created_at),
    };
  }

  async getBrowserOAuthTransaction(state: string): Promise<BrowserOAuthTransactionRecord | undefined> {
    const row = this.db.prepare(`SELECT * FROM browser_oauth_transactions WHERE state = @state`).get({ state }) as Record<string, unknown> | undefined;
    return row ? this.mapBrowserOAuthTransactionRow(row) : undefined;
  }

  async consumeBrowserOAuthTransaction(state: string): Promise<BrowserOAuthTransactionRecord> {
    const row = this.db.prepare(`SELECT * FROM browser_oauth_transactions WHERE state = @state`).get({ state }) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Browser OAuth transaction not found");
    const record = this.mapBrowserOAuthTransactionRow(row);
    if (record.usedAt) throw new Error("Browser OAuth transaction already consumed (replay detected)");
    if (new Date(record.expiresAt).getTime() < Date.now()) throw new Error("Browser OAuth transaction expired");
    const now = new Date().toISOString();
    const result = this.db.prepare(`UPDATE browser_oauth_transactions SET used_at = @now WHERE state = @state AND used_at IS NULL`).run({ state, now });
    if (Number(result.changes) === 0) throw new Error("Browser OAuth transaction already consumed (replay detected)");
    return { ...record, usedAt: now };
  }

  async createBrowserSession(params: { userId: string; sessionTokenHash: string; expiresInSeconds?: number }): Promise<BrowserSessionRecord> {
    const now = new Date();
    const record: BrowserSessionRecord = {
      id: randomUUID(),
      userId: params.userId,
      sessionTokenHash: params.sessionTokenHash,
      expiresAt: new Date(now.getTime() + (params.expiresInSeconds ?? 7 * 24 * 60 * 60) * 1000).toISOString(),
      revokedAt: null,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
    };
    this.db.prepare(`INSERT INTO browser_sessions (id, user_id, session_token_hash, expires_at, revoked_at, created_at, last_seen_at) VALUES (@id, @userId, @sessionTokenHash, @expiresAt, NULL, @createdAt, @lastSeenAt)`).run({
      id: record.id,
      userId: record.userId,
      sessionTokenHash: record.sessionTokenHash,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      lastSeenAt: record.lastSeenAt,
    });
    return record;
  }

  private mapBrowserSessionRow(row: Record<string, unknown>): BrowserSessionRecord {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      sessionTokenHash: String(row.session_token_hash),
      expiresAt: String(row.expires_at),
      revokedAt: row.revoked_at ? String(row.revoked_at) : null,
      createdAt: String(row.created_at),
      lastSeenAt: String(row.last_seen_at),
    };
  }

  async getBrowserSessionByTokenHash(sessionTokenHash: string): Promise<BrowserSessionRecord | undefined> {
    const row = this.db.prepare(`SELECT * FROM browser_sessions WHERE session_token_hash = @sessionTokenHash`).get({ sessionTokenHash }) as Record<string, unknown> | undefined;
    return row ? this.mapBrowserSessionRow(row) : undefined;
  }

  async updateBrowserSessionLastSeen(id: string): Promise<void> {
    this.db.prepare(`UPDATE browser_sessions SET last_seen_at = @lastSeenAt WHERE id = @id`).run({ id, lastSeenAt: new Date().toISOString() });
  }

  async revokeBrowserSession(id: string): Promise<void> {
    this.db.prepare(`UPDATE browser_sessions SET revoked_at = @revokedAt WHERE id = @id AND revoked_at IS NULL`).run({ id, revokedAt: new Date().toISOString() });
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

  async claimGitHubWebhookDelivery(params: { deliveryId: string; event: string; action?: string; installationId?: number }): Promise<{ claimed: boolean }> {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO github_webhook_deliveries (id, delivery_id, event, action, installation_id, status, received_at, created_at)
      VALUES (@id, @deliveryId, @event, @action, @installationId, 'claimed', @now, @now)
      ON CONFLICT(delivery_id) DO NOTHING
    `).run({
      id: randomUUID(),
      deliveryId: params.deliveryId,
      event: params.event,
      action: params.action ?? null,
      installationId: params.installationId ?? null,
      now,
    });
    return { claimed: Number(result.changes) > 0 };
  }

  async completeGitHubWebhookDelivery(deliveryId: string, status: "processed" | "failed" | "ignored"): Promise<void> {
    this.db.prepare(`UPDATE github_webhook_deliveries SET status = @status, processed_at = @now WHERE delivery_id = @deliveryId`)
      .run({ deliveryId, status, now: new Date().toISOString() });
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

  // --- Security audit trail ---

  async recordSecurityAuditEvent(params: { occurredAt?: string; eventType: string; outcome: string; userId?: string; ipAddress?: string; details?: Record<string, string | number | boolean | null> }): Promise<SecurityAuditEventRecord> {
    const now = new Date().toISOString();
    const record: SecurityAuditEventRecord = {
      id: randomUUID(),
      occurredAt: params.occurredAt ?? now,
      eventType: params.eventType,
      outcome: params.outcome,
      userId: params.userId,
      ipAddress: params.ipAddress,
      details: params.details,
      createdAt: now,
    };
    this.db.prepare(`
      INSERT INTO security_audit_events (id, occurred_at, event_type, outcome, user_id, ip_address, details, created_at)
      VALUES (@id, @occurredAt, @eventType, @outcome, @userId, @ipAddress, @details, @createdAt)
    `).run({
      id: record.id,
      occurredAt: record.occurredAt,
      eventType: record.eventType,
      outcome: record.outcome,
      userId: record.userId ?? null,
      ipAddress: record.ipAddress ?? null,
      details: record.details ? JSON.stringify(record.details) : null,
      createdAt: record.createdAt,
    });
    return record;
  }

  async listSecurityAuditEvents(filter: { userId?: string; eventType?: string; limit?: number } = {}): Promise<SecurityAuditEventRecord[]> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit: Math.min(Math.max(filter.limit ?? 100, 1), 1000) };
    if (filter.userId) { clauses.push("user_id = @userId"); params.userId = filter.userId; }
    if (filter.eventType) { clauses.push("event_type = @eventType"); params.eventType = filter.eventType; }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM security_audit_events ${where} ORDER BY occurred_at DESC LIMIT @limit`).all(params) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      occurredAt: String(row.occurred_at),
      eventType: String(row.event_type),
      outcome: String(row.outcome),
      userId: row.user_id ? String(row.user_id) : undefined,
      ipAddress: row.ip_address ? String(row.ip_address) : undefined,
      details: row.details ? (JSON.parse(String(row.details)) as Record<string, string | number | boolean | null>) : undefined,
      createdAt: String(row.created_at),
    }));
  }

  // --- GDPR Article 17 Erasure ---

  /**
   * SQLite does not enforce ON DELETE CASCADE unless `PRAGMA foreign_keys = ON` is set for the
   * connection, which this codebase does not currently do — so, unlike the PostgreSQL backend,
   * this cannot lean on the schema's cascade clauses at all. Every table is deleted explicitly.
   * Wrapped in an explicit BEGIN/COMMIT/ROLLBACK (via the same `exec()` the rest of this class
   * already uses for DDL) rather than relying on per-statement autocommit, since this is a
   * multi-statement sequence that must never be left half-applied.
   */
  async deleteUserAccount(userId: string): Promise<AccountDeletionResult> {
    const tables: AccountDeletionTableSummary[] = [];
    const del = (table: string, sql: string): void => {
      const res = this.db.prepare(sql).run({ userId });
      tables.push({ table, rowsDeleted: Number(res.changes ?? 0) });
    };

    this.db.exec("BEGIN");
    try {
      const anonymized = this.db.prepare(`UPDATE abuse_events SET user_id = NULL WHERE user_id = @userId`).run({ userId });
      const auditAnonymized = this.db.prepare(`UPDATE security_audit_events SET user_id = NULL WHERE user_id = @userId`).run({ userId });

      // Children of github_installations (repository authorizations, publications) must be
      // deleted before that parent table — node:sqlite defaults foreign key enforcement to ON
      // (unlike better-sqlite3, which this module falls back to on older Node runtimes), so an
      // out-of-order explicit delete can be silently beaten by cascade, under-reporting this
      // receipt's counts even though the row does still end up gone either way.
      del(
        "github_repository_authorizations",
        `DELETE FROM github_repository_authorizations WHERE installation_id IN (SELECT id FROM github_installations WHERE codeforge_user_id = @userId)`,
      );
      del("publications", `DELETE FROM publications WHERE user_id = @userId`);
      del("github_installations", `DELETE FROM github_installations WHERE codeforge_user_id = @userId`);
      del("github_app_callback_states", `DELETE FROM github_app_callback_states WHERE codeforge_user_id = @userId`);
      del("desktop_auth_codes", `DELETE FROM desktop_auth_codes WHERE user_id = @userId`);
      del("browser_sessions", `DELETE FROM browser_sessions WHERE user_id = @userId`);
      del("identities", `DELETE FROM identities WHERE user_id = @userId`);
      del("device_sessions", `DELETE FROM device_sessions WHERE user_id = @userId`);
      del("subscriptions", `DELETE FROM subscriptions WHERE user_id = @userId`);
      del("entitlements", `DELETE FROM entitlements WHERE user_id = @userId`);
      del("credit_ledger", `DELETE FROM credit_ledger WHERE user_id = @userId`);
      del("usage_events", `DELETE FROM usage_events WHERE user_id = @userId`);
      del("usage_periods", `DELETE FROM usage_periods WHERE user_id = @userId`);
      del("reservations", `DELETE FROM reservations WHERE user_id = @userId`);
      del("hosted_requests", `DELETE FROM hosted_requests WHERE user_id = @userId`);
      del("hosted_admission_receipts", `DELETE FROM hosted_admission_receipts WHERE user_id = @userId`);
      del("hosted_capacity_leases", `DELETE FROM hosted_capacity_leases WHERE user_id = @userId`);
      del("hosted_user_admission_state", `DELETE FROM hosted_user_admission_state WHERE user_id = @userId`);
      del("hosted_executions", `DELETE FROM hosted_executions WHERE user_id = @userId`);
      del("account_settings", `DELETE FROM account_settings WHERE user_id = @userId`);
      del("users", `DELETE FROM users WHERE id = @userId`);

      this.db.exec("COMMIT");
      return { userId, tables, abuseEventsAnonymized: Number(anonymized.changes ?? 0), securityAuditEventsAnonymized: Number(auditAnonymized.changes ?? 0) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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

  // --- CF-11B: GitHub App Installation & Authorization ---

  private mapInstallationRow(row: Record<string, unknown>): GitHubInstallationRecord {
    return {
      id: String(row.id),
      installationId: Number(row.installation_id),
      githubAccountId: Number(row.github_account_id),
      accountLogin: String(row.account_login),
      accountType: row.account_type as "User" | "Organization",
      codeForgeUserId: String(row.codeforge_user_id),
      repositorySelection: row.repository_selection as "all" | "selected",
      status: row.status as GitHubInstallationStatus,
      revokedAt: row.revoked_at ? String(row.revoked_at) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  async createGitHubInstallation(params: {
    installationId: number;
    githubAccountId: number;
    accountLogin: string;
    accountType: "User" | "Organization";
    codeForgeUserId: string;
    repositorySelection: "all" | "selected";
  }): Promise<GitHubInstallationRecord> {
    const now = new Date().toISOString();
    const record: GitHubInstallationRecord = {
      id: randomUUID(),
      installationId: params.installationId,
      githubAccountId: params.githubAccountId,
      accountLogin: params.accountLogin,
      accountType: params.accountType,
      codeForgeUserId: params.codeForgeUserId,
      repositorySelection: params.repositorySelection,
      status: "active",
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO github_installations (id, installation_id, github_account_id, account_login, account_type, codeforge_user_id, repository_selection, status, revoked_at, created_at, updated_at)
      VALUES (@id, @installationId, @githubAccountId, @accountLogin, @accountType, @codeForgeUserId, @repositorySelection, @status, NULL, @createdAt, @updatedAt)
    `).run({
      id: record.id,
      installationId: record.installationId,
      githubAccountId: record.githubAccountId,
      accountLogin: record.accountLogin,
      accountType: record.accountType,
      codeForgeUserId: record.codeForgeUserId,
      repositorySelection: record.repositorySelection,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
    return record;
  }

  async getGitHubInstallationById(id: string): Promise<GitHubInstallationRecord | undefined> {
    const row = this.db.prepare(`SELECT * FROM github_installations WHERE id = @id`).get({ id }) as Record<string, unknown> | undefined;
    return row ? this.mapInstallationRow(row) : undefined;
  }

  async getGitHubInstallationByInstallationId(installationId: number): Promise<GitHubInstallationRecord | undefined> {
    if (!Number.isSafeInteger(installationId)) return undefined;
    const row = this.db.prepare(`SELECT * FROM github_installations WHERE installation_id = @installationId`).get({ installationId }) as Record<string, unknown> | undefined;
    return row ? this.mapInstallationRow(row) : undefined;
  }

  async listGitHubInstallationsByUser(codeForgeUserId: string): Promise<GitHubInstallationRecord[]> {
    const rows = this.db.prepare(`SELECT * FROM github_installations WHERE codeforge_user_id = @codeForgeUserId ORDER BY created_at ASC`).all({ codeForgeUserId }) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapInstallationRow(row));
  }

  async updateGitHubInstallationStatus(id: string, status: GitHubInstallationStatus): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE github_installations SET status = @status, revoked_at = @revokedAt, updated_at = @now WHERE id = @id`)
      .run({ id, status, revokedAt: status === "revoked" ? now : null, now });
  }

  async updateGitHubInstallationAccount(params: {
    id: string;
    githubAccountId: number;
    accountLogin: string;
    accountType: "User" | "Organization";
    repositorySelection: "all" | "selected";
  }): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE github_installations
      SET github_account_id = @githubAccountId, account_login = @accountLogin, account_type = @accountType, repository_selection = @repositorySelection, updated_at = @now
      WHERE id = @id
    `).run({ ...params, now });
  }

  private mapRepositoryAuthorizationRow(row: Record<string, unknown>): GitHubRepositoryAuthorizationRecord {
    return {
      id: String(row.id),
      installationId: String(row.installation_id),
      repositoryId: Number(row.repository_id),
      owner: String(row.owner),
      name: String(row.name),
      fullName: String(row.full_name),
      private: Boolean(row.private),
      authorizationState: row.authorization_state as GitHubRepositoryAuthorizationState,
      observedAt: String(row.observed_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  async createGitHubRepositoryAuthorization(params: {
    installationId: string;
    repositoryId: number;
    owner: string;
    name: string;
    fullName: string;
    private: boolean;
  }): Promise<GitHubRepositoryAuthorizationRecord> {
    const now = new Date().toISOString();
    const record: GitHubRepositoryAuthorizationRecord = {
      id: randomUUID(),
      installationId: params.installationId,
      repositoryId: params.repositoryId,
      owner: params.owner,
      name: params.name,
      fullName: params.fullName,
      private: params.private,
      authorizationState: "authorized",
      observedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO github_repository_authorizations (id, installation_id, repository_id, owner, name, full_name, private, authorization_state, observed_at, created_at, updated_at)
      VALUES (@id, @installationId, @repositoryId, @owner, @name, @fullName, @private, @authorizationState, @observedAt, @createdAt, @updatedAt)
    `).run({
      id: record.id,
      installationId: record.installationId,
      repositoryId: record.repositoryId,
      owner: record.owner,
      name: record.name,
      fullName: record.fullName,
      private: record.private ? 1 : 0,
      authorizationState: record.authorizationState,
      observedAt: record.observedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
    return record;
  }

  async getGitHubRepositoryAuthorization(repositoryId: number): Promise<GitHubRepositoryAuthorizationRecord | undefined> {
    if (!Number.isSafeInteger(repositoryId)) return undefined;
    const row = this.db.prepare(`SELECT * FROM github_repository_authorizations WHERE repository_id = @repositoryId`).get({ repositoryId }) as Record<string, unknown> | undefined;
    return row ? this.mapRepositoryAuthorizationRow(row) : undefined;
  }

  async listGitHubRepositoryAuthorizations(installationId: string): Promise<GitHubRepositoryAuthorizationRecord[]> {
    const rows = this.db.prepare(`SELECT * FROM github_repository_authorizations WHERE installation_id = @installationId ORDER BY created_at ASC`).all({ installationId }) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRepositoryAuthorizationRow(row));
  }

  async updateGitHubRepositoryAuthorizationState(id: string, state: GitHubRepositoryAuthorizationState): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE github_repository_authorizations SET authorization_state = @state, updated_at = @now WHERE id = @id`).run({ id, state, now });
  }

  async updateGitHubRepositoryAuthorizationMetadata(params: {
    id: string;
    installationId: string;
    owner: string;
    name: string;
    fullName: string;
    private: boolean;
  }): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE github_repository_authorizations
      SET installation_id = @installationId, owner = @owner, name = @name, full_name = @fullName, private = @private, observed_at = @now, updated_at = @now
      WHERE id = @id
    `).run({ id: params.id, installationId: params.installationId, owner: params.owner, name: params.name, fullName: params.fullName, private: params.private ? 1 : 0, now });
  }

  private mapCallbackStateRow(row: Record<string, unknown>): GitHubAppCallbackStateRecord {
    return {
      id: String(row.id),
      state: String(row.state),
      codeForgeUserId: String(row.codeforge_user_id),
      deviceSessionId: row.device_session_id ? String(row.device_session_id) : null,
      expiresAt: String(row.expires_at),
      consumedAt: row.consumed_at ? String(row.consumed_at) : null,
      createdAt: String(row.created_at),
    };
  }

  async createGitHubAppCallbackState(params: {
    state: string;
    codeForgeUserId: string;
    deviceSessionId?: string;
    expiresInSeconds?: number;
  }): Promise<GitHubAppCallbackStateRecord> {
    const now = new Date().toISOString();
    const record: GitHubAppCallbackStateRecord = {
      id: randomUUID(),
      state: params.state,
      codeForgeUserId: params.codeForgeUserId,
      deviceSessionId: params.deviceSessionId ?? null,
      expiresAt: new Date(Date.now() + (params.expiresInSeconds ?? 600) * 1000).toISOString(),
      consumedAt: null,
      createdAt: now,
    };
    this.db.prepare(`
      INSERT INTO github_app_callback_states (id, state, codeforge_user_id, device_session_id, expires_at, consumed_at, created_at)
      VALUES (@id, @state, @codeForgeUserId, @deviceSessionId, @expiresAt, NULL, @createdAt)
    `).run({
      id: record.id,
      state: record.state,
      codeForgeUserId: record.codeForgeUserId,
      deviceSessionId: record.deviceSessionId ?? null,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
    });
    return record;
  }

  async getGitHubAppCallbackState(state: string): Promise<GitHubAppCallbackStateRecord | undefined> {
    const row = this.db.prepare(`SELECT * FROM github_app_callback_states WHERE state = @state`).get({ state }) as Record<string, unknown> | undefined;
    return row ? this.mapCallbackStateRow(row) : undefined;
  }

  /**
   * Single conditional UPDATE: expiry and prior consumption are both part of the predicate, so a
   * replay (or two racing callbacks) can never both observe an unconsumed row.
   */
  async consumeGitHubAppCallbackState(state: string): Promise<GitHubAppCallbackStateRecord | undefined> {
    const now = new Date().toISOString();
    const row = this.db.prepare(`
      UPDATE github_app_callback_states
      SET consumed_at = @now
      WHERE state = @state AND consumed_at IS NULL AND expires_at > @now
      RETURNING *
    `).get({ state, now }) as Record<string, unknown> | undefined;
    return row ? this.mapCallbackStateRow(row) : undefined;
  }

  async deleteExpiredGitHubAppCallbackStates(cutoffIso: string): Promise<number> {
    const result = this.db.prepare(`DELETE FROM github_app_callback_states WHERE expires_at <= @cutoff`).run({ cutoff: cutoffIso });
    return Number(result.changes ?? 0);
  }

  async purgeExpiredSecurityArtifacts(params: { nowIso: string; revokedSessionCutoffIso: string }): Promise<Record<string, number>> {
    const run = (sql: string, args: Record<string, unknown>) => Number(this.db.prepare(sql).run(args).changes ?? 0);
    const { nowIso, revokedSessionCutoffIso } = params;
    return {
      oauth_transactions: run(`DELETE FROM oauth_transactions WHERE expires_at <= @now OR used_at IS NOT NULL`, { now: nowIso }),
      browser_oauth_transactions: run(`DELETE FROM browser_oauth_transactions WHERE expires_at <= @now OR used_at IS NOT NULL`, { now: nowIso }),
      desktop_auth_codes: run(`DELETE FROM desktop_auth_codes WHERE expires_at <= @now OR used_at IS NOT NULL`, { now: nowIso }),
      github_app_callback_states: run(`DELETE FROM github_app_callback_states WHERE expires_at <= @now OR consumed_at IS NOT NULL`, { now: nowIso }),
      browser_sessions: run(`DELETE FROM browser_sessions WHERE expires_at <= @now OR (revoked_at IS NOT NULL AND revoked_at <= @cutoff)`, { now: nowIso, cutoff: revokedSessionCutoffIso }),
      device_sessions: run(`DELETE FROM device_sessions WHERE (revoked_at IS NOT NULL AND revoked_at <= @cutoff) OR expires_at <= @cutoff`, { cutoff: revokedSessionCutoffIso }),
    };
  }

  // --- CF-11B: Publication Records ---

  private mapPublicationRow(row: Record<string, unknown>): PublicationRecord {
    return {
      id: String(row.id),
      deliveryId: String(row.delivery_id),
      userId: String(row.user_id),
      repositoryId: Number(row.repository_id),
      installationId: String(row.installation_id),
      targetBranch: String(row.target_branch),
      baseSha: String(row.base_sha),
      targetSha: String(row.target_sha),
      certifiedHead: String(row.certified_head),
      certifiedTree: String(row.certified_tree),
      artifactSha256: String(row.artifact_sha256),
      artifactBytes: Number(row.artifact_bytes),
      artifactState: row.artifact_state as PublicationRecord["artifactState"],
      artifactKey: row.artifact_key ? String(row.artifact_key) : null,
      state: row.state as PublicationState,
      leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
      leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null,
      leaseFence: Number(row.lease_fence ?? 0),
      pushRef: row.push_ref ? String(row.push_ref) : null,
      pullRequestNumber: row.pull_request_number === null || row.pull_request_number === undefined ? null : Number(row.pull_request_number),
      pullRequestUrl: row.pull_request_url ? String(row.pull_request_url) : null,
      pullRequestNodeId: row.pull_request_node_id ? String(row.pull_request_node_id) : null,
      errorCode: row.error_code ? String(row.error_code) : null,
      failureReason: row.failure_reason ? String(row.failure_reason) : null,
      attemptCount: Number(row.attempt_count ?? 0),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      completedAt: row.completed_at ? String(row.completed_at) : null,
    };
  }

  async createPublication(params: {
    deliveryId: string;
    userId: string;
    repositoryId: number;
    installationId: string;
    targetBranch: string;
    baseSha: string;
    targetSha: string;
    certifiedHead: string;
    certifiedTree: string;
    artifactSha256: string;
    artifactBytes: number;
  }): Promise<PublicationRecord> {
    const now = new Date().toISOString();
    const record: PublicationRecord = {
      id: randomUUID(),
      deliveryId: params.deliveryId,
      userId: params.userId,
      repositoryId: params.repositoryId,
      installationId: params.installationId,
      targetBranch: params.targetBranch,
      baseSha: params.baseSha,
      targetSha: params.targetSha,
      certifiedHead: params.certifiedHead,
      certifiedTree: params.certifiedTree,
      artifactSha256: params.artifactSha256,
      artifactBytes: params.artifactBytes,
      artifactState: "pending",
      artifactKey: null,
      state: "awaiting_artifact",
      leaseOwner: null,
      leaseExpiresAt: null,
      leaseFence: 0,
      pushRef: null,
      pullRequestNumber: null,
      pullRequestUrl: null,
      pullRequestNodeId: null,
      errorCode: null,
      failureReason: null,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    this.db.prepare(`
      INSERT INTO publications (id, delivery_id, user_id, repository_id, installation_id, target_branch, base_sha, target_sha, certified_head, certified_tree, artifact_sha256, artifact_bytes, artifact_state, artifact_key, state, lease_owner, lease_expires_at, lease_fence, push_ref, pull_request_number, pull_request_url, pull_request_node_id, error_code, failure_reason, attempt_count, created_at, updated_at, completed_at)
      VALUES (@id, @deliveryId, @userId, @repositoryId, @installationId, @targetBranch, @baseSha, @targetSha, @certifiedHead, @certifiedTree, @artifactSha256, @artifactBytes, 'pending', NULL, 'awaiting_artifact', NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, 0, @createdAt, @updatedAt, NULL)
    `).run({
      id: record.id,
      deliveryId: record.deliveryId,
      userId: record.userId,
      repositoryId: record.repositoryId,
      installationId: record.installationId,
      targetBranch: record.targetBranch,
      baseSha: record.baseSha,
      targetSha: record.targetSha,
      certifiedHead: record.certifiedHead,
      certifiedTree: record.certifiedTree,
      artifactSha256: record.artifactSha256,
      artifactBytes: record.artifactBytes,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
    return record;
  }

  async getPublicationById(id: string): Promise<PublicationRecord | undefined> {
    const row = this.db.prepare(`SELECT * FROM publications WHERE id = @id`).get({ id }) as Record<string, unknown> | undefined;
    return row ? this.mapPublicationRow(row) : undefined;
  }

  async getPublicationByDeliveryId(userId: string, deliveryId: string): Promise<PublicationRecord | undefined> {
    const row = this.db.prepare(`SELECT * FROM publications WHERE user_id = @userId AND delivery_id = @deliveryId`).get({ userId, deliveryId }) as Record<string, unknown> | undefined;
    return row ? this.mapPublicationRow(row) : undefined;
  }

  async listPublicationsByUser(userId: string): Promise<PublicationRecord[]> {
    const rows = this.db.prepare(`SELECT * FROM publications WHERE user_id = @userId ORDER BY created_at DESC`).all({ userId }) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapPublicationRow(row));
  }

  async listPublicationsByState(state: PublicationState, limit = 500): Promise<PublicationRecord[]> {
    const rows = this.db.prepare(`SELECT * FROM publications WHERE state = @state ORDER BY updated_at ASC LIMIT @limit`).all({ state, limit: Math.min(Math.max(limit, 1), 5000) }) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapPublicationRow(row));
  }

  async markPublicationArtifactStored(params: { publicationId: string; artifactKey: string }): Promise<boolean> {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE publications
      SET artifact_state = 'stored', artifact_key = @artifactKey, state = 'artifact_uploaded', updated_at = @now
      WHERE id = @publicationId AND artifact_state = 'pending' AND state = 'awaiting_artifact'
    `).run({ publicationId: params.publicationId, artifactKey: params.artifactKey, now });
    return Number(result.changes ?? 0) === 1;
  }

  async acquirePublicationLease(params: { publicationId: string; owner: string; leaseDurationMs: number }): Promise<PublicationLease | undefined> {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + params.leaseDurationMs).toISOString();
    const row = this.db.prepare(`
      UPDATE publications
      SET lease_owner = @owner, lease_expires_at = @expiresAt, lease_fence = lease_fence + 1, updated_at = @now
      WHERE id = @publicationId
        AND state NOT IN ('completed', 'failed_permanent', 'authorization_revoked', 'target_diverged')
        AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= @now)
      RETURNING *
    `).get({ publicationId: params.publicationId, owner: params.owner, expiresAt, now }) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const record = this.mapPublicationRow(row);
    return { publicationId: record.id, owner: params.owner, fence: record.leaseFence, expiresAt };
  }

  async renewPublicationLease(params: { publicationId: string; owner: string; fence: number; leaseDurationMs: number }): Promise<boolean> {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + params.leaseDurationMs).toISOString();
    const result = this.db.prepare(`
      UPDATE publications SET lease_expires_at = @expiresAt, updated_at = @now
      WHERE id = @publicationId AND lease_owner = @owner AND lease_fence = @fence
    `).run({ publicationId: params.publicationId, owner: params.owner, fence: params.fence, expiresAt, now });
    return Number(result.changes ?? 0) === 1;
  }

  async releasePublicationLease(params: { publicationId: string; owner: string; fence: number }): Promise<boolean> {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE publications SET lease_owner = NULL, lease_expires_at = NULL, updated_at = @now
      WHERE id = @publicationId AND lease_owner = @owner AND lease_fence = @fence
    `).run({ publicationId: params.publicationId, owner: params.owner, fence: params.fence, now });
    return Number(result.changes ?? 0) === 1;
  }

  async updatePublicationState(params: {
    publicationId: string;
    owner: string;
    fence: number;
    state: PublicationState;
    errorCode?: string | null;
    failureReason?: string | null;
  }): Promise<boolean> {
    const now = new Date().toISOString();
    const allowedPreviousStates = this.allowedPublicationPredecessors(params.state);
    if (!allowedPreviousStates.length) return false;
    const statePredicates = allowedPreviousStates.map((_, index) => `@previousState${index}`).join(", ");
    const result = this.db.prepare(`
      UPDATE publications
      SET state = @state, error_code = @errorCode, failure_reason = @failureReason, updated_at = @now
      WHERE id = @publicationId AND lease_owner = @owner AND lease_fence = @fence
        AND state NOT IN ('completed', 'failed_permanent', 'authorization_revoked', 'target_diverged')
        AND state IN (${statePredicates})
    `).run({
      publicationId: params.publicationId,
      owner: params.owner,
      fence: params.fence,
      state: params.state,
      errorCode: params.errorCode ?? null,
      failureReason: params.failureReason ?? null,
      now,
      ...Object.fromEntries(allowedPreviousStates.map((state, index) => [`previousState${index}`, state])),
    });
    return Number(result.changes ?? 0) === 1;
  }

  async recordPublicationPush(params: { publicationId: string; owner: string; fence: number; pushRef: string }): Promise<boolean> {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE publications SET push_ref = @pushRef, state = 'pushed', updated_at = @now
      WHERE id = @publicationId AND lease_owner = @owner AND lease_fence = @fence
        AND state NOT IN ('completed', 'failed_permanent', 'authorization_revoked', 'target_diverged')
        AND state = 'pushing'
    `).run({ publicationId: params.publicationId, owner: params.owner, fence: params.fence, pushRef: params.pushRef, now });
    return Number(result.changes ?? 0) === 1;
  }

  async recordPublicationPullRequest(params: {
    publicationId: string;
    owner: string;
    fence: number;
    pullRequestNumber: number;
    pullRequestUrl: string;
    pullRequestNodeId?: string;
  }): Promise<boolean> {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE publications
      SET pull_request_number = @pullRequestNumber, pull_request_url = @pullRequestUrl, pull_request_node_id = @pullRequestNodeId, state = 'pr_created', updated_at = @now
      WHERE id = @publicationId AND lease_owner = @owner AND lease_fence = @fence
        AND state NOT IN ('completed', 'failed_permanent', 'authorization_revoked', 'target_diverged')
        AND state = 'creating_pr'
    `).run({
      publicationId: params.publicationId,
      owner: params.owner,
      fence: params.fence,
      pullRequestNumber: params.pullRequestNumber,
      pullRequestUrl: params.pullRequestUrl,
      pullRequestNodeId: params.pullRequestNodeId ?? null,
      now,
    });
    return Number(result.changes ?? 0) === 1;
  }

  async completePublication(params: { publicationId: string; owner: string; fence: number }): Promise<boolean> {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE publications
      SET state = 'completed', completed_at = @now, lease_owner = NULL, lease_expires_at = NULL, error_code = NULL, failure_reason = NULL, updated_at = @now
      WHERE id = @publicationId AND lease_owner = @owner AND lease_fence = @fence
        AND state NOT IN ('completed', 'failed_permanent', 'authorization_revoked', 'target_diverged')
        AND state = 'pr_created'
        AND push_ref IS NOT NULL AND pull_request_number IS NOT NULL
    `).run({ publicationId: params.publicationId, owner: params.owner, fence: params.fence, now });
    return Number(result.changes ?? 0) === 1;
  }

  async incrementPublicationAttempt(id: string): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE publications SET attempt_count = attempt_count + 1, updated_at = @now WHERE id = @id`).run({ id, now });
  }

  async listReclaimablePublications(nowIso: string): Promise<PublicationRecord[]> {
    const rows = this.db.prepare(`
      SELECT * FROM publications
      WHERE state NOT IN ('completed', 'failed_permanent', 'authorization_revoked', 'target_diverged', 'awaiting_artifact')
        AND lease_owner IS NOT NULL
        AND (lease_expires_at IS NULL OR lease_expires_at <= @now)
      ORDER BY created_at ASC
    `).all({ now: nowIso }) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapPublicationRow(row));
  }

  private allowedPublicationPredecessors(next: PublicationState): PublicationState[] {
    if (["failed_retryable", "failed_permanent", "authorization_revoked", "target_diverged"].includes(next)) {
      return ["artifact_uploaded", "validating", "validated", "authorizing", "checking_target", "pushing", "pushed", "creating_pr", "pr_created", "failed_retryable"];
    }
    switch (next) {
      case "validating": return ["artifact_uploaded", "validating", "validated", "authorizing", "checking_target", "pushing", "pushed", "creating_pr", "pr_created", "failed_retryable"];
      case "validated": return ["validating", "validated"];
      case "authorizing": return ["validated", "authorizing"];
      case "checking_target": return ["authorizing", "checking_target"];
      case "pushing": return ["checking_target", "pushing"];
      case "creating_pr": return ["pushed", "creating_pr"];
      default: return [];
    }
  }
}
