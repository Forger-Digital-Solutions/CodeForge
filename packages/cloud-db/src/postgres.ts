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
  AccountDeletionTableSummary,
} from "./types.js";

const { Pool } = pg;
const MIGRATION_LOCK_NAMESPACE = 1_807_468_221;
const MIGRATION_LOCK_KEY = 1_247_271_903;

// Namespaced migration-history table for this package. Earlier builds of both
// @codeforge/cloud-db and @codeforge/sessions tracked migrations in an identically named
// `schema_migrations` table — harmless in normal deployment topology (each service has its own
// physical database) but a real collision when both are pointed at one shared database (e.g. a
// local test database used by both suites). See adoptLegacyMigrationsTableIfOwned below for the
// backward-compatible upgrade path for a database that already has the legacy table.
const MIGRATIONS_TABLE = "cloud_schema_migrations";
const LEGACY_MIGRATIONS_TABLE = "schema_migrations";

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
      await this.adoptLegacyMigrationsTableIfOwned(client);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
          version INTEGER PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          checksum VARCHAR(64) NOT NULL,
          applied_at VARCHAR(64) NOT NULL
        );
      `);

      for (const migration of MIGRATIONS) {
        const res = await client.query(`SELECT checksum FROM ${MIGRATIONS_TABLE} WHERE version = $1`, [migration.version]);
        if (res.rows.length > 0) {
          if (res.rows[0].checksum !== migration.checksum) {
            throw new Error(`Database migration checksum mismatch for version ${migration.version} (${migration.name}). Database integrity compromised.`);
          }
        } else {
          await client.query(migration.postgresUp);
          await client.query(
            `INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum, applied_at) VALUES ($1, $2, $3, $4)`,
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

  /**
   * Backward-compatible, ownership-safe upgrade path for a database created before this
   * package's migration table was namespaced. Runs under the same advisory lock as the rest of
   * `initSchema`, so it is race-free even across concurrently booting processes.
   *
   * - If the namespaced table already exists, this is a no-op (already upgraded).
   * - If no legacy `schema_migrations` table exists, this is a no-op (a genuinely fresh database
   *   — the CREATE TABLE IF NOT EXISTS right after this call creates the namespaced table).
   * - If a legacy table exists, its version-1 migration name is compared against this package's
   *   own ("001_initial_cloud_schema"). An exact match means the legacy table is this package's
   *   own prior history: it is renamed in place (every row preserved, zero data loss) to the
   *   namespaced name. Any other name (or none) means the legacy table belongs to another
   *   package (most likely @codeforge/sessions) or is unrecognized — it is left completely
   *   untouched, and this package simply starts its own namespaced table fresh. Ownership is
   *   never guessed from anything but this exact, unambiguous name match.
   */
  private async adoptLegacyMigrationsTableIfOwned(client: pg.PoolClient): Promise<void> {
    const namespaced = await client.query(`SELECT to_regclass($1) IS NOT NULL AS exists`, [MIGRATIONS_TABLE]);
    if (namespaced.rows[0]?.exists) return;

    const legacy = await client.query(`SELECT to_regclass($1) IS NOT NULL AS exists`, [LEGACY_MIGRATIONS_TABLE]);
    if (!legacy.rows[0]?.exists) return;

    const ownMigrationOne = MIGRATIONS.find((m) => m.version === 1);
    const legacyOwner = await client.query(`SELECT name FROM ${LEGACY_MIGRATIONS_TABLE} WHERE version = 1`);
    if (!ownMigrationOne || legacyOwner.rows[0]?.name !== ownMigrationOne.name) return;

    try {
      await client.query(`ALTER TABLE ${LEGACY_MIGRATIONS_TABLE} RENAME TO ${MIGRATIONS_TABLE}`);
    } catch {
      // A concurrent process already claimed/renamed it under its own advisory-locked pass;
      // the namespaced table it created is picked up normally by the CREATE TABLE IF NOT EXISTS
      // that follows this call.
    }
  }

  async close(): Promise<void> {
    if (!this.isCustomPool) {
      await this.pool.end();
    }
  }

  async createVerificationPlan(record: CloudVerificationPlanRecord): Promise<CloudVerificationPlanRecord> {
    await this.pool.query(`INSERT INTO verification_plans (id,run_id,workspace_id,policy_version,input_state_hash,scope,payload_json,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`, [record.id, record.runId, record.workspaceId, record.policyVersion, record.inputStateHash, record.scope, JSON.stringify(record.payload), record.createdAt]);
    return (await this.getVerificationPlan(record.id)) ?? record;
  }

  async getVerificationPlan(id: string): Promise<CloudVerificationPlanRecord | undefined> {
    const result = await this.pool.query(`SELECT * FROM verification_plans WHERE id=$1`, [id]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? { id: String(row.id), runId: String(row.run_id), workspaceId: String(row.workspace_id), policyVersion: String(row.policy_version), inputStateHash: String(row.input_state_hash), scope: String(row.scope), payload: typeof row.payload_json === "string" ? JSON.parse(row.payload_json) as Record<string, unknown> : row.payload_json as Record<string, unknown>, createdAt: String(row.created_at) } : undefined;
  }

  async createVerificationAttempt(record: CloudVerificationAttemptRecord): Promise<CloudVerificationAttemptRecord> {
    await this.pool.query(`INSERT INTO verification_attempts (id,plan_id,run_id,verifier_id,verifier_version,status,started_at,finished_at,exit_code,payload_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING`, [record.id, record.planId, record.runId, record.verifierId, record.verifierVersion, record.status, record.startedAt, record.finishedAt ?? null, record.exitCode ?? null, JSON.stringify(record.payload)]);
    return (await this.listVerificationAttempts(record.planId)).find((attempt) => attempt.id === record.id) ?? record;
  }

  async terminalizeVerificationAttempt(id: string, status: Exclude<CloudVerificationAttemptRecord["status"], "pending" | "running">, finishedAt: string, exitCode?: number): Promise<CloudVerificationAttemptRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query(`SELECT * FROM verification_attempts WHERE id=$1 FOR UPDATE`, [id]);
      const row = current.rows[0] as Record<string, unknown> | undefined;
      if (!row) throw new Error(`Unknown verification attempt ${id}`);
      const existing = String(row.status) as CloudVerificationAttemptRecord["status"];
      const terminals = new Set(["passed", "failed", "cancelled", "timed_out", "infra_error", "interrupted"]);
      if (terminals.has(existing) && existing !== status) throw new Error("Terminal verification attempt is immutable");
      if (!terminals.has(existing)) await client.query(`UPDATE verification_attempts SET status=$1,finished_at=$2,exit_code=$3 WHERE id=$4 AND status IN ('pending','running')`, [status, finishedAt, exitCode ?? null, id]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    const result = (await this.pool.query(`SELECT * FROM verification_attempts WHERE id=$1`, [id])).rows[0] as Record<string, unknown>;
    return { id: String(result.id), planId: String(result.plan_id), runId: String(result.run_id), verifierId: String(result.verifier_id), verifierVersion: String(result.verifier_version), status: String(result.status) as CloudVerificationAttemptRecord["status"], startedAt: String(result.started_at), ...(result.finished_at ? { finishedAt: String(result.finished_at) } : {}), ...(result.exit_code !== null ? { exitCode: Number(result.exit_code) } : {}), payload: typeof result.payload_json === "string" ? JSON.parse(result.payload_json) as Record<string, unknown> : result.payload_json as Record<string, unknown> };
  }

  async createVerificationEvidence(record: CloudVerificationEvidenceRecord): Promise<CloudVerificationEvidenceRecord> {
    await this.pool.query(`INSERT INTO verification_evidence (id,attempt_id,plan_id,run_id,verifier_id,verifier_version,input_state_hash,status,output_digest,output_truncated,payload_json,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(attempt_id) DO NOTHING`, [record.id, record.attemptId, record.planId, record.runId, record.verifierId, record.verifierVersion, record.inputStateHash, record.status, record.outputDigest, record.outputTruncated, JSON.stringify(record.payload), record.createdAt]);
    const row = (await this.pool.query(`SELECT * FROM verification_evidence WHERE attempt_id=$1`, [record.attemptId])).rows[0] as Record<string, unknown>;
    return { id: String(row.id), attemptId: String(row.attempt_id), planId: String(row.plan_id), runId: String(row.run_id), verifierId: String(row.verifier_id), verifierVersion: String(row.verifier_version), inputStateHash: String(row.input_state_hash), status: String(row.status) as CloudVerificationEvidenceRecord["status"], outputDigest: String(row.output_digest), outputTruncated: Boolean(row.output_truncated), payload: typeof row.payload_json === "string" ? JSON.parse(row.payload_json) as Record<string, unknown> : row.payload_json as Record<string, unknown>, createdAt: String(row.created_at) };
  }

  async listVerificationAttempts(planId: string): Promise<CloudVerificationAttemptRecord[]> {
    const rows = (await this.pool.query(`SELECT * FROM verification_attempts WHERE plan_id=$1 ORDER BY started_at,id`, [planId])).rows as Array<Record<string, unknown>>;
    return rows.map((row) => ({ id: String(row.id), planId: String(row.plan_id), runId: String(row.run_id), verifierId: String(row.verifier_id), verifierVersion: String(row.verifier_version), status: String(row.status) as CloudVerificationAttemptRecord["status"], startedAt: String(row.started_at), ...(row.finished_at ? { finishedAt: String(row.finished_at) } : {}), ...(row.exit_code !== null ? { exitCode: Number(row.exit_code) } : {}), payload: typeof row.payload_json === "string" ? JSON.parse(row.payload_json) as Record<string, unknown> : row.payload_json as Record<string, unknown> }));
  }

  async listVerificationEvidence(planId: string): Promise<CloudVerificationEvidenceRecord[]> {
    const rows = (await this.pool.query(`SELECT * FROM verification_evidence WHERE plan_id=$1 ORDER BY created_at,id`, [planId])).rows as Array<Record<string, unknown>>;
    return rows.map((row) => ({ id: String(row.id), attemptId: String(row.attempt_id), planId: String(row.plan_id), runId: String(row.run_id), verifierId: String(row.verifier_id), verifierVersion: String(row.verifier_version), inputStateHash: String(row.input_state_hash), status: String(row.status) as CloudVerificationEvidenceRecord["status"], outputDigest: String(row.output_digest), outputTruncated: Boolean(row.output_truncated), payload: typeof row.payload_json === "string" ? JSON.parse(row.payload_json) as Record<string, unknown> : row.payload_json as Record<string, unknown>, createdAt: String(row.created_at) }));
  }

  async recoverInterruptedVerificationAttempts(planId?: string): Promise<number> {
    const result = await this.pool.query(`UPDATE verification_attempts SET status='interrupted',finished_at=$1 WHERE status='running' ${planId ? "AND plan_id=$2" : ""}`, planId ? [new Date().toISOString(), planId] : [new Date().toISOString()]);
    return result.rowCount ?? 0;
  }

  /**
   * Read-only diagnostic escape hatch for deployment validation tooling (schema introspection, TLS
   * posture, migration state). It is deliberately NOT part of {@link ICloudDatabase}: business logic
   * must go through the typed contract, so only driver-specific operational tooling reaches for this.
   */
  async diagnosticQuery<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[] }> {
    const res = await this.pool.query(sql, params);
    return { rows: res.rows as T[] };
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
      providerLogin: row.provider_login ? String(row.provider_login) : undefined,
      providerAvatarUrl: row.provider_avatar_url ? String(row.provider_avatar_url) : undefined,
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
      revokedReason: (row.revoked_reason ? String(row.revoked_reason) : null) as DeviceSessionRecord["revokedReason"],
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
      gitHubCodeVerifier: row.github_code_verifier ? String(row.github_code_verifier) : undefined,
      redirectUri: String(row.redirect_uri),
      deviceName: row.device_name ? String(row.device_name) : undefined,
      expiresAt: String(row.expires_at),
      usedAt: row.used_at ? String(row.used_at) : null,
      createdAt: String(row.created_at),
    };
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
    await this.pool.query(
      `INSERT INTO identities (id, user_id, provider, provider_user_id, provider_login, provider_avatar_url, provider_email, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [identity.id, identity.userId, identity.provider, identity.providerUserId, identity.providerLogin ?? null, identity.providerAvatarUrl ?? null, identity.providerEmail ?? null, identity.createdAt, identity.updatedAt],
    );
    return identity;
  }

  async getIdentityByProvider(provider: string, providerUserId: string): Promise<IdentityRecord | undefined> {
    const res = await this.pool.query(`SELECT * FROM identities WHERE provider = $1 AND provider_user_id = $2`, [provider, providerUserId]);
    if (res.rows.length === 0) return undefined;
    return this.mapIdentityRow(res.rows[0]);
  }

  async updateIdentityMetadata(params: { id: string; providerLogin?: string; providerAvatarUrl?: string; providerEmail?: string }): Promise<void> {
    await this.pool.query(`UPDATE identities SET provider_login = $1, provider_avatar_url = $2, provider_email = $3, updated_at = $4 WHERE id = $5`, [params.providerLogin ?? null, params.providerAvatarUrl ?? null, params.providerEmail ?? null, new Date().toISOString(), params.id]);
  }

  async updateUserProfile(params: { id: string; displayName: string; avatarUrl?: string }): Promise<void> {
    await this.pool.query(`UPDATE users SET display_name = $1, avatar_url = $2, updated_at = $3 WHERE id = $4`, [params.displayName, params.avatarUrl ?? null, new Date().toISOString(), params.id]);
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

  async revokeDeviceSession(id: string, reason: "rotated" | "logout" | "breach" = "logout"): Promise<void> {
    const now = new Date().toISOString();
    await this.pool.query(`UPDATE device_sessions SET revoked_at = $1, revoked_reason = $2 WHERE id = $3`, [now, reason, id]);
  }

  async revokeAllUserDeviceSessions(userId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.pool.query(
      `UPDATE device_sessions SET revoked_at = $1, revoked_reason = 'breach' WHERE user_id = $2 AND revoked_at IS NULL`,
      [now, userId],
    );
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
        // Reuse of a ROTATED token means a second party holds a token this device already spent —
        // the OAuth refresh-token replay signal, so the entire session family is revoked. Reuse of a
        // token the user explicitly LOGGED OUT is just a stale client, and must not sign the account
        // out on every other device.
        if (session.revokedReason === "rotated") {
          const now = new Date().toISOString();
          await client.query(
            `UPDATE device_sessions SET revoked_at = $1, revoked_reason = 'breach' WHERE user_id = $2 AND revoked_at IS NULL`,
            [now, session.userId],
          );
          throw new Error("Device session has been revoked (replay detected)");
        }
        throw new Error("Device session has been revoked");
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
      const revokeRes = await client.query(
        `UPDATE device_sessions SET revoked_at = $1, revoked_reason = 'rotated' WHERE id = $2 AND revoked_at IS NULL`,
        [now, session.id],
      );
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
    await this.pool.query(
      `INSERT INTO oauth_transactions (id, state, code_challenge, github_code_verifier, redirect_uri, device_name, expires_at, used_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [record.id, record.state, record.codeChallenge, record.gitHubCodeVerifier ?? null, record.redirectUri, record.deviceName ?? null, record.expiresAt, null, record.createdAt],
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
    await this.pool.query(
      `INSERT INTO desktop_auth_codes (id, code_hash, user_id, code_challenge, redirect_uri, device_name, is_new_user, expires_at, used_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9)`,
      [
        record.id,
        record.codeHash,
        record.userId,
        record.codeChallenge,
        record.redirectUri,
        record.deviceName ?? null,
        record.isNewUser ? 1 : 0,
        record.expiresAt,
        record.createdAt,
      ],
    );
    return record;
  }

  async getDesktopAuthCode(codeHash: string): Promise<DesktopAuthCodeRecord | undefined> {
    const res = await this.pool.query(`SELECT * FROM desktop_auth_codes WHERE code_hash = $1`, [codeHash]);
    if (res.rows.length === 0) return undefined;
    return this.mapDesktopAuthCodeRow(res.rows[0]);
  }

  async consumeDesktopAuthCode(codeHash: string): Promise<DesktopAuthCodeRecord> {
    const existing = await this.getDesktopAuthCode(codeHash);
    if (!existing) {
      throw new Error("Desktop authorization code not found");
    }
    if (new Date(existing.expiresAt).getTime() < Date.now()) {
      throw new Error("Desktop authorization code expired");
    }

    // Single-use: the conditional UPDATE is the authority. Under concurrent exchanges exactly one
    // caller matches `used_at IS NULL` and gets a row back; every other one gets zero rows.
    const now = new Date().toISOString();
    const res = await this.pool.query(
      `UPDATE desktop_auth_codes
       SET used_at = $1
       WHERE code_hash = $2 AND used_at IS NULL
       RETURNING *`,
      [now, codeHash],
    );
    if (res.rows.length === 0) {
      throw new Error("Desktop authorization code already consumed (replay detected)");
    }
    return this.mapDesktopAuthCodeRow(res.rows[0]);
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
    await this.pool.query(`INSERT INTO browser_oauth_transactions (id, state, github_code_verifier, return_target, expires_at, used_at, created_at) VALUES ($1, $2, $3, $4, $5, NULL, $6)`, [record.id, record.state, record.gitHubCodeVerifier, record.returnTarget, record.expiresAt, record.createdAt]);
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
    const res = await this.pool.query(`SELECT * FROM browser_oauth_transactions WHERE state = $1`, [state]);
    return res.rows[0] ? this.mapBrowserOAuthTransactionRow(res.rows[0]) : undefined;
  }

  async consumeBrowserOAuthTransaction(state: string): Promise<BrowserOAuthTransactionRecord> {
    const existing = await this.getBrowserOAuthTransaction(state);
    if (!existing) throw new Error("Browser OAuth transaction not found");
    if (existing.usedAt) throw new Error("Browser OAuth transaction already consumed (replay detected)");
    if (new Date(existing.expiresAt).getTime() < Date.now()) throw new Error("Browser OAuth transaction expired");
    const now = new Date().toISOString();
    const res = await this.pool.query(`UPDATE browser_oauth_transactions SET used_at = $1 WHERE state = $2 AND used_at IS NULL RETURNING *`, [now, state]);
    if (!res.rows[0]) throw new Error("Browser OAuth transaction already consumed (replay detected)");
    return this.mapBrowserOAuthTransactionRow(res.rows[0]);
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
    await this.pool.query(`INSERT INTO browser_sessions (id, user_id, session_token_hash, expires_at, revoked_at, created_at, last_seen_at) VALUES ($1, $2, $3, $4, NULL, $5, $6)`, [record.id, record.userId, record.sessionTokenHash, record.expiresAt, record.createdAt, record.lastSeenAt]);
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
    const res = await this.pool.query(`SELECT * FROM browser_sessions WHERE session_token_hash = $1`, [sessionTokenHash]);
    return res.rows[0] ? this.mapBrowserSessionRow(res.rows[0]) : undefined;
  }

  async updateBrowserSessionLastSeen(id: string): Promise<void> {
    await this.pool.query(`UPDATE browser_sessions SET last_seen_at = $1 WHERE id = $2`, [new Date().toISOString(), id]);
  }

  async revokeBrowserSession(id: string): Promise<void> {
    await this.pool.query(`UPDATE browser_sessions SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL`, [new Date().toISOString(), id]);
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

  // --- GDPR Article 17 Erasure ---

  async deleteUserAccount(userId: string): Promise<AccountDeletionResult> {
    return this.withTx(async (client) => {
      const tables: AccountDeletionTableSummary[] = [];
      const del = async (table: string, sql: string): Promise<void> => {
        const res = await client.query(sql, [userId]);
        tables.push({ table, rowsDeleted: res.rowCount ?? 0 });
      };

      const anonymized = await client.query(`UPDATE abuse_events SET user_id = NULL WHERE user_id = $1`, [userId]);

      // Children of github_installations (repository authorizations, publications) must be
      // deleted before that parent table — both PostgreSQL's real ON DELETE CASCADE and, on newer
      // Node runtimes, node:sqlite's default-enabled foreign key enforcement would otherwise beat
      // an out-of-order explicit delete to it, silently under-reporting this receipt's counts.
      await del(
        "github_repository_authorizations",
        `DELETE FROM github_repository_authorizations WHERE installation_id IN (SELECT id FROM github_installations WHERE codeforge_user_id = $1)`,
      );
      await del("publications", `DELETE FROM publications WHERE user_id = $1`);
      await del("github_installations", `DELETE FROM github_installations WHERE codeforge_user_id = $1`);
      await del("github_app_callback_states", `DELETE FROM github_app_callback_states WHERE codeforge_user_id = $1`);
      await del("desktop_auth_codes", `DELETE FROM desktop_auth_codes WHERE user_id = $1`);
      await del("browser_sessions", `DELETE FROM browser_sessions WHERE user_id = $1`);
      await del("identities", `DELETE FROM identities WHERE user_id = $1`);
      await del("device_sessions", `DELETE FROM device_sessions WHERE user_id = $1`);
      await del("subscriptions", `DELETE FROM subscriptions WHERE user_id = $1`);
      await del("entitlements", `DELETE FROM entitlements WHERE user_id = $1`);
      await del("credit_ledger", `DELETE FROM credit_ledger WHERE user_id = $1`);
      await del("usage_events", `DELETE FROM usage_events WHERE user_id = $1`);
      await del("usage_periods", `DELETE FROM usage_periods WHERE user_id = $1`);
      await del("reservations", `DELETE FROM reservations WHERE user_id = $1`);
      await del("hosted_requests", `DELETE FROM hosted_requests WHERE user_id = $1`);
      await del("account_settings", `DELETE FROM account_settings WHERE user_id = $1`);
      await del("users", `DELETE FROM users WHERE id = $1`);

      return { userId, tables, abuseEventsAnonymized: anonymized.rowCount ?? 0 };
    });
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
    await this.pool.query(
      `INSERT INTO github_installations (id, installation_id, github_account_id, account_login, account_type, codeforge_user_id, repository_selection, status, revoked_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $10)`,
      [record.id, record.installationId, record.githubAccountId, record.accountLogin, record.accountType, record.codeForgeUserId, record.repositorySelection, record.status, record.createdAt, record.updatedAt],
    );
    return record;
  }

  async getGitHubInstallationById(id: string): Promise<GitHubInstallationRecord | undefined> {
    const res = await this.pool.query(`SELECT * FROM github_installations WHERE id = $1`, [id]);
    return res.rows[0] ? this.mapInstallationRow(res.rows[0]) : undefined;
  }

  async getGitHubInstallationByInstallationId(installationId: number): Promise<GitHubInstallationRecord | undefined> {
    if (!Number.isSafeInteger(installationId)) return undefined;
    const res = await this.pool.query(`SELECT * FROM github_installations WHERE installation_id = $1`, [installationId]);
    return res.rows[0] ? this.mapInstallationRow(res.rows[0]) : undefined;
  }

  async listGitHubInstallationsByUser(codeForgeUserId: string): Promise<GitHubInstallationRecord[]> {
    const res = await this.pool.query(`SELECT * FROM github_installations WHERE codeforge_user_id = $1 ORDER BY created_at ASC`, [codeForgeUserId]);
    return res.rows.map((row) => this.mapInstallationRow(row));
  }

  async updateGitHubInstallationStatus(id: string, status: GitHubInstallationStatus): Promise<void> {
    const now = new Date().toISOString();
    await this.pool.query(
      `UPDATE github_installations SET status = $1, revoked_at = $2, updated_at = $3 WHERE id = $4`,
      [status, status === "revoked" ? now : null, now, id],
    );
  }

  async updateGitHubInstallationAccount(params: {
    id: string;
    githubAccountId: number;
    accountLogin: string;
    accountType: "User" | "Organization";
    repositorySelection: "all" | "selected";
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.pool.query(
      `UPDATE github_installations
       SET github_account_id = $1, account_login = $2, account_type = $3, repository_selection = $4, updated_at = $5
       WHERE id = $6`,
      [params.githubAccountId, params.accountLogin, params.accountType, params.repositorySelection, now, params.id],
    );
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
    await this.pool.query(
      `INSERT INTO github_repository_authorizations (id, installation_id, repository_id, owner, name, full_name, private, authorization_state, observed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [record.id, record.installationId, record.repositoryId, record.owner, record.name, record.fullName, record.private, record.authorizationState, record.observedAt, record.createdAt, record.updatedAt],
    );
    return record;
  }

  async getGitHubRepositoryAuthorization(repositoryId: number): Promise<GitHubRepositoryAuthorizationRecord | undefined> {
    if (!Number.isSafeInteger(repositoryId)) return undefined;
    const res = await this.pool.query(`SELECT * FROM github_repository_authorizations WHERE repository_id = $1`, [repositoryId]);
    return res.rows[0] ? this.mapRepositoryAuthorizationRow(res.rows[0]) : undefined;
  }

  async listGitHubRepositoryAuthorizations(installationId: string): Promise<GitHubRepositoryAuthorizationRecord[]> {
    const res = await this.pool.query(`SELECT * FROM github_repository_authorizations WHERE installation_id = $1 ORDER BY created_at ASC`, [installationId]);
    return res.rows.map((row) => this.mapRepositoryAuthorizationRow(row));
  }

  async updateGitHubRepositoryAuthorizationState(id: string, state: GitHubRepositoryAuthorizationState): Promise<void> {
    const now = new Date().toISOString();
    await this.pool.query(`UPDATE github_repository_authorizations SET authorization_state = $1, updated_at = $2 WHERE id = $3`, [state, now, id]);
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
    await this.pool.query(
      `UPDATE github_repository_authorizations
       SET installation_id = $1, owner = $2, name = $3, full_name = $4, private = $5, observed_at = $6, updated_at = $6
       WHERE id = $7`,
      [params.installationId, params.owner, params.name, params.fullName, params.private, now, params.id],
    );
  }

  private mapGitHubAppCallbackStateRow(row: Record<string, unknown>): GitHubAppCallbackStateRecord {
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
    await this.pool.query(
      `INSERT INTO github_app_callback_states (id, state, codeforge_user_id, device_session_id, expires_at, consumed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, NULL, $6)`,
      [record.id, record.state, record.codeForgeUserId, record.deviceSessionId ?? null, record.expiresAt, record.createdAt],
    );
    return record;
  }

  async getGitHubAppCallbackState(state: string): Promise<GitHubAppCallbackStateRecord | undefined> {
    const res = await this.pool.query(`SELECT * FROM github_app_callback_states WHERE state = $1`, [state]);
    return res.rows[0] ? this.mapGitHubAppCallbackStateRow(res.rows[0]) : undefined;
  }

  /**
   * Single conditional UPDATE ... RETURNING: expiry and prior consumption are both in the predicate,
   * so concurrent callbacks on different API instances cannot both win.
   */
  async consumeGitHubAppCallbackState(state: string): Promise<GitHubAppCallbackStateRecord | undefined> {
    const now = new Date().toISOString();
    const res = await this.pool.query(
      `UPDATE github_app_callback_states
       SET consumed_at = $1
       WHERE state = $2 AND consumed_at IS NULL AND expires_at > $1
       RETURNING *`,
      [now, state],
    );
    return res.rows[0] ? this.mapGitHubAppCallbackStateRow(res.rows[0]) : undefined;
  }

  async deleteExpiredGitHubAppCallbackStates(cutoffIso: string): Promise<number> {
    const res = await this.pool.query(`DELETE FROM github_app_callback_states WHERE expires_at <= $1`, [cutoffIso]);
    return res.rowCount ?? 0;
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
    await this.pool.query(
      `INSERT INTO publications (id, delivery_id, user_id, repository_id, installation_id, target_branch, base_sha, target_sha, certified_head, certified_tree, artifact_sha256, artifact_bytes, artifact_state, artifact_key, state, lease_owner, lease_expires_at, lease_fence, push_ref, pull_request_number, pull_request_url, pull_request_node_id, error_code, failure_reason, attempt_count, created_at, updated_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', NULL, 'awaiting_artifact', NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, 0, $13, $14, NULL)`,
      [record.id, record.deliveryId, record.userId, record.repositoryId, record.installationId, record.targetBranch, record.baseSha, record.targetSha, record.certifiedHead, record.certifiedTree, record.artifactSha256, record.artifactBytes, record.createdAt, record.updatedAt],
    );
    return record;
  }

  async getPublicationById(id: string): Promise<PublicationRecord | undefined> {
    const res = await this.pool.query(`SELECT * FROM publications WHERE id = $1`, [id]);
    return res.rows[0] ? this.mapPublicationRow(res.rows[0]) : undefined;
  }

  async getPublicationByDeliveryId(userId: string, deliveryId: string): Promise<PublicationRecord | undefined> {
    const res = await this.pool.query(`SELECT * FROM publications WHERE user_id = $1 AND delivery_id = $2`, [userId, deliveryId]);
    return res.rows[0] ? this.mapPublicationRow(res.rows[0]) : undefined;
  }

  async listPublicationsByUser(userId: string): Promise<PublicationRecord[]> {
    const res = await this.pool.query(`SELECT * FROM publications WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
    return res.rows.map((row) => this.mapPublicationRow(row));
  }

  async markPublicationArtifactStored(params: { publicationId: string; artifactKey: string }): Promise<boolean> {
    const now = new Date().toISOString();
    const res = await this.pool.query(
      `UPDATE publications
       SET artifact_state = 'stored', artifact_key = $1, state = 'artifact_uploaded', updated_at = $2
       WHERE id = $3 AND artifact_state = 'pending' AND state = 'awaiting_artifact'`,
      [params.artifactKey, now, params.publicationId],
    );
    return (res.rowCount ?? 0) === 1;
  }

  async acquirePublicationLease(params: { publicationId: string; owner: string; leaseDurationMs: number }): Promise<PublicationLease | undefined> {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + params.leaseDurationMs).toISOString();
    const res = await this.pool.query(
      `UPDATE publications
       SET lease_owner = $1, lease_expires_at = $2, lease_fence = lease_fence + 1, updated_at = $3
       WHERE id = $4
         AND state NOT IN ('completed', 'failed_permanent', 'authorization_revoked', 'target_diverged')
         AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= $3)
       RETURNING *`,
      [params.owner, expiresAt, now, params.publicationId],
    );
    if (!res.rows[0]) return undefined;
    const record = this.mapPublicationRow(res.rows[0]);
    return { publicationId: record.id, owner: params.owner, fence: record.leaseFence, expiresAt };
  }

  async renewPublicationLease(params: { publicationId: string; owner: string; fence: number; leaseDurationMs: number }): Promise<boolean> {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + params.leaseDurationMs).toISOString();
    const res = await this.pool.query(
      `UPDATE publications SET lease_expires_at = $1, updated_at = $2
       WHERE id = $3 AND lease_owner = $4 AND lease_fence = $5`,
      [expiresAt, now, params.publicationId, params.owner, params.fence],
    );
    return (res.rowCount ?? 0) === 1;
  }

  async releasePublicationLease(params: { publicationId: string; owner: string; fence: number }): Promise<boolean> {
    const now = new Date().toISOString();
    const res = await this.pool.query(
      `UPDATE publications SET lease_owner = NULL, lease_expires_at = NULL, updated_at = $1
       WHERE id = $2 AND lease_owner = $3 AND lease_fence = $4`,
      [now, params.publicationId, params.owner, params.fence],
    );
    return (res.rowCount ?? 0) === 1;
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
    const res = await this.pool.query(
      `UPDATE publications
       SET state = $1, error_code = $2, failure_reason = $3, updated_at = $4
       WHERE id = $5 AND lease_owner = $6 AND lease_fence = $7
         AND state NOT IN ('completed', 'failed_permanent', 'authorization_revoked', 'target_diverged')
         AND state = ANY($8::text[])`,
      [params.state, params.errorCode ?? null, params.failureReason ?? null, now, params.publicationId, params.owner, params.fence, allowedPreviousStates],
    );
    return (res.rowCount ?? 0) === 1;
  }

  async recordPublicationPush(params: { publicationId: string; owner: string; fence: number; pushRef: string }): Promise<boolean> {
    const now = new Date().toISOString();
    const res = await this.pool.query(
      `UPDATE publications SET push_ref = $1, state = 'pushed', updated_at = $2
       WHERE id = $3 AND lease_owner = $4 AND lease_fence = $5
         AND state NOT IN ('completed', 'failed_permanent', 'authorization_revoked', 'target_diverged')
         AND state = 'pushing'`,
      [params.pushRef, now, params.publicationId, params.owner, params.fence],
    );
    return (res.rowCount ?? 0) === 1;
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
    const res = await this.pool.query(
      `UPDATE publications
       SET pull_request_number = $1, pull_request_url = $2, pull_request_node_id = $3, state = 'pr_created', updated_at = $4
       WHERE id = $5 AND lease_owner = $6 AND lease_fence = $7
         AND state NOT IN ('completed', 'failed_permanent', 'authorization_revoked', 'target_diverged')
         AND state = 'creating_pr'`,
      [params.pullRequestNumber, params.pullRequestUrl, params.pullRequestNodeId ?? null, now, params.publicationId, params.owner, params.fence],
    );
    return (res.rowCount ?? 0) === 1;
  }

  async completePublication(params: { publicationId: string; owner: string; fence: number }): Promise<boolean> {
    const now = new Date().toISOString();
    const res = await this.pool.query(
      `UPDATE publications
       SET state = 'completed', completed_at = $1, lease_owner = NULL, lease_expires_at = NULL, error_code = NULL, failure_reason = NULL, updated_at = $1
       WHERE id = $2 AND lease_owner = $3 AND lease_fence = $4
         AND state NOT IN ('completed', 'failed_permanent', 'authorization_revoked', 'target_diverged')
         AND state = 'pr_created'
         AND push_ref IS NOT NULL AND pull_request_number IS NOT NULL`,
      [now, params.publicationId, params.owner, params.fence],
    );
    return (res.rowCount ?? 0) === 1;
  }

  async incrementPublicationAttempt(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.pool.query(`UPDATE publications SET attempt_count = attempt_count + 1, updated_at = $1 WHERE id = $2`, [now, id]);
  }

  async listReclaimablePublications(nowIso: string): Promise<PublicationRecord[]> {
    const res = await this.pool.query(
      `SELECT * FROM publications
       WHERE state NOT IN ('completed', 'failed_permanent', 'authorization_revoked', 'target_diverged', 'awaiting_artifact')
         AND lease_owner IS NOT NULL
         AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
       ORDER BY created_at ASC`,
      [nowIso],
    );
    return res.rows.map((row) => this.mapPublicationRow(row));
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
