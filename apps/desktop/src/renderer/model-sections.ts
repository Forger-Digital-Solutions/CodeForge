import type { ModelSection, ModelSelectorItem } from "@codeforge/ui";

export interface ApiModel {
  id: string;
  providerId: string;
  displayName: string;
  tier: "free" | "gems_paid" | "paid";
  freeStatus: string;
  accessClass?: string;
  contextWindow?: number;
  capabilities?: {
    text: boolean;
    coding: boolean;
    toolCalling: boolean;
    vision: boolean;
    structuredOutput: boolean;
    longContext: boolean;
  };
  costProfile?: {
    inputCostPerMillion: number;
    outputCostPerMillion: number;
    isFree: boolean;
    paidFallbackPossible: boolean;
  };
  isPromotional?: boolean;
  /** Server-authoritative ForgeZero + provider-oracle result for this exact route. */
  eligible?: boolean;
}

/**
 * Whether a route can drive CodeForge's agent loop at all. The loop executes tools through native
 * tool calls, so a $0 route without tool calling (a content-safety classifier, a music model) is
 * not a usable coding route no matter how "free" it is — offering it would only waste a request.
 */
export function canDriveAgent(m: Pick<ApiModel, "capabilities">): boolean {
  return m.capabilities?.toolCalling !== false;
}

export function selectorAvailability(m: ApiModel): { available: boolean; unavailableReason?: string } {
  if (m.eligible !== true) return { available: false, unavailableReason: "Provider or entitlement is unavailable" };
  if (!canDriveAgent(m)) return { available: false, unavailableReason: "No tool calling — cannot run agent tasks" };
  return { available: true };
}

// Muse Spark is a promotional model excluded from normal routing entirely — hide any stray record.
const HIDDEN_MODEL_RE = /muse[-\s]?spark/i;
export function isHiddenModel(id: string): boolean {
  return HIDDEN_MODEL_RE.test(id);
}

/**
 * Internal routing sentinels that must never surface as a second, confusing row next to the
 * pinned "ForgeAuto/Free" Recommended entry. "codeforge-auto" is the hosted-adapter's own alias
 * for the same automatic-routing concept the UI already represents via the "auto" model id.
 */
const INTERNAL_SENTINEL_MODEL_IDS = new Set(["codeforge-auto"]);

/**
 * CodeForge's own no-credential-required providers: the bundled generic free record
 * ("codeforge") and CodeForge Cloud's hosted, server-owned-key-backed catalog ("codeforge-cloud").
 * A model behind either of these needed no user-supplied credential to appear, so — and only
 * these — belong in the credential-free "CodeForge Free" section. A model that is merely
 * free-of-charge on a BYOK-connected provider still required the user's own credential to exist
 * at all, so it stays under that provider's own Connected/BYOK section instead.
 */
const CODEFORGE_FREE_PROVIDER_IDS = new Set(["codeforge", "codeforge-cloud"]);

/**
 * CodeForge's free-model program targets roughly the best 13 verified $0 slots, not a forced
 * exact count and not an unbounded dump of every upstream-flagged "free" model. This caps the
 * canonical "CodeForge Free" section so it stays a curated, useful list.
 */
export const MAX_CODEFORGE_FREE_MODELS = 13;

// Provider → user-facing BYOK section label. Order follows the spec's model dropdown structure.
export const PROVIDER_SECTION: Record<string, string> = {
  zai: "Z.AI",
  openrouter: "OPENROUTER",
  google: "GOOGLE",
  groq: "GROQ",
  "cloudflare-workers-ai": "CLOUDFLARE",
  anthropic: "ANTHROPIC",
  openai: "OPENAI",
};

export const SECTION_ORDER = [
  "RECOMMENDED",
  "CODEFORGE FREE",
  "GEMS",
  "Z.AI",
  "OPENROUTER",
  "GOOGLE",
  "GROQ",
  "CLOUDFLARE",
  "ANTHROPIC",
  "OPENAI",
];
export function getSectionOrder(sectionLabel: string): number {
  const idx = SECTION_ORDER.indexOf(sectionLabel);
  return idx === -1 ? 99 : idx;
}

// Honest access-status badge from the CodeForge access class — never derived from name matching.
export function accessBadge(m: ApiModel): string {
  switch (m.accessClass) {
    case "FREE_NATIVE":
      return "Free";
    case "FREE_ROUTED":
      return "Free · routed";
    case "FREE_ALLOWANCE":
      return "Free · allowance";
    case "FREE_PROMO":
      return "Promo";
    case "TRIAL":
      return "Trial";
    case "PAID": {
      const inC = m.costProfile?.inputCostPerMillion;
      const outC = m.costProfile?.outputCostPerMillion;
      return inC != null && outC != null ? `Paid · $${inC}/$${outC} per 1M` : "Paid";
    }
    default:
      return m.costProfile?.isFree ? "Free" : "Paid";
  }
}

/**
 * Buckets the live model catalog into the canonical picker sections: Recommended (ForgeAuto),
 * CodeForge Free (no credential required), GEMS (first-party paid, locked until entitled), and
 * one section per connected BYOK provider. This is the single source of truth for picker
 * grouping — the picker component itself renders whatever sections it is given rather than
 * deriving its own groups, so there is exactly one place this logic can drift.
 */
export function buildModelSections(apiModels: ApiModel[], models: ModelSelectorItem[]): ModelSection[] {
  const sectionMap = new Map<string, ModelSelectorItem[]>();
  const gemsModels: ModelSelectorItem[] = [];
  const codeforgeFreeModels: ModelSelectorItem[] = [];

  const autoAvailable = apiModels.some(
    (m) => m.eligible === true && m.freeStatus === "verified_free" && m.costProfile?.isFree === true,
  );
  const existingAutoItem = models.find((m) => m.id === "auto");
  const autoItem = {
    ...(existingAutoItem ?? {
      id: "auto",
      displayName: "ForgeAuto/Free",
      tier: "free" as const,
    }),
    available: autoAvailable,
    description: autoAvailable ? "Automatic free routing" : "No eligible free route",
    unavailableReason: autoAvailable ? undefined : "Connect a verified-free provider or sign in to CodeForge Cloud",
  };
  sectionMap.set("RECOMMENDED", [autoItem]);

  for (const m of apiModels) {
    if (isHiddenModel(m.id)) continue;
    if (INTERNAL_SENTINEL_MODEL_IDS.has(m.id)) continue;

    const availability = selectorAvailability(m);
    const selectorItem: ModelSelectorItem = {
      id: m.id,
      displayName: m.displayName,
      tier: m.tier === "gems_paid" ? "gems_paid" : "free",
      description: canDriveAgent(m) ? accessBadge(m) : `${accessBadge(m)} · No tools`,
      ...availability,
    };

    if (m.tier === "gems_paid") {
      gemsModels.push(selectorItem);
      continue;
    }

    if (CODEFORGE_FREE_PROVIDER_IDS.has(m.providerId)) {
      if (codeforgeFreeModels.length < MAX_CODEFORGE_FREE_MODELS) {
        codeforgeFreeModels.push(selectorItem);
      }
      continue;
    }

    const secName = PROVIDER_SECTION[m.providerId] || m.providerId.toUpperCase();
    const existing = sectionMap.get(secName) || [];
    existing.push(selectorItem);
    sectionMap.set(secName, existing);
  }

  if (codeforgeFreeModels.length > 0) sectionMap.set("CODEFORGE FREE", codeforgeFreeModels);
  if (gemsModels.length > 0) sectionMap.set("GEMS", gemsModels);

  const sections: ModelSection[] = [];
  const sortedKeys = Array.from(sectionMap.keys()).sort((a, b) => getSectionOrder(a) - getSectionOrder(b));
  for (const key of sortedKeys) {
    const items = sectionMap.get(key);
    if (items && items.length > 0) {
      sections.push({ sectionId: key.toLowerCase().replace(/[^a-z0-9]+/g, "-"), sectionLabel: key, models: items });
    }
  }
  return sections;
}

export interface ForgeZeroTrustStatus {
  /** True only when the active route is affirmatively known to be $0. Fails closed otherwise. */
  verifiedFree: boolean;
  label: string;
  detail: string;
}

/**
 * Resolves the header trust badge from the actually-selected route instead of a constant string.
 * ForgeAuto only ever resolves into ForgeZero-eligible (free) models by construction, so it is
 * trusted directly; any concrete model must show independently verified free status on its own
 * record. Anything else — GEMS, a BYOK paid model, or a model the catalog doesn't recognize —
 * fails closed to a truthful "not verified" state rather than defaulting to green.
 */
export function resolveForgeZeroTrust(selectedModelId: string | null, selected: ApiModel | undefined, autoAvailable = false, discovering = false): ForgeZeroTrustStatus {
  if (selectedModelId === "auto") {
    if (autoAvailable) return { verifiedFree: true, label: "ForgeZero · Verified Free", detail: "ForgeAuto/Free · Automatic free routing" };
    // While a connected provider's catalog is still being verified, "no route" is not yet a fact.
    if (discovering) return { verifiedFree: false, label: "ForgeZero · Discovering free routes…", detail: "Verifying connected providers' live catalogs" };
    return { verifiedFree: false, label: "ForgeZero · No Free Route", detail: "ForgeAuto/Free has no eligible provider right now" };
  }
  if (!selected) {
    return { verifiedFree: false, label: "ForgeZero · Unverified", detail: "No model selection recognized" };
  }
  if (selected.tier === "gems_paid") {
    return { verifiedFree: false, label: "ForgeZero · Paid (GEMS)", detail: `${selected.displayName} is a first-party paid model` };
  }
  const verified = selected.eligible === true && selected.freeStatus === "verified_free" && selected.costProfile?.isFree === true;
  if (verified) {
    return { verifiedFree: true, label: "ForgeZero · Verified Free", detail: `${selected.displayName} · verified $0` };
  }
  return { verifiedFree: false, label: "ForgeZero · Billing May Apply", detail: `${selected.displayName} is not a verified-free route` };
}

export interface RuntimeLabel {
  label: string;
  detail: string;
}

/**
 * Where the next turn will actually execute, derived from the real selected model's provider —
 * never a made-up label. "Hosted" covers anything CodeForge itself backs (its own hosted free
 * capacity, or GEMS); "Direct (BYOK)" covers a user-connected provider credential; "Auto" is
 * ForgeAuto/Free, whose concrete route is decided per task by the server.
 */
export function resolveRuntimeLabel(selectedModelId: string | null, selected: ApiModel | undefined): RuntimeLabel {
  if (selectedModelId === "auto") {
    return { label: "Auto", detail: "ForgeAuto/Free selects the best eligible free route for each task" };
  }
  if (!selected) {
    return { label: "Unknown", detail: "No model selection recognized" };
  }
  if (selected.providerId === "codeforge-cloud" || selected.providerId === "codeforge" || selected.tier === "gems_paid") {
    return { label: "Hosted", detail: `${selected.displayName} runs on CodeForge's hosted infrastructure` };
  }
  return { label: "Direct (BYOK)", detail: `${selected.displayName} runs directly against your connected ${selected.providerId} credential` };
}
