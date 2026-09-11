import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CloudDatabase } from "@codeforge/cloud-db";
import { EntitlementService } from "@codeforge/cloud-entitlements";
import { UsageEngine } from "@codeforge/cloud-usage";
import { createGenericFreeRecord } from "@codeforge/forge-zero";
import { REGION_UNKNOWN, classifyRegionEvidence, type EnterpriseOverrideConfig } from "@codeforge/legal-policy";
import type { ProviderAdapter, StreamEvent } from "@codeforge/providers";
import { CloudFirewallManager, GatewayService, type HostedStreamEvent } from "../src/index.js";

class MockProvider implements ProviderAdapter {
  constructor(public readonly providerId: string) {}
  async *streamChat(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "ok" };
    yield { type: "usage", usage: { inputTokens: 5, outputTokens: 5 } };
    yield { type: "finish", finishReason: "stop" };
  }
  async healthCheck() {
    return { status: "available" as const };
  }
  async listModels() {
    return [];
  }
  async chat() {
    return { id: "1", model: "m", choices: [], usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

// R1 remediation spec §51: region restriction test — allowed region, denied region, unknown
// region, BYOK vs hosted must all behave differently. This exercises the real hosted-inference
// path end-to-end, not just the pure evaluateRouteEligibility() unit tests in @codeforge/legal-policy.
describe("GatewayService — provider region policy (LEG-P0-03 / ENG-P0-03)", () => {
  let db: CloudDatabase;
  let firewallManager: CloudFirewallManager;
  let gateway: GatewayService;

  async function makeUser(id: string) {
    const user = await db.createUser({ displayName: id, primaryIdentity: `github:${id}` });
    await db.getOrCreateCurrentUsagePeriod(user.id, 500_000);
    await db.setEntitlement(user.id, "HOSTED_FREE", "true");
    return user;
  }

  beforeEach(() => {
    db = new CloudDatabase({ dbPath: ":memory:" });
    firewallManager = new CloudFirewallManager();
    const entitlementService = new EntitlementService(db);
    const usageEngine = new UsageEngine(db);
    gateway = new GatewayService({ firewallManager, entitlementService, usageEngine, db });

    const geminiFree = createGenericFreeRecord({ providerId: "google-gemini", modelId: "gemini-free-test" });
    firewallManager.registerModel(geminiFree);
    firewallManager.registerProvider(new MockProvider("google-gemini"));

    // A non-restricted free alternative so the "auto" graceful-fallback test has somewhere to land.
    const groqFree = createGenericFreeRecord({ providerId: "groq", modelId: "groq-free-test" });
    firewallManager.registerModel(groqFree);
    firewallManager.registerProvider(new MockProvider("groq"));
  });

  afterEach(() => db.close());

  it("denies exact-pin Gemini hosted routing for a trusted EEA region", async () => {
    const user = await makeUser("eea-user");
    const region = classifyRegionEvidence({ countryCode: "DE", source: "TRUSTED_EDGE_HEADER", observedAt: new Date().toISOString() });
    await expect(
      gateway.executeHostedInference(
        user.id,
        { requestId: "req-eea-1", messages: [{ role: "user", content: "hi" }], modelId: "gemini-free-test", providerId: "google-gemini" },
        () => {},
        undefined,
        region,
      ),
    ).rejects.toThrow(/PROVIDER_POLICY_REGION_RESTRICTED/);
  });

  it("denies exact-pin Gemini hosted routing when region cannot be resolved (fail closed)", async () => {
    const user = await makeUser("unknown-region-user");
    await expect(
      gateway.executeHostedInference(
        user.id,
        { requestId: "req-unknown-1", messages: [{ role: "user", content: "hi" }], modelId: "gemini-free-test", providerId: "google-gemini" },
        () => {},
        undefined,
        REGION_UNKNOWN,
      ),
    ).rejects.toThrow(/PROVIDER_POLICY_REGION_UNKNOWN_FAIL_CLOSED/);
  });

  it("allows exact-pin Gemini hosted routing for a trusted non-denied region", async () => {
    const user = await makeUser("us-user");
    const region = classifyRegionEvidence({ countryCode: "US", source: "ACCOUNT_BILLING_COUNTRY", observedAt: new Date().toISOString() });
    const events: HostedStreamEvent[] = [];
    const result = await gateway.executeHostedInference(
      user.id,
      { requestId: "req-us-1", messages: [{ role: "user", content: "hi" }], modelId: "gemini-free-test", providerId: "google-gemini" },
      (e) => events.push(e),
      undefined,
      region,
    );
    expect(result.fullText).toBe("ok");
    expect(events.some((e) => e.type === "turn.completed")).toBe(true);
  });

  it("auto-routing falls back to an eligible provider instead of failing the whole task when the top pick is region-denied", async () => {
    const user = await makeUser("auto-eea-user");
    const events: HostedStreamEvent[] = [];
    const result = await gateway.executeHostedInference(
      user.id,
      { requestId: "req-auto-1", messages: [{ role: "user", content: "hi" }], modelId: "auto" },
      (e) => events.push(e),
      undefined,
      REGION_UNKNOWN, // fails Gemini closed, groq has no region restriction
    );
    expect(result.fullText).toBe("ok");
    const started = events.find((e) => e.type === "assistant.message.started");
    expect(started && "provider" in started ? started.provider : undefined).toBe("groq");
  });

  it("does not fall back to a paid provider when the free candidate is policy-denied", async () => {
    // Sanity check on the fixture itself: gems models are tier "gems_paid" and never enter
    // eligibleModels()'s free pool, so the router has nothing paid to accidentally prefer.
    const user = await makeUser("no-paid-fallback-user");
    const region = classifyRegionEvidence({ countryCode: "DE", source: "TRUSTED_EDGE_HEADER", observedAt: new Date().toISOString() });
    const events: HostedStreamEvent[] = [];
    const result = await gateway.executeHostedInference(
      user.id,
      { requestId: "req-nopaid-1", messages: [{ role: "user", content: "hi" }], modelId: "auto" },
      (e) => events.push(e),
      undefined,
      region,
    );
    const started = events.find((e) => e.type === "assistant.message.started");
    expect(started && "provider" in started ? started.provider : undefined).toBe("groq");
    expect(result.fullText).toBe("ok");
  });

  it("respects a trusted EnterpriseOverrideConfig for OpenRouter hosted pooling", async () => {
    const openRouterFree = createGenericFreeRecord({ providerId: "openrouter", modelId: "or-free-test" });
    const denied = new CloudFirewallManager();
    denied.registerModel(openRouterFree);
    denied.registerProvider(new MockProvider("openrouter"));
    const gatewayDenied = new GatewayService({
      firewallManager: denied,
      entitlementService: new EntitlementService(db),
      usageEngine: new UsageEngine(db),
      db,
    });
    const user1 = await makeUser("or-denied-user");
    await expect(
      gatewayDenied.executeHostedInference(
        user1.id,
        { requestId: "req-or-1", messages: [{ role: "user", content: "hi" }], modelId: "or-free-test", providerId: "openrouter" },
        () => {},
      ),
    ).rejects.toThrow(/OPENROUTER_ENTERPRISE_AGREEMENT_REQUIRED/);

    const overrides: Record<string, EnterpriseOverrideConfig> = {
      openrouter: { providerId: "openrouter", status: "ENTERPRISE_AUTHORIZED", allowedArchitectures: ["HOSTED_MULTI_TENANT"], agreementReference: "TEST-FIXTURE" },
    };
    const authorized = new CloudFirewallManager({ enterpriseOverrides: overrides });
    authorized.registerModel(openRouterFree);
    authorized.registerProvider(new MockProvider("openrouter"));
    const gatewayAuthorized = new GatewayService({
      firewallManager: authorized,
      entitlementService: new EntitlementService(db),
      usageEngine: new UsageEngine(db),
      db,
    });
    const user2 = await makeUser("or-authorized-user");
    const result = await gatewayAuthorized.executeHostedInference(
      user2.id,
      { requestId: "req-or-2", messages: [{ role: "user", content: "hi" }], modelId: "or-free-test", providerId: "openrouter" },
      () => {},
    );
    expect(result.fullText).toBe("ok");
  });
});
