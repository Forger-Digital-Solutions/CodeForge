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

export interface ICloudDatabase {
  /**
   * Initialize the database schema (run pending migrations, seed default plans). MUST be awaited
   * before serving traffic. SQLite initializes synchronously in its constructor and this is an
   * idempotent no-op; Postgres performs asynchronous schema creation here, so this is the ONLY
   * place a fresh Postgres database gets its tables. Failing to await it is a fail-closed boot error.
   */
  init(): void | Promise<void>;
  close(): void | Promise<void>;

  // Users & Identities
  createUser(params: { displayName: string; avatarUrl?: string; primaryIdentity: string; id?: string }): UserRecord;
  getUserById(id: string): UserRecord | undefined;
  getUserByPrimaryIdentity(primaryIdentity: string): UserRecord | undefined;
  createIdentity(params: { userId: string; provider: "github" | "email"; providerUserId: string; providerEmail?: string; id?: string }): IdentityRecord;
  getIdentityByProvider(provider: string, providerUserId: string): IdentityRecord | undefined;

  // Device Sessions
  createDeviceSession(params: { userId: string; deviceName?: string; refreshTokenHash: string; ipAddress?: string; userAgent?: string; expiresInSeconds?: number }): DeviceSessionRecord;
  getDeviceSessionByTokenHash(refreshTokenHash: string): DeviceSessionRecord | undefined;
  updateDeviceSessionLastSeen(id: string): void;
  revokeDeviceSession(id: string): void;
  revokeAllUserDeviceSessions(userId: string): void;
  rotateDeviceSession(params: { oldTokenHash: string; newRefreshTokenHash: string; deviceName?: string; ipAddress?: string; userAgent?: string; expiresInSeconds?: number }): { user: UserRecord; session: DeviceSessionRecord };

  // Plans & Subscriptions
  getPlan(id: string): PlanRecord | undefined;
  listPlans(): PlanRecord[];
  getSubscriptionByUserId(userId: string): SubscriptionRecord | undefined;
  getSubscriptionByStripeCustomerId(stripeCustomerId: string): SubscriptionRecord | undefined;
  getSubscriptionByStripeSubscriptionId(stripeSubscriptionId: string): SubscriptionRecord | undefined;
  upsertSubscription(sub: Omit<SubscriptionRecord, "id" | "createdAt" | "updatedAt"> & { id?: string }): SubscriptionRecord;

  // Entitlements
  getEntitlements(userId: string): EntitlementRecord[];
  hasEntitlement(userId: string, featureKey: FeatureKey | string): boolean;
  setEntitlement(userId: string, featureKey: FeatureKey | string, grantedValue?: string, expiresAt?: string | null): EntitlementRecord;
  removeEntitlement(userId: string, featureKey: FeatureKey | string): void;

  // Credit Ledger
  getCreditBalance(userId: string): number;
  appendLedgerEvent(params: { userId: string; amount: number; eventType: CreditEventType; requestId?: string; description?: string; metadata?: Record<string, unknown> }): CreditLedgerRecord;
  listLedgerEvents(userId: string, limit?: number): CreditLedgerRecord[];

  // Usage Events
  recordUsageEvent(event: Omit<UsageEventRecord, "id" | "createdAt"> & { id?: string }): UsageEventRecord;
  listUsageEvents(userId: string, limit?: number): UsageEventRecord[];
  getDailyProviderSpendUsd(sinceIsoString?: string): number;
  getUserBillingPeriodSpendUsd(userId: string, sinceIsoString?: string): number;

  // Authoritative Reservations
  createReservation(params: { id?: string; requestId: string; userId: string; providerId: string; modelId: string; reservedCredits: number }): ReservationRecord;
  getReservationByRequestId(requestId: string): ReservationRecord | undefined;
  commitReservation(requestId: string, userId: string, actualCredits: number): ReservationRecord;
  releaseReservation(requestId: string, userId: string): ReservationRecord;
  /** Reservations still in 'reserved' state created before the cutoff — candidates for stale recovery. */
  listStaleReservations(cutoffIso: string): ReservationRecord[];

  // Hosted Requests
  createHostedRequest(req: { id: string; userId: string; providerId: string; modelId: string; estimatedCredits: number }): HostedRequestRecord;
  getHostedRequest(id: string): HostedRequestRecord | undefined;
  updateHostedRequest(id: string, status: HostedRequestRecord["status"], actualCredits?: number): void;

  // Usage Periods
  getOrCreateCurrentUsagePeriod(userId: string, allowanceAmount?: number, now?: Date): { period: UsagePeriodRecord; grantedNewAllowance: boolean };

  // OAuth Transactions
  createOAuthTransaction(params: { state: string; codeChallenge: string; redirectUri: string; deviceName?: string; expiresInSeconds?: number }): OAuthTransactionRecord;
  getOAuthTransaction(state: string): OAuthTransactionRecord | undefined;
  consumeOAuthTransaction(state: string): OAuthTransactionRecord;

  // Webhooks
  isWebhookProcessed(stripeEventId: string): boolean;
  recordWebhookEvent(params: { stripeEventId: string; eventType: string; status: "processed" | "failed" | "ignored"; payload?: Record<string, unknown> }): BillingWebhookEventRecord;

  // Settings
  getAccountSettings(userId: string): AccountSettingsRecord;
  upsertAccountSettings(settings: Partial<AccountSettingsRecord> & { userId: string }): AccountSettingsRecord;

  // Abuse
  recordAbuseEvent(params: { userId?: string; ipAddress?: string; eventType: string; details?: string }): AbuseEventRecord;
}
