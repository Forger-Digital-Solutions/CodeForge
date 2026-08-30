import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { createGenericFreeRecord } from "@codeforge/forge-zero";
import type { ProviderAdapter, StreamEvent } from "@codeforge/providers";
import { CodeForgeCloudServer } from "../src/index.js";

// Mock streaming provider
class MockStreamingProvider implements ProviderAdapter {
  readonly providerId = "codeforge";
  readonly isTestProvider = true;

  async *streamChat(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "The repository contains a monorepo architecture." };
    yield { type: "usage", usage: { inputTokens: 40, outputTokens: 10 } };
    yield { type: "finish", finishReason: "stop" };
  }

  async healthCheck() {
    return { status: "available" as const };
  }

  async listModels() {
    return [];
  }

  async chat() {
    return {
      id: "chat-1",
      model: "test/free",
      choices: [{ index: 0, message: { role: "assistant" as const, content: "hi" }, finishReason: "stop" as const }],
      usage: { inputTokens: 10, outputTokens: 10 },
    };
  }
}

describe("CodeForge Cloud Server API End-to-End", () => {
  let server: CodeForgeCloudServer;
  let baseUrl: string;
  const webhookSecret = "whsec_test_12345";

  const createMockGitHubFetch = () => {
    return async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes("login/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "gho_mock_access_token_123", token_type: "bearer", scope: "read:user user:email" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("api.github.com/user")) {
        return new Response(
          JSON.stringify({
            id: 554433,
            login: "alice_cloud",
            name: "Alice Cloud",
            avatar_url: "https://github.com/alice.png",
            email: "alice@example.com",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response("Not found", { status: 404 });
    };
  };

  beforeEach(async () => {
    server = new CodeForgeCloudServer({
      jwtSecret: "test-jwt-secret-32-character-long",
      fetchFn: createMockGitHubFetch() as typeof fetch,
      stripeConfig: {
        secretKey: "sk_test_123",
        webhookSecret,
        proPriceId: "price_pro",
        creditPackPriceId: "price_credits",
      },
    });

    const freeModel = createGenericFreeRecord();
    server.firewallManager.registerModel(freeModel);
    server.firewallManager.providerCatalog.register(new MockStreamingProvider(freeModel.providerId));

    const port = await server.start(0);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await server.stop();
  });

  it("serves live, ready, meta, and models endpoints", async () => {
    const liveRes = await fetch(`${baseUrl}/health/live`);
    expect(liveRes.status).toBe(200);
    const live = await liveRes.json();
    expect(live.status).toBe("ok");

    const readyRes = await fetch(`${baseUrl}/health/ready`);
    expect(readyRes.status).toBe(200);
    const ready = await readyRes.json();
    expect(ready.status).toBe("ready");
    expect(ready.database).toBe("connected");
    expect(ready.hostedInferenceReady).toBe(true);

    const metaRes = await fetch(`${baseUrl}/v1/meta`);
    expect(metaRes.status).toBe(200);
    const meta = await metaRes.json();
    expect(meta.apiVersion).toBe("1.0.0");

    const modelsRes = await fetch(`${baseUrl}/v1/hosted/models`);
    expect(modelsRes.status).toBe(200);
    const models = await modelsRes.json();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);

    expect(readyRes.headers.get("cache-control")).toContain("no-store");
    expect(readyRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(readyRes.headers.get("referrer-policy")).toBe("no-referrer");

    const allowed = await fetch(`${baseUrl}/v1/meta`, { headers: { Origin: "http://127.0.0.1:4555" } });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:4555");
    expect(allowed.headers.get("vary")).toBe("Origin");

    const denied = await fetch(`${baseUrl}/v1/meta`, { headers: { Origin: "https://untrusted.example" } });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();

    const deniedPreflight = await fetch(`${baseUrl}/v1/hosted/inference`, {
      method: "OPTIONS",
      headers: { Origin: "https://untrusted.example" },
    });
    expect(deniedPreflight.status).toBe(403);
  });

  it("completes full server-authoritative auth lifecycle, account queries, and hosted inference streaming", async () => {
    // 1. Auth Start
    const startRes = await fetch(`${baseUrl}/v1/auth/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirectUri: "http://127.0.0.1:8765/auth/callback" }),
    });
    expect(startRes.status).toBe(200);
    const startData = await startRes.json();
    expect(startData.state).toBeDefined();
    expect(startData.codeVerifier).toBeDefined();

    // 2. Auth Exchange (Server exchanges code with GitHub and consumes transaction)
    const exchangeRes = await fetch(`${baseUrl}/v1/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "code_alice_1",
        state: startData.state,
        codeVerifier: startData.codeVerifier,
        redirectUri: "http://127.0.0.1:8765/auth/callback",
      }),
    });
    expect(exchangeRes.status).toBe(200);
    const authTokens = await exchangeRes.json();
    expect(authTokens.isNewUser).toBe(true);
    expect(authTokens.accessToken).toBeDefined();
    expect(authTokens.refreshToken).toBeDefined();

    const authHeaders = { Authorization: `Bearer ${authTokens.accessToken}` };

    // 3. Get Account Details
    const accountRes = await fetch(`${baseUrl}/v1/account`, { headers: authHeaders });
    expect(accountRes.status).toBe(200);
    const account = await accountRes.json();
    expect(account.user.displayName).toBe("Alice Cloud");
    expect(account.planId).toBe("free");
    expect(account.creditBalance).toBe(500_000);

    // 4. Execute Hosted Inference (Streaming SSE)
    const inferenceRes = await fetch(`${baseUrl}/v1/hosted/inference`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "11111111-2222-3333-4444-555555555555",
        messages: [{ role: "user", content: "Explain this repo" }],
        modelId: "auto",
        taskType: "coding",
      }),
    });
    expect(inferenceRes.status).toBe(200);
    expect(inferenceRes.headers.get("content-type")).toContain("text/event-stream");
    expect(inferenceRes.headers.get("x-accel-buffering")).toBe("no");
    expect(inferenceRes.headers.get("referrer-policy")).toBe("no-referrer");

    const sseBody = await inferenceRes.text();
    expect(sseBody).toContain("assistant.message.started");
    expect(sseBody).toContain("The repository contains a monorepo architecture.");
    expect(sseBody).toContain("assistant.message.completed");
    expect(sseBody).toContain("turn.completed");

    // 5. Verify usage deduction
    const usageRes = await fetch(`${baseUrl}/v1/usage`, { headers: authHeaders });
    expect(usageRes.status).toBe(200);
    const usage = await usageRes.json();
    expect(usage.creditBalance).toBeLessThan(500_000);
    expect(usage.recentEvents).toHaveLength(1);

    // 6. Refresh Auth Session
    const refreshRes = await fetch(`${baseUrl}/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: authTokens.refreshToken }),
    });
    expect(refreshRes.status).toBe(200);
    const refreshed = await refreshRes.json();
    expect(refreshed.accessToken).toBeDefined();
    expect(refreshed.refreshToken).not.toBe(authTokens.refreshToken);

    // 7. Logout
    const logoutRes = await fetch(`${baseUrl}/v1/auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: refreshed.refreshToken }),
    });
    expect(logoutRes.status).toBe(200);
  });

  it("processes Stripe webhook signatures and activates Pro subscriptions", async () => {
    const user = await server.db.createUser({ displayName: "Stripe User", primaryIdentity: "github:999888" });
    await server.db.appendLedgerEvent({ userId: user.id, amount: 500_000, eventType: "FREE_ALLOWANCE_GRANTED" });

    const event = {
      id: "evt_stripe_test_1",
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          client_reference_id: user.id,
          customer: "cus_123",
          subscription: "sub_123",
          mode: "subscription",
        },
      },
    };

    const payload = JSON.stringify(event);
    const now = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", webhookSecret).update(`${now}.${payload}`).digest("hex");

    const res = await fetch(`${baseUrl}/v1/billing/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": `t=${now},v1=${signature}`,
      },
      body: payload,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.processed).toBe(true);
    expect(data.action).toBe("pro_subscription_activated");

    // Pro balance is now 5.5M credits
    expect(await server.db.getCreditBalance(user.id)).toBe(5_500_000);
  });
});
