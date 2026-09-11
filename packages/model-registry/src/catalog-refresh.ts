import type { FreeModelRecord } from "@codeforge/forge-zero";
import type { ProviderAdapter, ProviderCatalog, ProviderModel } from "@codeforge/providers";
import { NormalizedModelRegistry, createNormalizedRegistry, type RegistryOptions, type RefreshResultDetailed } from "./registry.js";
import { discoverAndVerifyFree, verifyAllowanceViaProbe, type LiveModelInfo, type DiscoverResult } from "./discovery.js";
import { ForgeZero } from "@codeforge/forge-zero";
import { createEightBitRuntime, type EightBitRuntime } from "@codeforge/eight-bit";
import type { ISessionPersistence } from "@codeforge/sessions";

export interface RefreshOptions {
  registry?: NormalizedModelRegistry;
  firewall?: ForgeZero;
  eightBit?: EightBitRuntime;
  persistence?: ISessionPersistence;
  providerCatalog: ProviderCatalog;
  now?: () => Date;
  /** Max models to probe for allowance verification per provider. Default 1. */
  maxAllowanceProbes?: number;
  /** Skip providers without credentials. Default true. */
  requireCredentials?: boolean;
}

export interface FullRefreshResult {
  registry: RefreshResultDetailed;
  discovery: DiscoverResult[];
  allowance: DiscoverResult[];
  registered: number;
  failed: number;
  errors: string[];
}

/**
 * Production free-model catalog refresh orchestration.
 *
 * Flow:
 *   1. Iterate connected provider adapters with credentials
 *   2. Fetch live catalog from each
 *   3. Normalize into ModelRecord facts
 *   4. Run zero-unit verification (live catalog cross-check)
 *   5. Run allowance verification (live probe) for allowance providers
 *   6. Register verified-free models into ForgeZero
 *   6. Update 8-Bit health/reliability from fresh data
 *   7. Persist refresh timestamp
 */
export class FreeModelCatalogRefresh {
  private readonly registry: NormalizedModelRegistry;
  private readonly firewall: ForgeZero;
  private readonly eightBit?: EightBitRuntime;
  private readonly persistence?: ISessionPersistence;
  private readonly providerCatalog: ProviderCatalog;
  private readonly now: () => Date;
  private readonly maxAllowanceProbes: number;
  private readonly requireCredentials: boolean;

  constructor(options: RefreshOptions) {
    this.registry = options.registry ?? createNormalizedRegistry();
    this.firewall = options.firewall ?? new ForgeZero();
    this.eightBit = options.eightBit;
    this.persistence = options.persistence;
    this.providerCatalog = options.providerCatalog;
    this.now = options.now ?? (() => new Date());
    this.maxAllowanceProbes = options.maxAllowanceProbes ?? 1;
    this.requireCredentials = options.requireCredentials ?? true;
  }

  async refresh(): Promise<FullRefreshResult> {
    const errors: string[] = [];
    let totalRegistered = 0;
    let totalFailed = 0;

    // 1. Refresh base registry from Models.dev (facts + discovery hints)
    const registryResult = await this.registry.refresh();

    // 2. For each connected provider with credentials, fetch live catalog
    const adapters = this.providerCatalog.all();
    const discoveryResults: DiscoverResult[] = [];
    const allowanceResults: DiscoverResult[] = [];

    for (const adapter of adapters) {
      if (this.requireCredentials && !this.hasCredentials(adapter.providerId)) {
        continue;
      }

      try {
        const liveModels = await adapter.listModels();
        const liveModelInfos = this.convertToLiveModelInfo(liveModels);

        // 3. Zero-unit free verification (FREE_NATIVE, FREE_ROUTED)
        const zeroUnitResult = discoverAndVerifyFree(this.registry, adapter.providerId, liveModelInfos, { now: this.now });
        discoveryResults.push(zeroUnitResult);

        // Register into ForgeZero
        for (const rec of zeroUnitResult.records) {
          this.firewall.register(rec);
          totalRegistered++;
        }

        // 4. Allowance free verification (FREE_ALLOWANCE) - probe if provider supports it
        const policy = await this.getProviderPolicy(adapter.providerId);
        if (policy?.hasAllowanceFree) {
          const allowanceResult = await this.verifyAllowanceWithProbe(adapter, liveModelInfos);
          allowanceResults.push(allowanceResult);
          for (const rec of allowanceResult.records) {
            this.firewall.register(rec);
            totalRegistered++;
          }
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        errors.push(`${adapter.providerId}: ${err}`);
        totalFailed++;
      }
    }

    // 5. Sync 8-Bit health from fresh ForgeZero state
    if (this.eightBit) {
      this.syncEightBitHealth();
    }

    // 6. Persist refresh metadata
    await this.persistRefreshMetadata(registryResult.lastUpdated ?? this.now().toISOString());

    return {
      registry: registryResult,
      discovery: discoveryResults,
      allowance: allowanceResults,
      registered: totalRegistered,
      failed: totalFailed,
      errors,
    };
  }

  private hasCredentials(providerId: string): boolean {
    // Check EnvironmentCredentialStore pattern
    const envVar = `${providerId.toUpperCase()}_API_KEY`;
    return !!process.env[envVar];
  }

  private convertToLiveModelInfo(models: ProviderModel[]): LiveModelInfo[] {
    return models.map((m) => ({
      modelId: m.modelId,
      isFree: m.isFree,
      displayName: m.displayName,
      contextWindow: m.contextWindow,
      toolCalling: m.capabilities.toolCalling,
      vision: m.capabilities.vision,
      structuredOutput: m.capabilities.structuredOutput,
    }));
  }

  private async getProviderPolicy(providerId: string) {
    // Import dynamically to avoid circular deps
    const { getProviderPolicy } = await import("./provider-policy.js");
    return getProviderPolicy(providerId);
  }

  private async verifyAllowanceWithProbe(adapter: ProviderAdapter, liveModels: LiveModelInfo[]): Promise<DiscoverResult> {
    // Build a probe function that uses the adapter to make a real request
    const probe = async (modelId: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        // Minimal chat request to test free tier access
        const req = {
          model: modelId,
          messages: [{ role: "user", content: "ping" }],
          maxTokens: 1,
        } as import("@codeforge/providers").ChatRequest;
        await adapter.chat(req);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    };

    return verifyAllowanceViaProbe(this.registry, adapter.providerId, liveModels, probe, { now: this.now });
  }

  private syncEightBitHealth(): void {
    if (!this.eightBit) return;
    const models = this.firewall.allModels();
    for (const model of models) {
      const health = model.health;
      if (health) {
        // Update 8-Bit health tracker from ForgeZero health
        // This ensures health state is consistent after refresh
        // (EightBitHealthTracker is internal; we sync via ForgeZero markProviderHealth)
        this.firewall.markProviderHealth(model.providerId, health.status, {
          retryAfter: health.retryAfter,
          lastError: health.lastError,
        });
      }
    }
  }

  private async persistRefreshMetadata(lastUpdated: string): Promise<void> {
    if (!this.persistence) return;
    try {
      await this.persistence.upsertWorkItem({
        kind: "model_catalog_refresh",
        id: `model-catalog-refresh-${Date.now()}`,
        sessionId: "global",
        lastUpdated,
        modelCount: this.registry.all().length,
        verifiedFreeCount: this.registry.freeCandidates().filter((r) => {
          const overlay = this.registry.overlay.getById(r.id);
          return overlay?.verifiedFree === true;
        }).length,
        createdAt: this.now().toISOString(),
        updatedAt: this.now().toISOString(),
      } as any);
    } catch {
      // Non-blocking
    }
  }

  /** Get the registry for external access (UI, etc.) */
  getRegistry(): NormalizedModelRegistry {
    return this.registry;
  }

  /** Get the firewall for external access */
  getFirewall(): ForgeZero {
    return this.firewall;
  }
}

export function createFreeModelCatalogRefresh(options: RefreshOptions): FreeModelCatalogRefresh {
  return new FreeModelCatalogRefresh(options);
}