import type { RouteQuota } from "./free-cloud-registry.js";

/**
 * Provider quota/rate-limit capture (R1 §79). Parses only what providers actually expose —
 * standard `x-ratelimit-*` headers (Groq, OpenRouter on 429, Cerebras, Mistral) and
 * `retry-after`. CodeForge never invents quota numbers.
 */
export function parseRouteQuota(headers: Iterable<[string, string]>, now: () => Date = () => new Date()): RouteQuota | undefined {
  const h = new Map<string, string>();
  for (const [k, v] of headers) h.set(k.toLowerCase(), v);
  const num = (...names: string[]): number | undefined => {
    for (const n of names) {
      const v = h.get(n);
      if (v === undefined) continue;
      const parsed = Number(v);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  };
  // Mistral names its per-minute windows x-ratelimit-*-req-minute / *-tokens-minute — measured
  // live on codestral 2026-09-24 (124/125 RPM, 624,990/625,000 TPM). Without the suffix these
  // headers parse to nothing and the route looks unmeasured instead of metered.
  const remainingRequests = num("x-ratelimit-remaining-requests", "x-ratelimit-remaining", "x-ratelimit-remaining-req-minute");
  const limitRequests = num("x-ratelimit-limit-requests", "x-ratelimit-limit", "x-ratelimit-limit-req-minute");
  const remainingTokens = num("x-ratelimit-remaining-tokens", "x-ratelimit-remaining-tokens-minute");
  const limitTokens = num("x-ratelimit-limit-tokens", "x-ratelimit-limit-tokens-minute");
  const retryAfterMs = parseRetryAfterMs(h.get("retry-after"), now);
  const resetAt = parseResetAt(h.get("x-ratelimit-reset-requests") ?? h.get("x-ratelimit-reset"), now);
  if (remainingRequests === undefined && limitRequests === undefined && remainingTokens === undefined && retryAfterMs === undefined && resetAt === undefined) {
    return undefined;
  }
  return {
    remainingRequests,
    limitRequests,
    remainingTokens,
    limitTokens,
    resetAt,
    retryAfterMs,
    observedAt: now().toISOString(),
  };
}

function parseRetryAfterMs(value: string | undefined, now: () => Date): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - now().getTime());
  return undefined;
}

/** Groq-style "2m59.56s" / "7.66s" durations, epoch millis, or ISO timestamps. */
function parseResetAt(value: string | undefined, now: () => Date): string | undefined {
  if (!value) return undefined;
  const duration = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (duration && value.length > 0) {
    const ms = (Number(duration[1] ?? 0) * 3600 + Number(duration[2] ?? 0) * 60 + Number(duration[3] ?? 0)) * 1000;
    return new Date(now().getTime() + ms).toISOString();
  }
  const n = Number(value);
  if (Number.isFinite(n)) {
    const epochMs = n > 1e12 ? n : n > 1e9 ? n * 1000 : now().getTime() + n * 1000;
    return new Date(epochMs).toISOString();
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? new Date(date).toISOString() : undefined;
}

/**
 * A declared reset that has already elapsed means the provider refilled its window — the raw
 * `remaining` is stale. Reporting it forever would strand a pool at zero with no traffic to
 * refresh the headers (no calls → no observations → still exhausted). The refilled budget is
 * the window's own declared limit, never an invented number; when no limit was observed the
 * stale remainder is kept rather than claimed as refilled.
 */
export function effectiveQuota(quota: RouteQuota | undefined, now: () => Date = () => new Date()): RouteQuota | undefined {
  if (!quota?.resetAt) return quota;
  const reset = Date.parse(quota.resetAt);
  if (!Number.isFinite(reset) || reset > now().getTime()) return quota;
  return {
    ...quota,
    remainingRequests: quota.limitRequests ?? quota.remainingRequests,
    remainingTokens: quota.limitTokens ?? quota.remainingTokens,
    resetAt: undefined,
  };
}

/** In-memory per-route quota observations, keyed `${providerId}::${modelId}`. */
export class RouteQuotaTracker {
  private readonly byRoute = new Map<string, RouteQuota>();
  private readonly byProvider = new Map<string, RouteQuota>();

  /**
   * Route-scoped recording (R15): a quota observed on a named model applies to that route ONLY.
   * Writing it into the provider bucket let one OpenRouter `:free` model's daily-cap 429 mark
   * every sibling route QUOTA_EXHAUSTED — including routes still returning 200 — and a healthy
   * response records no quota, so the false provider-level observation could never clear. The
   * provider bucket is reserved for observations with no model attached (genuinely
   * account-scoped signals), which `get` still honours as a fallback.
   */
  record(providerId: string, modelId: string | undefined, quota: RouteQuota | undefined): void {
    if (!quota) return;
    if (modelId) {
      this.byRoute.set(`${providerId}::${modelId}`, quota);
    } else {
      this.byProvider.set(providerId, quota);
    }
  }

  get(providerId: string, modelId: string): RouteQuota | undefined {
    return this.byRoute.get(`${providerId}::${modelId}`) ?? this.byProvider.get(providerId);
  }

  /** True when a genuinely account-scoped observation exists for this provider. */
  hasProviderScoped(providerId: string): boolean {
    return this.byProvider.has(providerId);
  }

  /** Model ids with a route-scoped quota observation for this provider (the measurable
   *  per-model quota domains — used to enumerate physical pools for model-domain providers). */
  providerRouteModels(providerId: string): string[] {
    const prefix = `${providerId}::`;
    const models: string[] = [];
    for (const key of this.byRoute.keys()) {
      if (key.startsWith(prefix)) models.push(key.slice(prefix.length));
    }
    return models;
  }

  /** Remaining request budget when known; undefined when the provider does not expose it. */
  remainingRequests(providerId: string, modelId: string): number | undefined {
    return this.get(providerId, modelId)?.remainingRequests;
  }
}
