import type { Result } from "@codeforge/core";
import type { 
  Account, 
  AccountId, 
  AuthMethod, 
  AuthResult, 
  AuthSession, 
  AuthSessionId,
  AuthToken,
  PlanType,
  UserId,
} from "./types.js";

/**
 * Authentication provider interface.
 * 
 * Supports:
 * - GitHub OAuth
 * - Email/Password
 * - Developer mode (for testing)
 * 
 * NOTE: This is separate from provider API credentials.
 * CodeForge accounts are for entitlement/billing purposes.
 * Provider credentials (OpenRouter API keys, etc.) are handled separately.
 */
export interface AuthProvider {
  /**
   * Authenticate a user via GitHub OAuth
   */
  authenticateWithGitHub(code: string): Promise<Result<AuthResult, Error>>;

  /**
   * Authenticate a user via email/password
   */
  authenticateWithEmail(email: string, password: string): Promise<Result<AuthResult, Error>>;

  /**
   * Validate an existing session
   */
  validateSession(sessionId: AuthSessionId): Promise<Result<AuthSession, Error>>;

  /**
   * Refresh an access token
   */
  refreshToken(refreshToken: string): Promise<Result<AuthToken, Error>>;

  /**
   * Logout and invalidate session
   */
  logout(sessionId: AuthSessionId): Promise<void>;

  /**
   * Get account by ID
   */
  getAccount(accountId: AccountId): Promise<Account | undefined>;

  /**
   * Get account plan
   */
  getPlan(accountId: AccountId): Promise<PlanType>;

  /**
   * Check health of auth service
   */
  healthCheck(): Promise<{ healthy: boolean; latencyMs?: number }>;
}

/**
 * Development authentication provider for testing.
 * 
 * Creates deterministic test accounts for development.
 * 
 * IMPORTANT: This is ONLY for development/testing.
 * Production authentication requires a real auth provider configuration.
 * 
 * TEST ACCOUNTS:
 * - "dev-free@test.codeforge": Free tier account
 * - "dev-trial@test.codeforge": Trial account (7 day trial)
 * - "dev-paid@test.codeforge": Paid account
 * - "dev-unknown@test.codeforge": Unknown/invalid account
 */
export class DevelopmentAuthProvider implements AuthProvider {
  private readonly accounts: Map<string, Account> = new Map();
  private readonly sessions: Map<string, AuthSession> = new Map();
  private readonly tokens: Map<string, AuthToken> = new Map();

  constructor() {
    this.initializeTestAccounts();
  }

  private initializeTestAccounts(): void {
    const now = new Date().toISOString();
    
    // Free account
    this.accounts.set("dev-free@test.codeforge", {
      id: "account-free" as AccountId,
      email: "dev-free@test.codeforge",
      displayName: "Free Test User",
      plan: "free",
      createdAt: now,
      updatedAt: now,
    });

    // Trial account
    this.accounts.set("dev-trial@test.codeforge", {
      id: "account-trial" as AccountId,
      email: "dev-trial@test.codeforge",
      displayName: "Trial Test User",
      plan: "trial",
      createdAt: now,
      updatedAt: now,
    });

    // Paid account
    this.accounts.set("dev-paid@test.codeforge", {
      id: "account-paid" as AccountId,
      email: "dev-paid@test.codeforge",
      displayName: "Paid Test User",
      plan: "paid",
      createdAt: now,
      updatedAt: now,
    });
  }

  async authenticateWithGitHub(_code: string): Promise<Result<AuthResult, Error>> {
    const { ok, err } = await import("@codeforge/core");
    // Development scaffold: GitHub OAuth not fully implemented
    return err(new Error("GitHub OAuth not configured in development mode. Use email auth with dev-*@test.codeforge"));
  }

  async authenticateWithEmail(email: string, password: string): Promise<Result<AuthResult, Error>> {
    const { ok, err } = await import("@codeforge/core");
    
    // In development, accept any password for test accounts
    const account = this.accounts.get(email);
    if (!account) {
      return ok({
        success: false,
        error: "account_not_found",
        message: `No account found for ${email}`,
      });
    }

    // Create a fake password check for development
    if (password.length < 1) {
      return ok({
        success: false,
        error: "invalid_credentials",
        message: "Invalid password",
      });
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours

    const session: AuthSession = {
      id: `session-${crypto.randomUUID()}` as AuthSessionId,
      accountId: account.id,
      userId: `user-${account.id.split("-")[1]}` as UserId,
      method: "email_password",
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      lastActivityAt: now.toISOString(),
      isActive: true,
    };

    const token: AuthToken = {
      id: `token-${crypto.randomUUID()}`,
      sessionId: session.id,
      tokenType: "access",
      value: `dev-token-${crypto.randomUUID()}`,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      revoked: false,
    };

    this.sessions.set(session.id, session);
    this.tokens.set(token.value, token);

    return ok({
      success: true,
      account,
      session,
      token,
    });
  }

  async validateSession(sessionId: AuthSessionId): Promise<Result<AuthSession, Error>> {
    const { ok, err } = await import("@codeforge/core");
    const session = this.sessions.get(sessionId);
    if (!session) {
      return err(new Error("Session not found"));
    }
    if (!session.isActive) {
      return err(new Error("Session is inactive"));
    }
    if (new Date(session.expiresAt) < new Date()) {
      return err(new Error("Session expired"));
    }
    return ok(session);
  }

  async refreshToken(refreshToken: string): Promise<Result<AuthToken, Error>> {
    const { ok, err } = await import("@codeforge/core");
    const existingToken = this.tokens.get(refreshToken);
    if (!existingToken) {
      return err(new Error("Invalid refresh token"));
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const newToken: AuthToken = {
      id: `token-${crypto.randomUUID()}`,
      sessionId: existingToken.sessionId,
      tokenType: "access",
      value: `dev-token-${crypto.randomUUID()}`,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      revoked: false,
    };

    this.tokens.set(newToken.value, newToken);
    return ok(newToken);
  }

  async logout(sessionId: AuthSessionId): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.isActive = false;
      this.sessions.set(sessionId, session);
    }
  }

  async getAccount(accountId: AccountId): Promise<Account | undefined> {
    for (const account of this.accounts.values()) {
      if (account.id === accountId) {
        return account;
      }
    }
    return undefined;
  }

  async getPlan(accountId: AccountId): Promise<PlanType> {
    const account = await this.getAccount(accountId);
    return account?.plan ?? "free";
  }

  async healthCheck(): Promise<{ healthy: boolean; latencyMs: number }> {
    return { healthy: true, latencyMs: 1 };
  }
}

/**
 * Create development auth provider for testing.
 */
export function createDevelopmentAuthProvider(): AuthProvider {
  return new DevelopmentAuthProvider();
}
