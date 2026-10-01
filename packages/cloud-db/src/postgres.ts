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

const { Pool } = pg;
const MIGRATION_LOCK_NAMESPACE = 1_807_468_221;
const MIGRATION_LOCK_KEY = 1_247_271_903;

/**
 * Cross-process hosted execution signal channel. Carries correlation identifiers only — never
 * prompts, payloads, credentials, or provider output. Receivers treat every message as a hint and
 * re-verify against the durable row before acting.
 */
export const HOSTED_EXECUTION_EVENT_CHANNEL = "hosted_execution_events";
/** pg_notify payloads are hard-limited to 8000 bytes; below that we stay well under it. */
const HOSTED_NOTIFY_PAYLOAD_LIMIT = 7_000;
const HOSTED_EVENT_MAX_IDS = 64;

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
  /** Max pool connections when constructing the default pool. Deliberate sizing matters:
   *  N worker processes × this value must stay under the server's max_connections. */
  poolMax?: number;
}

/**
 * Validates a NOTIFY payload before it may act as a wake-up hint. Only the documented event shape
 * is honored; anything malformed degrades to a resync hint so workers re-verify durable state
 * rather than trusting (or dropping) an unknown message.
 */
function parseHostedEventPayload(payload: string | undefined): HostedExecutionEvent {
  try {
    const parsed = JSON.parse(payload ?? "") as { kind?: unknown; executionIds?: unknown };
    if (parsed && parsed.kind === "execution.cancelled") {
      if (parsed.executionIds === "*") return { kind: "execution.cancelled", executionIds: "*" };
      if (Array.isArray(parsed.executionIds) && parsed.executionIds.every((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 255)) {
        return { kind: "execution.cancelled", executionIds: parsed.executionIds.slice(0, HOSTED_EVENT_MAX_IDS) };
      }
    }
  } catch {
    // fall through to resync
  }
  return { kind: "resync", executionIds: "*" };
}

export class PostgresCloudDatabase implements ICloudDatabase {
  private readonly pool: pg.Pool;
  private readonly isCustomPool: boolean;
  private readonly connectionString?: string;
  private readonly ssl?: boolean;
  private initialized = false;
  private initPromise?: Promise<void>;
  private hostedEventHandlers?: Set<(event: HostedExecutionEvent) => void>;
  private hostedEventClient?: pg.Client | pg.PoolClient;
  private hostedEventReconnect?: NodeJS.Timeout;
  private hostedEventClosed = true;

  constructor(options: PostgresCloudDatabaseOptions = {}) {
    const connectionString = options.connectionString || process.env.DATABASE_URL;
    if (!connectionString && !options.pool) {
      throw new Error("PostgresCloudDatabase requires a valid connectionString or DATABASE_URL");
    }
    this.connectionString = connectionString;
    this.ssl = options.ssl;
    if (options.pool) {
      this.pool = options.pool;
      this.isCustomPool = true;
    } else {
      this.pool = new Pool({
        connectionString,
        ssl: options.ssl === undefined ? undefined : options.ssl ? { rejectUnauthorized: true } : false,
        max: options.poolMax ?? 20,
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
    await this.closeHostedEventClient();
    this.hostedEventHandlers?.clear();
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
    // pg-pool only absorbs 'error' on clients while they sit idle IN the pool. A checked-out
    // client whose backend is killed mid-transaction (admin terminate, restart, network flap)
    // emits 'error' with no listener → unhandled → process crash. Absorb it here; in-flight
    // queries already reject via the driver's own pending-query error path, and releasing
    // with the error tells the pool to destroy the dead socket rather than recycle it.
    let clientError: Error | undefined;
    const onClientError = (err: Error) => { clientError ??= err; };
    client.on?.("error", onClientError);
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
      client.removeListener?.("error", onClientError);
      client.release(clientError);
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
      usagePeriodId: row.usage_period_id ? String(row.usage_period_id) : null,
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

  async getDeviceSessionById(id: string): Promise<DeviceSessionRecord | undefined> {
    const res = await this.pool.query(`SELECT * FROM device_sessions WHERE id = $1`, [id]);
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
    if (params.requestId) {
      const existing = await client.query(`SELECT * FROM credit_ledger WHERE user_id = $1 AND request_id = $2 AND eventType = $3 ORDER BY seq DESC LIMIT 1`, [params.userId, params.requestId, params.eventType]);
      if (existing.rows.length > 0) return this.mapCreditLedgerRow(existing.rows[0]);
    }
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
    params: { id?: string; requestId: string; userId: string; providerId: string; modelId: string; reservedCredits: number; usagePeriodId?: string },
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
      usagePeriodId: params.usagePeriodId ?? null,
      actualCredits: 0,
      status: "reserved",
      createdAt: now,
      committedAt: null,
      releasedAt: null,
    };

    await client.query(
      `INSERT INTO reservations (id, request_id, user_id, provider_id, model_id, reserved_credits, usage_period_id, actual_credits, status, created_at, committed_at, released_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        record.id,
        record.requestId,
        record.userId,
        record.providerId,
        record.modelId,
        record.reservedCredits,
        record.usagePeriodId,
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
    usagePeriodId?: string;
    maxTaskSpendCredits?: number;
  }): Promise<{ reservation: ReservationRecord; balanceAfter: number; created: boolean }> {
    const existing = await this.getReservationByRequestId(params.requestId);
    if (existing) {
      if (existing.userId !== params.userId) {
        throw new Error("Request ID is already associated with another user account");
      }
      if (Boolean(existing.usagePeriodId) !== Boolean(params.usagePeriodId)) {
        throw new Error("Request ID is already reserved under a different allowance scope");
      }
      const currentBalance = existing.usagePeriodId
        ? await this.getUsagePeriodRemainingWithClient(this.pool, existing.usagePeriodId)
        : await this.getCreditBalance(params.userId);
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
        if (Boolean(existingInTx.usagePeriodId) !== Boolean(params.usagePeriodId)) {
          throw new Error("Request ID is already reserved under a different allowance scope");
        }
        const balance = existingInTx.usagePeriodId
          ? await this.getUsagePeriodRemainingWithClient(client, existingInTx.usagePeriodId)
          : await this.getCreditBalanceWithClient(client, params.userId);
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

      let balance: number;
      if (params.usagePeriodId) {
        const periodRes = await client.query(`SELECT * FROM usage_periods WHERE id = $1 AND user_id = $2 FOR UPDATE`, [params.usagePeriodId, params.userId]);
        if (periodRes.rows.length === 0) throw new Error("Free allowance period not found for authenticated account");
        const period = this.mapUsagePeriodRow(periodRes.rows[0]);
        const taskLimit = params.maxTaskSpendCredits ?? 50_000;
        if (params.reservedCredits > taskLimit) throw new Error(`Free task credit limit exceeded (limit: ${taskLimit}, requested: ${params.reservedCredits})`);
        const activeRes = await client.query(`SELECT COALESCE(SUM(reserved_credits), 0) AS credits FROM reservations WHERE usage_period_id = $1 AND status = 'reserved'`, [params.usagePeriodId]);
        const reserved = Number(activeRes.rows[0]?.credits ?? 0);
        if (period.creditsUsed + reserved + params.reservedCredits > period.freeAllowanceGranted) {
          throw new Error(`Free allowance exhausted (available: ${Math.max(0, period.freeAllowanceGranted - period.creditsUsed - reserved)}, required: ${params.reservedCredits})`);
        }
        balance = period.freeAllowanceGranted - period.creditsUsed - reserved - params.reservedCredits;
      } else {
        balance = await this.getCreditBalanceWithClient(client, params.userId);
        if (balance < params.reservedCredits) {
          throw new Error(`Insufficient credit balance for reservation (available: ${balance}, required: ${params.reservedCredits})`);
        }
      }

      const reservation = await this.insertReservationWithClient(client, params);
      if (params.usagePeriodId) return { reservation, balanceAfter: balance, created: true };
      const ledger = await this.appendLedgerWithClient(client, {
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
        const balance = res.usagePeriodId
          ? await this.getUsagePeriodRemainingWithClient(client, res.usagePeriodId)
          : await this.getCreditBalanceWithClient(client, params.userId);
        return { reservation: res, transitioned: false, balanceAfter: balance };
      }

      await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [params.userId]);
      const availableBalance = await this.getCreditBalanceWithClient(client, params.userId);
      const additionalCredits = Math.max(0, params.actualCredits - res.reservedCredits);
      if (res.usagePeriodId && params.actualCredits > res.reservedCredits) {
        throw new Error(`Free request actual usage exceeds its reservation (${params.actualCredits} > ${res.reservedCredits})`);
      }
      if (!res.usagePeriodId && additionalCredits > availableBalance) throw new Error(`Insufficient credit balance to settle request ${params.requestId}`);

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
        const balance = currentRes?.usagePeriodId
          ? await this.getUsagePeriodRemainingWithClient(client, currentRes.usagePeriodId)
          : await this.getCreditBalanceWithClient(client, params.userId);
        return { reservation: currentRes!, transitioned: false, balanceAfter: balance };
      }

      const updatedReservation = this.mapReservationRow(updateRes.rows[0]);
      const diff = updatedReservation.reservedCredits - params.actualCredits;
      let balanceAfter = availableBalance;

      if (updatedReservation.usagePeriodId) {
        const usageRes = await client.query(
          `UPDATE usage_periods SET credits_used = credits_used + $1, updated_at = $2 WHERE id = $3 AND user_id = $4 RETURNING id`,
          [params.actualCredits, now, updatedReservation.usagePeriodId, params.userId],
        );
        if (usageRes.rows.length === 0) throw new Error("Free allowance period disappeared during settlement");
        balanceAfter = await this.getUsagePeriodRemainingWithClient(client, updatedReservation.usagePeriodId);
        return { reservation: updatedReservation, transitioned: true, balanceAfter };
      }

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
        const balance = res.usagePeriodId
          ? await this.getUsagePeriodRemainingWithClient(client, res.usagePeriodId)
          : await this.getCreditBalanceWithClient(client, params.userId);
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
        const balance = currentRes?.usagePeriodId
          ? await this.getUsagePeriodRemainingWithClient(client, currentRes.usagePeriodId)
          : await this.getCreditBalanceWithClient(client, params.userId);
        return { reservation: currentRes!, transitioned: false, refundedCredits: currentRes?.reservedCredits ?? res.reservedCredits, balanceAfter: balance };
      }

      const updatedReservation = this.mapReservationRow(updateRes.rows[0]);
      if (updatedReservation.usagePeriodId) {
        const balance = await this.getUsagePeriodRemainingWithClient(client, updatedReservation.usagePeriodId);
        return { reservation: updatedReservation, transitioned: true, refundedCredits: updatedReservation.reservedCredits, balanceAfter: balance };
      }
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

  private mapHostedExecutionRow(row: Record<string, unknown>): HostedExecutionRecord {
    const iso = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
    return { id: String(row.id), idempotencyKey: String(row.idempotency_key), userId: String(row.user_id), taskId: String(row.task_id), providerId: String(row.provider_id), modelId: String(row.model_id), status: row.status as HostedExecutionRecord["status"], priority: Number(row.priority), attempt: Number(row.attempt), eligibleAt: iso(row.eligible_at), leaseOwner: row.lease_owner ? String(row.lease_owner) : null, leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : null, leaseToken: row.lease_token ? String(row.lease_token) : null, cancellationRequested: Boolean(row.cancellation_requested), requestPayload: row.request_payload != null ? String(row.request_payload) : null, resultPayload: row.result_payload != null ? String(row.result_payload) : null, resultError: row.result_error != null ? String(row.result_error) : null, dispatchedAt: row.dispatched_at ? iso(row.dispatched_at) : null, terminalAt: row.terminal_at ? iso(row.terminal_at) : null, parentExecutionId: row.parent_execution_id ? String(row.parent_execution_id) : null, rootExecutionId: row.root_execution_id ? String(row.root_execution_id) : null, depth: Number(row.depth ?? 0), providerDispatchId: row.provider_dispatch_id != null ? String(row.provider_dispatch_id) : null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
  }

  private mapHostedCapacityLeaseRow(row: Record<string, unknown>): HostedCapacityLeaseRecord {
    const iso = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
    return { id: String(row.id), executionId: String(row.execution_id), userId: String(row.user_id), providerId: String(row.provider_id), modelId: String(row.model_id), workerId: String(row.worker_id), state: row.state as HostedCapacityLeaseRecord["state"], leaseExpiresAt: iso(row.lease_expires_at), createdAt: iso(row.created_at), releasedAt: row.released_at ? iso(row.released_at) : null, releaseReason: row.release_reason ? String(row.release_reason) : null };
  }

  async enqueueHostedExecution(params: { id: string; idempotencyKey: string; userId: string; taskId: string; providerId: string; modelId: string; priority?: number; eligibleAt?: string; requestPayload?: string; parentExecutionId?: string; rootExecutionId?: string; fanOutLimits?: HostedFanOutLimits }): Promise<{ execution: HostedExecutionRecord; created: boolean }> {
    return this.withTx(async (client) => {
      const now = new Date().toISOString();
      // Idempotency check first: a replayed enqueue must return the existing row before any
      // fan-out budget evaluation — the existing row already consumed its budget slot.
      const prior = await client.query(`SELECT * FROM hosted_executions WHERE idempotency_key = $1 FOR UPDATE`, [params.idempotencyKey]);
      if (prior.rows.length > 0) {
        if (String(prior.rows[0].user_id) !== params.userId) throw new Error("Idempotency key is already associated with another user account");
        await client.query(`INSERT INTO hosted_admission_receipts (id, execution_id, user_id, event_type, created_at) VALUES ($1,$2,$3,'DUPLICATE_SUPPRESSED',$4)`, [randomUUID(), prior.rows[0].id, params.userId, now]);
        return { execution: this.mapHostedExecutionRow(prior.rows[0]), created: false };
      }
      let rootExecutionId = params.rootExecutionId ?? null;
      let depth = 0;
      if (params.parentExecutionId) {
        if (!rootExecutionId) {
          // Unlocked hint only: the authoritative parent/root validation happens below under
          // both row locks. A caller that knows the root should pass it — this path exists for
          // compatibility with callers that link a bare parentExecutionId.
          const hint = await client.query(`SELECT root_execution_id FROM hosted_executions WHERE id = $1`, [params.parentExecutionId]);
          rootExecutionId = hint.rows[0]?.root_execution_id ? String(hint.rows[0].root_execution_id) : params.parentExecutionId;
        }
        // Lock order is ancestors-first everywhere — cancellation cascades root → descendants —
        // so the root row lock is taken before the parent lock here. Reversed order would
        // deadlock against a concurrent cascade, and could admit a child whose parent was
        // cancelled while the enqueue was in flight (late child revival).
        const root = await client.query(`SELECT id FROM hosted_executions WHERE id = $1 FOR UPDATE`, [rootExecutionId]);
        if (root.rows.length === 0) throw new Error("Root hosted execution not found");
        const parent = await client.query(`SELECT user_id, status, root_execution_id, depth FROM hosted_executions WHERE id = $1 FOR UPDATE`, [params.parentExecutionId]);
        if (parent.rows.length === 0) throw new Error("Parent hosted execution not found");
        if (String(parent.rows[0].user_id) !== params.userId) throw new Error("Parent hosted execution belongs to another user account");
        if (["completed", "failed", "cancelled"].includes(String(parent.rows[0].status))) throw new Error("Parent hosted execution is already terminal");
        const authoritativeRoot = parent.rows[0].root_execution_id ? String(parent.rows[0].root_execution_id) : params.parentExecutionId;
        if (authoritativeRoot !== rootExecutionId) throw new Error("rootExecutionId does not match the parent's authoritative root");
        depth = Number(parent.rows[0].depth ?? 0) + 1;
        const limits = params.fanOutLimits;
        if (limits && (limits.maxChildrenPerParent !== undefined || limits.maxDescendantsPerRoot !== undefined || limits.maxDepth !== undefined)) {
          // Budget authority: both ancestor locks are held above, so concurrent child enqueues
          // under different parents of the same tree serialize on the root row — the descendant
          // count cannot be raced past the budget.
          if (limits.maxDepth !== undefined && depth > limits.maxDepth) {
            throw new Error(`Hosted execution fan-out budget exceeded: depth ${depth} exceeds limit ${limits.maxDepth}`);
          }
          if (limits.maxChildrenPerParent !== undefined) {
            const siblings = await client.query(`SELECT COUNT(*)::int AS count FROM hosted_executions WHERE parent_execution_id = $1`, [params.parentExecutionId]);
            if (Number(siblings.rows[0]?.count ?? 0) >= limits.maxChildrenPerParent) {
              throw new Error(`Hosted execution fan-out budget exceeded: parent already has ${limits.maxChildrenPerParent} children`);
            }
          }
          if (limits.maxDescendantsPerRoot !== undefined && rootExecutionId) {
            const descendants = await client.query(`SELECT COUNT(*)::int AS count FROM hosted_executions WHERE root_execution_id = $1`, [rootExecutionId]);
            if (Number(descendants.rows[0]?.count ?? 0) >= limits.maxDescendantsPerRoot) {
              throw new Error(`Hosted execution fan-out budget exceeded: root already has ${limits.maxDescendantsPerRoot} descendants`);
            }
          }
        }
      }
      const inserted = await client.query(`INSERT INTO hosted_executions (id, idempotency_key, user_id, task_id, provider_id, model_id, status, priority, attempt, eligible_at, cancellation_requested, request_payload, parent_execution_id, root_execution_id, depth, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,0,$8,FALSE,$9,$10,$11,$12,$13,$13) ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`, [params.id, params.idempotencyKey, params.userId, params.taskId, params.providerId, params.modelId, params.priority ?? 0, params.eligibleAt ?? now, params.requestPayload ?? null, params.parentExecutionId ?? null, rootExecutionId, depth, now]);
      if (inserted.rows.length > 0) {
        await client.query(`INSERT INTO hosted_admission_receipts (id, execution_id, user_id, event_type, created_at) VALUES ($1,$2,$3,'QUEUE_ENQUEUED',$4)`, [randomUUID(), params.id, params.userId, now]);
        return { execution: this.mapHostedExecutionRow(inserted.rows[0]), created: true };
      }
      const existing = await client.query(`SELECT * FROM hosted_executions WHERE idempotency_key = $1 FOR UPDATE`, [params.idempotencyKey]);
      if (existing.rows.length === 0) throw new Error("Idempotent enqueue lost its authoritative row");
      if (String(existing.rows[0].user_id) !== params.userId) throw new Error("Idempotency key is already associated with another user account");
      await client.query(`INSERT INTO hosted_admission_receipts (id, execution_id, user_id, event_type, created_at) VALUES ($1,$2,$3,'DUPLICATE_SUPPRESSED',$4)`, [randomUUID(), existing.rows[0].id, params.userId, now]);
      return { execution: this.mapHostedExecutionRow(existing.rows[0]), created: false };
    });
  }

  async getHostedExecution(id: string, userId: string): Promise<HostedExecutionRecord | undefined> {
    const res = await this.pool.query(`SELECT * FROM hosted_executions WHERE id = $1 AND user_id = $2`, [id, userId]);
    return res.rows[0] ? this.mapHostedExecutionRow(res.rows[0]) : undefined;
  }

  async listHostedExecutionChildren(executionId: string, userId: string): Promise<HostedExecutionRecord[]> {
    const owns = await this.pool.query(`SELECT 1 FROM hosted_executions WHERE id = $1 AND user_id = $2`, [executionId, userId]);
    if (owns.rows.length === 0) throw new Error("Hosted execution not found for user");
    const res = await this.pool.query(`SELECT * FROM hosted_executions WHERE parent_execution_id = $1 AND user_id = $2 ORDER BY created_at ASC`, [executionId, userId]);
    return res.rows.map((row) => this.mapHostedExecutionRow(row));
  }

  async listHostedExecutions(userId: string, limit = 100): Promise<HostedExecutionRecord[]> {
    // Metadata projection only: request/result payload columns are deliberately excluded so a
    // status list never turns into a bulk payload read.
    const res = await this.pool.query(`SELECT id, idempotency_key, user_id, task_id, provider_id, model_id, status, priority, attempt, eligible_at, lease_owner, lease_expires_at, lease_token, cancellation_requested, dispatched_at, terminal_at, parent_execution_id, root_execution_id, created_at, updated_at FROM hosted_executions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`, [userId, limit]);
    return res.rows.map((row) => this.mapHostedExecutionRow(row));
  }

  async setHostedProviderCapacity(params: { providerId: string; modelId: string; maxConcurrent: number }): Promise<void> {
    if (!Number.isSafeInteger(params.maxConcurrent) || params.maxConcurrent < 0) throw new Error("maxConcurrent must be a non-negative safe integer");
    await this.pool.query(`INSERT INTO hosted_provider_capacity (provider_id, model_id, max_concurrent, updated_at) VALUES ($1,$2,$3,NOW()) ON CONFLICT (provider_id, model_id) DO UPDATE SET max_concurrent = EXCLUDED.max_concurrent, updated_at = EXCLUDED.updated_at`, [params.providerId, params.modelId, params.maxConcurrent]);
  }

  async ensureHostedProviderCapacity(params: { providerId: string; modelId: string; maxConcurrent: number }): Promise<void> {
    await this.pool.query(`INSERT INTO hosted_provider_capacity (provider_id, model_id, max_concurrent, updated_at) VALUES ($1,$2,$3,NOW()) ON CONFLICT (provider_id, model_id) DO NOTHING`, [params.providerId, params.modelId, params.maxConcurrent]);
  }

  async claimNextHostedExecution(params: { workerId: string; leaseMs: number; maxUserConcurrent: number; providerIds?: string[]; now?: Date }): Promise<{ execution: HostedExecutionRecord; lease: HostedCapacityLeaseRecord } | undefined> {
    if (!Number.isSafeInteger(params.leaseMs) || params.leaseMs < 1) throw new Error("leaseMs must be a positive safe integer");
    if (!Number.isSafeInteger(params.maxUserConcurrent) || params.maxUserConcurrent < 1) throw new Error("maxUserConcurrent must be a positive safe integer");
    return this.withTx(async (client) => {
      const now = params.now ?? new Date();
      // Provider-scoped probes must not use `provider_id = ANY(...)`: ScalarArrayOp ordering is not
      // index-servable, so each per-user probe would scan that user's whole queued set and sort it.
      // Decomposing into per-provider equality probes lets the (user_id, provider_id, priority,
      // created_at) partial index serve each head in O(1).
      const candidate = await client.query(`
        WITH RECURSIVE queued_users AS (
          (SELECT user_id FROM hosted_executions WHERE status = 'queued' ORDER BY user_id LIMIT 1)
          UNION ALL
          (SELECT n.user_id FROM queued_users qu CROSS JOIN LATERAL (
            SELECT user_id FROM hosted_executions
            WHERE status = 'queued' AND user_id > qu.user_id
            ORDER BY user_id LIMIT 1) n)
        ),
        user_heads AS (
          SELECT h.id FROM queued_users qu CROSS JOIN LATERAL (
            ${params.providerIds == null
              ? `SELECT e2.id, e2.priority, e2.created_at FROM hosted_executions e2
                 WHERE e2.status = 'queued' AND e2.user_id = qu.user_id AND e2.eligible_at <= $1
                 ORDER BY e2.priority DESC, e2.created_at ASC, e2.id ASC LIMIT 1`
              : `SELECT e2.id, e2.priority, e2.created_at FROM unnest($3::text[]) p(pid) CROSS JOIN LATERAL (
                   SELECT e3.id, e3.priority, e3.created_at FROM hosted_executions e3
                   WHERE e3.status = 'queued' AND e3.user_id = qu.user_id AND e3.provider_id = p.pid
                     AND e3.eligible_at <= $1
                   ORDER BY e3.priority DESC, e3.created_at ASC, e3.id ASC LIMIT 1
                 ) e2
                 ORDER BY e2.priority DESC, e2.created_at ASC, e2.id ASC LIMIT 1`}
          ) h
        )
        SELECT e.* FROM user_heads head
        JOIN hosted_executions e ON e.id = head.id
        LEFT JOIN hosted_user_admission_state uas ON uas.user_id = e.user_id
        JOIN hosted_provider_capacity pc ON pc.provider_id = e.provider_id AND pc.model_id = e.model_id
        WHERE (SELECT COUNT(*) FROM hosted_capacity_leases ul WHERE ul.user_id = e.user_id AND ul.state = 'active' AND ul.lease_expires_at > $1) < $2
          AND (SELECT COUNT(*) FROM hosted_capacity_leases rl WHERE rl.provider_id = e.provider_id AND rl.model_id = e.model_id AND rl.state = 'active' AND rl.lease_expires_at > $1) < pc.max_concurrent
        ORDER BY CASE WHEN uas.last_admitted_at IS NULL THEN 0 ELSE 1 END, uas.last_admitted_at ASC NULLS FIRST, e.priority DESC, e.created_at ASC
        FOR UPDATE OF e SKIP LOCKED LIMIT 1`,
        params.providerIds == null
          ? [now, params.maxUserConcurrent]
          : [now, params.maxUserConcurrent, params.providerIds]);
      if (candidate.rows.length === 0) return undefined;
      const row = candidate.rows[0];
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || '::' || $2, 0))`, [row.provider_id, row.model_id]);
      const capacity = await client.query(`SELECT max_concurrent FROM hosted_provider_capacity WHERE provider_id=$1 AND model_id=$2 FOR UPDATE`, [row.provider_id, row.model_id]);
      if (capacity.rows.length === 0) return undefined;
      await client.query(`INSERT INTO hosted_user_admission_state (user_id, updated_at) VALUES ($1,$2) ON CONFLICT (user_id) DO NOTHING`, [row.user_id, now]);
      await client.query(`SELECT user_id FROM hosted_user_admission_state WHERE user_id=$1 FOR UPDATE`, [row.user_id]);
      const routeActive = await client.query(`SELECT COUNT(*)::int AS count FROM hosted_capacity_leases WHERE provider_id=$1 AND model_id=$2 AND state='active' AND lease_expires_at > $3`, [row.provider_id, row.model_id, now]);
      if (Number(routeActive.rows[0]?.count ?? 0) >= Number(capacity.rows[0].max_concurrent)) return undefined;
      const userActive = await client.query(`SELECT COUNT(*)::int AS count FROM hosted_capacity_leases WHERE user_id=$1 AND state='active' AND lease_expires_at > $2`, [row.user_id, now]);
      if (Number(userActive.rows[0]?.count ?? 0) >= params.maxUserConcurrent) return undefined;
      const leaseId = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + params.leaseMs);
      const updated = await client.query(`UPDATE hosted_executions SET status='claimed', lease_owner=$1, lease_expires_at=$2, lease_token=$3, attempt=attempt+1, updated_at=$4 WHERE id=$5 AND status='queued' RETURNING *`, [params.workerId, leaseExpiresAt, leaseId, now, row.id]);
      if (updated.rows.length === 0) return undefined;
      const lease = await client.query(`INSERT INTO hosted_capacity_leases (id, execution_id, user_id, provider_id, model_id, worker_id, state, lease_expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,'active',$7,NOW()) RETURNING *`, [leaseId, row.id, row.user_id, row.provider_id, row.model_id, params.workerId, leaseExpiresAt]);
      await client.query(`INSERT INTO hosted_user_admission_state (user_id, last_admitted_at, updated_at) VALUES ($1,$2,$2) ON CONFLICT (user_id) DO UPDATE SET last_admitted_at=EXCLUDED.last_admitted_at, updated_at=EXCLUDED.updated_at`, [row.user_id, now]);
      await client.query(`INSERT INTO hosted_admission_receipts (id, execution_id, user_id, event_type, worker_id, details, created_at) VALUES ($1,$2,$3,'CAPACITY_RESERVED',$4,$5,$6)`, [randomUUID(), row.id, row.user_id, params.workerId, JSON.stringify({ leaseExpiresAt: leaseExpiresAt.toISOString() }), now]);
      return { execution: this.mapHostedExecutionRow(updated.rows[0]), lease: this.mapHostedCapacityLeaseRow(lease.rows[0]) };
    });
  }

  async markHostedExecutionDispatching(params: { executionId: string; workerId: string; leaseToken: string; providerDispatchId?: string }): Promise<HostedExecutionRecord> {
    return this.withTx(async (client) => {
      const updated = await client.query(`UPDATE hosted_executions SET status='dispatching', dispatched_at=NOW(), provider_dispatch_id=COALESCE($4, provider_dispatch_id), updated_at=NOW() WHERE id=$1 AND lease_owner=$2 AND lease_token=$3 AND status='claimed' RETURNING *`, [params.executionId, params.workerId, params.leaseToken, params.providerDispatchId ?? null]);
      if (updated.rows.length === 0) throw new Error("Execution is not claimed by this worker lease");
      await client.query(`INSERT INTO hosted_admission_receipts (id, execution_id, user_id, event_type, worker_id, created_at) VALUES ($1,$2,$3,'DISPATCH_STARTED',$4,NOW())`, [randomUUID(), params.executionId, updated.rows[0].user_id, params.workerId]);
      return this.mapHostedExecutionRow(updated.rows[0]);
    });
  }

  async completeHostedExecution(params: { executionId: string; userId: string; workerId: string; leaseToken: string; status: "completed" | "failed"; releaseReason?: string; resultPayload?: string; resultError?: string }): Promise<{ execution: HostedExecutionRecord; transitioned: boolean }> {
    return this.withTx(async (client) => {
      const locked = await client.query(`SELECT * FROM hosted_executions WHERE id=$1 AND user_id=$2 FOR UPDATE`, [params.executionId, params.userId]);
      if (locked.rows.length === 0) throw new Error("Hosted execution not found for user");
      if (["completed", "failed", "cancelled"].includes(String(locked.rows[0].status))) return { execution: this.mapHostedExecutionRow(locked.rows[0]), transitioned: false };
      // Fencing: only the worker holding the token minted by the winning claim may terminalize a
      // live execution. A stale worker whose lease expired and was reclaimed is rejected here.
      if (String(locked.rows[0].lease_owner) !== params.workerId || String(locked.rows[0].lease_token) !== params.leaseToken) {
        throw new Error("Hosted execution lease fencing token does not match this worker");
      }
      const updated = await client.query(`UPDATE hosted_executions SET status=$1, lease_owner=NULL, lease_expires_at=NULL, lease_token=NULL, result_payload=$2, result_error=$3, terminal_at=NOW(), updated_at=NOW() WHERE id=$4 RETURNING *`, [params.status, params.resultPayload ?? null, params.resultError ?? null, params.executionId]);
      await client.query(`UPDATE hosted_capacity_leases SET state='released', released_at=NOW(), release_reason=$1 WHERE execution_id=$2 AND state='active'`, [params.releaseReason ?? params.status, params.executionId]);
      await client.query(`INSERT INTO hosted_admission_receipts (id, execution_id, user_id, event_type, details, created_at) VALUES ($1,$2,$3,'CAPACITY_RELEASED',$4,NOW())`, [randomUUID(), params.executionId, params.userId, JSON.stringify({ status: params.status })]);
      return { execution: this.mapHostedExecutionRow(updated.rows[0]), transitioned: true };
    });
  }

  async cancelHostedExecution(params: { executionId: string; userId: string }): Promise<{ execution: HostedExecutionRecord; dispatchMayHaveStarted: boolean; transitioned: boolean; cancelledChildIds: string[] }> {
    return this.withTx(async (client) => {
      const locked = await client.query(`SELECT * FROM hosted_executions WHERE id=$1 AND user_id=$2 FOR UPDATE`, [params.executionId, params.userId]);
      if (locked.rows.length === 0) throw new Error("Hosted execution not found for user");
      const current = locked.rows[0];
      if (["completed", "failed", "cancelled"].includes(String(current.status))) return { execution: this.mapHostedExecutionRow(current), dispatchMayHaveStarted: String(current.status) !== "queued", transitioned: false, cancelledChildIds: [] };
      const dispatchMayHaveStarted = current.status === "dispatching" || current.status === "recovery_pending";
      await client.query(`INSERT INTO hosted_admission_receipts (id, execution_id, user_id, event_type, details, created_at) VALUES ($1,$2,$3,'CANCEL_REQUESTED',$4,NOW())`, [randomUUID(), params.executionId, params.userId, JSON.stringify({ dispatchMayHaveStarted })]);
      const updated = await client.query(`UPDATE hosted_executions SET status='cancelled', cancellation_requested=TRUE, lease_owner=NULL, lease_expires_at=NULL, lease_token=NULL, terminal_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *`, [params.executionId]);
      await client.query(`UPDATE hosted_capacity_leases SET state='released', released_at=NOW(), release_reason='cancelled' WHERE execution_id=$1 AND state='active'`, [params.executionId]);
      await client.query(`INSERT INTO hosted_admission_receipts (id, execution_id, user_id, event_type, details, created_at) VALUES ($1,$2,$3,'CANCELLED',$4,NOW())`, [randomUUID(), params.executionId, params.userId, JSON.stringify({ dispatchMayHaveStarted })]);
      // Cascade to every non-terminal descendant of the same user — a cancelled parent must never
      // leave orphaned subagent children queued or running against provider capacity.
      const descendants = await client.query(`WITH RECURSIVE tree(id) AS (SELECT id FROM hosted_executions WHERE parent_execution_id=$1 UNION ALL SELECT e.id FROM hosted_executions e JOIN tree t ON e.parent_execution_id=t.id) SELECT id FROM tree`, [params.executionId]);
      const cancelledChildIds: string[] = [];
      for (const child of descendants.rows) {
        const childLocked = await client.query(`SELECT user_id, status FROM hosted_executions WHERE id=$1 FOR UPDATE`, [child.id]);
        if (childLocked.rows.length === 0 || String(childLocked.rows[0].user_id) !== params.userId) continue;
        if (["completed", "failed", "cancelled"].includes(String(childLocked.rows[0].status))) continue;
        await client.query(`UPDATE hosted_executions SET status='cancelled', cancellation_requested=TRUE, lease_owner=NULL, lease_expires_at=NULL, lease_token=NULL, terminal_at=NOW(), updated_at=NOW() WHERE id=$1`, [child.id]);
        await client.query(`UPDATE hosted_capacity_leases SET state='released', released_at=NOW(), release_reason='cancelled' WHERE execution_id=$1 AND state='active'`, [child.id]);
        await client.query(`INSERT INTO hosted_admission_receipts (id, execution_id, user_id, event_type, details, created_at) VALUES ($1,$2,$3,'CANCELLED',$4,NOW())`, [randomUUID(), child.id, params.userId, JSON.stringify({ cancelledAsChild: true })]);
        cancelledChildIds.push(String(child.id));
      }
      // Wake-up signal for remote workers owning any cancelled row (parent or descendant). The
      // payload carries correlation identifiers only — a receiving worker verifies the durable
      // row before aborting, and a missed notification is recovered by the durable terminal-state
      // poll. pg_notify inside the transaction fires exactly once, at commit.
      const cancelledIds = [params.executionId, ...cancelledChildIds];
      // An id list longer than the receive cap would be silently truncated by the parser —
      // degrade to "*" instead so receivers resync every active execution rather than act on a
      // partial list. The byte limit is the second guard for genuinely huge payloads.
      let notifyPayload = JSON.stringify(
        cancelledIds.length > HOSTED_EVENT_MAX_IDS
          ? { kind: "execution.cancelled", executionIds: "*" }
          : { kind: "execution.cancelled", executionIds: cancelledIds },
      );
      if (notifyPayload.length > HOSTED_NOTIFY_PAYLOAD_LIMIT) {
        notifyPayload = JSON.stringify({ kind: "execution.cancelled", executionIds: "*" });
      }
      await client.query(`SELECT pg_notify($1, $2)`, [HOSTED_EXECUTION_EVENT_CHANNEL, notifyPayload]);
      return { execution: this.mapHostedExecutionRow(updated.rows[0]), dispatchMayHaveStarted, transitioned: true, cancelledChildIds };
    });
  }

  async renewHostedExecutionLease(params: { executionId: string; workerId: string; leaseToken: string; leaseMs: number; now?: Date }): Promise<HostedCapacityLeaseRecord> {
    return this.withTx(async (client) => {
      const now = params.now ?? new Date();
      const leaseExpiresAt = new Date(now.getTime() + params.leaseMs);
      const lease = await client.query(`UPDATE hosted_capacity_leases SET lease_expires_at=$1 WHERE id=$2 AND execution_id=$3 AND worker_id=$4 AND state='active' RETURNING *`, [leaseExpiresAt, params.leaseToken, params.executionId, params.workerId]);
      if (lease.rows.length === 0) throw new Error("Active hosted execution lease not found for worker");
      await client.query(`UPDATE hosted_executions SET lease_expires_at=$1, updated_at=$2 WHERE id=$3 AND lease_owner=$4 AND lease_token=$5 AND status IN ('claimed','dispatching')`, [leaseExpiresAt, now, params.executionId, params.workerId, params.leaseToken]);
      return this.mapHostedCapacityLeaseRow(lease.rows[0]);
    });
  }

  async resolveHostedRecoveryPending(params: { executionId: string; workerId: string; reason?: string; resolution?: "failed" | "requeue" }): Promise<{ execution: HostedExecutionRecord; transitioned: boolean }> {
    return this.withTx(async (client) => {
      const locked = await client.query(`SELECT * FROM hosted_executions WHERE id=$1 FOR UPDATE`, [params.executionId]);
      if (locked.rows.length === 0) throw new Error("Hosted execution not found");
      const current = locked.rows[0];
      if (String(current.status) !== "recovery_pending") return { execution: this.mapHostedExecutionRow(current), transitioned: false };
      const resolution = params.resolution ?? "failed";
      if (resolution === "requeue") {
        // safe_retry only: the caller established the provider deduplicates the persisted dispatch
        // identity, so a redispatch cannot double-execute. The row rejoins the queue with the same
        // provider_dispatch_id; a fresh claim redispatches under a new fencing token.
        if (!current.provider_dispatch_id) {
          throw new Error("Cannot requeue a recovery_pending execution with no provider dispatch identity — the outcome is ambiguous, resolve failed instead");
        }
        const updated = await client.query(`UPDATE hosted_executions SET status='queued', lease_owner=NULL, lease_expires_at=NULL, lease_token=NULL, updated_at=NOW() WHERE id=$1 RETURNING *`, [params.executionId]);
        await client.query(`UPDATE hosted_capacity_leases SET state='expired', released_at=NOW(), release_reason='recovery_resolved' WHERE execution_id=$1 AND state='active'`, [params.executionId]);
        await client.query(`INSERT INTO hosted_admission_receipts (id, execution_id, user_id, event_type, worker_id, details, created_at) VALUES ($1,$2,$3,'RECOVERY_RESOLVED',$4,$5,NOW())`, [randomUUID(), params.executionId, current.user_id, params.workerId, JSON.stringify({ resolution: "requeue", providerDispatchId: current.provider_dispatch_id })]);
        return { execution: this.mapHostedExecutionRow(updated.rows[0]), transitioned: true };
      }
      // Fail closed: post-dispatch worker loss makes the provider outcome unknowable, so the
      // execution terminalizes as failed rather than being retried into a duplicate provider call.
      const updated = await client.query(`UPDATE hosted_executions SET status='failed', result_error=$1, lease_owner=NULL, lease_expires_at=NULL, lease_token=NULL, terminal_at=NOW(), updated_at=NOW() WHERE id=$2 RETURNING *`, [params.reason ?? "dispatch outcome ambiguous after worker loss", params.executionId]);
      await client.query(`UPDATE hosted_capacity_leases SET state='expired', released_at=NOW(), release_reason='recovery_resolved' WHERE execution_id=$1 AND state='active'`, [params.executionId]);
      await client.query(`INSERT INTO hosted_admission_receipts (id, execution_id, user_id, event_type, worker_id, details, created_at) VALUES ($1,$2,$3,'RECOVERY_RESOLVED',$4,$5,NOW())`, [randomUUID(), params.executionId, current.user_id, params.workerId, JSON.stringify({ resolution: "failed" })]);
      return { execution: this.mapHostedExecutionRow(updated.rows[0]), transitioned: true };
    });
  }

  async recoverExpiredHostedLeases(now = new Date()): Promise<{ recovered: number; executionIds: string[] }> {
    return this.withTx(async (client) => {
      const expired = await client.query(`SELECT e.* FROM hosted_executions e JOIN hosted_capacity_leases l ON l.execution_id=e.id WHERE l.state='active' AND l.lease_expires_at <= $1 AND e.status IN ('claimed','dispatching') FOR UPDATE OF e, l SKIP LOCKED`, [now]);
      const executionIds: string[] = [];
      for (const row of expired.rows) {
        const nextStatus = row.status === "claimed" ? "queued" : "recovery_pending";
        await client.query(`UPDATE hosted_executions SET status=$1, lease_owner=NULL, lease_expires_at=NULL, lease_token=NULL, updated_at=$2 WHERE id=$3`, [nextStatus, now, row.id]);
        await client.query(`UPDATE hosted_capacity_leases SET state='expired', released_at=$1, release_reason='lease_expired' WHERE execution_id=$2 AND state='active'`, [now, row.id]);
        await client.query(`INSERT INTO hosted_admission_receipts (id, execution_id, user_id, event_type, details, created_at) VALUES ($1,$2,$3,'LEASE_EXPIRED',$4,$5)`, [randomUUID(), row.id, row.user_id, JSON.stringify({ nextStatus }), now]);
        executionIds.push(String(row.id));
      }
      return { recovered: executionIds.length, executionIds };
    });
  }

  async listHostedTerminalExecutionIds(executionIds: string[]): Promise<string[]> {
    if (executionIds.length === 0) return [];
    const res = await this.pool.query(`SELECT id FROM hosted_executions WHERE id = ANY($1) AND status IN ('completed','failed','cancelled')`, [executionIds]);
    return res.rows.map((row) => String(row.id));
  }

  async listHostedExecutionsByStatus(status: HostedExecutionStatus, limit = 200): Promise<HostedExecutionRecord[]> {
    // Metadata projection — payloads excluded; the worker resolves a live row by id when needed.
    const res = await this.pool.query(`SELECT id, idempotency_key, user_id, task_id, provider_id, model_id, status, priority, attempt, eligible_at, lease_owner, lease_expires_at, lease_token, cancellation_requested, dispatched_at, terminal_at, parent_execution_id, root_execution_id, depth, provider_dispatch_id, created_at, updated_at FROM hosted_executions WHERE status = $1 ORDER BY updated_at ASC LIMIT $2`, [status, limit]);
    return res.rows.map((row) => this.mapHostedExecutionRow(row));
  }

  async getHostedExecutionTreeStats(rootExecutionId: string, userId: string): Promise<HostedExecutionTreeStats | undefined> {
    const owns = await this.pool.query(`SELECT 1 FROM hosted_executions WHERE id = $1 AND user_id = $2`, [rootExecutionId, userId]);
    if (owns.rows.length === 0) return undefined;
    const res = await this.pool.query(
      `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(attempt),0)::int AS attempts, COALESCE(MAX(depth),0)::int AS max_depth
       FROM hosted_executions WHERE id = $1 OR root_execution_id = $1 GROUP BY status`,
      [rootExecutionId],
    );
    const byStatus: Partial<Record<HostedExecutionStatus, number>> = {};
    let totalExecutions = 0;
    let activeDescendants = 0;
    let providerDispatchAttempts = 0;
    let maxDepth = 0;
    for (const row of res.rows) {
      const status = String(row.status) as HostedExecutionStatus;
      const count = Number(row.count);
      byStatus[status] = count;
      totalExecutions += count;
      providerDispatchAttempts += Number(row.attempts);
      maxDepth = Math.max(maxDepth, Number(row.max_depth));
      if (!["completed", "failed", "cancelled"].includes(status)) activeDescendants += count;
    }
    // The root itself is always counted in totals; activeDescendants counts live non-root rows —
    // subtract the root's own live row so the number means "live descendants" exactly.
    if (byStatus.queued || byStatus.claimed || byStatus.dispatching || byStatus.recovery_pending) {
      const root = await this.pool.query(`SELECT status FROM hosted_executions WHERE id = $1`, [rootExecutionId]);
      if (root.rows.length > 0 && !["completed", "failed", "cancelled"].includes(String(root.rows[0].status))) activeDescendants -= 1;
    }
    return { rootExecutionId, totalExecutions, byStatus, activeDescendants, providerDispatchAttempts, maxDepth };
  }

  async appendHostedExecutionStreamEvent(params: { executionId: string; userId: string; payload: string; createdAt?: string }): Promise<number> {
    if (params.payload.length > 64 * 1024) throw new Error("Hosted stream event exceeds the 64 KiB event limit");
    const result = await this.pool.query(
      `INSERT INTO hosted_execution_stream_events (execution_id, user_id, payload, created_at)
       SELECT id, user_id, $3, COALESCE($4::timestamptz, NOW()) FROM hosted_executions WHERE id = $1 AND user_id = $2
       RETURNING sequence`,
      [params.executionId, params.userId, params.payload, params.createdAt ?? null],
    );
    if (!result.rows[0]) throw new Error("Hosted execution not found for user");
    return Number(result.rows[0].sequence);
  }

  async listHostedExecutionStreamEvents(params: { executionId: string; userId: string; afterSequence: number; limit?: number }): Promise<HostedExecutionStreamEventRecord[]> {
    const limit = Math.min(Math.max(params.limit ?? 128, 1), 512);
    const result = await this.pool.query(
      `SELECT e.sequence, e.payload, e.created_at FROM hosted_execution_stream_events e
       JOIN hosted_executions h ON h.id = e.execution_id AND h.user_id = e.user_id
       WHERE e.execution_id = $1 AND e.user_id = $2 AND h.user_id = $2 AND e.sequence > $3
       ORDER BY e.sequence ASC LIMIT $4`,
      [params.executionId, params.userId, params.afterSequence, limit],
    );
    if (result.rows.length === 0) {
      const owned = await this.pool.query(`SELECT 1 FROM hosted_executions WHERE id = $1 AND user_id = $2`, [params.executionId, params.userId]);
      if (owned.rows.length === 0) throw new Error("Hosted execution not found for user");
    }
    return result.rows.map((row) => ({ sequence: Number(row.sequence), payload: String(row.payload), createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at) }));
  }

  /**
   * LISTEN/NOTIFY wake-up channel on a dedicated connection (never the shared pool — a LISTEN
   * client is occupied for its whole lifetime). Reconnects with bounded backoff; every reconnect
   * emits a resync so workers re-verify durable state after a possible notification gap.
   */
  async subscribeHostedExecutionEvents(handler: (event: HostedExecutionEvent) => void): Promise<HostedExecutionEventSubscription> {
    this.hostedEventHandlers ??= new Set();
    this.hostedEventHandlers.add(handler);
    this.hostedEventClosed = false;
    if (!this.hostedEventClient) {
      try {
        await this.openHostedEventClient();
      } catch (error) {
        // A first-connect failure leaves no listener behind — the caller keeps its durable
        // polling fallback and a later subscribe retries cleanly.
        this.hostedEventClient = undefined;
        throw error;
      }
    }
    let closed = false;
    return {
      close: async () => {
        if (closed) return;
        closed = true;
        this.hostedEventHandlers?.delete(handler);
        if (this.hostedEventHandlers?.size === 0) await this.closeHostedEventClient();
      },
    };
  }

  private hostedEventOpening?: Promise<void>;

  private openHostedEventClient(): Promise<void> {
    // Single-flight: concurrent opens (initial subscribe racing a reconnect timer) share one
    // connection attempt so two LISTEN clients can never coexist untracked.
    this.hostedEventOpening ??= this.doOpenHostedEventClient().finally(() => {
      this.hostedEventOpening = undefined;
    });
    return this.hostedEventOpening;
  }

  private async doOpenHostedEventClient(): Promise<void> {
    if (this.hostedEventClosed || this.hostedEventClient) return;
    let client: pg.Client | pg.PoolClient | undefined;
    try {
      client = this.isCustomPool
        ? await this.pool.connect()
        : new pg.Client({ connectionString: this.connectionString, ssl: this.ssl === undefined ? undefined : this.ssl ? { rejectUnauthorized: true } : false });
      const onDead = () => {
        if (this.hostedEventClient !== client) return;
        this.hostedEventClient = undefined;
        if (!this.isCustomPool) void (client as pg.Client).end().catch(() => undefined);
        else try { (client as pg.PoolClient).release(new Error("hosted event listener dropped")); } catch { /* already released */ }
        if (this.hostedEventClosed) return;
        // A dead listener means notifications may have been lost — wake every handler so workers
        // re-verify durable state, then reconnect with bounded backoff.
        this.emitHostedEvent({ kind: "resync", executionIds: "*" });
        this.scheduleHostedEventReconnect(1_000);
      };
      client.on("notification", (msg) => this.emitHostedEvent(parseHostedEventPayload(msg.payload)));
      client.on("error", onDead);
      client.on("end", onDead);
      if (!this.isCustomPool) await (client as pg.Client).connect();
      await client.query(`LISTEN ${HOSTED_EXECUTION_EVENT_CHANNEL}`);
      if (this.hostedEventClosed) throw new Error("hosted event listener closed during connect");
      this.hostedEventClient = client;
    } catch (error) {
      if (client) {
        try {
          if (this.isCustomPool) (client as pg.PoolClient).release(error instanceof Error ? error : new Error(String(error)));
          else await (client as pg.Client).end();
        } catch { /* best effort */ }
      }
      if (!this.hostedEventClosed) this.scheduleHostedEventReconnect(1_000);
      throw error;
    }
  }

  private scheduleHostedEventReconnect(delayMs: number): void {
    if (this.hostedEventClosed || this.hostedEventReconnect) return;
    this.hostedEventReconnect = setTimeout(() => {
      this.hostedEventReconnect = undefined;
      void this.openHostedEventClient().catch(() => undefined);
    }, delayMs);
    this.hostedEventReconnect.unref();
  }

  private emitHostedEvent(event: HostedExecutionEvent): void {
    for (const handler of this.hostedEventHandlers ?? []) {
      try {
        handler(event);
      } catch {
        // A broken consumer must never kill the shared listener.
      }
    }
  }

  private async closeHostedEventClient(): Promise<void> {
    this.hostedEventClosed = true;
    if (this.hostedEventReconnect) clearTimeout(this.hostedEventReconnect);
    this.hostedEventReconnect = undefined;
    const client = this.hostedEventClient;
    this.hostedEventClient = undefined;
    if (!client) return;
    try {
      await client.query(`UNLISTEN ${HOSTED_EXECUTION_EVENT_CHANNEL}`).catch(() => undefined);
      if (this.isCustomPool) (client as pg.PoolClient).release();
      else await (client as pg.Client).end();
    } catch {
      try { (client as pg.PoolClient).release(new Error("listener close failed")); } catch { /* best effort */ }
    }
  }

  /** @internal Test hook: force-drops the LISTEN connection to exercise reconnect/resync paths. */
  async _dropHostedEventListenerForTest(): Promise<void> {
    const client = this.hostedEventClient;
    if (!client) return;
    // The 'end'/'error' listener (onDead) performs the resync emit + reconnect — the hook only
    // severs the connection so the real failure path runs end to end.
    try {
      if (this.isCustomPool) (client as pg.PoolClient).release(new Error("test-induced listener drop"));
      else await (client as pg.Client).end();
    } catch { /* drop is best effort */ }
  }

  async listHostedAdmissionReceipts(executionId: string, userId: string): Promise<HostedAdmissionReceiptRecord[]> {
    const owns = await this.pool.query(`SELECT 1 FROM hosted_executions WHERE id=$1 AND user_id=$2`, [executionId, userId]);
    if (owns.rows.length === 0) throw new Error("Hosted execution not found for user");
    const res = await this.pool.query(`SELECT * FROM hosted_admission_receipts WHERE execution_id=$1 AND user_id=$2 ORDER BY created_at ASC`, [executionId, userId]);
    return res.rows.map((row) => ({ id: String(row.id), executionId: String(row.execution_id), userId: String(row.user_id), eventType: row.event_type as HostedAdmissionReceiptRecord["eventType"], workerId: row.worker_id ? String(row.worker_id) : undefined, details: row.details ? JSON.parse(String(row.details)) : undefined, createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at) }));
  }

  async getHostedAdmissionMetrics(): Promise<HostedAdmissionMetrics> {
    const res = await this.pool.query(`SELECT
      (SELECT COUNT(*) FROM hosted_executions WHERE status='queued') AS queue_depth,
      (SELECT COUNT(DISTINCT user_id) FROM hosted_executions WHERE status='queued') AS queued_users,
      (SELECT COUNT(DISTINCT user_id) FROM hosted_capacity_leases WHERE state='active') AS active_users,
      (SELECT COUNT(*) FROM hosted_capacity_leases WHERE state='active') AS active_reservations,
      (SELECT COUNT(*) FROM hosted_capacity_leases WHERE state='expired') AS reservation_expirations,
      (SELECT COUNT(*) FROM hosted_admission_receipts WHERE event_type='DUPLICATE_SUPPRESSED') AS duplicate_request_suppressions,
      (SELECT COUNT(*) FROM hosted_executions WHERE status='cancelled') AS cancellations`);
    const row = res.rows[0];
    return { queueDepth: Number(row.queue_depth), queuedUsers: Number(row.queued_users), activeUsers: Number(row.active_users), activeReservations: Number(row.active_reservations), reservationExpirations: Number(row.reservation_expirations), duplicateRequestSuppressions: Number(row.duplicate_request_suppressions), cancellations: Number(row.cancellations) };
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

      const historicalUsageRes = await client.query(
        `SELECT COALESCE(SUM(credits_consumed), 0) AS credits
         FROM usage_events
         WHERE user_id = $1 AND access_class = 'free' AND created_at >= $2 AND created_at < $3`,
        [userId, periodStart, periodEnd],
      );
      const creditsUsed = Number(historicalUsageRes.rows[0]?.credits ?? 0);
      const id = randomUUID();
      const nowIso = now.toISOString();
      const insertRes = await client.query(
        `INSERT INTO usage_periods (id, user_id, period_start, period_end, free_allowance_granted, credits_used, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id, period_start) DO NOTHING
         RETURNING *`,
        [id, userId, periodStart, periodEnd, allowanceAmount, creditsUsed, nowIso, nowIso],
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

      return {
        period: this.mapUsagePeriodRow(insertRes.rows[0]),
        grantedNewAllowance: true,
      };
    });
  }

  private async getUsagePeriodRemainingWithClient(client: pg.PoolClient | pg.Pool, periodId: string): Promise<number> {
    const res = await client.query(
      `SELECT p.free_allowance_granted, p.credits_used,
        COALESCE((SELECT SUM(r.reserved_credits) FROM reservations r WHERE r.usage_period_id = p.id AND r.status = 'reserved'), 0) AS reserved_credits
       FROM usage_periods p WHERE p.id = $1`,
      [periodId],
    );
    const row = res.rows[0];
    if (!row) return 0;
    return Math.max(0, Number(row.free_allowance_granted) - Number(row.credits_used) - Number(row.reserved_credits));
  }

  async getUsagePeriodReservedCredits(periodId: string): Promise<number> {
    const res = await this.pool.query(`SELECT COALESCE(SUM(reserved_credits), 0) AS credits FROM reservations WHERE usage_period_id = $1 AND status = 'reserved'`, [periodId]);
    return Number(res.rows[0]?.credits ?? 0);
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

  async claimGitHubWebhookDelivery(params: { deliveryId: string; event: string; action?: string; installationId?: number }): Promise<{ claimed: boolean }> {
    const now = new Date().toISOString();
    const res = await this.pool.query(
      `INSERT INTO github_webhook_deliveries (id, delivery_id, event, action, installation_id, status, received_at, created_at)
       VALUES ($1, $2, $3, $4, $5, 'claimed', $6, $6)
       ON CONFLICT (delivery_id) DO NOTHING
       RETURNING id`,
      [randomUUID(), params.deliveryId, params.event, params.action ?? null, params.installationId ?? null, now],
    );
    return { claimed: res.rows.length > 0 };
  }

  async completeGitHubWebhookDelivery(deliveryId: string, status: "processed" | "failed" | "ignored"): Promise<void> {
    await this.pool.query(
      `UPDATE github_webhook_deliveries SET status = $1, processed_at = $2 WHERE delivery_id = $3`,
      [status, new Date().toISOString(), deliveryId],
    );
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
    await this.pool.query(
      `INSERT INTO security_audit_events (id, occurred_at, event_type, outcome, user_id, ip_address, details, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [record.id, record.occurredAt, record.eventType, record.outcome, record.userId ?? null, record.ipAddress ?? null, record.details ? JSON.stringify(record.details) : null, record.createdAt],
    );
    return record;
  }

  async listSecurityAuditEvents(filter: { userId?: string; eventType?: string; limit?: number } = {}): Promise<SecurityAuditEventRecord[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.userId) { values.push(filter.userId); clauses.push(`user_id = ${values.length}`); }
    if (filter.eventType) { values.push(filter.eventType); clauses.push(`event_type = ${values.length}`); }
    values.push(Math.min(Math.max(filter.limit ?? 100, 1), 1000));
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const res = await this.pool.query(`SELECT * FROM security_audit_events ${where} ORDER BY occurred_at DESC LIMIT ${values.length}`, values);
    return res.rows.map((row: Record<string, unknown>) => ({
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

  async deleteUserAccount(userId: string): Promise<AccountDeletionResult> {
    return this.withTx(async (client) => {
      const tables: AccountDeletionTableSummary[] = [];
      const del = async (table: string, sql: string): Promise<void> => {
        const res = await client.query(sql, [userId]);
        tables.push({ table, rowsDeleted: res.rowCount ?? 0 });
      };

      const anonymized = await client.query(`UPDATE abuse_events SET user_id = NULL WHERE user_id = $1`, [userId]);
      const auditAnonymized = await client.query(`UPDATE security_audit_events SET user_id = NULL WHERE user_id = $1`, [userId]);

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
      await del("hosted_admission_receipts", `DELETE FROM hosted_admission_receipts WHERE user_id = $1`);
      await del("hosted_capacity_leases", `DELETE FROM hosted_capacity_leases WHERE user_id = $1`);
      await del("hosted_user_admission_state", `DELETE FROM hosted_user_admission_state WHERE user_id = $1`);
      await del("hosted_executions", `DELETE FROM hosted_executions WHERE user_id = $1`);
      await del("account_settings", `DELETE FROM account_settings WHERE user_id = $1`);
      await del("users", `DELETE FROM users WHERE id = $1`);

      return { userId, tables, abuseEventsAnonymized: anonymized.rowCount ?? 0, securityAuditEventsAnonymized: auditAnonymized.rowCount ?? 0 };
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

  async purgeExpiredSecurityArtifacts(params: { nowIso: string; revokedSessionCutoffIso: string }): Promise<Record<string, number>> {
    const { nowIso, revokedSessionCutoffIso } = params;
    const count = async (sql: string, args: unknown[]) => (await this.pool.query(sql, args)).rowCount ?? 0;
    return {
      oauth_transactions: await count(`DELETE FROM oauth_transactions WHERE expires_at <= $1 OR used_at IS NOT NULL`, [nowIso]),
      browser_oauth_transactions: await count(`DELETE FROM browser_oauth_transactions WHERE expires_at <= $1 OR used_at IS NOT NULL`, [nowIso]),
      desktop_auth_codes: await count(`DELETE FROM desktop_auth_codes WHERE expires_at <= $1 OR used_at IS NOT NULL`, [nowIso]),
      github_app_callback_states: await count(`DELETE FROM github_app_callback_states WHERE expires_at <= $1 OR consumed_at IS NOT NULL`, [nowIso]),
      browser_sessions: await count(`DELETE FROM browser_sessions WHERE expires_at <= $1 OR (revoked_at IS NOT NULL AND revoked_at <= $2)`, [nowIso, revokedSessionCutoffIso]),
      device_sessions: await count(`DELETE FROM device_sessions WHERE (revoked_at IS NOT NULL AND revoked_at <= $1) OR expires_at <= $1`, [revokedSessionCutoffIso]),
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

  async listPublicationsByState(state: PublicationState, limit = 500): Promise<PublicationRecord[]> {
    const res = await this.pool.query(`SELECT * FROM publications WHERE state = $1 ORDER BY updated_at ASC LIMIT $2`, [state, Math.min(Math.max(limit, 1), 5000)]);
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
