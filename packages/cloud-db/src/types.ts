import { z } from "zod";

export const FeatureKeySchema = z.enum([
  "HOSTED_FREE",
  "HOSTED_PAID",
  "PREMIUM_MODELS",
  "GEMS_READY",
  "HIGH_CONTEXT",
  "HIGH_CONCURRENCY",
  "PRIORITY_ROUTING",
  "CLOUD_JOBS",
  "DIRECT_PROVIDERS",
  "COMMUNITY_MODELS",
]);
export type FeatureKey = z.infer<typeof FeatureKeySchema>;

export const UserRecordSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().min(1),
  avatarUrl: z.string().url().optional(),
  primaryIdentity: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type UserRecord = z.infer<typeof UserRecordSchema>;

export const IdentityRecordSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  provider: z.enum(["github", "email"]),
  providerUserId: z.string(),
  providerEmail: z.string().email().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IdentityRecord = z.infer<typeof IdentityRecordSchema>;

export const DeviceSessionRecordSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  deviceName: z.string().default("CodeForge Desktop"),
  refreshTokenHash: z.string(),
  ipAddress: z.string().optional(),
  userAgent: z.string().optional(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable().optional(),
  /**
   * Why this session was revoked. The distinction is security-relevant, not bookkeeping:
   *   * `rotated` — consumed by a refresh. Reuse of this token means someone else holds it, so the
   *     whole session family must be revoked (OAuth 2.0 BCP refresh-token replay detection).
   *   * `logout`  — the user signed this device out. Reuse is just a stale client; revoking other
   *     devices would sign the user out everywhere for a benign event.
   *   * `breach`  — already revoked as part of a family revocation.
   */
  revokedReason: z.enum(["rotated", "logout", "breach"]).nullable().optional(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
});
export type DeviceSessionRecord = z.infer<typeof DeviceSessionRecordSchema>;

export const PlanRecordSchema = z.object({
  id: z.string(), // "free" | "pro" | "team"
  name: z.string(),
  monthlyCreditAllowance: z.number().int().nonnegative(),
  maxConcurrentTasks: z.number().int().positive(),
  maxTaskSpendCredits: z.number().int().positive(),
  features: z.array(FeatureKeySchema).default([]),
  createdAt: z.string(),
});
export type PlanRecord = z.infer<typeof PlanRecordSchema>;

export const SubscriptionRecordSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  planId: z.string(),
  stripeCustomerId: z.string().optional(),
  stripeSubscriptionId: z.string().optional(),
  status: z.enum(["active", "trialing", "past_due", "canceled", "incomplete", "incomplete_expired", "unpaid"]),
  currentPeriodStart: z.string(),
  currentPeriodEnd: z.string(),
  cancelAtPeriodEnd: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SubscriptionRecord = z.infer<typeof SubscriptionRecordSchema>;

export const EntitlementRecordSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  featureKey: FeatureKeySchema,
  grantedValue: z.string().default("true"),
  expiresAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EntitlementRecord = z.infer<typeof EntitlementRecordSchema>;

export const CreditEventTypeSchema = z.enum([
  "FREE_ALLOWANCE_GRANTED",
  "CREDIT_PURCHASED",
  "CREDIT_RESERVED",
  "CREDIT_USED",
  "CREDIT_RELEASED",
  "CREDIT_REFUNDED",
  "SUBSCRIPTION_ALLOWANCE_GRANTED",
  "ADMIN_ADJUSTMENT",
]);
export type CreditEventType = z.infer<typeof CreditEventTypeSchema>;

export const CreditLedgerRecordSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  amount: z.number().int(), // positive for grants/refunds, negative for usage/reservations
  balanceAfter: z.number().int().nonnegative(),
  eventType: CreditEventTypeSchema,
  requestId: z.string().optional(),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string(),
});
export type CreditLedgerRecord = z.infer<typeof CreditLedgerRecordSchema>;

export const UsageEventRecordSchema = z.object({
  id: z.string().uuid(),
  requestId: z.string(),
  userId: z.string().uuid(),
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  providerId: z.string(),
  modelId: z.string(),
  accessClass: z.string().optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative().default(0),
  providerCostUsd: z.number().nonnegative().default(0),
  creditsConsumed: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative().default(0),
  status: z.enum(["completed", "failed", "cancelled"]),
  createdAt: z.string(),
});
export type UsageEventRecord = z.infer<typeof UsageEventRecordSchema>;

export const UsagePeriodRecordSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  periodStart: z.string(),
  periodEnd: z.string(),
  freeAllowanceGranted: z.number().int().nonnegative().default(0),
  creditsUsed: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type UsagePeriodRecord = z.infer<typeof UsagePeriodRecordSchema>;

export const ReservationStatusSchema = z.enum(["reserved", "committed", "released"]);
export type ReservationStatus = z.infer<typeof ReservationStatusSchema>;

export const ReservationRecordSchema = z.object({
  id: z.string().uuid(),
  requestId: z.string(),
  userId: z.string().uuid(),
  providerId: z.string(),
  modelId: z.string(),
  reservedCredits: z.number().int().nonnegative(),
  actualCredits: z.number().int().nonnegative().default(0),
  status: ReservationStatusSchema,
  createdAt: z.string(),
  committedAt: z.string().nullable().optional(),
  releasedAt: z.string().nullable().optional(),
});
export type ReservationRecord = z.infer<typeof ReservationRecordSchema>;

export const HostedRequestRecordSchema = z.object({
  id: z.string(),
  userId: z.string().uuid(),
  status: z.enum(["pending", "in_progress", "completed", "failed", "cancelled"]),
  estimatedCredits: z.number().int().nonnegative(),
  actualCredits: z.number().int().nonnegative().default(0),
  providerId: z.string(),
  modelId: z.string(),
  createdAt: z.string(),
  completedAt: z.string().nullable().optional(),
});
export type HostedRequestRecord = z.infer<typeof HostedRequestRecordSchema>;

export const BillingWebhookEventRecordSchema = z.object({
  id: z.string().uuid(),
  stripeEventId: z.string(),
  eventType: z.string(),
  processedAt: z.string(),
  status: z.enum(["processed", "failed", "ignored"]),
  payload: z.record(z.unknown()).optional(),
  createdAt: z.string(),
});
export type BillingWebhookEventRecord = z.infer<typeof BillingWebhookEventRecordSchema>;

export const AccountSettingsRecordSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  privacyMode: z.enum(["STRICT", "STANDARD", "MAXIMUM_FREE"]).default("STANDARD"),
  autoTopUpEnabled: z.boolean().default(false),
  spendLimitUsd: z.number().nonnegative().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AccountSettingsRecord = z.infer<typeof AccountSettingsRecordSchema>;

export const AbuseEventRecordSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid().optional(),
  ipAddress: z.string().optional(),
  eventType: z.string(),
  details: z.string().optional(),
  createdAt: z.string(),
});
export type AbuseEventRecord = z.infer<typeof AbuseEventRecordSchema>;

export const OAuthTransactionRecordSchema = z.object({
  id: z.string().uuid(),
  state: z.string(),
  /**
   * The DESKTOP client's PKCE challenge. It binds this authorization attempt to the desktop process
   * that started it, and is later verified against the code verifier presented at desktop-code
   * exchange. It is never the GitHub PKCE challenge — that pair is server-owned (see
   * {@link OAuthTransactionRecordSchema.shape.gitHubCodeVerifier}).
   */
  codeChallenge: z.string(),
  /**
   * Server-owned GitHub PKCE verifier. Generated by the Cloud, never sent to any client, and used
   * only on the server→GitHub token exchange. Storing it here (rather than handing it to the
   * desktop) is what keeps the authorization-server leg a confidential-client exchange.
   */
  gitHubCodeVerifier: z.string().optional(),
  redirectUri: z.string(),
  deviceName: z.string().optional(),
  expiresAt: z.string(),
  usedAt: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type OAuthTransactionRecord = z.infer<typeof OAuthTransactionRecordSchema>;

/**
 * A single-use, short-lived artifact handed to the desktop loopback listener after GitHub
 * authorization succeeds. It carries NO session authority on its own: it must be exchanged at the
 * Cloud, over POST, with the desktop PKCE verifier, before any token is minted. Only the SHA-256
 * hash of the code is persisted, so a database disclosure never yields a usable code.
 */
export const DesktopAuthCodeRecordSchema = z.object({
  id: z.string().uuid(),
  codeHash: z.string(),
  userId: z.string(),
  codeChallenge: z.string(),
  redirectUri: z.string(),
  deviceName: z.string().optional(),
  isNewUser: z.boolean(),
  expiresAt: z.string(),
  usedAt: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type DesktopAuthCodeRecord = z.infer<typeof DesktopAuthCodeRecordSchema>;

export const SchemaMigrationRecordSchema = z.object({
  version: z.number().int().positive(),
  name: z.string(),
  checksum: z.string(),
  appliedAt: z.string(),
});
export type SchemaMigrationRecord = z.infer<typeof SchemaMigrationRecordSchema>;

// CF-11B: GitHub App Installation & Repository Authorization

export const GitHubInstallationRecordSchema = z.object({
  id: z.string().uuid(),
  installationId: z.number().int().positive(),
  githubAccountId: z.number().int().positive(),
  accountLogin: z.string(),
  accountType: z.enum(["User", "Organization"]),
  codeForgeUserId: z.string().uuid(),
  repositorySelection: z.enum(["all", "selected"]),
  status: z.enum(["active", "suspended", "revoked"]),
  revokedAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type GitHubInstallationRecord = z.infer<typeof GitHubInstallationRecordSchema>;
export type GitHubInstallationStatus = GitHubInstallationRecord["status"];

/**
 * Authorization is keyed on GitHub's immutable numeric repository id. Owner/name are cached
 * display metadata only: a rename keeps the row (same id), and a different repository that later
 * reuses the old owner/name gets a different id and therefore no inherited authorization.
 */
export const GitHubRepositoryAuthorizationRecordSchema = z.object({
  id: z.string().uuid(),
  installationId: z.string().uuid(),
  repositoryId: z.number().int().positive(),
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
  private: z.boolean(),
  authorizationState: z.enum(["authorized", "revoked", "deleted"]),
  observedAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type GitHubRepositoryAuthorizationRecord = z.infer<typeof GitHubRepositoryAuthorizationRecordSchema>;
export type GitHubRepositoryAuthorizationState = GitHubRepositoryAuthorizationRecord["authorizationState"];

export const GitHubAppCallbackStateRecordSchema = z.object({
  id: z.string().uuid(),
  state: z.string(),
  codeForgeUserId: z.string().uuid(),
  deviceSessionId: z.string().nullable().optional(),
  expiresAt: z.string(),
  consumedAt: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type GitHubAppCallbackStateRecord = z.infer<typeof GitHubAppCallbackStateRecordSchema>;

// CF-11B: Publication Records

export const PublicationStateSchema = z.enum([
  "awaiting_artifact",
  "artifact_uploaded",
  "validating",
  "validated",
  "waiting_for_lease",
  "authorizing",
  "checking_target",
  "pushing",
  "pushed",
  "creating_pr",
  "pr_created",
  "completed",
  "failed_retryable",
  "failed_permanent",
  "authorization_revoked",
  "target_diverged",
]);
export type PublicationState = z.infer<typeof PublicationStateSchema>;

/** States after which no further remote mutation may be attempted. */
export const TERMINAL_PUBLICATION_STATES: readonly PublicationState[] = [
  "completed",
  "failed_permanent",
  "authorization_revoked",
  "target_diverged",
];

export const PublicationArtifactStateSchema = z.enum(["pending", "stored"]);
export type PublicationArtifactState = z.infer<typeof PublicationArtifactStateSchema>;

export const PublicationRecordSchema = z.object({
  id: z.string().uuid(),
  deliveryId: z.string(),
  userId: z.string().uuid(),
  repositoryId: z.number().int().positive(),
  installationId: z.string().uuid(),
  targetBranch: z.string(),
  baseSha: z.string(),
  targetSha: z.string(),
  certifiedHead: z.string(),
  certifiedTree: z.string(),
  artifactSha256: z.string(),
  artifactBytes: z.number().int().nonnegative(),
  artifactState: PublicationArtifactStateSchema,
  /** Server-controlled storage key. Never derived from client input, never the bundle bytes. */
  artifactKey: z.string().nullable().optional(),
  state: PublicationStateSchema,
  leaseOwner: z.string().nullable().optional(),
  leaseExpiresAt: z.string().nullable().optional(),
  /** Monotonic fencing token. A worker whose fence is stale can no longer write. */
  leaseFence: z.number().int().nonnegative(),
  pushRef: z.string().nullable().optional(),
  pullRequestNumber: z.number().int().nullable().optional(),
  pullRequestUrl: z.string().nullable().optional(),
  pullRequestNodeId: z.string().nullable().optional(),
  errorCode: z.string().nullable().optional(),
  failureReason: z.string().nullable().optional(),
  attemptCount: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable().optional(),
});
export type PublicationRecord = z.infer<typeof PublicationRecordSchema>;

export interface PublicationLease {
  publicationId: string;
  owner: string;
  fence: number;
  expiresAt: string;
}

export type VerificationRecordStatus = "pending" | "running" | "passed" | "failed" | "cancelled" | "timed_out" | "infra_error" | "interrupted";

export interface CloudVerificationPlanRecord {
  id: string;
  runId: string;
  workspaceId: string;
  policyVersion: string;
  inputStateHash: string;
  scope: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CloudVerificationAttemptRecord {
  id: string;
  planId: string;
  runId: string;
  verifierId: string;
  verifierVersion: string;
  status: VerificationRecordStatus;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  payload: Record<string, unknown>;
}

export interface CloudVerificationEvidenceRecord {
  id: string;
  attemptId: string;
  planId: string;
  runId: string;
  verifierId: string;
  verifierVersion: string;
  inputStateHash: string;
  status: Exclude<VerificationRecordStatus, "pending" | "running">;
  outputDigest: string;
  outputTruncated: boolean;
  payload: Record<string, unknown>;
  createdAt: string;
}
