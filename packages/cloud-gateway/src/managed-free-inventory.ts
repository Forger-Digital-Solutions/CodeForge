import { createGenericFreeRecord, type FreeModelRecord } from "@codeforge/forge-zero";

/**
 * The only upstream routes CodeForge Cloud may execute for its managed Free product.
 * This is deliberately code-reviewed inventory, not a projection of a provider's /models response.
 */
export interface ManagedFreeRoute {
  providerId: "zai" | "groq" | "cloudflare-workers-ai";
  modelId: string;
  displayName: string;
  rank: number;
  /** A provider feature with a separate price must never be enabled for this route. */
  builtInToolsFree: false;
  freePlanOnly: boolean;
  /** A missing hosted data-use/terms record blocks execution even when price is $0. */
  activation: "ready" | "policy_record_required";
  source: string;
  record(verifiedAt: string): FreeModelRecord;
}

const capabilities = { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true };

function allowanceRecord(route: Omit<ManagedFreeRoute, "record">, verifiedAt: string, limits?: FreeModelRecord["limits"]): FreeModelRecord {
  return createGenericFreeRecord({
    providerId: route.providerId,
    modelId: route.modelId,
    displayName: route.displayName,
    contextWindow: route.providerId === "zai" ? 200_000 : 131_072,
    maxOutput: route.providerId === "zai" ? 128_000 : undefined,
    capabilities,
    limits,
    accessClass: route.providerId === "zai" ? "FREE_NATIVE" : "FREE_ALLOWANCE",
    privacyClass: "standard",
    verificationSource: "managed-free-static-inventory+live-probe",
    lastVerified: verifiedAt,
    freeStatus: "verified_free",
    costProfile: {
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      isFree: true,
      freeTierVerifiedAt: verifiedAt,
      freeQuotaDescription: route.providerId === "zai" ? "Published $0 model price; no built-in tools" : "Operator-attested provider Free plan allowance; hard-stop on exhaustion",
      paidFallbackPossible: false,
      paidFallbackDisabled: true,
      source: route.source,
    },
  });
}

const zai: Omit<ManagedFreeRoute, "record"> = {
  providerId: "zai", modelId: "glm-4.7-flash", displayName: "GLM-4.7 Flash", rank: 10,
  builtInToolsFree: false, freePlanOnly: false, activation: "policy_record_required", source: "https://docs.z.ai/guides/overview/pricing",
};
const groq120: Omit<ManagedFreeRoute, "record"> = {
  providerId: "groq", modelId: "openai/gpt-oss-120b", displayName: "GPT-OSS 120B", rank: 20,
  builtInToolsFree: false, freePlanOnly: true, activation: "ready", source: "https://console.groq.com/docs/rate-limits",
};
const groq20: Omit<ManagedFreeRoute, "record"> = {
  providerId: "groq", modelId: "openai/gpt-oss-20b", displayName: "GPT-OSS 20B", rank: 30,
  builtInToolsFree: false, freePlanOnly: true, activation: "ready", source: "https://console.groq.com/docs/rate-limits",
};
const cloudflare: Omit<ManagedFreeRoute, "record"> = {
  providerId: "cloudflare-workers-ai", modelId: "@cf/zai-org/glm-4.7-flash", displayName: "GLM-4.7 Flash (Workers AI reserve)", rank: 40,
  builtInToolsFree: false, freePlanOnly: true, activation: "ready", source: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
};

export const MANAGED_FREE_INVENTORY: readonly ManagedFreeRoute[] = [
  { ...zai, record: (verifiedAt) => allowanceRecord(zai, verifiedAt) },
  { ...groq120, record: (verifiedAt) => allowanceRecord(groq120, verifiedAt, { requestsPerMinute: 30, requestsPerDay: 1000, tokensPerMinute: 8000, tokensPerDay: 200000 }) },
  { ...groq20, record: (verifiedAt) => allowanceRecord(groq20, verifiedAt, { requestsPerMinute: 30, requestsPerDay: 1000, tokensPerMinute: 8000, tokensPerDay: 200000 }) },
  { ...cloudflare, record: (verifiedAt) => allowanceRecord(cloudflare, verifiedAt) },
] as const;

export function managedRoutesFor(providerId: string): readonly ManagedFreeRoute[] {
  return MANAGED_FREE_INVENTORY.filter((route) => route.providerId === providerId);
}

export function isManagedFreeRoute(providerId: string, modelId: string): boolean {
  return MANAGED_FREE_INVENTORY.some((route) => route.providerId === providerId && route.modelId === modelId);
}
