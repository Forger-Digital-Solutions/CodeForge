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
  codeChallenge: z.string(),
  redirectUri: z.string(),
  deviceName: z.string().optional(),
  expiresAt: z.string(),
  usedAt: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type OAuthTransactionRecord = z.infer<typeof OAuthTransactionRecordSchema>;

export const SchemaMigrationRecordSchema = z.object({
  version: z.number().int().positive(),
  name: z.string(),
  checksum: z.string(),
  appliedAt: z.string(),
});
export type SchemaMigrationRecord = z.infer<typeof SchemaMigrationRecordSchema>;
