import { z } from "zod";

/**
 * CodeForge Account ID (branded type for type safety)
 */
export type AccountId = z.infer<typeof AccountIdSchema>;
export const AccountIdSchema = z.string().brand<"AccountId">();

/**
 * User ID within CodeForge (separate from provider credentials)
 */
export type UserId = z.infer<typeof UserIdSchema>;
export const UserIdSchema = z.string().brand<"UserId">();

/**
 * Session ID for authentication session
 */
export type AuthSessionId = z.infer<typeof AuthSessionIdSchema>;
export const AuthSessionIdSchema = z.string().brand<"AuthSessionId">();

/**
 * Subscription plan types for CodeForge
 */
export const PlanTypeSchema = z.enum(["free", "trial", "paid", "enterprise"]);
export type PlanType = z.infer<typeof PlanTypeSchema>;

/**
 * Authentication method used
 */
export const AuthMethodSchema = z.enum(["github_oauth", "email_password", "api_key", "developer"]);
export type AuthMethod = z.infer<typeof AuthMethodSchema>;

/**
 * Token type for session management
 */
export const TokenTypeSchema = z.enum(["access", "refresh", "developer"]);
export type TokenType = z.infer<typeof TokenTypeSchema>;

/**
 * A CodeForge user account
 * 
 * NOTE: This is separate from provider API credentials.
 * Provider credentials (OpenRouter, Gemini, etc.) are managed separately.
 */
export const AccountSchema = z.object({
  id: AccountIdSchema,
  email: z.string().email().optional(),
  githubId: z.string().optional(),
  displayName: z.string().optional(),
  plan: PlanTypeSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Account = z.infer<typeof AccountSchema>;

/**
 * Authentication session for a logged-in user
 */
export const AuthSessionSchema = z.object({
  id: AuthSessionIdSchema,
  accountId: AccountIdSchema,
  userId: UserIdSchema,
  method: AuthMethodSchema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  lastActivityAt: z.string().datetime(),
  isActive: z.boolean(),
});
export type AuthSession = z.infer<typeof AuthSessionSchema>;

/**
 * Token for API access
 */
export const AuthTokenSchema = z.object({
  id: z.string(),
  sessionId: AuthSessionIdSchema,
  tokenType: TokenTypeSchema,
  value: z.string(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  revoked: z.boolean(),
});
export type AuthToken = z.infer<typeof AuthTokenSchema>;

/**
 * Plan limits and entitlements
 */
export const PlanEntitlementSchema = z.object({
  plan: PlanTypeSchema,
  gemsModelsEnabled: z.boolean(),
  gemsModelsTrialDays: z.number().int().nonnegative().optional(),
  maxSessionsPerDay: z.number().int().positive().optional(),
  maxTokensPerMonth: z.number().int().positive().optional(),
  prioritySupport: z.boolean(),
});
export type PlanEntitlement = z.infer<typeof PlanEntitlementSchema>;

/**
 * Result of authentication attempt
 */
export const AuthResultSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    account: AccountSchema,
    session: AuthSessionSchema,
    token: AuthTokenSchema,
  }),
  z.object({
    success: z.literal(false),
    error: z.enum(["invalid_credentials", "account_not_found", "account_disabled", "rate_limited", "provider_error"]),
    message: z.string(),
  }),
]);
export type AuthResult = z.infer<typeof AuthResultSchema>;
