import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CloudDatabase } from "@codeforge/cloud-db";
import {
  generatePkcePair,
  verifyPkce,
  signAccessToken,
  verifyAccessToken,
  AuthService,
} from "../src/index.js";

describe("Cloud Auth System", () => {
  let db: CloudDatabase;
  let auth: AuthService;
  const jwtSecret = "super-secret-jwt-key-for-testing-123456";

  beforeEach(() => {
    db = new CloudDatabase({ dbPath: ":memory:" });
    auth = new AuthService({
      db,
      jwtSecret,
      gitHubClientId: "gh_client_123",
      gitHubClientSecret: "gh_secret_456",
    });
  });

  afterEach(() => {
    db.close();
  });

  it("generates and verifies PKCE challenges", () => {
    const pkce = generatePkcePair();
    expect(pkce.method).toBe("S256");
    expect(pkce.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(pkce.codeChallenge.length).toBeGreaterThan(0);

    expect(verifyPkce(pkce.codeVerifier, pkce.codeChallenge)).toBe(true);
    expect(verifyPkce("tampered_verifier", pkce.codeChallenge)).toBe(false);
  });

  it("signs and verifies JWT access tokens and rejects expired or tampered tokens", () => {
    const token = signAccessToken(
      { sub: "user-123", sid: "session-456", planId: "free", displayName: "Alice" },
      jwtSecret,
      3600,
    );
    expect(token).toBeDefined();

    const payload = verifyAccessToken(token, jwtSecret);
    expect(payload.sub).toBe("user-123");
    expect(payload.sid).toBe("session-456");
    expect(payload.displayName).toBe("Alice");

    // Rejects tampered token
    const tampered = token.slice(0, -5) + "abcde";
    expect(() => verifyAccessToken(tampered, jwtSecret)).toThrow(/signature/i);

    // Rejects expired token
    const expiredToken = signAccessToken(
      { sub: "user-123", sid: "session-456" },
      jwtSecret,
      -10, // expired 10 seconds ago
    );
    expect(() => verifyAccessToken(expiredToken, jwtSecret)).toThrow(/expired/i);
  });

  it("executes full GitHub OAuth callback, provisions Free tier idempotently, and issues tokens", async () => {
    const oauthStart = auth.startOAuth({ redirectUri: "http://127.0.0.1:8765/auth/callback" });
    expect(oauthStart.authUrl).toContain("client_id=gh_client_123");
    expect(oauthStart.authUrl).toContain(`code_challenge=${oauthStart.codeChallenge}`);

    // Simulate successful OAuth callback for a new user
    const loginResult = await auth.handleOAuthCallback({
      code: "valid_code_1",
      state: oauthStart.state,
      expectedState: oauthStart.state,
      codeVerifier: oauthStart.codeVerifier,
      mockProfile: {
        id: 98765,
        login: "dev_alice",
        name: "Alice Developer",
        avatar_url: "https://github.com/alice.png",
        email: "alice@example.com",
      },
    });

    expect(loginResult.isNewUser).toBe(true);
    expect(loginResult.user.displayName).toBe("Alice Developer");
    expect(loginResult.accessToken).toBeDefined();
    expect(loginResult.refreshToken).toBeDefined();

    // Verify default Free tier entitlement & initial credit balance
    const account = auth.getAccount(loginResult.user.id);
    expect(account.planId).toBe("free");
    expect(account.creditBalance).toBe(500_000);
    expect(account.entitlements.some((e) => e.featureKey === "HOSTED_FREE")).toBe(true);

    // Second login with same GitHub profile should be idempotent (NO duplicate credits)
    const secondLogin = await auth.handleOAuthCallback({
      code: "valid_code_2",
      state: oauthStart.state,
      expectedState: oauthStart.state,
      codeVerifier: oauthStart.codeVerifier,
      mockProfile: {
        id: 98765,
        login: "dev_alice",
        name: "Alice Developer",
      },
    });
    expect(secondLogin.isNewUser).toBe(false);
    expect(secondLogin.user.id).toBe(loginResult.user.id);

    const accountAfterSecondLogin = auth.getAccount(loginResult.user.id);
    expect(accountAfterSecondLogin.creditBalance).toBe(500_000); // strictly unchanged
  });

  it("rotates refresh tokens and handles session revocation on logout", () => {
    const oauthStart = auth.startOAuth({ redirectUri: "http://127.0.0.1:8765/auth/callback" });
    let loginResult!: Awaited<ReturnType<typeof auth.handleOAuthCallback>>;

    // Setup user
    return auth
      .handleOAuthCallback({
        code: "code_1",
        state: oauthStart.state,
        expectedState: oauthStart.state,
        codeVerifier: oauthStart.codeVerifier,
        mockProfile: { id: 112233, login: "bob" },
      })
      .then((res) => {
        loginResult = res;
        // Refresh token
        const refreshResult = auth.refreshSession({ refreshToken: loginResult.refreshToken });
        expect(refreshResult.accessToken).toBeDefined();
        expect(refreshResult.refreshToken).not.toBe(loginResult.refreshToken);

        // Old refresh token is now revoked
        expect(() => auth.refreshSession({ refreshToken: loginResult.refreshToken })).toThrow(/revoked/i);

        // Logout revokes new refresh token
        auth.logout(refreshResult.refreshToken);
        expect(() => auth.refreshSession({ refreshToken: refreshResult.refreshToken })).toThrow(/revoked/i);
      });
  });
});
