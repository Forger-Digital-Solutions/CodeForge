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

/**
 * The canonical CodeForge Cloud persistence contract. Every operation is asynchronous so that a
 * genuinely async backend (Postgres over `pg`) is a first-class citizen alongside the synchronous
 * embedded backend (SQLite). SQLite implements this contract with fully synchronous method bodies
 * wrapped in resolved promises — which keeps each individual operation atomic on a single-threaded
 * event loop — while Postgres implements it with real network round-trips and, where correctness
 * demands it, explicit transactions with row-level locking.
 *
 * There is exactly ONE contract. There is no "sync path" that silently diverges from an "async path":
 * callers always await, and both drivers return the same records with the same semantics.
 */
export interface ICloudDatabase {
  /**
   * Initialize the database schema (run pending migrations, seed default plans). MUST be awaited
   * before serving traffic. SQLite initializes synchronously in its constructor and this is an
   * idempotent no-op; Postgres performs asynchronous schema creation here, so this is the ONLY
   * place a fresh Postgres database gets its tables. Failing to await it is a fail-closed boot error.
   */
  init(): Promise<void>;
  close(): Promise<void>;

  // Users & Identities
  createUser(params: { displayName: string; avatarUrl?: string; primaryIdentity: string; id?: string }): Promise<UserRecord>;
  getUserById(id: string): Promise<UserRecord | undefined>;
  getUserByPrimaryIdentity(primaryIdentity: string): Promise<UserRecord | undefined>;
  createIdentity(params: { userId: string; provider: "github" | "email"; providerUserId: string; providerEmail?: string; id?: string }): Promise<IdentityRecord>;
  getIdentityByProvider(provider: string, providerUserId: string): Promise<IdentityRecord | undefined>;

  // Device Sessions
  createDeviceSession(params: { userId: string; deviceName?: string; refreshTokenHash: string; ipAddress?: string; userAgent?: string; expiresInSeconds?: number }): Promise<DeviceSessionRecord>;
  getDeviceSessionByTokenHash(refreshTokenHash: string): Promise<DeviceSessionRecord | undefined>;
  updateDeviceSessionLastSeen(id: string): Promise<void>;
  revokeDeviceSession(id: string): Promise<void>;
  revokeAllUserDeviceSessions(userId: string): Promise<void>;
  /**
   * Atomically rotate a refresh token: validate the old session (rejecting revoked/expired tokens and
   * flagging replay), revoke it, and mint a fresh session — all as one authoritative transition so a
   * refresh can never mint two live session chains from one token.
   */
  rotateDeviceSession(params: { oldTokenHash: string; newRefreshTokenHash: string; deviceName?: string; ipAddress?: string; userAgent?: string; expiresInSeconds?: number }): Promise<{ user: UserRecord; session: DeviceSessionRecord }>;

  // Plans & Subscriptions
  getPlan(id: string): Promise<PlanRecord | undefined>;
  listPlans(): Promise<PlanRecord[]>;
  getSubscriptionByUserId(userId: string): Promise<SubscriptionRecord | undefined>;
  getSubscriptionByStripeCustomerId(stripeCustomerId: string): Promise<SubscriptionRecord | undefined>;
  getSubscriptionByStripeSubscriptionId(stripeSubscriptionId: string): Promise<SubscriptionRecord | undefined>;
  upsertSubscription(sub: Omit<SubscriptionRecord, "id" | "createdAt" | "updatedAt"> & { id?: string }): Promise<SubscriptionRecord>;

  // Entitlements
  getEntitlements(userId: string): Promise<EntitlementRecord[]>;
  hasEntitlement(userId: string, featureKey: FeatureKey | string): Promise<boolean>;
  setEntitlement(userId: string, featureKey: FeatureKey | string, grantedValue?: string, expiresAt?: string | null): Promise<EntitlementRecord>;
  removeEntitlement(userId: string, featureKey: FeatureKey | string): Promise<void>;

  // Credit Ledger
  getCreditBalance(userId: string): Promise<number>;
  /**
   * Append one authoritative balance mutation. The new balance is checked to be non-negative and the
   * read-of-current-balance and the insert are atomic per user (Postgres locks the user row; SQLite is
   * atomic by virtue of its synchronous body) so concurrent appends can never overspend or lose an update.
   */
  appendLedgerEvent(params: { userId: string; amount: number; eventType: CreditEventType; requestId?: string; description?: string; metadata?: Record<string, unknown> }): Promise<CreditLedgerRecord>;
  listLedgerEvents(userId: string, limit?: number): Promise<CreditLedgerRecord[]>;

  // Usage Events
  recordUsageEvent(event: Omit<UsageEventRecord, "id" | "createdAt"> & { id?: string }): Promise<UsageEventRecord>;
  listUsageEvents(userId: string, limit?: number): Promise<UsageEventRecord[]>;
  getDailyProviderSpendUsd(sinceIsoString?: string): Promise<number>;
  getUserBillingPeriodSpendUsd(userId: string, sinceIsoString?: string): Promise<number>;

  // Authoritative Reservations (low-level row operations)
  createReservation(params: { id?: string; requestId: string; userId: string; providerId: string; modelId: string; reservedCredits: number }): Promise<ReservationRecord>;
  getReservationByRequestId(requestId: string): Promise<ReservationRecord | undefined>;
  commitReservation(requestId: string, userId: string, actualCredits: number): Promise<ReservationRecord>;
  releaseReservation(requestId: string, userId: string): Promise<ReservationRecord>;
  /** Reservations still in 'reserved' state created before the cutoff — candidates for stale recovery. */
  listStaleReservations(cutoffIso: string): Promise<ReservationRecord[]>;

  // Authoritative Reservations (atomic compound money operations — used by the usage engine)
  /**
   * Atomically reserve credits for a request: idempotent by requestId, balance-checked, and (on
   * Postgres) serialized per user with `SELECT ... FOR UPDATE`. Creates the reservation row and the
   * CREDIT_RESERVED ledger debit as one unit — a concurrent duplicate requestId returns the existing
   * reservation without a second debit, and concurrent distinct requests can never overspend.
   */
  reserveCredits(params: {
    requestId: string;
    userId: string;
    providerId: string;
    modelId: string;
    reservedCredits: number;
    description?: string;
    metadata?: Record<string, unknown>;
    maxConcurrentTasks?: number;
  }): Promise<{ reservation: ReservationRecord; balanceAfter: number; created: boolean }>;

  /**
   * Atomically settle a reserved request: transition reserved→committed exactly once and reconcile the
   * difference between reserved and actual credits (refund excess, or charge the bounded remainder).
   * `transitioned` is true only for the caller that performed the transition, so usage recording never
   * double-counts under concurrent retries. Throws if the reservation was already released.
   */
  settleReservation(params: { requestId: string; userId: string; actualCredits: number; settleDescription?: string }): Promise<{ reservation: ReservationRecord; transitioned: boolean; balanceAfter: number }>;
  /**
   * Atomically release a reserved request and refund the held credits exactly once. Idempotent: a
   * second release refunds nothing further (`transitioned` false) but reports the original refund.
   * Throws if the reservation was already committed.
   */
  releaseReservationCredits(params: { requestId: string; userId: string; reason?: string }): Promise<{ reservation: ReservationRecord; transitioned: boolean; refundedCredits: number; balanceAfter: number }>;

  // Hosted Requests
  createHostedRequest(req: { id: string; userId: string; providerId: string; modelId: string; estimatedCredits: number }): Promise<HostedRequestRecord>;
  getHostedRequest(id: string): Promise<HostedRequestRecord | undefined>;
  updateHostedRequest(id: string, status: HostedRequestRecord["status"], actualCredits?: number): Promise<void>;

  // Usage Periods
  getOrCreateCurrentUsagePeriod(userId: string, allowanceAmount?: number, now?: Date): Promise<{ period: UsagePeriodRecord; grantedNewAllowance: boolean }>;

  // OAuth Transactions
  createOAuthTransaction(params: { state: string; codeChallenge: string; redirectUri: string; deviceName?: string; expiresInSeconds?: number }): Promise<OAuthTransactionRecord>;
  getOAuthTransaction(state: string): Promise<OAuthTransactionRecord | undefined>;
  consumeOAuthTransaction(state: string): Promise<OAuthTransactionRecord>;

  // Webhooks
  isWebhookProcessed(stripeEventId: string): Promise<boolean>;
  recordWebhookEvent(params: { stripeEventId: string; eventType: string; status: "processed" | "failed" | "ignored"; payload?: Record<string, unknown> }): Promise<BillingWebhookEventRecord>;
  /**
   * Atomically claim a webhook event for processing. Returns `claimed: true` for exactly one caller
   * per stripeEventId (the winner applies the mutation) and `false` for every duplicate delivery, so a
   * repeated Stripe webhook can never apply an upgrade or credit grant twice.
   */
  claimWebhookEvent(params: { stripeEventId: string; eventType: string }): Promise<{ claimed: boolean }>;

  // Settings
  getAccountSettings(userId: string): Promise<AccountSettingsRecord>;
  upsertAccountSettings(settings: Partial<AccountSettingsRecord> & { userId: string }): Promise<AccountSettingsRecord>;

  // Health & Concurrency
  ping(): Promise<boolean>;
  getActiveReservationCount(userId: string): Promise<number>;

  // Abuse
  recordAbuseEvent(params: { userId?: string; ipAddress?: string; eventType: string; details?: string }): Promise<AbuseEventRecord>;
}
