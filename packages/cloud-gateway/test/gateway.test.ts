import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CloudDatabase } from "@codeforge/cloud-db";
import { EntitlementService } from "@codeforge/cloud-entitlements";
import { UsageEngine } from "@codeforge/cloud-usage";
import { createGenericFreeRecord } from "@codeforge/forge-zero";
import type { ProviderAdapter, StreamEvent } from "@codeforge/providers";
import { CloudFirewallManager, GatewayService, type HostedStreamEvent } from "../src/index.js";

// Mock streaming provider adapter
class MockStreamingProvider implements ProviderAdapter {
  readonly providerId: string;
  readonly isTestProvider = true;

  constructor(providerId = "codeforge") {
    this.providerId = providerId;
  }

  async *streamChat(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "CodeForge Cloud is " };
    yield { type: "text_delta", delta: "analyzing the repository architecture." };
    yield { type: "usage", usage: { inputTokens: 50, outputTokens: 20 } };
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

describe("Cloud AI Gateway Service", () => {
  let db: CloudDatabase;
  let entitlementService: EntitlementService;
  let usageEngine: UsageEngine;
  let firewallManager: CloudFirewallManager;
  let gateway: GatewayService;

  beforeEach(() => {
    db = new CloudDatabase({ dbPath: ":memory:" });
    entitlementService = new EntitlementService(db);
    usageEngine = new UsageEngine(db);
    firewallManager = new CloudFirewallManager();

    // Register a verified free model and mock adapter
    const freeModel = createGenericFreeRecord();
    firewallManager.registerModel(freeModel);
    firewallManager.providerCatalog.register(new MockStreamingProvider(freeModel.providerId));

    gateway = new GatewayService({
      firewallManager,
      entitlementService,
      usageEngine,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("routes, reserves budget, streams assistant response, and reconciles ledger", async () => {
    const user = db.createUser({ displayName: "Dev1", primaryIdentity: "github:123" });
    db.setEntitlement(user.id, "HOSTED_FREE", "true");
    db.appendLedgerEvent({
      userId: user.id,
      amount: 100_000,
      eventType: "FREE_ALLOWANCE_GRANTED",
    });

    const events: HostedStreamEvent[] = [];
    const result = await gateway.executeHostedInference(
      user.id,
      {
        requestId: "req-e2e-1",
        messages: [{ role: "user", content: "Explain the architecture of this repo" }],
        modelId: "auto",
        taskType: "coding",
      },
      (e) => events.push(e),
    );

    expect(result.fullText).toBe("CodeForge Cloud is analyzing the repository architecture.");
    expect(result.creditsConsumed).toBeGreaterThan(0);
    expect(result.balanceAfter).toBeLessThan(100_000);

    // Verify stream events
    expect(events.some((e) => e.type === "assistant.message.started")).toBe(true);
    expect(events.some((e) => e.type === "assistant.message.delta")).toBe(true);
    expect(events.some((e) => e.type === "assistant.message.completed")).toBe(true);
    expect(events.some((e) => e.type === "turn.completed")).toBe(true);

    // Verify ledger balance updated
    expect(db.getCreditBalance(user.id)).toBe(result.balanceAfter);
  });

  it("fails closed BEFORE provider call when free quota is exhausted", async () => {
    const user = db.createUser({ displayName: "EmptyDev", primaryIdentity: "github:456" });
    db.setEntitlement(user.id, "HOSTED_FREE", "true");
    // 0 credits

    const events: HostedStreamEvent[] = [];
    await expect(
      gateway.executeHostedInference(
        user.id,
        {
          requestId: "req-quota-1",
          messages: [{ role: "user", content: "hi" }],
          modelId: "auto",
          taskType: "coding",
        },
        (e) => events.push(e),
      ),
    ).rejects.toThrow(/used your included CodeForge hosted usage/);

    expect(events.some((e) => e.type === "turn.failed")).toBe(true);
  });

  it("enforces global operator kill-switch", async () => {
    const user = db.createUser({ displayName: "User3", primaryIdentity: "github:789" });
    db.setEntitlement(user.id, "HOSTED_FREE", "true");
    db.appendLedgerEvent({ userId: user.id, amount: 50_000, eventType: "FREE_ALLOWANCE_GRANTED" });

    firewallManager.setKillSwitches({ hostedInferenceEnabled: false });

    await expect(
      gateway.executeHostedInference(
        user.id,
        {
          requestId: "req-kill-1",
          messages: [{ role: "user", content: "hi" }],
          modelId: "auto",
          taskType: "coding",
        },
        () => {},
      ),
    ).rejects.toThrow(/disabled by operator policy/);
  });

  it("registers GEMS models as offline until real backend exists", () => {
    const check = firewallManager.firewall.verify("gems", "gems-topaz");
    expect(check.ok).toBe(false);
  });
});
