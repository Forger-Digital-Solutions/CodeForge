import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { CodeForgeCloudServer } from "codeforge-cloud-api";
import { HostedProviderAdapter } from "@codeforge/providers";
import { createGenericFreeRecord } from "@codeforge/forge-zero";
import type { ProviderAdapter, StreamEvent } from "@codeforge/providers";

// Mock upstream free LLM provider on cloud server
class MockCloudUpstreamProvider implements ProviderAdapter {
  readonly providerId = "codeforge";
  readonly isTestProvider = true;

  async *streamChat(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "CodeForge Cloud: " };
    yield { type: "text_delta", delta: "Successfully processed task with zero API keys." };
    yield { type: "usage", usage: { inputTokens: 45, outputTokens: 15 } };
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
      id: "mock-1",
      model: "codeforge/free",
      choices: [{ index: 0, message: { role: "assistant" as const, content: "ok" }, finishReason: "stop" as const }],
      usage: { inputTokens: 10, outputTokens: 10 },
    };
  }
}

describe("CodeForge Cloud Full Platform Certification E2E", () => {
  let cloudServer: CodeForgeCloudServer;
  let cloudUrl: string;
  const webhookSecret = "whsec_test_certification_secret";

  const createMockGitHubFetch = () => {
    return async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes("login/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "gho_mock_access_token_octo", token_type: "bearer", scope: "read:user user:email" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("api.github.com/user")) {
        return new Response(
          JSON.stringify({
            id: 424242,
            login: "octodev",
            name: "Octo Developer",
            avatar_url: "https://github.com/octodev.png",
            email: "octodev@codeforge.dev",
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
    cloudServer = new CodeForgeCloudServer({
      jwtSecret: "cert-jwt-secret-key-32-chars-long",
      fetchFn: createMockGitHubFetch() as typeof fetch,
      stripeConfig: {
        secretKey: "sk_test_mock_cert",
        webhookSecret,
        proPriceId: "price_pro_test",
        creditPackPriceId: "price_credits_test",
      },
    });

    const freeModel = createGenericFreeRecord();
    cloudServer.firewallManager.registerModel(freeModel);
    cloudServer.firewallManager.providerCatalog.register(new MockCloudUpstreamProvider());

    const port = await cloudServer.start(0);
    cloudUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await cloudServer.stop();
  });

  it("completes full certified cloud flow: Zero-Setup Sign-in -> Free Inference -> Metering -> Stripe Pro Upgrade -> Cancellation", async () => {
    // 1. Desktop starts PKCE flow
    const startRes = await fetch(`${cloudUrl}/v1/auth/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirectUri: "http://127.0.0.1:8765/auth/callback" }),
    });
    const start = await startRes.json();
    expect(start.state).toBeDefined();
    expect(start.codeVerifier).toBeDefined();

    // 2. Browser callback arrives & Desktop exchanges code for tokens
    const exchangeRes = await fetch(`${cloudUrl}/v1/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "code_dev_123",
        state: start.state,
        codeVerifier: start.codeVerifier,
        redirectUri: "http://127.0.0.1:8765/auth/callback",
      }),
    });
    const authData = await exchangeRes.json();
    expect(authData.isNewUser).toBe(true);
    expect(authData.accessToken).toBeDefined();
    expect(authData.refreshToken).toBeDefined();

    // 3. Verify Free Tier account & initial 500,000 credit allowance
    const accountRes = await fetch(`${cloudUrl}/v1/account`, {
      headers: { Authorization: `Bearer ${authData.accessToken}` },
    });
    const account = await accountRes.json();
    expect(account.user.displayName).toBe("Octo Developer");
    expect(account.planId).toBe("free");
    expect(account.creditBalance).toBe(500_000);

    // 4. Run hosted inference through client HostedProviderAdapter (Zero-API-key inference)
    const hostedAdapter = new HostedProviderAdapter({
      cloudApiUrl: cloudUrl,
      getAccessToken: () => authData.accessToken,
    });

    const chatResponse = await hostedAdapter.chat({
      model: "codeforge-auto",
      messages: [{ role: "user", content: "Implement the login button" }],
    });

    expect(chatResponse.choices[0]?.message.content).toBe(
      "CodeForge Cloud: Successfully processed task with zero API keys.",
    );
    expect(chatResponse.usage.totalTokens).toBeGreaterThan(0);

    // 5. Verify usage metered & credit balance accurately decremented in ledger
    const balanceAfterTurn = cloudServer.db.getCreditBalance(authData.user.id);
    expect(balanceAfterTurn).toBeLessThan(500_000);
    expect(balanceAfterTurn).toBeGreaterThan(490_000);

    // 6. Test Quota Exhaustion Guard
    // Simulate consuming all remaining credits
    cloudServer.db.appendLedgerEvent({
      userId: authData.user.id,
      amount: -balanceAfterTurn, // bring balance to exactly 0
      eventType: "ADMIN_ADJUSTMENT",
      description: "Simulate quota exhaustion",
    });
    expect(cloudServer.db.getCreditBalance(authData.user.id)).toBe(0);

    // Next inference attempt must FAIL CLOSED before calling provider
    await expect(
      hostedAdapter.chat({
        model: "codeforge-auto",
        messages: [{ role: "user", content: "Another task" }],
      }),
    ).rejects.toThrow(/used your included CodeForge hosted usage/);

    // 7. Stripe Test Mode Subscription Upgrade
    const stripeEvent = {
      id: "evt_stripe_cert_checkout_1",
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          client_reference_id: authData.user.id,
          customer: "cus_stripe_cert_1",
          subscription: "sub_stripe_cert_1",
          mode: "subscription",
        },
      },
    };

    const webhookPayload = JSON.stringify(stripeEvent);
    const now = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", webhookSecret).update(`${now}.${webhookPayload}`).digest("hex");

    const webhookRes = await fetch(`${cloudUrl}/v1/billing/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": `t=${now},v1=${sig}`,
      },
      body: webhookPayload,
    });

    expect(webhookRes.status).toBe(200);
    const webhookResult = await webhookRes.json();
    expect(webhookResult.action).toBe("pro_subscription_activated");

    // 8. Account is now Pro with 5,000,000 credits and can run inference again!
    const upgradedBalance = cloudServer.db.getCreditBalance(authData.user.id);
    expect(upgradedBalance).toBe(5_000_000);

    const proChatResponse = await hostedAdapter.chat({
      model: "codeforge-auto",
      messages: [{ role: "user", content: "Resume coding as Pro subscriber" }],
    });
    expect(proChatResponse.choices[0]?.message.content).toContain("Successfully processed task");

    // 9. Webhook Idempotency check: duplicate event does not double-grant credits
    const duplicateWebhookRes = await fetch(`${cloudUrl}/v1/billing/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": `t=${now},v1=${sig}`,
      },
      body: webhookPayload,
    });
    const dupResult = await duplicateWebhookRes.json();
    expect(dupResult.action).toBe("duplicate_skipped");
    expect(cloudServer.db.getCreditBalance(authData.user.id)).toBeLessThan(5_000_000);

    // 10. Cancellation webhook downgrades user cleanly back to Free plan
    const cancelEvent = {
      id: "evt_stripe_cert_cancel_1",
      type: "customer.subscription.deleted",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "sub_stripe_cert_1",
        },
      },
    };
    const cancelPayload = JSON.stringify(cancelEvent);
    const cancelSig = createHmac("sha256", webhookSecret).update(`${now}.${cancelPayload}`).digest("hex");

    const cancelRes = await fetch(`${cloudUrl}/v1/billing/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": `t=${now},v1=${cancelSig}`,
      },
      body: cancelPayload,
    });
    expect(cancelRes.status).toBe(200);
    const cancelResult = await cancelRes.json();
    expect(cancelResult.action).toBe("subscription_canceled");

    const subAfterCancel = cloudServer.db.getSubscriptionByUserId(authData.user.id);
    expect(subAfterCancel?.planId).toBe("free");
    expect(subAfterCancel?.status).toBe("canceled");
  });
});
