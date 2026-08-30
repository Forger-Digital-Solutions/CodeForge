import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CloudDatabase } from "@codeforge/cloud-db";
import { EntitlementService } from "@codeforge/cloud-entitlements";
import { UsageEngine } from "@codeforge/cloud-usage";
import { createGenericFreeRecord } from "@codeforge/forge-zero";
import type { ProviderAdapter, StreamEvent } from "@codeforge/providers";
import { CloudFirewallManager, GatewayService } from "../src/index.js";

class OkProvider implements ProviderAdapter {
  readonly providerId = "standard-prov";
  readonly isTestProvider = true;
  async *streamChat(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "hi" };
    yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
    yield { type: "finish", finishReason: "stop" };
  }
  async healthCheck() { return { status: "available" as const }; }
  async listModels() { return []; }
  async chat() { return { id: "1", model: "m", choices: [], usage: { inputTokens: 0, outputTokens: 0 } }; }
}

describe("Per-account privacy mode genuinely constrains hosted routing", () => {
  let db: CloudDatabase;
  let gateway: GatewayService;
  let userId: string;

  beforeEach(async () => {
    db = new CloudDatabase({ dbPath: ":memory:" });
    const firewallManager = new CloudFirewallManager();
    gateway = new GatewayService({ firewallManager, entitlementService: new EntitlementService(db), usageEngine: new UsageEngine(db), db });

    // A model served from a `standard`-privacy endpoint (typical free provider).
    firewallManager.registerModel(createGenericFreeRecord({ providerId: "standard-prov", modelId: "std-free", privacyClass: "standard" }));
    firewallManager.registerProvider(new OkProvider());

    const user = await db.createUser({ displayName: "Privacy User", primaryIdentity: "github:priv-1" });
    userId = user.id;
    await db.getOrCreateCurrentUsagePeriod(userId, 500_000);
    await db.setEntitlement(userId, "HOSTED_FREE", "true");
  });

  afterEach(() => db.close());

  it("STRICT mode excludes standard-privacy endpoints (fails closed to no free capacity)", async () => {
    await db.upsertAccountSettings({ userId, privacyMode: "STRICT" });
    await expect(
      gateway.executeHostedInference(userId, { requestId: "p-strict", messages: [{ role: "user", content: "hi" }], modelId: "auto" }, () => {}),
    ).rejects.toThrow(/No verified free model/);
  });

  it("STANDARD mode permits standard-privacy endpoints", async () => {
    await db.upsertAccountSettings({ userId, privacyMode: "STANDARD" });
    const result = await gateway.executeHostedInference(
      userId,
      { requestId: "p-standard", messages: [{ role: "user", content: "hi" }], modelId: "auto" },
      () => {},
    );
    expect(result.fullText).toBe("hi");
  });
});

