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
  // Request and token windows reset independently — providers publish separate reset headers.
  // A generic `x-ratelimit-reset` is the provider's request-window reset.
  const requestResetAt = parseResetAt(h.get("x-ratelimit-reset-requests") ?? h.get("x-ratelimit-reset"), now);
  const tokenResetAt = parseResetAt(h.get("x-ratelimit-reset-tokens"), now);
  const resetAt = earliestReset(requestResetAt, tokenResetAt);
  if (remainingRequests === undefined && limitRequests === undefined && remainingTokens === undefined && retryAfterMs === undefined && resetAt === undefined) {
    return undefined;
  }
  return {
    remainingRequests,
    limitRequests,
    remainingTokens,
    limitTokens,
    requestResetAt,
    tokenResetAt,
    resetAt,
    retryAfterMs,
    observedAt: now().toISOString(),
  };
}

/** Earliest parseable timestamp among the given resets — the compatibility aggregate. */
function earliestReset(...values: Array<string | undefined>): string | undefined {
  let best: string | undefined;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (value === undefined) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed < bestMs) {
      bestMs = parsed;
      best = value;
    }
  }
  return best;
}

function parseRetryAfterMs(value: string | undefined, now: () => Date): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - now().getTime());
  return undefined;
}

/** Groq-style "2m59.56s" / "7.66s" / "547ms" durations, epoch millis, or ISO timestamps. */
function parseResetAt(value: string | undefined, now: () => Date): string | undefined {
  if (!value) return undefined;
  const duration = value.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/);
  if (duration && value.length > 0) {
    const ms = (Number(duration[1] ?? 0) * 3600 + Number(duration[2] ?? 0) * 60 + Number(duration[3] ?? 0)) * 1000
      + Number(duration[4] ?? 0);
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
  if (!quota) return quota;
  const nowMs = now().getTime();
  const elapsed = (iso: string | undefined): boolean => {
    if (iso === undefined) return false;
    const reset = Date.parse(iso);
    return Number.isFinite(reset) && reset <= nowMs;
  };
  // resetAt on a dimension-aware observation is the aggregate (earliest active reset) — it is
  // not a second, independent reset. Only a legacy observation carrying resetAt alone may use
  // it as a per-dimension reset; otherwise one window's reset would invent the other's.
  const legacyAggregate = quota.requestResetAt === undefined && quota.tokenResetAt === undefined;
  const requestElapsed = elapsed(quota.requestResetAt ?? (legacyAggregate ? quota.resetAt : undefined));
  const tokenElapsed = elapsed(quota.tokenResetAt ?? (legacyAggregate ? quota.resetAt : undefined));
  if (!requestElapsed && !tokenElapsed) return quota;
  const requestResetAt = requestElapsed ? undefined : quota.requestResetAt;
  const tokenResetAt = tokenElapsed ? undefined : quota.tokenResetAt;
  return {
    ...quota,
    remainingRequests: requestElapsed ? quota.limitRequests ?? quota.remainingRequests : quota.remainingRequests,
    remainingTokens: tokenElapsed ? quota.limitTokens ?? quota.remainingTokens : quota.remainingTokens,
    requestResetAt,
    tokenResetAt,
    resetAt: earliestReset(requestResetAt, tokenResetAt),
  };
}

/**
 * When an exhausted route's quota recovers: the LATEST parseable reset among dimensions observed
 * at `<= 0` — request reset for request exhaustion, token reset for token exhaustion, `resetAt`
 * as the legacy fallback. A route stays unavailable until every exhausted dimension refills, so
 * the earlier reset alone must never advertise recovery.
 */
export function exhaustedQuotaResetAt(quota: RouteQuota | undefined): string | undefined {
  if (!quota) return undefined;
  let latest: string | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  const consider = (remaining: number | undefined, reset: string | undefined): void => {
    if (remaining === undefined || remaining > 0 || reset === undefined) return;
    const parsed = Date.parse(reset);
    if (!Number.isFinite(parsed) || parsed <= latestMs) return;
    latestMs = parsed;
    latest = reset;
  };
  consider(quota.remainingRequests, quota.requestResetAt ?? quota.resetAt);
  consider(quota.remainingTokens, quota.tokenResetAt ?? quota.resetAt);
  return latest;
}

/** In-memory per-route quota observations, keyed `${providerId}::${modelId}` — or
 * `${providerId}::${accountId}::${modelId}` when the caller stamps the upstream account that
 * served the response (R34 Mission B: one provider credential ≠ one quota domain; managed
 * fleets run several accounts per provider, each with independent windows). */
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
  record(providerId: string, modelId: string | undefined, quota: RouteQuota | undefined, accountId?: string): void {
    if (!quota) return;
    const account = accountId ? `${accountId}::` : "";
    if (modelId) {
      this.byRoute.set(`${providerId}::${account}${modelId}`, quota);
    } else {
      this.byProvider.set(`${providerId}::${account}`, quota);
    }
  }

  get(providerId: string, modelId: string, accountId?: string): RouteQuota | undefined {
    const account = accountId ? `${accountId}::` : "";
    // R47 §14: an account-scoped query never falls back to the unscoped bucket — evidence that
    // could not be attributed to the declared quota domain is not that domain's capacity. Two
    // managed accounts reading one unstamped bucket would double-count the same window.
    return this.byRoute.get(`${providerId}::${account}${modelId}`) ?? this.byProvider.get(`${providerId}::${account}`);
  }

  /** True when a genuinely account-scoped observation exists for this provider (optionally
   *  for one upstream account only). An unscoped provider bucket is NOT evidence for a named
   *  account — it could belong to any domain on that provider. */
  hasProviderScoped(providerId: string, accountId?: string): boolean {
    return this.byProvider.has(`${providerId}::${accountId ? `${accountId}::` : ""}`);
  }

  /** Model ids with a route-scoped quota observation for this provider (the measurable
   *  per-model quota domains — used to enumerate physical pools for model-domain providers). */
  providerRouteModels(providerId: string, accountId?: string): string[] {
    const prefix = `${providerId}::${accountId ? `${accountId}::` : ""}`;
    const models: string[] = [];
    for (const key of this.byRoute.keys()) {
      if (!key.startsWith(prefix)) continue;
      const model = key.slice(prefix.length);
      // Unscoped keys are `provider::model`; account-scoped are `provider::account::model`.
      // Without an account filter the second form must not leak `account::model` as a "model".
      if (accountId === undefined && model.includes("::")) continue;
      models.push(model);
    }
    return models;
  }

  /** Remaining request budget when known; undefined when the provider does not expose it. */
  remainingRequests(providerId: string, modelId: string): number | undefined {
    return this.get(providerId, modelId)?.remainingRequests;
  }
}
