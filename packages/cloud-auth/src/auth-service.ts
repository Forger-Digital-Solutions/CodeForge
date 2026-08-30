import { CloudDatabase, type UserRecord, type DeviceSessionRecord, type SubscriptionRecord, type EntitlementRecord, type AccountSettingsRecord } from "@codeforge/cloud-db";
import { generatePkcePair, generateState, verifyPkce } from "./pkce.js";
import { signAccessToken, verifyAccessToken, generateRefreshToken, hashRefreshToken, type AccessTokenPayload } from "./jwt.js";
import { buildGitHubAuthUrl, exchangeGitHubCode, fetchGitHubUserProfile, type GitHubUserProfile } from "./github-oauth.js";

export interface AuthServiceConfig {
  db: CloudDatabase;
  jwtSecret: string;
  gitHubClientId: string;
  gitHubClientSecret?: string;
  accessTokenExpiresInSeconds?: number;
  refreshTokenExpiresInSeconds?: number;
}

export interface AuthAccountSnapshot {
  user: UserRecord;
  planId: string;
  planName: string;
  subscription?: SubscriptionRecord;
  entitlements: EntitlementRecord[];
  creditBalance: number;
  settings: AccountSettingsRecord;
}

export class AuthService {
  private readonly db: CloudDatabase;
  private readonly jwtSecret: string;
  private readonly gitHubClientId: string;
  private readonly gitHubClientSecret?: string;
  private readonly accessTokenExpiresInSeconds: number;
  private readonly refreshTokenExpiresInSeconds: number;

  constructor(config: AuthServiceConfig) {
    this.db = config.db;
    this.jwtSecret = config.jwtSecret;
    this.gitHubClientId = config.gitHubClientId;
    this.gitHubClientSecret = config.gitHubClientSecret;
    this.accessTokenExpiresInSeconds = config.accessTokenExpiresInSeconds ?? 3600;
    this.refreshTokenExpiresInSeconds = config.refreshTokenExpiresInSeconds ?? 30 * 24 * 60 * 60;
  }

  startOAuth(options: { redirectUri: string; deviceName?: string }): { state: string; codeVerifier: string; codeChallenge: string; authUrl: string } {
    const pkce = generatePkcePair();
    const state = generateState();
    const authUrl = buildGitHubAuthUrl({
      clientId: this.gitHubClientId,
      redirectUri: options.redirectUri,
      state,
      codeChallenge: pkce.codeChallenge,
    });
    return {
      state,
      codeVerifier: pkce.codeVerifier,
      codeChallenge: pkce.codeChallenge,
      authUrl,
    };
  }

  async handleOAuthCallback(options: {
    code: string;
    state: string;
    expectedState: string;
    codeVerifier: string;
    redirectUri?: string;
    deviceName?: string;
    ipAddress?: string;
    userAgent?: string;
    fetchFn?: typeof fetch;
    mockProfile?: GitHubUserProfile;
  }): Promise<{ user: UserRecord; session: DeviceSessionRecord; accessToken: string; refreshToken: string; isNewUser: boolean }> {
    if (options.state !== options.expectedState) {
      throw new Error("OAuth state mismatch (CSRF protection)");
    }

    let profile: GitHubUserProfile;
    if (options.mockProfile) {
      profile = options.mockProfile;
    } else {
      const exchange = await exchangeGitHubCode({
        clientId: this.gitHubClientId,
        clientSecret: this.gitHubClientSecret,
        code: options.code,
        redirectUri: options.redirectUri,
        codeVerifier: options.codeVerifier,
        fetchFn: options.fetchFn,
      });
      profile = await fetchGitHubUserProfile(exchange.accessToken, options.fetchFn);
    }

    const primaryIdentity = `github:${profile.id}`;
    let user = this.db.getUserByPrimaryIdentity(primaryIdentity);
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      user = this.db.createUser({
        displayName: profile.name || profile.login,
        avatarUrl: profile.avatar_url,
        primaryIdentity,
      });
      this.db.createIdentity({
        userId: user.id,
        provider: "github",
        providerUserId: String(profile.id),
        providerEmail: profile.email,
      });

      // Default Free Tier Provisioning (IDEMPOTENT)
      this.db.setEntitlement(user.id, "HOSTED_FREE", "true");
      this.db.setEntitlement(user.id, "DIRECT_PROVIDERS", "true");
      this.db.upsertSubscription({
        userId: user.id,
        planId: "free",
        status: "active",
        currentPeriodStart: new Date().toISOString(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
        cancelAtPeriodEnd: false,
      });
      this.db.appendLedgerEvent({
        userId: user.id,
        amount: 500_000,
        eventType: "FREE_ALLOWANCE_GRANTED",
        description: "Initial CodeForge Free Tier allowance",
      });
    }

    // Create device session with rotating refresh token
    const refreshToken = generateRefreshToken();
    const refreshTokenHash = hashRefreshToken(refreshToken);
    const session = this.db.createDeviceSession({
      userId: user.id,
      deviceName: options.deviceName ?? "CodeForge Desktop",
      refreshTokenHash,
      ipAddress: options.ipAddress,
      userAgent: options.userAgent,
      expiresInSeconds: this.refreshTokenExpiresInSeconds,
    });

    const subscription = this.db.getSubscriptionByUserId(user.id);
    const accessToken = signAccessToken(
      {
        sub: user.id,
        sid: session.id,
        planId: subscription?.planId ?? "free",
        displayName: user.displayName,
      },
      this.jwtSecret,
      this.accessTokenExpiresInSeconds,
    );

    return {
      user,
      session,
      accessToken,
      refreshToken,
      isNewUser,
    };
  }

  refreshSession(options: { refreshToken: string; ipAddress?: string; userAgent?: string }): { user: UserRecord; session: DeviceSessionRecord; accessToken: string; refreshToken: string } {
    const oldHash = hashRefreshToken(options.refreshToken);
    const session = this.db.getDeviceSessionByTokenHash(oldHash);

    if (!session) {
      throw new Error("Invalid refresh token");
    }
    if (session.revokedAt) {
      throw new Error("Device session has been revoked");
    }
    if (new Date(session.expiresAt).getTime() < Date.now()) {
      throw new Error("Device session has expired");
    }

    const user = this.db.getUserById(session.userId);
    if (!user) {
      throw new Error("User associated with session not found");
    }

    // Rotate refresh token
    const newRefreshToken = generateRefreshToken();
    const newHash = hashRefreshToken(newRefreshToken);

    this.db.revokeDeviceSession(session.id);
    const newSession = this.db.createDeviceSession({
      userId: user.id,
      deviceName: session.deviceName,
      refreshTokenHash: newHash,
      ipAddress: options.ipAddress ?? session.ipAddress,
      userAgent: options.userAgent ?? session.userAgent,
      expiresInSeconds: this.refreshTokenExpiresInSeconds,
    });

    const subscription = this.db.getSubscriptionByUserId(user.id);
    const accessToken = signAccessToken(
      {
        sub: user.id,
        sid: newSession.id,
        planId: subscription?.planId ?? "free",
        displayName: user.displayName,
      },
      this.jwtSecret,
      this.accessTokenExpiresInSeconds,
    );

    return {
      user,
      session: newSession,
      accessToken,
      refreshToken: newRefreshToken,
    };
  }

  logout(refreshToken: string): void {
    const tokenHash = hashRefreshToken(refreshToken);
    const session = this.db.getDeviceSessionByTokenHash(tokenHash);
    if (session) {
      this.db.revokeDeviceSession(session.id);
    }
  }

  verifyToken(accessToken: string): AccessTokenPayload {
    return verifyAccessToken(accessToken, this.jwtSecret);
  }

  getAccount(userId: string): AuthAccountSnapshot {
    const user = this.db.getUserById(userId);
    if (!user) {
      throw new Error("User not found");
    }
    const subscription = this.db.getSubscriptionByUserId(userId);
    const planId = subscription?.planId ?? "free";
    const plan = this.db.getPlan(planId);
    const entitlements = this.db.getEntitlements(userId);
    const creditBalance = this.db.getCreditBalance(userId);
    const settings = this.db.getAccountSettings(userId);

    return {
      user,
      planId,
      planName: plan?.name ?? "CodeForge Free",
      subscription,
      entitlements,
      creditBalance,
      settings,
    };
  }
}
