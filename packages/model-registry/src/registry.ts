import type { FreeModelRecord } from "@codeforge/forge-zero";
import { FREE_ACCESS_CLASSES, ZERO_UNIT_ACCESS } from "@codeforge/forge-zero";
import type { CodeForgeOverlay, ModelRecord } from "./normalized-types.js";
import { canonicalId } from "./normalized-types.js";
import {
  fetchModelsDev,
  normalizeModelsDev,
  type FetchModelsDevOptions,
  type ModelsDevDoc,
  type NormalizeOptions,
} from "./models-dev.js";
import { MODELS_DEV_SNAPSHOT, MODELS_DEV_SNAPSHOT_CAPTURED_AT } from "./snapshot.js";
import { OverlayStore } from "./overlay.js";

export type RegistrySource = "live" | "cache" | "snapshot" | "empty";

/** Optional disk persistence for the last-good live catalog (injected by desktop/server). */
export interface CachePersistence {
  load(): { doc: ModelsDevDoc; fetchedAt: string } | null;
  save(entry: { doc: ModelsDevDoc; fetchedAt: string }): void;
}

export interface RefreshResultDetailed {
  ok: boolean;
  source: RegistrySource;
  lastUpdated: string | null;
  modelCount: number;
  error?: string;
}

export interface RegistryOptions {
  normalize?: NormalizeOptions;
  cache?: CachePersistence;
  now?: () => Date;
}

/**
 * The single normalized model registry consumed by UI and router.
 *
 *   Models.dev / live catalogs  ─▶  ModelRecord (facts)
 *                                        │
 *                              CodeForge overlay (trust)
 *                                        │
 *                                  toFreeModelRecord ─▶ ForgeZero ─▶ router / UI
 *
 * Never requires internet to launch: falls back cache → snapshot. The overlay is stored
 * separately and is the ONLY thing that can mark a model verified-free.
 */
export class NormalizedModelRegistry {
  private records = new Map<string, ModelRecord>();
  readonly overlay = new OverlayStore();
  private _source: RegistrySource = "empty";
  private _lastUpdated: string | null = null;
  private readonly opts: RegistryOptions;

  constructor(opts: RegistryOptions = {}) {
    this.opts = opts;
  }

  get source(): RegistrySource {
    return this._source;
  }
  get lastUpdated(): string | null {
    return this._lastUpdated;
  }

  private ingest(doc: ModelsDevDoc, source: RegistrySource, lastUpdated: string | null): void {
    const records = normalizeModelsDev(doc, this.opts.normalize);
    const next = new Map<string, ModelRecord>();
    for (const r of records) next.set(r.id, r);
    this.records = next;
    this._source = source;
    this._lastUpdated = lastUpdated;
  }

  /** Load the bundled offline snapshot. Safe to call at construction time. */
  loadSnapshot(): void {
    this.ingest(MODELS_DEV_SNAPSHOT, "snapshot", MODELS_DEV_SNAPSHOT_CAPTURED_AT);
  }

  /** Load a doc directly (e.g. from disk cache). */
  loadDoc(doc: ModelsDevDoc, source: RegistrySource, lastUpdated: string | null): void {
    this.ingest(doc, source, lastUpdated);
  }

  /**
   * Refresh from Models.dev live. On any failure, keep the current registry (fallback):
   * if empty, hydrate from disk cache, else from the bundled snapshot — CodeForge never loses
   * model availability because an upstream endpoint is down.
   */
  async refresh(fetchOpts: FetchModelsDevOptions = {}): Promise<RefreshResultDetailed> {
    const nowIso = (this.opts.now ?? (() => new Date()))().toISOString();
    try {
      const doc = await fetchModelsDev(fetchOpts);
      this.ingest(doc, "live", nowIso);
      this.opts.cache?.save({ doc, fetchedAt: nowIso });
      return { ok: true, source: "live", lastUpdated: nowIso, modelCount: this.records.size };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      // Fallback chain: keep current → disk cache → snapshot.
      if (this.records.size === 0) {
        const cached = this.opts.cache?.load();
        if (cached) {
          this.ingest(cached.doc, "cache", cached.fetchedAt);
        } else {
          this.loadSnapshot();
        }
      }
      return {
        ok: false,
        source: this._source,
        lastUpdated: this._lastUpdated,
        modelCount: this.records.size,
        error,
      };
    }
  }

  /** Ensure the registry is populated (cache → snapshot) without any network call. */
  ensureLoaded(): void {
    if (this.records.size > 0) return;
    const cached = this.opts.cache?.load();
    if (cached) {
      this.ingest(cached.doc, "cache", cached.fetchedAt);
    } else {
      this.loadSnapshot();
    }
  }

  all(): ModelRecord[] {
    return [...this.records.values()];
  }

  get(providerId: string, modelId: string): ModelRecord | undefined {
    return this.records.get(canonicalId(providerId, modelId));
  }

  byProvider(providerId: string): ModelRecord[] {
    return this.all().filter((r) => r.providerId === providerId);
  }

  /** Candidate free models (any free access class), before independent verification. */
  freeCandidates(): ModelRecord[] {
    return this.all().filter((r) => FREE_ACCESS_CLASSES.includes(r.accessClass));
  }

  /**
   * Bridge a normalized ModelRecord (+ its overlay) into a ForgeZero FreeModelRecord.
   * freeStatus is `verified_free` ONLY when the overlay independently verified it; otherwise
   * a free candidate is `unknown` (not eligible) — Models.dev facts alone never grant trust.
   */
  toFreeModelRecord(record: ModelRecord, overlayOverride?: CodeForgeOverlay): FreeModelRecord {
    const overlay = overlayOverride ?? this.overlay.getById(record.id);
    const isZeroUnit = ZERO_UNIT_ACCESS.includes(record.accessClass);
    const isFreeClass = FREE_ACCESS_CLASSES.includes(record.accessClass);
    const verifiedFree = overlay?.verifiedFree === true;

    const freeStatus: FreeModelRecord["freeStatus"] = verifiedFree
      ? "verified_free"
      : isFreeClass
        ? "unknown"
        : "paid";

    const health = overlay?.providerHealth
      ? mapHealth(overlay.providerHealth)
      : { status: "unknown" as const };

    return {
      providerId: record.providerId,
      modelId: record.modelId,
      displayName: record.displayName,
      freeStatus,
      freeStatusVerifiedAt: overlay?.freeVerification?.verifiedAt,
      tier: isFreeClass ? "free" : "paid",
      accessClass: record.accessClass,
      authMode: record.authMode,
      privacyClass: record.privacyClass,
      family: record.family,
      upstreamSource: record.upstreamSource,
      deprecated: record.deprecated,
      contextWindow: record.contextWindow,
      maxOutput: record.maxOutput,
      capabilities: {
        text: record.capabilities.text,
        coding: record.capabilities.coding,
        toolCalling: record.capabilities.toolCalling,
        vision: record.capabilities.vision,
        structuredOutput: record.capabilities.structuredOutput,
        longContext: record.capabilities.longContext,
      },
      costProfile: {
        inputCostPerMillion: record.pricing.inputPerMillion,
        outputCostPerMillion: record.pricing.outputPerMillion,
        cacheReadCostPerMillion: record.pricing.cacheReadPerMillion ?? undefined,
        cacheWriteCostPerMillion: record.pricing.cacheWritePerMillion ?? undefined,
        isFree: isZeroUnit,
        freeTierVerifiedAt: overlay?.freeVerification?.verifiedAt,
        paidFallbackPossible: false,
        paidFallbackDisabled: true,
        source: record.upstreamSource,
      },
      isRemote: true,
      isCloudHosted: true,
      codingScore: overlay?.codingScore,
      agentScore: overlay?.agentScore,
      toolReliability: overlay?.toolReliability,
      lastVerified: overlay?.lastVerified,
      verificationSource: overlay?.verificationSource,
      empiricalStatus: overlay?.empiricalStatus,
      health,
    };
  }

  /** Bridge all records to FreeModelRecords (for registering into ForgeZero). */
  freeModelRecords(): FreeModelRecord[] {
    return this.all().map((r) => this.toFreeModelRecord(r));
  }
}

function mapHealth(h: NonNullable<CodeForgeOverlay["providerHealth"]>): FreeModelRecord["health"] {
  const status =
    h.status === "healthy"
      ? "available"
      : h.status === "unavailable"
        ? "offline"
        : h.status; // degraded | auth_required | rate_limited | quota_exhausted | unknown
  return {
    status,
    lastCheckedAt: h.lastSuccess ?? h.lastFailure,
    retryAfter: h.retryAfter,
    recentFailureCount: h.recentFailureCount,
  };
}

export function createNormalizedRegistry(opts?: RegistryOptions): NormalizedModelRegistry {
  return new NormalizedModelRegistry(opts);
}
