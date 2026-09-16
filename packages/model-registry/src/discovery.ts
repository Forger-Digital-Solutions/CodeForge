import type { FreeModelRecord } from "@codeforge/forge-zero";
import type { CodeForgeOverlay, ModelRecord, NormalizedCapabilities } from "./normalized-types.js";
import { canonicalId } from "./normalized-types.js";
import type { NormalizedModelRegistry } from "./registry.js";
import { verifyZeroUnitFree, verifyAllowanceFree } from "./overlay.js";
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

/** Overlay explicit live capability facts onto a registry record; untouched when nothing is stated. */
export function applyLiveCapabilities(record: ModelRecord, live: LiveModelInfo): ModelRecord {
  const capabilities = { ...record.capabilities };
  let changed = false;
  for (const key of ["toolCalling", "vision", "structuredOutput"] as const) {
    const fact = live[key];
    if (typeof fact === "boolean" && capabilities[key] !== fact) {
      capabilities[key] = fact;
      changed = true;
    }
  }
  return changed ? { ...record, capabilities } : record;
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
    if (!isNormalProductionModel(providerId, live.modelId)) continue;
    const known = registry.get(providerId, live.modelId);
    // The connected provider's own catalog is authoritative for the capabilities of the route it
    // actually serves (a ":free" variant may lack tool calling the base model advertises upstream).
    const record = known ? applyLiveCapabilities(known, live) : recordFromLive(providerId, live);
    const policy = getProviderPolicy(providerId);
    // Some direct OpenAI-compatible providers return availability-only records from `/models`.
    // Z.AI is the narrowly approved example: its authenticated listing proves this account can
    // execute the route, while a *fresh* Models.dev record supplies its documented 0/0 price.
    // Never infer this from a bundled snapshot, model name, or a provider without the explicit
    // policy flag. This keeps a stale free label from turning into a billable request.
    const freshZeroUnitPricing =
      registry.source === "live" &&
      policy?.allowLiveCatalogZeroUnitInference === true &&
      record.pricing.inputPerMillion === 0 &&
      record.pricing.outputPerMillion === 0;
    if (!live.isFree && !freshZeroUnitPricing) continue;
    const overlay = verifyZeroUnitFree(record, { confirmedByLiveCatalog: true, now });
    if (!overlay) continue; // not a zero-unit free model → not verified here
    registry.overlay.merge(overlay);
    overlays.push(overlay);
    records.push(registry.toFreeModelRecord(record, overlay));
  }

  return { records, overlays, verifiedCount: records.length };
}

export interface ProbeResult {
  ok: boolean;
  error?: string;
}

const NON_CHAT_RE = /whisper|embed|tts|\bstt\b|lyria|guard|safety|moderation|rerank/i;
const EXPERIMENTAL_MODEL_RE = /(^|[-_./:])(beta|preview|labs?)([-_./:]|$)/i;

/** Preview, beta, and Labs routes are not durable production capacity. */
export function isNormalProductionModel(providerId: string, modelId: string): boolean {
  if (providerId !== "mistral" && providerId !== "cerebras") return true;
  return !EXPERIMENTAL_MODEL_RE.test(modelId);
}

/**
 * Verify an ALLOWANCE provider's free tier by an actual no-charge probe request. Allowance
 * providers (Gemini, Groq, Cloudflare) list paid unit prices, so $0-pricing verification never
 * applies — the only honest proof is that the connected account can make a request within its free
 * quota. We probe ONE representative chat model; on success the account's chat models are marked
 * FREE_ALLOWANCE-verified. Never awarded from pricing/metadata alone.
 */
export async function verifyAllowanceViaProbe(
  registry: NormalizedModelRegistry,
  providerId: string,
  liveModels: LiveModelInfo[],
  probe: (modelId: string) => Promise<ProbeResult>,
  opts: { now?: () => Date } = {},
): Promise<DiscoverResult> {
  const now = opts.now ?? (() => new Date());
  const policy = getProviderPolicy(providerId);
  const records: FreeModelRecord[] = [];
  const overlays: CodeForgeOverlay[] = [];
  if (!policy?.hasAllowanceFree) return { records, overlays, verifiedCount: 0 };

  const candidates = liveModels.filter((m) => {
    if (NON_CHAT_RE.test(m.modelId)) return false;
    if (!isNormalProductionModel(providerId, m.modelId)) return false;
    if (policy.allowanceScope === "allowlist" && !policy.allowanceModels?.includes(m.modelId)) return false;
    if (policy.paidPlanModels?.includes(m.modelId)) return false;
    return true;
  });
  if (candidates.length === 0) return { records, overlays, verifiedCount: 0 };

  const rep =
    candidates.find((m) => /llama|instant|versatile|gemma|qwen|mixtral|gpt-oss|flash|glm/i.test(m.modelId)) ??
    candidates[0]!;
  const result = await probe(rep.modelId);
  if (!result.ok) return { records, overlays, verifiedCount: 0 };

  // Account confirmed to have free-tier access → verify the chat candidates as FREE_ALLOWANCE.
  for (const m of candidates) {
    let record = registry.get(providerId, m.modelId) ?? recordFromLive(providerId, m);
    if (record.accessClass !== "FREE_ALLOWANCE") {
      record = { ...record, accessClass: "FREE_ALLOWANCE", privacyClass: derivePrivacyClass(policy, "FREE_ALLOWANCE") };
    }
    const overlay = verifyAllowanceFree(record, { probeSucceeded: true, now, method: "live-probe" });
    if (!overlay) continue;
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
