import type {
  ICloudDatabase,
  UserRecord,
  DeviceSessionRecord,
  SubscriptionRecord,
  EntitlementRecord,
  AccountSettingsRecord,
} from "@codeforge/cloud-db";
import { generatePkcePair, generateState, verifyPkce } from "./pkce.js";
import { normalizeDesktopLoopbackRedirectUri, buildCloudGitHubCallbackUrl } from "./redirect-uri.js";
import { signAccessToken, verifyAccessToken, generateRefreshToken, hashRefreshToken, type AccessTokenPayload } from "./jwt.js";
import { generateDesktopAuthCode, hashDesktopAuthCode } from "./desktop-auth-code.js";
import { buildGitHubAuthUrl, exchangeGitHubCode, fetchGitHubUserProfile } from "./github-oauth.js";

/**
 * THE CANONICAL CODEFORGE CLOUD OAUTH FLOW (server-brokered, confidential client).
 *
 *   1. Desktop generates its OWN PKCE pair and opens an ephemeral loopback listener on
 *      `http://127.0.0.1:<port>/auth/callback`.
 *   2. Desktop → Cloud `POST /v1/auth/start` { redirectUri, codeChallenge, deviceName }.
 *      The Cloud validates the loopback redirect URI, generates a SECOND, server-owned PKCE pair for
 *      the GitHub leg, persists an OAuth transaction, and returns the GitHub authorize URL. The
 *      desktop never receives the GitHub verifier, and the Cloud never receives the desktop verifier.
 *   3. Browser → GitHub → Cloud `GET /v1/auth/github/callback?code&state`. This is the ONLY
 *      `redirect_uri` ever sent to GitHub and the only URL registered in the GitHub OAuth App: one
 *      fixed public HTTPS URL. (GitHub matches registered callbacks by scheme + host + port, so an
 *      ephemeral loopback port fundamentally cannot be registered — which is why the loopback is not
 *      the authorization-server callback.)
 *   4. The Cloud consumes the transaction (single-use), exchanges the code using the server-held
 *      client secret + the server-owned verifier, provisions the account, then mints a single-use
 *      desktop authorization code and 302s to the *validated* loopback URI with that code.
 *   5. Desktop → Cloud `POST /v1/auth/exchange` { code, codeVerifier, redirectUri }. The Cloud
 *      verifies the desktop PKCE binding, consumes the code atomically, and only then mints tokens.
 *
 * Security consequences, stated as invariants the tests enforce:
 *   * the GitHub client secret exists only on the server;
 *   * no reusable session credential is ever placed in a URL — only a 120-second single-use code;
 *   * the redirect destination comes from a server-side record, never from callback request input,
 *     so there is no attacker-controlled redirect target at any step.
 */
export interface AuthServiceConfig {
  db: ICloudDatabase;
  jwtSecret: string;
  gitHubClientId: string;
  gitHubClientSecret?: string;
  /**
   * The deployment's public base URL. Required to run the server-brokered flow, because the GitHub
   * `redirect_uri` is derived from it. When absent (local unit tests), OAuth start fails closed.
   */
  publicUrl?: string;
  /** Allow a plain-http public URL. Only ever true for loopback development. */
  allowInsecurePublicUrl?: boolean;
  accessTokenExpiresInSeconds?: number;
  refreshTokenExpiresInSeconds?: number;
  /** Lifetime of the single-use desktop authorization code. Deliberately short. */
  desktopAuthCodeExpiresInSeconds?: number;
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

export interface StartOAuthResult {
  /** Opaque server-side correlation id for this attempt. Not a credential. */
  state: string;
  /** The GitHub authorize URL the desktop should open in the system browser. */
  authUrl: string;
  /** The Cloud callback that must be registered in the GitHub OAuth App. Echoed for operator tooling. */
  cloudCallbackUrl: string;
}

export interface GitHubCallbackResult {
  /** Fully-validated desktop loopback URL, with the single-use code appended. */
  redirectTo: string;
  userId: string;
  isNewUser: boolean;
}

export interface DesktopSessionResult {
  user: UserRecord;
  session: DeviceSessionRecord;
  accessToken: string;
  refreshToken: string;
  isNewUser: boolean;
}

export class AuthService {
  private readonly db: ICloudDatabase;
  private readonly jwtSecret: string;
  private readonly gitHubClientId: string;
  private readonly gitHubClientSecret?: string;
  private readonly publicUrl?: string;
  private readonly allowInsecurePublicUrl: boolean;
  private readonly accessTokenExpiresInSeconds: number;
  private readonly refreshTokenExpiresInSeconds: number;
  private readonly desktopAuthCodeExpiresInSeconds: number;
  private readonly defaultFetchFn: typeof fetch;

  constructor(config: AuthServiceConfig) {
    this.db = config.db;
    this.jwtSecret = config.jwtSecret;
    this.gitHubClientId = config.gitHubClientId;
    this.gitHubClientSecret = config.gitHubClientSecret;
    this.publicUrl = config.publicUrl;
    this.allowInsecurePublicUrl = config.allowInsecurePublicUrl ?? false;
    this.accessTokenExpiresInSeconds = config.accessTokenExpiresInSeconds ?? 3600;
    this.refreshTokenExpiresInSeconds = config.refreshTokenExpiresInSeconds ?? 30 * 24 * 60 * 60;
    this.desktopAuthCodeExpiresInSeconds = config.desktopAuthCodeExpiresInSeconds ?? 120;
    this.defaultFetchFn = config.fetchFn ?? fetch;
  }

  /**
   * The URL an operator must register as the GitHub OAuth App "Authorization callback URL".
   * Derived purely from server configuration — never from request input.
   */
  getCloudGitHubCallbackUrl(): string {
    if (!this.publicUrl) {
      throw new Error("CODEFORGE_PUBLIC_URL is not configured — the CodeForge Cloud OAuth callback URL cannot be derived");
    }
    return buildCloudGitHubCallbackUrl(this.publicUrl, { requireHttps: !this.allowInsecurePublicUrl });
  }

  /** Step 2: begin an authorization attempt for one desktop process. */
  async startOAuth(options: { redirectUri: string; codeChallenge: string; deviceName?: string }): Promise<StartOAuthResult> {
    const redirectUri = normalizeDesktopLoopbackRedirectUri(options.redirectUri);
    const cloudCallbackUrl = this.getCloudGitHubCallbackUrl();

    // The desktop's challenge binds the eventual code redemption to the process that started this
    // attempt. It must look like a real S256 challenge — an empty or trivially short value would
    // make the binding meaningless.
    const desktopCodeChallenge = options.codeChallenge;
    if (typeof desktopCodeChallenge !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(desktopCodeChallenge)) {
      throw new Error("A base64url S256 PKCE code_challenge (43-128 chars) is required to start CodeForge Cloud authentication");
    }

    // Server-owned PKCE pair for the GitHub leg. The verifier is persisted server-side and never
    // returned to any client.
    const gitHubPkce = generatePkcePair();
    const state = generateState();

    await this.db.createOAuthTransaction({
      state,
      codeChallenge: desktopCodeChallenge,
      gitHubCodeVerifier: gitHubPkce.codeVerifier,
      redirectUri,
      deviceName: options.deviceName,
      expiresInSeconds: 600, // 10 minutes
    });

    const authUrl = buildGitHubAuthUrl({
      clientId: this.gitHubClientId,
      redirectUri: cloudCallbackUrl,
      state,
      codeChallenge: gitHubPkce.codeChallenge,
    });

    return { state, authUrl, cloudCallbackUrl };
  }

  /**
   * Step 4: handle GitHub's redirect to the Cloud callback. Performs the confidential-client token
   * exchange, provisions the account, and returns the (server-derived) desktop redirect target with a
   * single-use code appended.
   *
   * Note what is NOT read from the request: the redirect destination. It comes from the persisted
   * transaction, so no callback parameter can steer the browser anywhere else.
   */
  async handleGitHubCallback(options: {
    code: string;
    state: string;
    fetchFn?: typeof fetch;
  }): Promise<GitHubCallbackResult> {
    const fetchFn = options.fetchFn ?? this.defaultFetchFn;
    if (!options.code || !options.state) {
      throw new Error("GitHub callback is missing the authorization code or state");
    }

    // Single-use consumption of the server-authoritative transaction. A replayed callback loses here.
    const tx = await this.db.consumeOAuthTransaction(options.state);
    if (!tx.gitHubCodeVerifier) {
      throw new Error("OAuth transaction is missing its server-owned PKCE verifier");
    }

    // Re-validate the stored redirect URI. Defense in depth: even a tampered database row cannot
    // turn this endpoint into an open redirector.
    const redirectUri = normalizeDesktopLoopbackRedirectUri(tx.redirectUri);

    const exchange = await exchangeGitHubCode({
      clientId: this.gitHubClientId,
      clientSecret: this.gitHubClientSecret,
      code: options.code,
      redirectUri: this.getCloudGitHubCallbackUrl(),
      codeVerifier: tx.gitHubCodeVerifier,
      fetchFn,
    });

    const profile = await fetchGitHubUserProfile(exchange.accessToken, fetchFn);
    const { user, isNewUser } = await this.provisionUser(profile);

    // Mint the single-use handoff code. Only its hash is stored.
    const desktopCode = generateDesktopAuthCode();
    await this.db.createDesktopAuthCode({
      codeHash: hashDesktopAuthCode(desktopCode),
      userId: user.id,
      codeChallenge: tx.codeChallenge,
      redirectUri,
      deviceName: tx.deviceName,
      isNewUser,
      expiresInSeconds: this.desktopAuthCodeExpiresInSeconds,
    });

    const target = new URL(redirectUri);
    target.searchParams.set("code", desktopCode);
    target.searchParams.set("state", options.state);

    return { redirectTo: target.toString(), userId: user.id, isNewUser };
  }

  /**
   * Step 5: redeem a single-use desktop authorization code for a real session. This is the only place
   * tokens are minted, and it requires proof of possession of the desktop PKCE verifier.
   */
  async exchangeDesktopAuthCode(options: {
    code: string;
    codeVerifier: string;
    redirectUri?: string;
    deviceName?: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<DesktopSessionResult> {
    if (!options.code || !options.codeVerifier) {
      throw new Error("Desktop authorization code and PKCE code verifier are both required");
    }

    // Atomic single-use consumption BEFORE any other validation result is observable, so a replay
    // races for the same row and exactly one caller can win.
    const record = await this.db.consumeDesktopAuthCode(hashDesktopAuthCode(options.code));

    if (options.redirectUri && record.redirectUri !== normalizeDesktopLoopbackRedirectUri(options.redirectUri)) {
      throw new Error("Desktop authorization code redirect URI mismatch");
    }
    if (!verifyPkce(options.codeVerifier, record.codeChallenge)) {
      throw new Error("PKCE code verifier verification failed");
    }

    const user = await this.db.getUserById(record.userId);
    if (!user) {
      throw new Error("User not found for desktop authorization code");
    }

    const session = await this.mintSession(user, {
      deviceName: options.deviceName ?? record.deviceName,
      ipAddress: options.ipAddress,
      userAgent: options.userAgent,
    });

    return { user, ...session, isNewUser: record.isNewUser };
  }

  /** Create (or load) the CodeForge account backing a GitHub identity, with idempotent Free provisioning. */
  private async provisionUser(profile: { id: number; login: string; name?: string; avatar_url?: string; email?: string }): Promise<{ user: UserRecord; isNewUser: boolean }> {
    const primaryIdentity = `github:${profile.id}`;
    let user = await this.db.getUserByPrimaryIdentity(primaryIdentity);
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      user = await this.db.createUser({
        displayName: profile.name || profile.login,
        avatarUrl: profile.avatar_url,
        primaryIdentity,
      });
      await this.db.createIdentity({
        userId: user.id,
        provider: "github",
        providerUserId: String(profile.id),
        providerEmail: profile.email,
      });

      // Default Free Tier Provisioning (IDEMPOTENT)
      await this.db.setEntitlement(user.id, "HOSTED_FREE", "true");
      await this.db.setEntitlement(user.id, "DIRECT_PROVIDERS", "true");
      await this.db.setEntitlement(user.id, "COMMUNITY_MODELS", "true");
      await this.db.upsertSubscription({
        userId: user.id,
        planId: "free",
        status: "active",
        currentPeriodStart: new Date().toISOString(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
        cancelAtPeriodEnd: false,
      });
    }

    // Monthly usage period & allowance (creates on first login, renews when the period rolls over).
    await this.db.getOrCreateCurrentUsagePeriod(user.id, 500_000);
    return { user, isNewUser };
  }

  private async mintSession(
    user: UserRecord,
    options: { deviceName?: string; ipAddress?: string; userAgent?: string },
  ): Promise<{ session: DeviceSessionRecord; accessToken: string; refreshToken: string }> {
    const refreshToken = generateRefreshToken();
    const session = await this.db.createDeviceSession({
      userId: user.id,
      deviceName: options.deviceName ?? "CodeForge Desktop",
      refreshTokenHash: hashRefreshToken(refreshToken),
      ipAddress: options.ipAddress,
      userAgent: options.userAgent,
      expiresInSeconds: this.refreshTokenExpiresInSeconds,
    });

    const subscription = await this.db.getSubscriptionByUserId(user.id);
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

    return { session, accessToken, refreshToken };
  }

  async refreshSession(options: {
    refreshToken: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<{ user: UserRecord; session: DeviceSessionRecord; accessToken: string; refreshToken: string }> {
    const oldHash = hashRefreshToken(options.refreshToken);
    const newRefreshToken = generateRefreshToken();
    const newHash = hashRefreshToken(newRefreshToken);

    const { user, session: newSession } = await this.db.rotateDeviceSession({
      oldTokenHash: oldHash,
      newRefreshTokenHash: newHash,
      ipAddress: options.ipAddress,
      userAgent: options.userAgent,
      expiresInSeconds: this.refreshTokenExpiresInSeconds,
    });

    // Check if new monthly period has begun
    await this.db.getOrCreateCurrentUsagePeriod(user.id, 500_000);

    const subscription = await this.db.getSubscriptionByUserId(user.id);
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

  /**
   * Sign one device out. The revocation is recorded as `logout`, which matters: a later refresh with
   * this device's stale token is then treated as a dead token rather than as refresh-token theft, so
   * signing out on one machine does not sign the account out on every other machine.
   */
  async logout(refreshToken: string): Promise<void> {
    const tokenHash = hashRefreshToken(refreshToken);
    const session = await this.db.getDeviceSessionByTokenHash(tokenHash);
    if (session) {
      await this.db.revokeDeviceSession(session.id, "logout");
    }
  }

  verifyToken(accessToken: string): AccessTokenPayload {
    return verifyAccessToken(accessToken, this.jwtSecret);
  }

  async getAccount(userId: string): Promise<AuthAccountSnapshot> {
    const user = await this.db.getUserById(userId);
    if (!user) {
      throw new Error("User not found");
    }

    // Check usage period to ensure recurring allowance is up-to-date
    await this.db.getOrCreateCurrentUsagePeriod(userId, 500_000);

    const subscription = await this.db.getSubscriptionByUserId(userId);
    const planId = subscription?.planId ?? "free";
    const plan = await this.db.getPlan(planId);
    const entitlements = await this.db.getEntitlements(userId);
    const creditBalance = await this.db.getCreditBalance(userId);
    const settings = await this.db.getAccountSettings(userId);

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
