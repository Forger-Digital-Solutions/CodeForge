import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CloudDatabase } from "@codeforge/cloud-db";
import { EntitlementService } from "@codeforge/cloud-entitlements";
import { UsageEngine } from "@codeforge/cloud-usage";
import { createGenericFreeRecord } from "@codeforge/forge-zero";
import type { ProviderAdapter, StreamEvent } from "@codeforge/providers";
import { CloudFirewallManager, GatewayService, type HostedStreamEvent } from "../src/index.js";

class MockGroqRateLimitedProvider implements ProviderAdapter {
  readonly providerId = "groq";
  readonly isTestProvider = true;

  async *streamChat(): AsyncIterable<StreamEvent> {
    throw new Error("groq error (429): rate limit reached. Please wait and retry.");
  }
  async healthCheck() {
    return { status: "rate_limited" as const };
  }
  async listModels() {
    return [];
  }
  async chat() {
    throw new Error("429 Rate Limited");
  }
}

class MockCloudflareReserveProvider implements ProviderAdapter {
  readonly providerId = "cloudflare-workers-ai";
  readonly isTestProvider = true;

  async *streamChat(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "Reserve response from Cloudflare" };
    yield { type: "usage", usage: { inputTokens: 50, outputTokens: 25 } };
    yield { type: "finish", finishReason: "stop" };
  }
  async healthCheck() {
    return { status: "available" as const };
  }
  async listModels() {
    return [];
  }
  async chat() {
    return { id: "cf-1", model: "@cf/zai-org/glm-4.7-flash", choices: [], usage: { inputTokens: 50, outputTokens: 25 } };
  }
}

describe("Global capacity throttling and allowance isolation under 429", () => {
  let db: CloudDatabase;
  let firewallManager: CloudFirewallManager;
  let entitlementService: EntitlementService;
  let usageEngine: UsageEngine;
  let gateway: GatewayService;

  beforeEach(() => {
    db = new CloudDatabase({ dbPath: ":memory:" });
    firewallManager = new CloudFirewallManager();
    entitlementService = new EntitlementService(db);
    usageEngine = new UsageEngine(db);
    gateway = new GatewayService({
      firewallManager,
      entitlementService,
      usageEngine,
      db,
    });

    const groqModel = createGenericFreeRecord({
      providerId: "groq",
      modelId: "openai/gpt-oss-120b",
      displayName: "GPT-OSS 120B",
      accessClass: "FREE_ALLOWANCE",
      rank: 20,
    });
    const cfModel = createGenericFreeRecord({
      providerId: "cloudflare-workers-ai",
      modelId: "@cf/zai-org/glm-4.7-flash",
      displayName: "GLM-4.7 Flash (Workers AI)",
      accessClass: "FREE_ALLOWANCE",
      rank: 40,
    });

    firewallManager.registerModel(groqModel);
    firewallManager.registerModel(cfModel);
    firewallManager.registerProvider(new MockGroqRateLimitedProvider());
    firewallManager.registerProvider(new MockCloudflareReserveProvider());
  });

  afterEach(() => {
    db.close();
  });

  it("handles Groq 429 by failing closed, releasing reservation without corrupting allowances, and routing to reserve free route", async () => {
    // Setup User A and User B
    const userA = await db.createUser({ displayName: "User A", primaryIdentity: "github:user-a" });
    const userB = await db.createUser({ displayName: "User B", primaryIdentity: "github:user-b" });
    await db.getOrCreateCurrentUsagePeriod(userA.id, 500_000);
    await db.getOrCreateCurrentUsagePeriod(userB.id, 500_000);
    await db.setEntitlement(userA.id, "HOSTED_FREE", "true");
    await db.setEntitlement(userB.id, "HOSTED_FREE", "true");

    expect(await db.getCreditBalance(userA.id)).toBe(500_000);
    expect(await db.getCreditBalance(userB.id)).toBe(500_000);

    // 1. User A attempts request against Groq which throws 429
    const eventsA: HostedStreamEvent[] = [];
    let caughtError: Error | null = null;
    try {
      await gateway.executeHostedInference(
        userA.id,
        {
          requestId: "req-groq-429",
          messages: [{ role: "user", content: "Optimize this algorithm" }],
          providerId: "groq",
          modelId: "openai/gpt-oss-120b",
        },
        (e) => eventsA.push(e),
      );
    } catch (err: any) {
      caughtError = err;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError?.message).toContain("429");

    // User A and User B allowances must NOT be corrupted or debited
    const balanceAAfterFail = await db.getCreditBalance(userA.id);
    const balanceBAfterFail = await db.getCreditBalance(userB.id);
    expect(balanceAAfterFail).toBe(500_000);
    expect(balanceBAfterFail).toBe(500_000);

    // Terminal event was emitted for failure
    const failedEvents = eventsA.filter((e) => e.type === "turn.failed");
    expect(failedEvents).toHaveLength(1);

    // 2. The gateway must mark the provider in cooldown globally as part of the failed request.
    // Groq model must no longer be eligible in the pool
    const eligibleDuringCooldown = firewallManager.firewall.eligibleModels();
    expect(eligibleDuringCooldown.some((m) => m.providerId === "groq")).toBe(false);
    expect(eligibleDuringCooldown.some((m) => m.providerId === "cloudflare-workers-ai")).toBe(true);
    expect(firewallManager.listHostedModels().find((m) => m.providerId === "groq")?.availability).toBe("rate_limited");

    // 3. Next auto-routed request for User A rotates cleanly to Cloudflare reserve route
    const eventsA2: HostedStreamEvent[] = [];
    const resultA2 = await gateway.executeHostedInference(
      userA.id,
      {
        requestId: "req-auto-fallback",
        messages: [{ role: "user", content: "Continue task" }],
        modelId: "auto",
      },
      (e) => eventsA2.push(e),
    );

    expect(resultA2.fullText).toContain("Reserve response from Cloudflare");
    expect(resultA2.creditsConsumed).toBeGreaterThan(0);

    // User A balance was decremented only for the successful Cloudflare inference
    const balanceAAfterSuccess = await db.getCreditBalance(userA.id);
    expect(balanceAAfterSuccess).toBeLessThan(500_000);

    // User B individual balance is strictly untouched (individual allowance isolation)
    const balanceBAfterSuccess = await db.getCreditBalance(userB.id);
    expect(balanceBAfterSuccess).toBe(500_000);

    // 4. After cooldown expires, Groq returns to available
    firewallManager.markProviderHealth("groq", "available");
    const eligibleAfterCooldown = firewallManager.firewall.eligibleModels();
    expect(eligibleAfterCooldown.some((m) => m.providerId === "groq")).toBe(true);
  });
});
