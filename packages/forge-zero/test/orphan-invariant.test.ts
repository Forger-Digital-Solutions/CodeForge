import { describe, it, expect } from "vitest";
import { ForgeZero } from "../src/firewall.js";
import { createGenericFreeRecord } from "../src/catalog.js";
import type { ProviderAvailabilityOracle } from "../src/verifier.js";
import type { FreeModelRecord } from "../src/types.js";

const NOW = new Date("2026-08-29T12:00:00Z");

function freeRecord(providerId: string, modelId: string, over: Partial<FreeModelRecord> = {}): FreeModelRecord {
  const base = createGenericFreeRecord({ providerId, modelId, displayName: modelId } as Partial<FreeModelRecord>);
  return {
    ...base,
    freeStatusVerifiedAt: NOW.toISOString(),
    costProfile: { ...base.costProfile, freeTierVerifiedAt: NOW.toISOString() },
    health: { status: "available", lastCheckedAt: NOW.toISOString() },
    ...over,
  };
}

describe("Orphan-model invariant (provider must be registered + authed)", () => {
  it("excludes a model whose provider has no active adapter", () => {
    const active = new Set<string>(); // nothing registered
    const oracle: ProviderAvailabilityOracle = { isActive: (id) => active.has(id) };
    const fw = new ForgeZero({ context: { now: () => NOW }, providerOracle: oracle });
    fw.register(freeRecord("openrouter", "x/y:free"));

    // No provider registered → orphan → not eligible, not routable.
    expect(fw.eligibleModels()).toHaveLength(0);
    expect(fw.canRouteTo("openrouter", "x/y:free")).toBe(false);
    expect(fw.verify("openrouter", "x/y:free").ok).toBe(false);

    // Register the provider → becomes eligible.
    active.add("openrouter");
    expect(fw.eligibleModels().map((m) => m.modelId)).toEqual(["x/y:free"]);
    expect(fw.canRouteTo("openrouter", "x/y:free")).toBe(true);
  });

  it("without an oracle, model-policy eligibility is unchanged (backward compatible)", () => {
    const fw = new ForgeZero({ context: { now: () => NOW } });
    fw.register(freeRecord("codeforge", "free-model-1"));
    expect(fw.eligibleModels()).toHaveLength(1);
  });

  it("excludes an invalid-auth provider (health auth_required) and restores on reconnect", () => {
    const oracle: ProviderAvailabilityOracle = { isActive: () => true };
    const fw = new ForgeZero({ context: { now: () => NOW }, providerOracle: oracle });
    // 401 marks the model's provider health auth_required → excluded from routing.
    fw.register(freeRecord("openrouter", "x/y:free", { health: { status: "auth_required", lastCheckedAt: NOW.toISOString() } }));
    expect(fw.eligibleModels()).toHaveLength(0);

    // Reconnect: health becomes available again → eligible.
    fw.register(freeRecord("openrouter", "x/y:free", { health: { status: "available", lastCheckedAt: NOW.toISOString() } }));
    expect(fw.eligibleModels()).toHaveLength(1);
  });

  it("oracle marking a provider inactive (e.g. after 401) removes it from routing", () => {
    let openRouterOk = true;
    const oracle: ProviderAvailabilityOracle = { isActive: (id) => (id === "openrouter" ? openRouterOk : true) };
    const fw = new ForgeZero({ context: { now: () => NOW }, providerOracle: oracle });
    fw.register(freeRecord("openrouter", "x/y:free"));
    expect(fw.eligibleModels()).toHaveLength(1);
    openRouterOk = false; // provider auth failed
    expect(fw.eligibleModels()).toHaveLength(0);
  });
});
