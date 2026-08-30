import type {
  ICloudDatabase,
  UserRecord,
  DeviceSessionRecord,
  SubscriptionRecord,
  EntitlementRecord,
  AccountSettingsRecord,
} from "@codeforge/cloud-db";
import { generatePkcePair, generateState, verifyPkce } from "./pkce.js";
import { signAccessToken, verifyAccessToken, generateRefreshToken, hashRefreshToken, type AccessTokenPayload } from "./jwt.js";
import { buildGitHubAuthUrl, exchangeGitHubCode, fetchGitHubUserProfile } from "./github-oauth.js";

export interface AuthServiceConfig {
  db: ICloudDatabase;
  jwtSecret: string;
  gitHubClientId: string;
  gitHubClientSecret?: string;
  accessTokenExpiresInSeconds?: number;
  refreshTokenExpiresInSeconds?: number;
  fetchFn?: typeof fetch;
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
  private readonly db: ICloudDatabase;
  private readonly jwtSecret: string;
  private readonly gitHubClientId: string;
  private readonly gitHubClientSecret?: string;
  private readonly accessTokenExpiresInSeconds: number;
  private readonly refreshTokenExpiresInSeconds: number;
  private readonly defaultFetchFn: typeof fetch;

  constructor(config: AuthServiceConfig) {
    this.db = config.db;
    this.jwtSecret = config.jwtSecret;
    this.gitHubClientId = config.gitHubClientId;
    this.gitHubClientSecret = config.gitHubClientSecret;
    this.accessTokenExpiresInSeconds = config.accessTokenExpiresInSeconds ?? 3600;
    this.refreshTokenExpiresInSeconds = config.refreshTokenExpiresInSeconds ?? 30 * 24 * 60 * 60;
    this.defaultFetchFn = config.fetchFn ?? fetch;
  }

  startOAuth(options: { redirectUri: string; deviceName?: string }): { state: string; codeVerifier: string; codeChallenge: string; authUrl: string } {
    const pkce = generatePkcePair();
    const state = generateState();

    // Persist server-authoritative OAuth transaction
    this.db.createOAuthTransaction({
      state,
      codeChallenge: pkce.codeChallenge,
      redirectUri: options.redirectUri,
      deviceName: options.deviceName,
      expiresInSeconds: 600, // 10 minutes
    });

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
    codeVerifier: string;
    redirectUri?: string;
    deviceName?: string;
    ipAddress?: string;
    userAgent?: string;
    fetchFn?: typeof fetch;
  }): Promise<{ user: UserRecord; session: DeviceSessionRecord; accessToken: string; refreshToken: string; isNewUser: boolean }> {
    const fetchFn = options.fetchFn ?? this.defaultFetchFn;

    // 1. Server-side transaction validation & single-use consumption
    const tx = this.db.consumeOAuthTransaction(options.state);

    // 2. Validate redirect URI binding if provided
    if (options.redirectUri && tx.redirectUri !== options.redirectUri) {
      throw new Error(`OAuth redirect URI mismatch: expected ${tx.redirectUri}, received ${options.redirectUri}`);
    }

    // 3. Verify PKCE challenge against codeVerifier
    if (!verifyPkce(options.codeVerifier, tx.codeChallenge)) {
      throw new Error("PKCE code verifier verification failed");
    }

    // 4. Exchange code for GitHub access token & user profile
    const exchange = await exchangeGitHubCode({
      clientId: this.gitHubClientId,
      clientSecret: this.gitHubClientSecret,
      code: options.code,
      redirectUri: tx.redirectUri,
      codeVerifier: options.codeVerifier,
      fetchFn,
    });

    const profile = await fetchGitHubUserProfile(exchange.accessToken, fetchFn);

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
      this.db.setEntitlement(user.id, "COMMUNITY_MODELS", "true");
      this.db.upsertSubscription({
        userId: user.id,
        planId: "free",
        status: "active",
        currentPeriodStart: new Date().toISOString(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
        cancelAtPeriodEnd: false,
      });

      // Initial monthly usage period & allowance
      this.db.getOrCreateCurrentUsagePeriod(user.id, 500_000);
    } else {
      // Existing user login: check if monthly period renewal is due
      this.db.getOrCreateCurrentUsagePeriod(user.id, 500_000);
    }

    // Create device session with rotating refresh token
    const refreshToken = generateRefreshToken();
    const refreshTokenHash = hashRefreshToken(refreshToken);
    const session = this.db.createDeviceSession({
      userId: user.id,
      deviceName: options.deviceName ?? tx.deviceName ?? "CodeForge Desktop",
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

  refreshSession(options: {
    refreshToken: string;
    ipAddress?: string;
    userAgent?: string;
  }): { user: UserRecord; session: DeviceSessionRecord; accessToken: string; refreshToken: string } {
    const oldHash = hashRefreshToken(options.refreshToken);
    const newRefreshToken = generateRefreshToken();
    const newHash = hashRefreshToken(newRefreshToken);

    const { user, session: newSession } = this.db.rotateDeviceSession({
      oldTokenHash: oldHash,
      newRefreshTokenHash: newHash,
      ipAddress: options.ipAddress,
      userAgent: options.userAgent,
      expiresInSeconds: this.refreshTokenExpiresInSeconds,
    });

    // Check if new monthly period has begun
    this.db.getOrCreateCurrentUsagePeriod(user.id, 500_000);

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

    // Check usage period to ensure recurring allowance is up-to-date
    this.db.getOrCreateCurrentUsagePeriod(userId, 500_000);

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
