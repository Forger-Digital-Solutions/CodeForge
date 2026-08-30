import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CloudDatabase } from "@codeforge/cloud-db";
import { AuthService, generatePkcePair, signAccessToken, verifyAccessToken } from "../src/index.js";

describe("AuthService", () => {
  let db: CloudDatabase;
  let auth: AuthService;
  const jwtSecret = "super-secret-jwt-key-32-chars-long";

  const createMockGitHubFetch = (profile = { id: 12345, login: "alice", name: "Alice", avatar_url: "https://example.com/alice.png", email: "alice@example.com" }) => {
    return async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes("login/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "gho_mock_access_token_123", token_type: "bearer", scope: "read:user user:email" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("api.github.com/user")) {
        return new Response(JSON.stringify(profile), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    };
  };

  beforeEach(() => {
    db = new CloudDatabase({ dbPath: ":memory:" });
    auth = new AuthService({
      db,
      jwtSecret,
      gitHubClientId: "gh_client_test_id",
      gitHubClientSecret: "gh_client_test_secret",
      fetchFn: createMockGitHubFetch() as typeof fetch,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("completes server-authoritative OAuth PKCE exchange and grants initial Free tier allowance", async () => {
    const start = await auth.startOAuth({ redirectUri: "http://127.0.0.1:8765/auth/callback", deviceName: "Test Device" });
    expect(start.state).toBeDefined();
    expect(start.codeVerifier).toBeDefined();

    const result = await auth.handleOAuthCallback({
      code: "valid_github_code",
      state: start.state,
      codeVerifier: start.codeVerifier,
      redirectUri: "http://127.0.0.1:8765/auth/callback",
    });

    expect(result.isNewUser).toBe(true);
    expect(result.user.displayName).toBe("Alice");
    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();

    const account = await auth.getAccount(result.user.id);
    expect(account.planId).toBe("free");
    expect(account.creditBalance).toBe(500_000);
    expect(account.entitlements.some((e) => e.featureKey === "HOSTED_FREE")).toBe(true);
  });

  it("only permits the CodeForge desktop loopback callback shape", async () => {
    await expect(auth.startOAuth({ redirectUri: "https://attacker.example/auth/callback" })).rejects.toThrow(/127\.0\.0\.1/);
    await expect(auth.startOAuth({ redirectUri: "http://localhost:8765/auth/callback" })).rejects.toThrow(/127\.0\.0\.1/);
    await expect(auth.startOAuth({ redirectUri: "http://127.0.0.1:8765/other" })).rejects.toThrow(/127\.0\.0\.1/);

    const start = await auth.startOAuth({ redirectUri: "http://127.0.0.1:8765/auth/callback" });
    await expect(
      auth.handleOAuthCallback({
        code: "some_code",
        state: start.state,
        codeVerifier: start.codeVerifier,
        redirectUri: "https://attacker.example/auth/callback",
      }),
    ).rejects.toThrow(/127\.0\.0\.1/);
  });

  it("rejects unknown, tampered, or already consumed OAuth transactions", async () => {
    const start = await auth.startOAuth({ redirectUri: "http://127.0.0.1:8765/auth/callback" });

    // Wrong state
    await expect(
      auth.handleOAuthCallback({
        code: "some_code",
        state: "wrong_state",
        codeVerifier: start.codeVerifier,
      }),
    ).rejects.toThrow(/not found/);

    // Wrong PKCE code verifier
    await expect(
      auth.handleOAuthCallback({
        code: "some_code",
        state: start.state,
        codeVerifier: "invalid_verifier_that_does_not_match_challenge",
      }),
    ).rejects.toThrow(/PKCE/);

    // First valid consumption succeeds
    const start2 = await auth.startOAuth({ redirectUri: "http://127.0.0.1:8765/auth/callback" });
    await auth.handleOAuthCallback({
      code: "some_code",
      state: start2.state,
      codeVerifier: start2.codeVerifier,
    });

    // Replay of same state fails (single-use consumption)
    await expect(
      auth.handleOAuthCallback({
        code: "some_code",
        state: start2.state,
        codeVerifier: start2.codeVerifier,
      }),
    ).rejects.toThrow(/already consumed/);
  });

  it("rotates refresh token and detects token reuse", async () => {
    const start = await auth.startOAuth({ redirectUri: "http://127.0.0.1:8765/auth/callback" });
    const initial = await auth.handleOAuthCallback({
      code: "code_1",
      state: start.state,
      codeVerifier: start.codeVerifier,
    });

    // Refresh rotation
    const rotated = await auth.refreshSession({ refreshToken: initial.refreshToken });
    expect(rotated.refreshToken).not.toBe(initial.refreshToken);

    // Validating new access token
    const payload = auth.verifyToken(rotated.accessToken);
    expect(payload.sub).toBe(initial.user.id);

    // Replay of old refresh token fails and detects breach
    await expect(async () => {
      await auth.refreshSession({ refreshToken: initial.refreshToken });
    }).rejects.toThrow(/replay detected/);
  });

  it("handles user logout by revoking device session", async () => {
    const start = await auth.startOAuth({ redirectUri: "http://127.0.0.1:8765/auth/callback" });
    const authResult = await auth.handleOAuthCallback({
      code: "code_logout",
      state: start.state,
      codeVerifier: start.codeVerifier,
    });

    await auth.logout(authResult.refreshToken);

    await expect(async () => {
      await auth.refreshSession({ refreshToken: authResult.refreshToken });
    }).rejects.toThrow(/revoked/);
  });

  it("verifies and rejects tampered or expired JWT access tokens", () => {
    const token = signAccessToken(
      { sub: "user-123", sid: "sess-456", planId: "free", displayName: "User" },
      jwtSecret,
      3600,
    );

    const verified = verifyAccessToken(token, jwtSecret);
    expect(verified.sub).toBe("user-123");
    expect(verified.sid).toBe("sess-456");

    // Tampered token
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.tamperedSignature`;
    expect(() => verifyAccessToken(tampered, jwtSecret)).toThrow(/Invalid JWT signature/);

    // Expired token
    const expiredToken = signAccessToken(
      { sub: "user-123", sid: "sess-456" },
      jwtSecret,
      -10, // expired 10s ago
    );
    expect(() => verifyAccessToken(expiredToken, jwtSecret)).toThrow(/expired/);
  });
});
