import type { ProviderAdapter, ProviderCatalog, ProviderModel } from "@codeforge/providers";
import { NormalizedModelRegistry, createNormalizedRegistry, type RefreshResultDetailed } from "./registry.js";
import { discoverAndVerifyFree, verifyAllowanceViaProbe, applyLiveCapabilities, recordFromLive, type LiveModelInfo, type DiscoverResult } from "./discovery.js";
import { ForgeZero, FREE_ACCESS_CLASSES, type FreeModelRecord } from "@codeforge/forge-zero";
import {
  type EightBitRuntime,
  type EightBitRouteHealthAuthority,
  type EightBitRouteHealthLedger,
  EightBitRouteHealthLedger as RouteHealthLedgerClass,
  CatalogDriftTracker,
  type CatalogDriftEvent,
} from "@codeforge/eight-bit";
import type { ISessionPersistence } from "@codeforge/sessions";
import type { FreeCloudService } from "./free-cloud-service.js";
import { PROVIDER_DEFINITIONS } from "./provider-definitions.js";

export interface RefreshOptions {
  registry?: NormalizedModelRegistry;
  firewall?: ForgeZero;
  eightBit?: EightBitRuntime;
  routeHealth?: EightBitRouteHealthAuthority;
  routeHealthLedger?: EightBitRouteHealthLedger;
  service?: FreeCloudService;
  persistence?: ISessionPersistence;
  providerCatalog: ProviderCatalog;
  now?: () => Date;
  /** Total allowance probe calls this refresh cycle may issue across all providers. Each probe
   *  is a real provider request; the budget is shared, not per-provider. Default 1. */
  maxAllowanceProbes?: number;
  /** Skip providers without credentials. Default true. */
  requireCredentials?: boolean;
  /** Optional explicit replacement map: "providerId::oldModelId" -> "providerId::newModelId" */
  knownReplacements?: Record<string, string>;
  /** Max age of free tier verification in milliseconds before classified as STALE (default: 7 days) */
  maxVerificationAgeMs?: number;
  /** Optional drift tracker instance (if sharing across refreshes). Default new CatalogDriftTracker(). */
  driftTracker?: CatalogDriftTracker;
}

export interface FullRefreshResult {
  registry: RefreshResultDetailed;
  discovery: DiscoverResult[];
  allowance: DiscoverResult[];
  driftEvents: CatalogDriftEvent[];
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
 *   6. Detect catalog drift (appearance, disappearance, terms change, capability regression)
 *   7. Emit normalized observations to EightBitRouteHealthAuthority and durable ledger
 *   8. Register verified-free models into ForgeZero; unregister disappeared/paid models
 *   9. Sync 8-Bit health/reliability from fresh data
 *   10. Persist refresh timestamp and flush durable ledger
 */
export class FreeModelCatalogRefresh {
  private readonly registry: NormalizedModelRegistry;
  private readonly firewall: ForgeZero;
  private readonly eightBit?: EightBitRuntime;
  private readonly routeHealth?: EightBitRouteHealthAuthority;
  private routeHealthLedger?: EightBitRouteHealthLedger;
  private readonly service?: FreeCloudService;
  private readonly persistence?: ISessionPersistence;
  private readonly providerCatalog: ProviderCatalog;
  private readonly now: () => Date;
  private readonly maxAllowanceProbes: number;
  private readonly requireCredentials: boolean;
  private readonly knownReplacements: Record<string, string>;
  private readonly maxVerificationAgeMs?: number;
  private readonly driftTracker: CatalogDriftTracker;

  constructor(options: RefreshOptions) {
    this.registry = options.registry ?? createNormalizedRegistry();
    this.firewall = options.firewall ?? new ForgeZero();
    this.eightBit = options.eightBit;
    this.routeHealth = options.routeHealth ?? options.service?.getRouteHealth() ?? options.eightBit?.routeHealth;
    this.routeHealthLedger = options.routeHealthLedger ?? options.eightBit?.routeHealthLedger;
    this.service = options.service;
    this.persistence = options.persistence;
    this.providerCatalog = options.providerCatalog;
    this.now = options.now ?? (() => new Date());
    this.maxAllowanceProbes = options.maxAllowanceProbes ?? 1;
    this.requireCredentials = options.requireCredentials ?? true;
    this.knownReplacements = options.knownReplacements ?? {};
    this.maxVerificationAgeMs = options.maxVerificationAgeMs;
    this.driftTracker = options.driftTracker ?? new CatalogDriftTracker();

    if (this.routeHealth && !this.routeHealthLedger && this.persistence) {
      this.routeHealthLedger = new RouteHealthLedgerClass(this.persistence);
      this.routeHealthLedger.attach(this.routeHealth);
    }
  }

  async refresh(): Promise<FullRefreshResult> {
    const errors: string[] = [];
    let totalRegistered = 0;
    let totalFailed = 0;
    const allDriftEvents: CatalogDriftEvent[] = [];

    // Capture previous state of models from ForgeZero before this refresh cycle
    const previousModels = this.firewall.allModels();

    // 1. Refresh base registry from Models.dev (facts + discovery hints)
    const registryResult = await this.registry.refresh();

    // 2. For each connected provider with credentials, fetch live catalog
    const adapters = this.providerCatalog.all();
    const discoveryResults: DiscoverResult[] = [];
    const allowanceResults: DiscoverResult[] = [];
    const refreshedProviders = new Set<string>();
    const refreshedRecords: FreeModelRecord[] = [];
    // Total refresh-cycle probe budget — allowance probes are real provider requests, so one
    // shared counter bounds the cycle rather than letting every provider probe independently.
    let allowanceProbesRemaining = this.maxAllowanceProbes;

    for (const adapter of adapters) {
      if (this.requireCredentials && !this.hasCredentials(adapter.providerId)) {
        continue;
      }

      try {
        const liveModels = await adapter.listModels();
        const liveModelInfos = this.convertToLiveModelInfo(liveModels);
        refreshedProviders.add(adapter.providerId);

        // 3. Zero-unit free verification (FREE_NATIVE, FREE_ROUTED)
        const zeroUnitResult = discoverAndVerifyFree(this.registry, adapter.providerId, liveModelInfos, { now: this.now });
        discoveryResults.push(zeroUnitResult);

        // 4. Allowance free verification (FREE_ALLOWANCE) - probe if provider supports it
        let allowanceResult: DiscoverResult | undefined;
        const policy = await this.getProviderPolicy(adapter.providerId);
        if (policy?.hasAllowanceFree && allowanceProbesRemaining > 0) {
          allowanceProbesRemaining--;
          allowanceResult = await this.verifyAllowanceWithProbe(adapter, liveModelInfos);
          allowanceResults.push(allowanceResult);
        }

        const allowanceRecords = allowanceResult?.records ?? [];
        const allowanceModelIds = new Set(allowanceRecords.map((r) => r.modelId));
        for (const rec of zeroUnitResult.records) {
          if (!allowanceModelIds.has(rec.modelId)) {
            refreshedRecords.push(rec);
          }
        }
        for (const rec of allowanceRecords) {
          refreshedRecords.push(rec);
        }

        // Check for models that are still present in live catalog but are no longer free (terms changed to paid)
        const verifiedIds = new Set([
          ...zeroUnitResult.records.map((r) => r.modelId),
          ...allowanceRecords.map((r) => r.modelId),
        ]);
        const prevForAdapter = previousModels.filter((m) => m.providerId === adapter.providerId);
        for (const prev of prevForAdapter) {
          if (!verifiedIds.has(prev.modelId)) {
            const liveMatch = liveModelInfos.find((l) => l.modelId === prev.modelId);
            if (liveMatch && !liveMatch.isFree) {
              const known = this.registry.get(adapter.providerId, prev.modelId);
              const record = known
                ? applyLiveCapabilities(known, liveMatch)
                : recordFromLive(adapter.providerId, liveMatch);
              const paidRecord = this.registry.toFreeModelRecord({
                ...record,
                accessClass: "PAID",
                pricing: { inputPerMillion: 1, outputPerMillion: 1, currency: "USD" },
              });
              refreshedRecords.push(paidRecord);
            }
          }
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        // R46 §23: some free pools (Cloudflare Workers AI) expose no catalog listing — the
        // provider definition's declared allowanceModels is their documented discovery source.
        // Probe-verify that declared set instead of silently contributing zero routes.
        const declared = PROVIDER_DEFINITIONS[adapter.providerId]?.freeAccess?.allowanceModels ?? [];
        const policy = await this.getProviderPolicy(adapter.providerId).catch(() => undefined);
        if (declared.length > 0 && policy?.hasAllowanceFree) {
          if (allowanceProbesRemaining <= 0) {
            errors.push(`${adapter.providerId}: catalog listing unsupported (${err.slice(0, 120)}) — allowance verification skipped because the refresh probe budget is exhausted`);
            continue;
          }
          allowanceProbesRemaining--;
          const declaredInfos: LiveModelInfo[] = declared.map((modelId) => ({ modelId, isFree: false }));
          const allowanceResult = await this.verifyAllowanceWithProbe(adapter, declaredInfos);
          allowanceResults.push(allowanceResult);
          for (const rec of allowanceResult.records) refreshedRecords.push(rec);
          refreshedProviders.add(adapter.providerId);
          errors.push(`${adapter.providerId}: catalog listing unsupported (${err.slice(0, 120)}) — verified declared allowlist via probe`);
          continue;
        }
        errors.push(`${adapter.providerId}: ${err}`);
        totalFailed++;
        // NOTE: If listModels failed (e.g. temporary provider outage or network drop), adapter.providerId
        // was NOT added to refreshedProviders. That provider's models are NOT treated as disappeared!
        // Record temporary outage condition rather than permanent retirement.
        if (this.routeHealth) {
          const outageModels = previousModels.filter((m) => m.providerId === adapter.providerId);
          for (const m of outageModels) {
            this.routeHealth.observe({
              providerId: m.providerId,
              modelId: m.modelId,
              kind: "call_failure",
              reason: "PROVIDER_OUTAGE",
              source: "registry",
              observedAt: this.now().toISOString(),
              message: `Catalog refresh failed: ${err}`,
            });
          }
        }
      }
    }

    // 5. Detect catalog drift across the providers that were successfully refreshed
    if (refreshedProviders.size > 0) {
      const previousRefreshedModels = previousModels.filter((m) => refreshedProviders.has(m.providerId));

      const detectedDrift = this.driftTracker.detectCatalogDrift({
        previousModels: previousRefreshedModels,
        currentModels: refreshedRecords,
        knownReplacements: this.knownReplacements,
        maxVerificationAgeMs: this.maxVerificationAgeMs,
      });

      allDriftEvents.push(...detectedDrift);

      // Emit normalized catalog observations to the route health authority
      this.emitCatalogDriftToRouteHealth(detectedDrift);

      // Register fresh models into ForgeZero (only zero-cash verified models!)
      for (const rec of refreshedRecords) {
        if (rec.accessClass !== undefined && (FREE_ACCESS_CLASSES as readonly string[]).includes(rec.accessClass)) {
          this.firewall.register(rec);
          totalRegistered++;
        }
      }

      // For models that disappeared, were replaced, or whose terms revoked free status:
      for (const event of detectedDrift) {
        if (event.driftKind === "ROUTE_DISAPPEARED" || event.driftKind === "ROUTE_RENAMED_OR_REPLACED") {
          this.firewall.unregister(event.providerId, event.modelId);
          this.service?.invalidateReceipt(event.providerId, event.modelId);
        } else if (event.driftKind === "FREE_TERMS_CHANGED") {
          const evidence = event.evidence as { currentAccessClass?: string; currentIsFree?: boolean } | undefined;
          const currentClass = evidence?.currentAccessClass;
          const isFree = currentClass ? (FREE_ACCESS_CLASSES as readonly string[]).includes(currentClass) : (evidence?.currentIsFree ?? false);
          if (!isFree) {
            this.firewall.unregister(event.providerId, event.modelId);
            this.service?.invalidateReceipt(event.providerId, event.modelId);
          }
        }
      }
    }

    // 6. Sync 8-Bit health from fresh ForgeZero state
    if (this.eightBit) {
      this.syncEightBitHealth();
    }

    // 7. Flush durable ledger if present
    if (this.routeHealthLedger) {
      await this.routeHealthLedger.flush();
    }

    // 8. Persist refresh metadata
    await this.persistRefreshMetadata(registryResult.lastUpdated ?? this.now().toISOString());

    return {
      registry: registryResult,
      discovery: discoveryResults,
      allowance: allowanceResults,
      driftEvents: allDriftEvents,
      registered: totalRegistered,
      failed: totalFailed,
      errors,
    };
  }

  private emitCatalogDriftToRouteHealth(driftEvents: CatalogDriftEvent[]): void {
    if (!this.routeHealth) return;
    const nowIso = this.now().toISOString();

    for (const event of driftEvents) {
      switch (event.driftKind) {
        case "ROUTE_DISAPPEARED":
          this.routeHealth.observe({
            providerId: event.providerId,
            modelId: event.modelId,
            kind: "catalog",
            fact: "not_found",
            source: "registry",
            observedAt: event.timestamp ?? nowIso,
          });
          break;

        case "ROUTE_RENAMED_OR_REPLACED":
          this.routeHealth.observe({
            providerId: event.providerId,
            modelId: event.modelId,
            kind: "catalog",
            fact: "retired",
            source: "registry",
            observedAt: event.timestamp ?? nowIso,
          });
          if (event.replacementRoute) {
            this.routeHealth.observe({
              providerId: event.replacementRoute.providerId,
              modelId: event.replacementRoute.modelId,
              kind: "catalog",
              fact: "present",
              source: "registry",
              observedAt: event.timestamp ?? nowIso,
            });
          }
          break;

        case "ROUTE_APPEARED":
          this.routeHealth.observe({
            providerId: event.providerId,
            modelId: event.modelId,
            kind: "catalog",
            fact: "present",
            source: "registry",
            observedAt: event.timestamp ?? nowIso,
          });
          break;

        case "FREE_TERMS_CHANGED": {
          const evidence = event.evidence as { previousIsFree?: boolean; currentIsFree?: boolean; currentAccessClass?: string } | undefined;
          const currentClass = evidence?.currentAccessClass;
          const isFree = currentClass ? (FREE_ACCESS_CLASSES as readonly string[]).includes(currentClass) : (evidence?.currentIsFree ?? false);
          this.routeHealth.observe({
            providerId: event.providerId,
            modelId: event.modelId,
            kind: "catalog",
            fact: isFree ? "present" : "access_restricted",
            source: "registry",
            observedAt: event.timestamp ?? nowIso,
          });
          break;
        }

        case "CAPABILITIES_CHANGED": {
          const evidence = event.evidence as {
            previousCapabilities?: { toolCalling?: boolean };
            currentCapabilities?: { toolCalling?: boolean };
          } | undefined;
          if (evidence?.previousCapabilities?.toolCalling && !evidence.currentCapabilities?.toolCalling) {
            this.routeHealth.observe({
              providerId: event.providerId,
              modelId: event.modelId,
              kind: "role_outcome",
              role: "CODER",
              outcome: "role_failed",
              source: "registry",
              observedAt: event.timestamp ?? nowIso,
            });
            this.routeHealth.observe({
              providerId: event.providerId,
              modelId: event.modelId,
              kind: "role_outcome",
              role: "TOOL_AGENT",
              outcome: "role_failed",
              source: "registry",
              observedAt: event.timestamp ?? nowIso,
            });
          }
          break;
        }

        case "ROUTE_STALE":
          this.routeHealth.observe({
            providerId: event.providerId,
            modelId: event.modelId,
            kind: "catalog",
            fact: "billing_unverifiable",
            source: "registry",
            observedAt: event.timestamp ?? nowIso,
          });
          break;

        default:
          break;
      }
    }
  }

  getDriftTracker(): CatalogDriftTracker {
    return this.driftTracker;
  }

  getRouteHealth(): EightBitRouteHealthAuthority | undefined {
    return this.routeHealth;
  }

  getRouteHealthLedger(): EightBitRouteHealthLedger | undefined {
    return this.routeHealthLedger;
  }

  private hasCredentials(providerId: string): boolean {
    // Prefer the provider definition's declared env aliases — the computed
    // `<ID>_API_KEY` convention produces unsettable names for dashed ids like
    // cloudflare-workers-ai and misses documented aliases like CLOUDFLARE_API_KEY.
    const def = PROVIDER_DEFINITIONS[providerId];
    if (def) {
      const aliases = def.connection.fields.flatMap((f) => f.environmentAliases);
      if (aliases.length > 0) return aliases.some((name) => !!process.env[name]);
    }
    return !!process.env[`${providerId.toUpperCase()}_API_KEY`];
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