import crypto from "node:crypto";
import { FORGE_GREEN_CACHE_SCHEMA_VERSION } from "./canonical-cache.js";
import { FORGE_GREEN_POLICY_VERSION, FORGE_GREEN_FEATURE_VERSION } from "./constants.js";

/**
 * FG-1E ForgeGreen efficiency ledger.
 *
 * The ledger is observational only. It never grants a permission, resolves an approval,
 * waives verification, or contributes to a completion decision. Savings claims are honest:
 * every event carries an accuracy classification — `measured` (provider/deterministically
 * attributable), `estimated` (bounded heuristic), or `unknown` (detected but not quantifiable).
 * Events carry operational quantities, identities, hashes, and reason codes only — never
 * secret material, prompt text, conversation history, reasoning, or raw tool output.
 */

export type EfficiencyMeasurement = "measured" | "estimated" | "unknown";

export type ForgeGreenMechanism =
  | "provider_prompt_cache"
  | "local_prompt_prefix_cache"
  | "tool_output_compression"
  | "duplicate_suppression"
  | "no_progress_interruption"
  | "canonical_analysis_cache"
  | "context_reuse"
  | "request_dedupe"
  | "fallback"
  | "repository_intelligence"
  | "risk_analysis"
  | "model_failover";

export interface EfficiencyLedgerEvent {
  mechanism: ForgeGreenMechanism;
  measurement: EfficiencyMeasurement;
  quantity?: number;
  unit?: "bytes" | "tokens" | "count";
  /** Short reason code; never free-form content. */
  reason?: string;
}

export interface ForgeGreenLedgerTotals {
  bytesAvoidedMeasured: number;
  tokensAvoidedMeasured: number;
  eventsWithUnknownQuantity: number;
  duplicateActionsSuppressed: number;
  noProgressInterruptions: number;
  canonicalCacheHits: number;
  canonicalCacheMisses: number;
  canonicalCacheInvalidations: number;
  avoidedModelRequests: number;
  avoidedToolDispatches: number;
  fallbackEvents: number;
  /** FG-2: files reparsed by repository intelligence (work done). */
  repositoryFilesReparsed: number;
  /** FG-2: files whose persisted intelligence was reused without reparsing (work avoided). */
  repositoryFilesReused: number;
  /** FG-2: content-addressed parse-cache hits inside repository intelligence. */
  repositoryParseCacheHits: number;
  /** FG-2: dependents re-resolved because a resolved dependency target was deleted. */
  repositoryInvalidations: number;
  /** 8-Bit: cross-provider/model rotations performed during an active run. */
  modelFailoverRotations: number;
  /** 8-Bit: routing decisions that stopped short of a paid/unknown-cost dispatch because no
   * eligible free route existed (NO_ELIGIBLE_FREE_MODEL) — evidence of the free boundary
   * holding, not a savings claim. */
  modelFailoverBlockedDispatches: number;
  /** FG-3D: Context Pages served from the persistent cross-session/cross-worktree page cache
   * without recomputing from RepositoryIntelligence (work avoided). */
  contextPagesReused: number;
  /** FG-3D: Context Pages freshly built from RepositoryIntelligence this run (work done). */
  contextPagesPulled: number;
  /** FG-4: deterministic structural-risk analyses performed. */
  riskAnalyses: number;
  /** FG-4: structural-risk results served from the canonical cache. */
  riskCacheHits: number;
  /** FG-4: structural-risk cache misses/recomputations. */
  riskCacheMisses: number;
  /** FG-4: advisory capability escalations recommended by structural evidence. */
  riskRoleEscalations: number;
  /** FG-4: advisory context breadth expansions recommended by structural evidence. */
  riskContextExpansions: number;
}

export interface ForgeGreenLedgerIdentity {
  runId: string;
  operation: string;
  namespace: string;
  sessionId?: string;
  agentId?: string;
  turnId?: string;
  executionRevision?: string;
  workstreamScope?: string;
  policyVersion?: string;
  featureVersion?: string;
}

export interface ForgeGreenLedgerRecord {
  ledgerSchemaVersion: string;
  ledgerId: string;
  identity: ForgeGreenLedgerIdentity;
  events: EfficiencyLedgerEvent[];
  totals: ForgeGreenLedgerTotals;
  policyVersion: string;
  featureVersion: string;
  createdAt: string;
}

export const FORGE_GREEN_LEDGER_SCHEMA_VERSION = FORGE_GREEN_CACHE_SCHEMA_VERSION;

function emptyTotals(): ForgeGreenLedgerTotals {
  return {
    bytesAvoidedMeasured: 0,
    tokensAvoidedMeasured: 0,
    eventsWithUnknownQuantity: 0,
    duplicateActionsSuppressed: 0,
    noProgressInterruptions: 0,
    canonicalCacheHits: 0,
    canonicalCacheMisses: 0,
    canonicalCacheInvalidations: 0,
    avoidedModelRequests: 0,
    avoidedToolDispatches: 0,
    fallbackEvents: 0,
    repositoryFilesReparsed: 0,
    repositoryFilesReused: 0,
    repositoryParseCacheHits: 0,
    repositoryInvalidations: 0,
    modelFailoverRotations: 0,
    modelFailoverBlockedDispatches: 0,
    contextPagesReused: 0,
    contextPagesPulled: 0,
    riskAnalyses: 0,
    riskCacheHits: 0,
    riskCacheMisses: 0,
    riskRoleEscalations: 0,
    riskContextExpansions: 0,
  };
}

function clampQuantity(quantity: number | undefined): number {
  return typeof quantity === "number" && Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 0;
}

export class ForgeGreenLedgerCollector {
  private readonly events: EfficiencyLedgerEvent[] = [];
  private readonly totals = emptyTotals();

  constructor(private readonly identity: ForgeGreenLedgerIdentity) {}

  record(event: EfficiencyLedgerEvent): void {
    this.events.push(event);
    const quantity = clampQuantity(event.quantity);
    switch (event.mechanism) {
      case "provider_prompt_cache":
      case "local_prompt_prefix_cache":
        if (event.measurement === "measured" && event.unit === "tokens") this.tokensAvoidedMeasured(quantity);
        else if (event.measurement === "unknown") this.noteUnknown();
        break;
      case "tool_output_compression":
        if (event.unit === "bytes") this.totals.bytesAvoidedMeasured += quantity;
        else if (event.measurement === "unknown") this.noteUnknown();
        break;
      case "duplicate_suppression":
        this.totals.duplicateActionsSuppressed += 1;
        this.totals.avoidedToolDispatches += 1;
        break;
      case "no_progress_interruption":
        this.totals.noProgressInterruptions += 1;
        break;
      case "canonical_analysis_cache":
        if (event.reason === "hit") this.totals.canonicalCacheHits += 1;
        else if (event.reason === "miss") this.totals.canonicalCacheMisses += 1;
        else if (event.reason?.startsWith("invalidated")) this.totals.canonicalCacheInvalidations += 1;
        break;
      case "request_dedupe":
        this.totals.avoidedModelRequests += 1;
        break;
      case "context_reuse":
        if (event.reason === "page_reused") this.totals.contextPagesReused += quantity;
        else if (event.reason === "page_pulled") this.totals.contextPagesPulled += quantity;
        else if (event.measurement === "measured" && event.unit === "tokens") this.tokensAvoidedMeasured(quantity);
        else if (event.measurement === "unknown") this.noteUnknown();
        break;
      case "fallback":
        this.totals.fallbackEvents += 1;
        break;
      case "repository_intelligence":
        if (event.reason === "files_parsed") this.totals.repositoryFilesReparsed += quantity;
        else if (event.reason === "files_reused") this.totals.repositoryFilesReused += quantity;
        else if (event.reason === "parse_cache_hits") this.totals.repositoryParseCacheHits += quantity;
        else if (event.reason === "dependent_revalidation") this.totals.repositoryInvalidations += quantity;
        else if (event.measurement === "unknown") this.noteUnknown();
        break;
      case "risk_analysis":
        if (event.reason === "analysis") this.totals.riskAnalyses += quantity;
        else if (event.reason === "cache_hit") this.totals.riskCacheHits += quantity;
        else if (event.reason === "cache_miss") this.totals.riskCacheMisses += quantity;
        else if (event.reason === "role_escalation") this.totals.riskRoleEscalations += quantity;
        else if (event.reason === "context_expansion") this.totals.riskContextExpansions += quantity;
        break;
      case "model_failover":
        if (event.reason === "rotated") this.totals.modelFailoverRotations += 1;
        else if (event.reason === "no_eligible_route") this.totals.modelFailoverBlockedDispatches += 1;
        break;
    }
  }

  private tokensAvoidedMeasured(quantity: number): void {
    this.totals.tokensAvoidedMeasured += quantity;
  }

  private noteUnknown(): void {
    this.totals.eventsWithUnknownQuantity += 1;
  }

  recordToolCompression(originalBytes: number, compressedBytes: number, applied: boolean): void {
    if (!applied) return;
    this.record({ mechanism: "tool_output_compression", measurement: "measured", quantity: Math.max(0, originalBytes - compressedBytes), unit: "bytes" });
  }

  recordProviderPromptCache(cachedInputTokens?: number, cacheWriteTokens?: number): void {
    if (typeof cachedInputTokens === "number" && cachedInputTokens > 0) {
      this.record({ mechanism: "provider_prompt_cache", measurement: "measured", quantity: cachedInputTokens, unit: "tokens", reason: "provider_reported" });
    } else {
      this.record({ mechanism: "provider_prompt_cache", measurement: "unknown", reason: typeof cacheWriteTokens === "number" && cacheWriteTokens > 0 ? "cache_write_only" : "telemetry_absent" });
    }
  }

  recordDuplicateSuppressed(): void {
    this.record({ mechanism: "duplicate_suppression", measurement: "measured", quantity: 1, unit: "count", reason: "identical_read_unchanged_state" });
  }

  recordNoProgressInterruption(reason: string): void {
    this.record({ mechanism: "no_progress_interruption", measurement: "measured", quantity: 1, unit: "count", reason: reason.slice(0, 120) });
  }

  recordCanonicalCacheHit(): void {
    this.record({ mechanism: "canonical_analysis_cache", measurement: "measured", quantity: 1, unit: "count", reason: "hit" });
  }

  recordCanonicalCacheMiss(): void {
    this.record({ mechanism: "canonical_analysis_cache", measurement: "measured", quantity: 1, unit: "count", reason: "miss" });
  }

  recordCanonicalCacheInvalidation(reason: string): void {
    this.record({ mechanism: "canonical_analysis_cache", measurement: "measured", quantity: 1, unit: "count", reason: `invalidated:${reason.slice(0, 80)}` });
  }

  /** FG-2: observational repository-analysis metrics from the latest refresh or full index. */
  recordRepositoryRefresh(metrics: { filesParsed: number; filesReused: number; parseCacheHits: number; invalidations: number }): void {
    if (metrics.filesParsed > 0) this.record({ mechanism: "repository_intelligence", measurement: "measured", quantity: metrics.filesParsed, unit: "count", reason: "files_parsed" });
    if (metrics.filesReused > 0) this.record({ mechanism: "repository_intelligence", measurement: "measured", quantity: metrics.filesReused, unit: "count", reason: "files_reused" });
    if (metrics.parseCacheHits > 0) this.record({ mechanism: "repository_intelligence", measurement: "measured", quantity: metrics.parseCacheHits, unit: "count", reason: "parse_cache_hits" });
    if (metrics.invalidations > 0) this.record({ mechanism: "repository_intelligence", measurement: "measured", quantity: metrics.invalidations, unit: "count", reason: "dependent_revalidation" });
  }

  recordRequestDeduped(): void {
    this.record({ mechanism: "request_dedupe", measurement: "measured", quantity: 1, unit: "count", reason: "in_flight_or_completed_match" });
  }

  recordFallback(reason: string): void {
    this.record({ mechanism: "fallback", measurement: "measured", quantity: 1, unit: "count", reason: reason.slice(0, 120) });
  }

  /** 8-Bit: a cross-provider/model rotation actually occurred during an active run. */
  recordModelFailoverRotation(): void {
    this.record({ mechanism: "model_failover", measurement: "measured", quantity: 1, unit: "count", reason: "rotated" });
  }

  /** 8-Bit: routing correctly refused to dispatch because no free-eligible route existed
   * (the free-policy boundary holding under pressure — observational, not a savings claim). */
  recordModelFailoverBlocked(): void {
    this.record({ mechanism: "model_failover", measurement: "measured", quantity: 1, unit: "count", reason: "no_eligible_route" });
  }

  /** FG-3D: Context Pages served from the persistent page cache this run (a count, not an
   * estimate — a page either hit the cache or it did not). */
  recordContextPagesReused(count: number): void {
    if (count > 0) this.record({ mechanism: "context_reuse", measurement: "measured", quantity: count, unit: "count", reason: "page_reused" });
  }

  /** FG-3D: Context Pages freshly built (not reused) this run. */
  recordContextPagesPulled(count: number): void {
    if (count > 0) this.record({ mechanism: "context_reuse", measurement: "measured", quantity: count, unit: "count", reason: "page_pulled" });
  }

  snapshot(): ForgeGreenLedgerRecord {
    const createdAt = new Date().toISOString();
    const record = {
      ledgerSchemaVersion: FORGE_GREEN_LEDGER_SCHEMA_VERSION,
      identity: this.identity,
      events: [...this.events],
      totals: { ...this.totals },
      policyVersion: this.identity.policyVersion ?? FORGE_GREEN_POLICY_VERSION,
      featureVersion: this.identity.featureVersion ?? FORGE_GREEN_FEATURE_VERSION,
      createdAt,
    };
    const ledgerId = crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex").slice(0, 24);
    return { ledgerId, ...record };
  }
}

export function createForgeGreenLedgerCollector(identity: ForgeGreenLedgerIdentity): ForgeGreenLedgerCollector {
  return new ForgeGreenLedgerCollector(identity);
}
