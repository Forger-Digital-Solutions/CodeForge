import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CloudDatabase } from "@codeforge/cloud-db";
import { EntitlementService } from "@codeforge/cloud-entitlements";
import { UsageEngine } from "@codeforge/cloud-usage";
import { CloudFirewallManager, GatewayService, type HostedStreamEvent } from "@codeforge/cloud-gateway";
import { HostedProviderAdapter, OpenRouterAdapter, createGroqAdapter, type ProviderAdapter, type StreamEvent } from "@codeforge/providers";
import { createGenericFreeRecord } from "@codeforge/forge-zero";

class FailingMockProvider implements ProviderAdapter {
  readonly providerId = "failing-provider";
  readonly isTestProvider = true;

  async *streamChat(_req: any, _signal?: AbortSignal): AsyncIterable<StreamEvent> {
    throw new Error("Upstream LLM Service Unavailable (HTTP 503)");
  }
  async healthCheck() {
    return { status: "offline" as const, error: "503" };
  }
  async listModels() {
    return [];
  }
  async chat() {
    throw new Error("503");
  }
}

describe("Phase 58 — Cloud Failure Matrix & Fallback Isolation", () => {
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

    const model = createGenericFreeRecord({ providerId: "failing-provider", modelId: "failing-model" });
    firewallManager.registerModel(model);
    firewallManager.registerProvider(new FailingMockProvider());
  });

  afterEach(() => {
    db.close();
  });

  it("handles upstream 503 failure cleanly: releases reservation, refunds balance, and emits exactly one turn.failed event", async () => {
    const user = await db.createUser({ displayName: "Fail User", primaryIdentity: "github:9000" });
    await db.getOrCreateCurrentUsagePeriod(user.id, 500_000);
    await db.setEntitlement(user.id, "HOSTED_FREE", "true");

    const events: HostedStreamEvent[] = [];

    await expect(
      gateway.executeHostedInference(
        user.id,
        {
          requestId: "req-fail-upstream-1",
          messages: [{ role: "user", content: "Test" }],
          modelId: "failing-model",
          providerId: "failing-provider",
        },
        (e) => events.push(e),
      ),
    ).rejects.toThrow(/503/);

    // Exactly 1 terminal event
    const terminalEvents = events.filter((e) => e.type === "turn.completed" || e.type === "turn.failed");
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.type).toBe("turn.failed");

    // Balance must be fully refunded back to 500,000
    const finalBalance = await db.getCreditBalance(user.id);
    expect(finalBalance).toBe(500_000);

    // Reservation status is released
    const res = await db.getReservationByRequestId("req-fail-upstream-1");
    expect(res?.status).toBe("released");
  });


  it("ensures Direct / BYOK providers are completely independent and functional even when Cloud is completely offline", async () => {
    // 1. Cloud adapter targeting dead port
    const offlineCloudAdapter = new HostedProviderAdapter({
      cloudApiUrl: "http://127.0.0.1:59999", // dead port
    });

    const health = await offlineCloudAdapter.healthCheck();
    expect(health.status).toBe("offline");

    // Cloud fails cleanly without hanging
    await expect(
      offlineCloudAdapter.chat({
        model: "codeforge-auto",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow();

    // 2. Direct providers instantiation remains unaffected
    const openRouter = new OpenRouterAdapter({ apiKey: "test-or-key" });
    expect(openRouter.providerId).toBe("openrouter");

    const groq = createGroqAdapter({ apiKey: "test-groq-key" });
    expect(groq.providerId).toBe("groq");
  });

  it("fails closed on database errors during entitlement evaluation", async () => {
    // Close DB to simulate database failure / outage
    db.close();

    const permission = await entitlementService.evaluateTaskExecution({
      userId: "any-user",
      requestedEstimatedCredits: 1000,
    });

    // Must fail closed
    expect(permission.allowed).toBe(false);
    expect(permission.reason).toContain("fail closed");
  });
});

