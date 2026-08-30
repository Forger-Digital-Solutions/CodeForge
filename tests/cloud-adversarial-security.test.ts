import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { CodeForgeCloudServer } from "codeforge-cloud-api";
import { CloudDatabase } from "@codeforge/cloud-db";
import { AuthService, signAccessToken, verifyAccessToken } from "@codeforge/cloud-auth";
import { StripeBillingService } from "@codeforge/cloud-billing";
import { EntitlementService } from "@codeforge/cloud-entitlements";
import { startCloudLogin, completeGitHubCallback, exchangeDesktopCode, loginToCloud, createDesktopPkce } from "./helpers/cloud-login.js";

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
        codeVerifier: "f".repeat(64),
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
    const { codeChallenge } = createDesktopPkce();
    for (const redirectUri of [
      "https://attacker.example/auth/callback",
      "http://localhost:8765/auth/callback",
      "http://127.0.0.1:8765/other",
      "http://127.0.0.1:8765/auth/callback?redirect=https://attacker.example",
      "http://127.0.0.1/auth/callback",
      "http://[::1]:8765/auth/callback",
      "http://127.0.0.1@attacker.example:8765/auth/callback",
      "http://192.168.0.10:8765/auth/callback",
    ]) {
      const res = await fetch(`${baseUrl}/v1/auth/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirectUri, codeChallenge }),
      });
      expect(res.status, `expected rejection for ${redirectUri}`).toBe(400);
      expect((await res.json()).authUrl).toBeUndefined();
    }
  });

  it("never lets callback input steer the GitHub-callback redirect (no open redirector)", async () => {
    const start = await startCloudLogin(baseUrl, { loopbackPort: 49152 });

    // Hostile parameters piggy-backed on the authorization-server callback are ignored entirely:
    // the destination comes from the server-side transaction, not the request.
    const res = await fetch(
      `${baseUrl}/v1/auth/github/callback?code=gh_code&state=${encodeURIComponent(start.state)}` +
        `&redirect_uri=${encodeURIComponent("https://attacker.example/steal")}` +
        `&redirectUri=${encodeURIComponent("https://attacker.example/steal")}` +
        `&next=${encodeURIComponent("https://attacker.example/steal")}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(new URL(location).host).toBe("127.0.0.1:49152");
    expect(location).not.toContain("attacker.example");
  });

  it("returns a static error page — never a redirect — for an invalid or replayed GitHub callback", async () => {
    const res = await fetch(`${baseUrl}/v1/auth/github/callback?code=x&state=unknown_state`, { redirect: "manual" });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    const text = await res.text();
    expect(text).not.toContain("unknown_state");
    expect(text).toContain("CodeForge sign-in failed");

    // GitHub-reported failures also terminate without a redirect.
    const denied = await fetch(`${baseUrl}/v1/auth/github/callback?error=access_denied&state=whatever`, { redirect: "manual" });
    expect(denied.status).toBe(400);
    expect(denied.headers.get("location")).toBeNull();
  });

  it("does not honor forged forwarding headers unless the deployment explicitly trusts its proxy", async () => {
    const spoofedIp = "203.0.113.42";
    const exchange = await loginToCloud(baseUrl, { loopbackPort: 8765, headers: { "X-Forwarded-For": spoofedIp } });
    expect((exchange as unknown as { session: { ipAddress?: string } }).session.ipAddress).not.toBe(spoofedIp);

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
      const proxiedExchange = await loginToCloud(proxiedBaseUrl, {
        loopbackPort: 8765,
        headers: { "X-Forwarded-For": `${spoofedIp}, 198.51.100.7` },
      });
      expect((proxiedExchange as unknown as { session: { ipAddress?: string } }).session.ipAddress).toBe(spoofedIp);
    } finally {
      await proxiedServer.stop();
    }
  });


  it("enforces server-owned OAuth transactions, rejecting unknown state and wrong PKCE", async () => {
    // 1. Unknown state at the GitHub callback
    const resUnknown = await fetch(`${baseUrl}/v1/auth/github/callback?code=code_1&state=completely_unknown_state_uuid`, { redirect: "manual" });
    expect(resUnknown.status).toBe(400);

    // 2. Unknown desktop code at the exchange
    const resUnknownCode = await fetch(`${baseUrl}/v1/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "cfa_not_a_real_code", codeVerifier: "v".repeat(64) }),
    });
    expect(resUnknownCode.status).toBe(400);
    expect((await resUnknownCode.json()).error).toContain("not found");

    // 3. Valid transaction, but the exchange presents the wrong desktop PKCE verifier
    const start = await startCloudLogin(baseUrl, { loopbackPort: 8765 });
    const { code } = await completeGitHubCallback(baseUrl, start);
    const resWrongPkce = await fetch(`${baseUrl}/v1/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        codeVerifier: createDesktopPkce().codeVerifier, // valid shape, wrong attempt
        redirectUri: start.redirectUri,
      }),
    });
    expect(resWrongPkce.status).toBe(400);
    expect((await resWrongPkce.json()).error).toContain("PKCE");
  });

  it("enforces single-use desktop authorization codes (replay fails)", async () => {
    const start = await startCloudLogin(baseUrl, { loopbackPort: 8765 });
    const { code } = await completeGitHubCallback(baseUrl, start);

    const firstRes = await exchangeDesktopCode(baseUrl, start, code);
    expect(firstRes.status).toBe(200);

    const replayRes = await exchangeDesktopCode(baseUrl, start, code);
    expect(replayRes.status).toBe(400);
    expect((await replayRes.json()).error).toContain("already consumed");
  });

  it("enforces single-use OAuth state at the GitHub callback (replaying state fails)", async () => {
    const start = await startCloudLogin(baseUrl, { loopbackPort: 8765 });
    await completeGitHubCallback(baseUrl, start);

    const replay = await fetch(`${baseUrl}/v1/auth/github/callback?code=gh&state=${encodeURIComponent(start.state)}`, { redirect: "manual" });
    expect(replay.status).toBe(400);
    expect(replay.headers.get("location")).toBeNull();
  });

  it("lets exactly one concurrent exchange of a captured desktop code succeed", async () => {
    const start = await startCloudLogin(baseUrl, { loopbackPort: 8765 });
    const { code } = await completeGitHubCallback(baseUrl, start);

    const responses = await Promise.all(Array.from({ length: 6 }, () => exchangeDesktopCode(baseUrl, start, code)));
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s !== 200)).toHaveLength(5);
  });

  it("enforces atomic refresh token rotation and rejects replaying consumed refresh tokens", async () => {
    const authData = await loginToCloud(baseUrl, { loopbackPort: 8765 });

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
