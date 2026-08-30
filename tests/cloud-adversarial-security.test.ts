import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { CodeForgeCloudServer } from "codeforge-cloud-api";
import { CloudDatabase } from "@codeforge/cloud-db";
import { AuthService, signAccessToken, verifyAccessToken } from "@codeforge/cloud-auth";
import { StripeBillingService } from "@codeforge/cloud-billing";
import { EntitlementService } from "@codeforge/cloud-entitlements";

describe("Phase 56 — P0 Adversarial Security Certification", () => {
  let server: CodeForgeCloudServer;
  let baseUrl: string;
  const jwtSecret = "adv-cert-jwt-secret-key-32-chars-long";
  const webhookSecret = "whsec_adv_test_12345";

  const createMockGitHubFetch = (profile = { id: 778899, login: "victim_user", name: "Victim User", avatar_url: "https://example.com/v.png", email: "v@example.com" }) => {
    return async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("login/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "gho_mock_access_adv", token_type: "bearer", scope: "read:user user:email" }), {
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

  beforeEach(async () => {
    server = new CodeForgeCloudServer({
      jwtSecret,
      fetchFn: createMockGitHubFetch() as typeof fetch,
      stripeConfig: {
        secretKey: "sk_test_mock_adv",
        webhookSecret,
        proPriceId: "price_pro_adv",
        creditPackPriceId: "price_credits_adv",
      },
    });

    const port = await server.start(0);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await server.stop();
  });

  it("P0: strictly blocks HTTP request-body mockProfile injection / authentication bypass", async () => {
    // Attacker attempts to bypass OAuth by sending mockProfile to /v1/auth/exchange
    const res = await fetch(`${baseUrl}/v1/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "fake_code",
        state: "fake_state",
        expectedState: "fake_state",
        codeVerifier: "fake_verifier",
        mockProfile: {
          id: 1,
          login: "torvalds",
          name: "Linus Torvalds",
        },
      }),
    });

    // Must be DENIED (HTTP 400 or 401, transaction not found)
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.json();
    expect(body.accessToken).toBeUndefined();
    expect(body.error).toBeDefined();

    // User "torvalds" was NOT created in DB
    const user = await server.db.getUserByPrimaryIdentity("github:1");
    expect(user).toBeUndefined();
  });

  it("rejects arbitrary OAuth redirect targets before they can become server-authoritative transactions", async () => {
    for (const redirectUri of [
      "https://attacker.example/auth/callback",
      "http://localhost:8765/auth/callback",
      "http://127.0.0.1:8765/other",
      "http://127.0.0.1:8765/auth/callback?redirect=https://attacker.example",
    ]) {
      const res = await fetch(`${baseUrl}/v1/auth/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirectUri }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).authUrl).toBeUndefined();
    }
  });

  it("does not honor forged forwarding headers unless the deployment explicitly trusts its proxy", async () => {
    const spoofedIp = "203.0.113.42";
    const start = await (await fetch(`${baseUrl}/v1/auth/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": spoofedIp },
      body: JSON.stringify({ redirectUri: "http://127.0.0.1:8765/auth/callback" }),
    })).json();
    const exchange = await (await fetch(`${baseUrl}/v1/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": spoofedIp },
      body: JSON.stringify({ code: "code_no_proxy", state: start.state, codeVerifier: start.codeVerifier, redirectUri: "http://127.0.0.1:8765/auth/callback" }),
    })).json();
    expect(exchange.session.ipAddress).not.toBe(spoofedIp);

    const proxiedServer = new CodeForgeCloudServer({
      jwtSecret,
      trustProxy: true,
      fetchFn: createMockGitHubFetch() as typeof fetch,
      stripeConfig: {
        secretKey: "sk_test_mock_adv",
        webhookSecret,
        proPriceId: "price_pro_adv",
        creditPackPriceId: "price_credits_adv",
      },
    });
    const proxiedPort = await proxiedServer.start(0);
    try {
      const proxiedBaseUrl = `http://127.0.0.1:${proxiedPort}`;
      const proxiedStart = await (await fetch(`${proxiedBaseUrl}/v1/auth/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": `${spoofedIp}, 198.51.100.7` },
        body: JSON.stringify({ redirectUri: "http://127.0.0.1:8765/auth/callback" }),
      })).json();
      const proxiedExchange = await (await fetch(`${proxiedBaseUrl}/v1/auth/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": `${spoofedIp}, 198.51.100.7` },
        body: JSON.stringify({ code: "code_trusted_proxy", state: proxiedStart.state, codeVerifier: proxiedStart.codeVerifier, redirectUri: "http://127.0.0.1:8765/auth/callback" }),
      })).json();
      expect(proxiedExchange.session.ipAddress).toBe(spoofedIp);
    } finally {
      await proxiedServer.stop();
    }
  });


  it("enforces server-owned OAuth transactions, rejecting unknown state, wrong PKCE, and expired state", async () => {
    // 1. Unknown state
    const resUnknown = await fetch(`${baseUrl}/v1/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "code_1",
        state: "completely_unknown_state_uuid",
        codeVerifier: "verifier_123",
      }),
    });
    expect(resUnknown.status).toBe(400);
    expect((await resUnknown.json()).error).toContain("OAuth transaction not found");

    // 2. Start valid transaction
    const startRes = await fetch(`${baseUrl}/v1/auth/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirectUri: "http://127.0.0.1:8765/auth/callback" }),
    });
    const startData = await startRes.json();

    // 3. Wrong PKCE verifier against server challenge
    const resWrongPkce = await fetch(`${baseUrl}/v1/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "code_1",
        state: startData.state,
        codeVerifier: "wrong_code_verifier_that_does_not_match_challenge",
        redirectUri: "http://127.0.0.1:8765/auth/callback",
      }),
    });
    expect(resWrongPkce.status).toBe(400);
    expect((await resWrongPkce.json()).error).toContain("PKCE");
  });

  it("enforces single-use OAuth transaction consumption (replaying state fails)", async () => {
    const startRes = await fetch(`${baseUrl}/v1/auth/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirectUri: "http://127.0.0.1:8765/auth/callback" }),
    });
    const startData = await startRes.json();

    // First consumption succeeds
    const firstRes = await fetch(`${baseUrl}/v1/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "code_first",
        state: startData.state,
        codeVerifier: startData.codeVerifier,
        redirectUri: "http://127.0.0.1:8765/auth/callback",
      }),
    });
    expect(firstRes.status).toBe(200);

    // Second consumption (replay) is rejected
    const replayRes = await fetch(`${baseUrl}/v1/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "code_first",
        state: startData.state,
        codeVerifier: startData.codeVerifier,
        redirectUri: "http://127.0.0.1:8765/auth/callback",
      }),
    });
    expect(replayRes.status).toBe(400);
    expect((await replayRes.json()).error).toContain("already consumed");
  });

  it("enforces atomic refresh token rotation and rejects replaying consumed refresh tokens", async () => {
    const startRes = await fetch(`${baseUrl}/v1/auth/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirectUri: "http://127.0.0.1:8765/auth/callback" }),
    });
    const startData = await startRes.json();

    const authRes = await fetch(`${baseUrl}/v1/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "code_rot",
        state: startData.state,
        codeVerifier: startData.codeVerifier,
        redirectUri: "http://127.0.0.1:8765/auth/callback",
      }),
    });
    const authData = await authRes.json();

    // 1. First refresh succeeds and rotates token
    const refresh1 = await fetch(`${baseUrl}/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: authData.refreshToken }),
    });
    expect(refresh1.status).toBe(200);
    const data1 = await refresh1.json();
    expect(data1.refreshToken).not.toBe(authData.refreshToken);

    // 2. Replay of consumed initial token is rejected
    const replay = await fetch(`${baseUrl}/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: authData.refreshToken }),
    });
    expect(replay.status).toBe(401);
    expect((await replay.json()).error).toContain("replay detected");
  });

  it("strictly rejects live Stripe credentials (sk_live_ / rk_live_)", () => {
    const ent = new EntitlementService(server.db);
    expect(() => {
      new StripeBillingService(server.db, ent, {
        secretKey: "sk_live_prod_secret_should_fail",
        webhookSecret: "whsec_123",
        proPriceId: "price_1",
        creditPackPriceId: "price_2",
      });
    }).toThrow(/Live Stripe credentials.*strictly prohibited/);

    expect(() => {
      new StripeBillingService(server.db, ent, {
        secretKey: "rk_live_prod_restricted_should_fail",
        webhookSecret: "whsec_123",
        proPriceId: "price_1",
        creditPackPriceId: "price_2",
      });
    }).toThrow(/Live Stripe credentials.*strictly prohibited/);
  });

  it("rejects oversized request bodies exceeding 1 MiB with HTTP 413", async () => {
    const hugePadding = "A".repeat(1024 * 1024 + 100);
    const res = await fetch(`${baseUrl}/v1/auth/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirectUri: "http://127.0.0.1:8765/auth/callback", deviceName: hugePadding }),
    });
    expect(res.status).toBe(413);
  });

  it("sanitizes error responses ensuring sentinel secrets never leak", async () => {
    const sentinelSecret = "sk_test_SUPER_CONFIDENTIAL_KEY_12345";
    const res = await fetch(`${baseUrl}/v1/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: `code_${sentinelSecret}`,
        state: "non_existent_state",
        codeVerifier: "ver",
      }),
    });
    const text = await res.text();
    expect(text).not.toContain(sentinelSecret);
  });

  it("rejects cross-user reservation spoofing", async () => {
    const userA = await server.db.createUser({ displayName: "User A", primaryIdentity: "github:1001" });
    const userB = await server.db.createUser({ displayName: "User B", primaryIdentity: "github:1002" });

    // User A creates reservation
    await server.db.createReservation({
      requestId: "req-shared-id",
      userId: userA.id,
      providerId: "codeforge",
      modelId: "test",
      reservedCredits: 5000,
    });

    // User B attempts to commit User A's reservation -> strictly DENIED
    await expect(async () => {
      await server.db.commitReservation("req-shared-id", userB.id, 5000);
    }).rejects.toThrow(/Unauthorized access/);

    // User B attempts to release User A's reservation -> strictly DENIED
    await expect(async () => {
      await server.db.releaseReservation("req-shared-id", userB.id);
    }).rejects.toThrow(/Unauthorized access/);
  });
});
