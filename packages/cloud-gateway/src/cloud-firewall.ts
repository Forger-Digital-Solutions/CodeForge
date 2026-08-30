import { ForgeZero, type FreeModelRecord } from "@codeforge/forge-zero";
import { ForgeRouter } from "@codeforge/router";
import { InMemoryProviderCatalog, type ProviderAdapter } from "@codeforge/providers";

export interface CloudKillSwitchConfig {
  hostedInferenceEnabled: boolean;
  hostedFreeEnabled: boolean;
  maxRequestCostUsd: number;
  globalDailySpendLimitUsd: number;
}

export const DEFAULT_KILL_SWITCH_CONFIG: CloudKillSwitchConfig = {
  hostedInferenceEnabled: true,
  hostedFreeEnabled: true,
  maxRequestCostUsd: 2.00,
  globalDailySpendLimitUsd: 1000.00,
};

export const GEMS_MODELS: FreeModelRecord[] = [
  {
    providerId: "gems",
    modelId: "gems-topaz",
    displayName: "GEMS Topaz (Fast Autonomous)",
    tier: "gems_paid",
    freeStatus: "paid",
    freeStatusVerifiedAt: new Date().toISOString(),
    isRemote: true,
    isCloudHosted: true,
    contextWindow: 128000,
    capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    costProfile: { inputCostPerMillion: 1.0, outputCostPerMillion: 3.0, isFree: false, freeTierVerifiedAt: new Date().toISOString(), paidFallbackPossible: false, paidFallbackDisabled: true, source: "gems:internal" },
    health: { status: "offline", lastCheckedAt: new Date().toISOString() }, // OFFLINE until real backend
  },
  {
    providerId: "gems",
    modelId: "gems-sapphire",
    displayName: "GEMS Sapphire (Deep Reasoning)",
    tier: "gems_paid",
    freeStatus: "paid",
    freeStatusVerifiedAt: new Date().toISOString(),
    isRemote: true,
    isCloudHosted: true,
    contextWindow: 200000,
    capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    costProfile: { inputCostPerMillion: 3.0, outputCostPerMillion: 15.0, isFree: false, freeTierVerifiedAt: new Date().toISOString(), paidFallbackPossible: false, paidFallbackDisabled: true, source: "gems:internal" },
    health: { status: "offline", lastCheckedAt: new Date().toISOString() },
  },
  {
    providerId: "gems",
    modelId: "gems-peridot",
    displayName: "GEMS Peridot (Specialized Toolchain)",
    tier: "gems_paid",
    freeStatus: "paid",
    freeStatusVerifiedAt: new Date().toISOString(),
    isRemote: true,
    isCloudHosted: true,
    contextWindow: 128000,
    capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    costProfile: { inputCostPerMillion: 2.0, outputCostPerMillion: 8.0, isFree: false, freeTierVerifiedAt: new Date().toISOString(), paidFallbackPossible: false, paidFallbackDisabled: true, source: "gems:internal" },
    health: { status: "offline", lastCheckedAt: new Date().toISOString() },
  },
  {
    providerId: "gems",
    modelId: "gems-garnet",
    displayName: "GEMS Garnet (Ultra Architecture)",
    tier: "gems_paid",
    freeStatus: "paid",
    freeStatusVerifiedAt: new Date().toISOString(),
    isRemote: true,
    isCloudHosted: true,
    contextWindow: 1000000,
    capabilities: { text: true, coding: true, toolCalling: true, vision: true, structuredOutput: true, longContext: true },
    costProfile: { inputCostPerMillion: 5.0, outputCostPerMillion: 20.0, isFree: false, freeTierVerifiedAt: new Date().toISOString(), paidFallbackPossible: false, paidFallbackDisabled: true, source: "gems:internal" },
    health: { status: "offline", lastCheckedAt: new Date().toISOString() },
  },
];

export class CloudFirewallManager {
  public readonly firewall: ForgeZero;
  public readonly router: ForgeRouter;
  public readonly providerCatalog: InMemoryProviderCatalog;
  private killSwitches: CloudKillSwitchConfig;

  constructor(options?: { killSwitches?: Partial<CloudKillSwitchConfig> }) {
    this.firewall = new ForgeZero();
    this.router = new ForgeRouter({ firewall: this.firewall });
    this.providerCatalog = new InMemoryProviderCatalog();
    this.killSwitches = { ...DEFAULT_KILL_SWITCH_CONFIG, ...(options?.killSwitches ?? {}) };

    // Register GEMS models (always present in catalog, offline until real inference engine)
    for (const gems of GEMS_MODELS) {
      this.firewall.register(gems);
    }
  }

  getKillSwitches(): CloudKillSwitchConfig {
    return { ...this.killSwitches };
  }

  setKillSwitches(updates: Partial<CloudKillSwitchConfig>): void {
    this.killSwitches = { ...this.killSwitches, ...updates };
  }

  registerModel(model: FreeModelRecord): void {
    this.firewall.register(model);
  }

  registerProvider(adapter: ProviderAdapter): void {
    this.providerCatalog.register(adapter);
  }

  listHostedModels(): Array<{
    providerId: string;
    modelId: string;
    displayName: string;
    availability: string;
    capabilities: Record<string, boolean>;
    contextWindow: number;
    accessClass: "free" | "paid" | "gems_paid";
    isEligibleFree: boolean;
  }> {
    const records = this.firewall.allModels();
    return records.map((m) => {
      const status = m.health?.status ?? "available";
      const isFree = m.costProfile?.isFree ?? false;
      return {
        providerId: m.providerId,
        modelId: m.modelId,
        displayName: m.displayName,
        availability: status,
        capabilities: m.capabilities as Record<string, boolean>,
        contextWindow: m.contextWindow ?? 128000,
        accessClass: m.tier === "gems_paid" ? ("gems_paid" as const) : isFree ? ("free" as const) : ("paid" as const),
        isEligibleFree: isFree && status === "available",
      };
    });
  }
}
