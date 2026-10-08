import { rateLimitScopeFor } from "./capacity-governor.js";

export function gatewayRateLimitScope(providerId: string, error: unknown): "model" | "provider" {
  if (!error || typeof error !== "object" || Array.isArray(error)) return "provider";
  const data = error as Record<string, unknown>;
  const message = typeof data.message === "string" ? data.message : "";
  // Kilo's own account/IP wall cannot be narrowed by model wording or upstream metadata.
  if (providerId === "kilo-free-direct" && /free.models.per|per.ip|this account|account.*limit|credit|quota/i.test(message)) return "provider";
  const inferred = rateLimitScopeFor(message);
  if (inferred === "model") return inferred;
  const metadata = data.metadata;
  if (providerId !== "kilo-free-direct" || !metadata || typeof metadata !== "object" || Array.isArray(metadata)) return "provider";
  const fields = metadata as Record<string, unknown>;
  if (typeof fields.provider_name === "string" && fields.provider_name.trim()
    && (fields.limit_source === "provider" || fields.provider_code === 429 || fields.provider_code === "429")) return "model";
  return "provider";
}

export function gatewayBodyRateLimitScope(providerId: string, body: string): "model" | "provider" {
  try {
    const parsed: unknown = JSON.parse(body);
    return gatewayRateLimitScope(providerId, parsed && typeof parsed === "object" ? (parsed as { error?: unknown }).error : undefined);
  } catch {
    return rateLimitScopeFor(body);
  }
}
