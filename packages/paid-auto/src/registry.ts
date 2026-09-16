import type { ProviderModel } from "@codeforge/providers";

export const PAID_AUTO_VERIFIED_AT = "2026-09-16T00:00:00.000Z";

export type PaidAutoCanonicalModelId =
  | "gpt-5.6-luna"
  | "glm-5.3-flash"
  | "qwen3.8-flash"
  | "deepseek-v4.1-flash";

export type PaidAutoRouteKind = "direct" | "openrouter";
export type PaidAutoRouteId = `${PaidAutoCanonicalModelId}:direct` | `${PaidAutoCanonicalModelId}:openrouter`;

export interface PaidAutoRoute {
  routeId: PaidAutoRouteId;
  canonicalModelId: PaidAutoCanonicalModelId;
  kind: PaidAutoRouteKind;
  providerId: "openai" | "zai" | "alibaba" | "deepseek" | "openrouter";
  providerModelId: string;
  priority: 1 | 2;
  source: string;
  pricing: {
    inputCostPerMillion: number | null;
    outputCostPerMillion: number | null;
    currency: "USD";
    status: "CURRENT" | "UNKNOWN" | "STALE";
    source: string;
  };
}

export interface PaidAutoModel {
  canonicalModelId: PaidAutoCanonicalModelId;
  displayName: string;
  family: string;
  contextWindow: number;
  maxOutput: number;
  capabilities: ProviderModel["capabilities"];
  direct: PaidAutoRoute;
  fallback: PaidAutoRoute;
  verification: {
    verifiedAt: string;
    sources: string[];
  };
}

const commonCapabilities: ProviderModel["capabilities"] = {
  text: true,
  coding: true,
  toolCalling: true,
  vision: true,
  structuredOutput: true,
  longContext: true,
};

export const PAID_AUTO_MODELS: readonly PaidAutoModel[] = [
  {
    canonicalModelId: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    family: "gpt",
    contextWindow: 1_050_000,
    maxOutput: 128_000,
    capabilities: commonCapabilities,
    direct: { routeId: "gpt-5.6-luna:direct", canonicalModelId: "gpt-5.6-luna", kind: "direct", providerId: "openai", providerModelId: "gpt-5.6-luna", priority: 1, source: "https://developers.openai.com/api/docs/models/gpt-5.6-luna", pricing: { inputCostPerMillion: 0.2, outputCostPerMillion: 1.2, currency: "USD", status: "CURRENT", source: "https://developers.openai.com/api/docs/models/gpt-5.6-luna" } },
    fallback: { routeId: "gpt-5.6-luna:openrouter", canonicalModelId: "gpt-5.6-luna", kind: "openrouter", providerId: "openrouter", providerModelId: "openai/gpt-5.6-luna", priority: 2, source: "https://openrouter.ai/openai/gpt-5.6-luna", pricing: { inputCostPerMillion: null, outputCostPerMillion: null, currency: "USD", status: "UNKNOWN", source: "https://openrouter.ai/openai/gpt-5.6-luna" } },
    verification: { verifiedAt: PAID_AUTO_VERIFIED_AT, sources: ["https://developers.openai.com/api/docs/models/gpt-5.6-luna", "https://openrouter.ai/openai/gpt-5.6-luna"] },
  },
  {
    canonicalModelId: "glm-5.3-flash",
    displayName: "GLM-5.3 Flash",
    family: "glm",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    capabilities: commonCapabilities,
    direct: { routeId: "glm-5.3-flash:direct", canonicalModelId: "glm-5.3-flash", kind: "direct", providerId: "zai", providerModelId: "glm-5.3-flash", priority: 1, source: "https://docs.z.ai/guides/overview/pricing", pricing: { inputCostPerMillion: 0.15, outputCostPerMillion: 0.5, currency: "USD", status: "CURRENT", source: "https://docs.z.ai/guides/overview/pricing" } },
    fallback: { routeId: "glm-5.3-flash:openrouter", canonicalModelId: "glm-5.3-flash", kind: "openrouter", providerId: "openrouter", providerModelId: "z-ai/glm-5.3-flash", priority: 2, source: "https://openrouter.ai/z-ai/glm-5.3-flash", pricing: { inputCostPerMillion: null, outputCostPerMillion: null, currency: "USD", status: "UNKNOWN", source: "https://openrouter.ai/z-ai/glm-5.3-flash" } },
    verification: { verifiedAt: PAID_AUTO_VERIFIED_AT, sources: ["https://docs.z.ai/guides/overview/pricing", "https://openrouter.ai/z-ai/glm-5.3-flash"] },
  },
  {
    canonicalModelId: "qwen3.8-flash",
    displayName: "Qwen3.8 Flash",
    family: "qwen",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    capabilities: commonCapabilities,
    direct: { routeId: "qwen3.8-flash:direct", canonicalModelId: "qwen3.8-flash", kind: "direct", providerId: "alibaba", providerModelId: "qwen3.8-flash", priority: 1, source: "https://www.alibabacloud.com/help/en/model-studio/models", pricing: { inputCostPerMillion: 0.113, outputCostPerMillion: 0.382, currency: "USD", status: "CURRENT", source: "https://www.alibabacloud.com/help/en/model-studio/models" } },
    fallback: { routeId: "qwen3.8-flash:openrouter", canonicalModelId: "qwen3.8-flash", kind: "openrouter", providerId: "openrouter", providerModelId: "qwen/qwen3.8-flash", priority: 2, source: "https://openrouter.ai/qwen/qwen3.8-flash", pricing: { inputCostPerMillion: null, outputCostPerMillion: null, currency: "USD", status: "UNKNOWN", source: "https://openrouter.ai/qwen/qwen3.8-flash" } },
    verification: { verifiedAt: PAID_AUTO_VERIFIED_AT, sources: ["https://www.alibabacloud.com/help/en/model-studio/models", "https://openrouter.ai/qwen/qwen3.8-flash"] },
  },
  {
    canonicalModelId: "deepseek-v4.1-flash",
    displayName: "DeepSeek V4.1 Flash",
    family: "deepseek",
    contextWindow: 1_000_000,
    maxOutput: 384_000,
    capabilities: commonCapabilities,
    direct: { routeId: "deepseek-v4.1-flash:direct", canonicalModelId: "deepseek-v4.1-flash", kind: "direct", providerId: "deepseek", providerModelId: "deepseek-flash", priority: 1, source: "https://api-docs.deepseek.com/quick_start/pricing/", pricing: { inputCostPerMillion: null, outputCostPerMillion: null, currency: "USD", status: "UNKNOWN", source: "https://api-docs.deepseek.com/quick_start/pricing/" } },
    fallback: { routeId: "deepseek-v4.1-flash:openrouter", canonicalModelId: "deepseek-v4.1-flash", kind: "openrouter", providerId: "openrouter", providerModelId: "deepseek/deepseek-v4.1-flash", priority: 2, source: "https://openrouter.ai/deepseek/deepseek-v4.1-flash", pricing: { inputCostPerMillion: null, outputCostPerMillion: null, currency: "USD", status: "UNKNOWN", source: "https://openrouter.ai/deepseek/deepseek-v4.1-flash" } },
    verification: { verifiedAt: PAID_AUTO_VERIFIED_AT, sources: ["https://api-docs.deepseek.com/quick_start/pricing/", "https://openrouter.ai/deepseek/deepseek-v4.1-flash"] },
  },
] as const;

export const PAID_AUTO_MODEL_IDS = PAID_AUTO_MODELS.map((model) => model.canonicalModelId) as readonly PaidAutoCanonicalModelId[];

const modelById = new Map(PAID_AUTO_MODELS.map((model) => [model.canonicalModelId, model]));
const routeById = new Map(PAID_AUTO_MODELS.flatMap((model) => [model.direct, model.fallback]).map((route) => [route.routeId, route]));

export function paidAutoModel(canonicalModelId: string): PaidAutoModel | undefined {
  return modelById.get(canonicalModelId as PaidAutoCanonicalModelId);
}

export function paidAutoRoute(routeId: string): PaidAutoRoute | undefined {
  return routeById.get(routeId as PaidAutoRouteId);
}

export function paidAutoProviderModel(model: PaidAutoModel): ProviderModel {
  return {
    modelId: model.canonicalModelId,
    displayName: model.displayName,
    contextWindow: model.contextWindow,
    capabilities: model.capabilities,
    isFree: false,
    freeStatus: "paid",
  };
}
