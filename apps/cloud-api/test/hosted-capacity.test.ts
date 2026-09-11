import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ProviderAdapter, ProviderModel, StreamEvent, ChatRequest } from "@codeforge/providers";
import { CloudFirewallManager, CloudProviderRegistry, MapCredentialStore } from "@codeforge/cloud-gateway";
import { CodeForgeCloudServer } from "../src/index.js";
import { loginToCloud } from "../../../tests/helpers/cloud-login.js";

// A server provider key that must NEVER cross the cloud→desktop boundary.
const PROVIDER_SECRET = "sk-or-SERVER_SECRET_SENTINEL_7f3a";

// Groq, not OpenRouter: as of the R1 legal remediation, hosted multi-tenant pooling through a
// CodeForge-owned OpenRouter key is denied absent an Enterprise Agreement (LEG-P1-01,
// @codeforge/legal-policy PROVIDER_POLICY_REGISTRY). This fixture exercises the general
// zero-setup capacity/routing/usage-settlement machinery, not anything OpenRouter-specific, so an
// unrestricted provider keeps the test's actual intent intact.
class FakeGroqProvider implements ProviderAdapter {
  readonly providerId = "groq";
  readonly isTestProvider = false;
  async listModels(): Promise<ProviderModel[]> {
    return [
      {
        modelId: "meta-llama/llama-3.1-8b-instruct:free",
        displayName: "Llama 3.1 8B Instruct (free)",
        contextWindow: 131072,
        capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
        isFree: true,
        freeStatus: "verified_free",
      },
    ];
  }
  async *streamChat(_req: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "CODEFORGE_HOSTED_SMOKE_OK" };
    yield { type: "usage", usage: { inputTokens: 12, outputTokens: 6 } };
    yield { type: "finish", finishReason: "stop" };
  }
  async chat() {
    return { id: "1", model: "m", choices: [], usage: { inputTokens: 0, outputTokens: 0 } };
  }
  async healthCheck() {
    return { status: "available" as const };
  }
}

const mockGitHubFetch = (): typeof fetch =>
  (async (url: string | URL | Request) => {
    const s = url.toString();
    if (s.includes("login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "gho_mock", token_type: "bearer", scope: "read:user user:email" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (s.includes("api.github.com/user")) {
      return new Response(JSON.stringify({ id: 12321, login: "zero_setup_user", name: "Zero Setup", email: "z@example.com" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;

describe("Zero-setup real hosted capacity (deterministic, injected provider)", () => {
  let server: CodeForgeCloudServer;
  let baseUrl: string;

  beforeEach(async () => {
    const firewallManager = new CloudFirewallManager();
    const store = new MapCredentialStore();
    store.set("groq", PROVIDER_SECRET);
    const providerRegistry = new CloudProviderRegistry({
      firewallManager,
      credentialStore: store,
      providerIds: ["groq"],
      adapterFactory: () => new FakeGroqProvider(),
    });

    server = new CodeForgeCloudServer({
      jwtSecret: "test-jwt-secret-32-character-long",
      fetchFn: mockGitHubFetch(),
      firewallManager,
      providerRegistry,
      stripeConfig: { secretKey: "sk_test_1", webhookSecret: "whsec_1", proPriceId: "price_pro", creditPackPriceId: "price_credits" },
    });

    const port = await server.start(0);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await server.stop();
  });

  it("discovers real free capacity at startup and reports it ready", async () => {
    const ready = await (await fetch(`${baseUrl}/health/ready`)).json();
    expect(ready.hostedInferenceReady).toBe(true);
    expect(ready.availableFreeCount).toBeGreaterThan(0);
    expect(ready.providerCapacity).toEqual(
      expect.arrayContaining([expect.objectContaining({ providerId: "groq", status: "healthy" })]),
    );
  });

  it("exposes the discovered provider model via /v1/hosted/models", async () => {
    const models = await (await fetch(`${baseUrl}/v1/hosted/models`)).json();
    const ids = models.map((m: { modelId: string }) => m.modelId);
    expect(ids).toContain("meta-llama/llama-3.1-8b-instruct:free");
    const free = models.find((m: { modelId: string }) => m.modelId.endsWith(":free"));
    expect(free.isEligibleFree).toBe(true);
    expect(free.accessClass).toBe("free");
  });

  it("runs a zero-provider-key hosted inference through Auto and settles usage", async () => {
    // Sign in (no provider account, no provider key from the user).
    const tokens = await loginToCloud(baseUrl, { loopbackPort: 8765 });
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };

    const inf = await fetch(`${baseUrl}/v1/hosted/inference`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        messages: [{ role: "user", content: "Reply exactly: CODEFORGE_HOSTED_SMOKE_OK" }],
        modelId: "auto",
        taskType: "coding",
      }),
    });
    expect(inf.status).toBe(200);
    const sse = await inf.text();
    // ForgeZero selected the real provider/model, and the real (fake) adapter produced the text.
    expect(sse).toContain("assistant.message.started");
    expect(sse).toContain('"provider":"groq"');
    expect(sse).toContain("CODEFORGE_HOSTED_SMOKE_OK");
    expect(sse).toContain("turn.completed");

    const usage = await (await fetch(`${baseUrl}/v1/usage`, { headers: auth })).json();
    expect(usage.creditBalance).toBeLessThan(500_000);
    expect(usage.recentEvents.length).toBeGreaterThan(0);
  });

  it("never leaks the server provider credential across the cloud→desktop boundary", async () => {
    const surfaces = await Promise.all([
      fetch(`${baseUrl}/v1/hosted/models`).then((r) => r.text()),
      fetch(`${baseUrl}/health/ready`).then((r) => r.text()),
      fetch(`${baseUrl}/v1/meta`).then((r) => r.text()),
    ]);
    for (const body of surfaces) {
      expect(body).not.toContain(PROVIDER_SECRET);
      expect(body).not.toContain("SERVER_SECRET_SENTINEL");
    }
  });
});
