import { describe, it, expect, beforeAll } from "vitest";
import { createFreeModelCatalogRefresh } from "@codeforge/model-registry";
import { createProviderCatalog, createOpenRouterAdapter, createOpencodeAdapter } from "@codeforge/providers";
import { ForgeZero } from "@codeforge/forge-zero";
import { createEightBitRuntime } from "@codeforge/eight-bit";

describe("Live Free-Model Catalog Snapshot (Integration)", () => {
  let catalog: any;
  let firewall: ForgeZero;
  let eightBit: any;

  beforeAll(() => {
    catalog = createProviderCatalog();
    
    if (process.env.OPENCODE_API_KEY) {
      const opencode = createOpencodeAdapter({ baseUrl: "https://opencode.ai/zen/v1" });
      catalog.register(opencode);
      console.log("[catalog] Registered opencode adapter");
    }

    if (process.env.OPENROUTER_API_KEY) {
      const openrouter = createOpenRouterAdapter({ baseUrl: "https://openrouter.ai/api/v1" });
      catalog.register(openrouter);
      console.log("[catalog] Registered openrouter adapter");
    }

    firewall = new ForgeZero();
    eightBit = createEightBitRuntime({ 
      firewall, 
      persistence: { 
        upsertWorkItem: async () => {}, 
        getWorkItem: async () => null, 
        deleteWorkItem: async () => {}, 
        listWorkItems: async () => [], 
        close: async () => {} 
      } as any 
    });
  });

  it("should discover and verify free models from live providers", async () => {
    const adapters = catalog.all();
    console.log(`[catalog] Testing with ${adapters.length} provider(s)`);
    
    if (adapters.length === 0) {
      console.log("[catalog] No provider credentials available - skipping live discovery");
      return;
    }

    const refresh = createFreeModelCatalogRefresh({
      firewall,
      eightBit,
      providerCatalog: catalog,
      maxAllowanceProbes: 1,
      requireCredentials: true,
    });

    console.log("[catalog] Starting live free-model catalog refresh...");
    const result = await refresh.refresh();

    console.log(`[catalog] Refresh complete:`);
    console.log(`  - Registry: ${result.registry.source} (${result.registry.modelCount} models)`);
    console.log(`  - Discovered: ${result.discovery.length} provider(s)`);
    console.log(`  - Verified free (zero-unit): ${result.discovery.reduce((s: number, d: any) => s + d.records.length, 0)}`);
    console.log(`  - Verified free (allowance): ${result.allowance.reduce((s: number, d: any) => s + d.records.length, 0)}`);
    console.log(`  - Registered in ForgeZero: ${result.registered}`);
    console.log(`  - Errors: ${result.errors.length}`);

    if (result.errors.length > 0) {
      console.log("\nErrors encountered:");
      for (const e of result.errors) {
        console.log(`  - ${e}`);
      }
    }

    // Build snapshot metadata
    const allModels = firewall.allModels();
    const verifiedFreeModels = allModels.filter((m: any) => m.freeStatus === "verified_free");
    
    console.log("\n=== VERIFIED_FREE Catalog Summary ===");
    console.log(`Total models in catalog: ${allModels.length}`);
    console.log(`Verified free models: ${verifiedFreeModels.length}`);

    if (verifiedFreeModels.length > 0) {
      console.log("\nVerified-free models:");
      for (const m of verifiedFreeModels) {
        const access = m.accessClass === "FREE_NATIVE" ? "native" : 
                      m.accessClass === "FREE_ROUTED" ? "routed" : 
                      m.accessClass === "FREE_ALLOWANCE" ? "allowance" : m.accessClass;
        console.log(`  - ${m.providerId}/${m.modelId} [${access}] ${m.displayName}`);
      }
    }

    // Store for other tests
    (globalThis as any).__LIVE_CATALOG_RESULT__ = {
      result,
      firewall,
      allModels,
      verifiedFreeModels,
    };
  }, 120000);
});