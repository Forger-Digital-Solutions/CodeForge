import type { FreeModelRecord } from "@codeforge/forge-zero";
import type { CodeForgeOverlay, ModelRecord, NormalizedCapabilities } from "./normalized-types.js";
import { canonicalId } from "./normalized-types.js";
import type { NormalizedModelRegistry } from "./registry.js";
import { verifyZeroUnitFree } from "./overlay.js";
import { deriveAccessClass, derivePrivacyClass, getProviderPolicy } from "./provider-policy.js";

/** A model as reported by a connected provider's LIVE catalog (adapter.listModels()). */
export interface LiveModelInfo {
  modelId: string;
  isFree: boolean;
  displayName?: string;
  contextWindow?: number;
  toolCalling?: boolean;
  vision?: boolean;
  structuredOutput?: boolean;
}

export interface DiscoverResult {
  /** Verified-free FreeModelRecords, ready to register into ForgeZero. */
  records: FreeModelRecord[];
  /** Overlays written into the registry as verification evidence. */
  overlays: CodeForgeOverlay[];
  verifiedCount: number;
}

function synthCaps(live: LiveModelInfo): NormalizedCapabilities {
  const ctx = live.contextWindow ?? 0;
  return {
    text: true,
    coding: true,
    toolCalling: live.toolCalling ?? true,
    vision: live.vision ?? false,
    structuredOutput: live.structuredOutput ?? true,
    longContext: ctx >= 32000,
    reasoning: false,
  };
}

/** Build a ModelRecord from a live listing when the registry has no snapshot/live entry yet. */
export function recordFromLive(providerId: string, live: LiveModelInfo): ModelRecord {
  const policy = getProviderPolicy(providerId);
  const capabilities = synthCaps(live);
  const pricing = live.isFree
    ? { inputPerMillion: 0, outputPerMillion: 0, currency: "USD" as const }
    : { inputPerMillion: null, outputPerMillion: null, currency: "USD" as const };
  const accessClass = deriveAccessClass(providerId, pricing, capabilities, policy);
  return {
    id: canonicalId(providerId, live.modelId),
    providerId,
    modelId: live.modelId,
    displayName: live.displayName ?? live.modelId,
    upstreamSource: `${providerId}-live`,
    capabilities,
    contextWindow: live.contextWindow,
    pricing,
    accessClass,
    authMode: policy?.authMode ?? "API_KEY",
    privacyClass: derivePrivacyClass(policy, accessClass),
    status: "active",
    deprecated: false,
  };
}

/**
 * Discover + verify free models from a CONNECTED provider's live catalog.
 *
 * A model is verified-free (and thus routable by Auto) only when the live, authenticated
 * provider actually lists it at $0 — Models.dev metadata alone can never grant this. The
 * cross-check between the connected catalog and the registry IS the independent evidence.
 *
 * Returns verified-free FreeModelRecords; the caller registers them into ForgeZero.
 */
export function discoverAndVerifyFree(
  registry: NormalizedModelRegistry,
  providerId: string,
  liveModels: LiveModelInfo[],
  opts: { now?: () => Date } = {},
): DiscoverResult {
  const now = opts.now ?? (() => new Date());
  const records: FreeModelRecord[] = [];
  const overlays: CodeForgeOverlay[] = [];

  for (const live of liveModels) {
    if (!live.isFree) continue;
    let record = registry.get(providerId, live.modelId);
    if (!record) {
      record = recordFromLive(providerId, live);
    }
    const overlay = verifyZeroUnitFree(record, { confirmedByLiveCatalog: true, now });
    if (!overlay) continue; // not a zero-unit free model → not verified here
    registry.overlay.merge(overlay);
    overlays.push(overlay);
    records.push(registry.toFreeModelRecord(record, overlay));
  }

  return { records, overlays, verifiedCount: records.length };
}

/** Human-readable LIVE "Top Verified Free" report line for a bridged record. */
export function describeVerifiedFree(rec: FreeModelRecord): string {
  const price = rec.costProfile.isFree ? "$0 / $0" : `${rec.costProfile.inputCostPerMillion}/${rec.costProfile.outputCostPerMillion} per 1M`;
  const tools = rec.capabilities.toolCalling ? "tools" : "no-tools";
  const ctx = rec.contextWindow ? `${Math.round(rec.contextWindow / 1000)}k ctx` : "ctx ?";
  return `${rec.providerId}::${rec.modelId} — ${rec.accessClass ?? "?"} · ${price} · ${ctx} · ${tools} · privacy:${rec.privacyClass ?? "?"} · health:${rec.health?.status ?? "?"}`;
}
