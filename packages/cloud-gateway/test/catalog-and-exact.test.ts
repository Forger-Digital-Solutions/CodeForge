import { describe, it, expect } from "vitest";
import { CloudDatabase } from "@codeforge/cloud-db";
import { EntitlementService } from "@codeforge/cloud-entitlements";
import { UsageEngine } from "@codeforge/cloud-usage";
import { createGenericFreeRecord } from "@codeforge/forge-zero";
import type { ProviderAdapter, StreamEvent } from "@codeforge/providers";
import { CloudFirewallManager, GatewayService } from "../src/index.js";

class Prov implements ProviderAdapter {
  constructor(readonly providerId: string) {}
  readonly isTestProvider = true;
  async *streamChat(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "ok" };
    yield { type: "usage", usage: { inputTokens: 3, outputTokens: 1 } };
    yield { type: "finish", finishReason: "stop" };
  }
  async healthCheck() { return { status: "available" as const }; }
  async listModels() { return []; }
  async chat() { return { id: "1", model: "m", choices: [], usage: { inputTokens: 0, outputTokens: 0 } }; }
}

describe("listHostedModels truthfully reports FREE_ALLOWANCE capacity", () => {
  it("marks a FREE_ALLOWANCE model (isFree=false) as accessClass=free and eligible", () => {
    const fm = new CloudFirewallManager();
    // Groq-style allowance model: lists a paid unit price (isFree false) but is verified free via allowance.
    fm.registerModel(
      createGenericFreeRecord({
        providerId: "groq",
        modelId: "llama-3.1-8b-instant",
        accessClass: "FREE_ALLOWANCE",
        costProfile: { inputCostPerMillion: 0.05, outputCostPerMillion: 0.08, isFree: false, paidFallbackPossible: false, paidFallbackDisabled: true, source: "groq:allowance", freeTierVerifiedAt: new Date().toISOString() },
      }),
    );
    fm.registerProvider(new Prov("groq"));

    const listed = fm.listHostedModels().find((m) => m.modelId === "llama-3.1-8b-instant")!;
    expect(listed.accessClass).toBe("free"); // not "paid"
    expect(listed.isEligibleFree).toBe(true);
  });
});

describe("Exact hosted model selection by bare modelId (no providerId)", () => {
  it("resolves a bare modelId to its provider and never substitutes another model", async () => {
    const db = new CloudDatabase({ dbPath: ":memory:" });
    const fm = new CloudFirewallManager();
    fm.registerModel(createGenericFreeRecord({ providerId: "groq", modelId: "exact-target" }));
    fm.registerProvider(new Prov("groq"));
    const gateway = new GatewayService({ firewallManager: fm, entitlementService: new EntitlementService(db), usageEngine: new UsageEngine(db), db });

    const user = db.createUser({ displayName: "Exact User", primaryIdentity: "github:exact-1" });
    db.getOrCreateCurrentUsagePeriod(user.id, 500_000);
    db.setEntitlement(user.id, "HOSTED_FREE", "true");

    const events: string[] = [];
    await gateway.executeHostedInference(
      user.id,
      { requestId: "exact-req", messages: [{ role: "user", content: "hi" }], modelId: "exact-target" },
      (e) => { if (e.type === "assistant.message.started") events.push(`${e.provider}::${e.model}`); },
    );
    expect(events[0]).toBe("groq::exact-target");

    // An unknown exact model is reported unavailable, never silently swapped.
    await expect(
      gateway.executeHostedInference(user.id, { requestId: "exact-missing", messages: [{ role: "user", content: "hi" }], modelId: "does-not-exist" }, () => {}),
    ).rejects.toThrow(/not currently available/);
    db.close();
  });
});
