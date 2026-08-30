import { ForgeZero, FREE_ACCESS_CLASSES, type AccessClass, type FreeModelRecord, type ModelHealthState, type PrivacyMode, type ProviderAvailabilityOracle } from "@codeforge/forge-zero";
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

export interface CloudFirewallManagerOptions {
  killSwitches?: Partial<CloudKillSwitchConfig>;
  /** Global privacy routing mode applied to hosted-free eligibility. Default: undefined (all classes). */
  privacyMode?: PrivacyMode;
}

export class CloudFirewallManager {
  public readonly firewall: ForgeZero;
  public readonly router: ForgeRouter;
  public readonly providerCatalog: InMemoryProviderCatalog;
  private killSwitches: CloudKillSwitchConfig;
  /** Per-provider auth/health state feeding the orphan-model oracle. */
  private readonly providerState = new Map<string, "ok" | "auth_required">();

  constructor(options?: CloudFirewallManagerOptions) {
    this.providerCatalog = new InMemoryProviderCatalog();

    // Orphan-model invariant: a hosted model is routable only when a provider adapter is registered
    // AND its credential still authenticates. A model whose provider has no adapter (GEMS, or a
    // provider whose key was revoked) is excluded from ForgeZero eligibility — never routed.
    const providerOracle: ProviderAvailabilityOracle = {
      isActive: (providerId: string): boolean => {
        if (!this.providerCatalog.get(providerId)) return false;
        return this.providerState.get(providerId) !== "auth_required";
      },
    };

    // Hosted Free is owner-sponsored ongoing free: exclude TRIAL/PROMO from the pool (fail-closed).
    this.firewall = new ForgeZero({ providerOracle, requireOngoingFree: true, privacyMode: options?.privacyMode });
    this.router = new ForgeRouter({ firewall: this.firewall });
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

  /** Model ids currently registered under a provider (excludes GEMS first-party records). */
  listProviderModelIds(providerId: string): string[] {
    return this.firewall
      .allModels()
      .filter((m) => m.providerId === providerId && m.tier !== "gems_paid")
      .map((m) => m.modelId);
  }

  /** Remove a model from the pool — used to reconcile away capacity that is no longer verified-free. */
  unregisterModel(providerId: string, modelId: string): boolean {
    return this.firewall.unregister(providerId, modelId);
  }

  registerProvider(adapter: ProviderAdapter): void {
    this.providerCatalog.register(adapter);
    if (!this.providerState.has(adapter.providerId)) {
      this.providerState.set(adapter.providerId, "ok");
    }
  }

  /**
   * Mark a provider's live health. Flips every one of its registered model records to `status`
   * (so a 401/429 provider is immediately excluded from routing) and updates the orphan oracle's
   * auth state. Health ages back to eligible once `retryAfter` elapses (rate limits) or a later
   * successful discovery re-marks it available.
   */
  markProviderHealth(providerId: string, status: ModelHealthState["status"], extra?: { retryAfter?: number; lastError?: string }): void {
    this.firewall.markProviderHealth(providerId, status, extra);
    this.providerState.set(providerId, status === "auth_required" ? "auth_required" : "ok");
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
    // Authoritative eligibility: a model is free-eligible only if it passes the full ForgeZero
    // verification (cost/allowance/health/orphan/privacy) — never a naive isFree flag, which would
    // mis-report FREE_ALLOWANCE models (Groq/Gemini) as paid and hide real capacity.
    const eligibleKeys = new Set(this.firewall.eligibleModels().map((m) => `${m.providerId}::${m.modelId}`));
    return records.map((m) => {
      const status = m.health?.status ?? "available";
      const isFreeClass =
        m.tier !== "gems_paid" &&
        ((m.accessClass !== undefined && FREE_ACCESS_CLASSES.includes(m.accessClass as AccessClass)) ||
          (m.accessClass === undefined && (m.costProfile?.isFree ?? false)));
      return {
        providerId: m.providerId,
        modelId: m.modelId,
        displayName: m.displayName,
        availability: status,
        capabilities: m.capabilities as Record<string, boolean>,
        contextWindow: m.contextWindow ?? 128000,
        accessClass: m.tier === "gems_paid" ? ("gems_paid" as const) : isFreeClass ? ("free" as const) : ("paid" as const),
        isEligibleFree: eligibleKeys.has(`${m.providerId}::${m.modelId}`) && m.tier !== "gems_paid",
      };
    });
  }
}
