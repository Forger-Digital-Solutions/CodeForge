import type { ModelHealthState } from "./types.js";

/**
 * Provider-failure health classification (R3.6). Observed in the R3-RC2 window-1 corpus run:
 * a model-scoped daily-token 429 (TPD) was marked provider-wide as a 60-second transient
 * `rate_limited`, which (a) destroyed within-provider failover by cooling down every sibling
 * model of the provider and (b) misreported daily-capacity exhaustion as a minute-level
 * transient. Classification therefore distinguishes scope (model vs provider) and lifetime
 * (until daily reset vs bounded cooldown).
 */

export type FailureScope = "model" | "provider";

export interface ProviderFailureClassification {
  scope: FailureScope;
  status: ModelHealthState["status"];
  retryAfter: number;
  reason: string;
}

/** Daily/quota signal in provider 429 bodies (observed verbatim in Groq TPD bodies and the
 * Cloudflare neurons model). Distinguishes a daily-token wall from a minute-level RPM/TPM wall. */
const DAILY_QUOTA_SIGNALS: RegExp[] = [
  /tokens?\s+per\s+day/i,
  /\btpd\b/i,
  /tokens?\/day/i,
  /\bdaily\b.{0,40}(limit|quota|token)/i,
  /neuron/i,
  /\bmonthly\b.{0,40}(credit|quota)/i,
];

const RETRY_AFTER_PATTERNS: RegExp[] = [
  /retry[- ]after["'s:]*\s*(\d+)\s*s/i,
  /try again in\s+(\d+)\s*s/i,
];

const MINUTE_COOLDOWN_DEFAULT_MS = 60_000;
const MINUTE_COOLDOWN_MAX_MS = 15 * 60_000;

/** Next 00:00 UTC (the standard daily-quota reset boundary), +30s reconciliation buffer. */
export function nextDailyResetUtc(now: Date): number {
  const midnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0,
  );
  return midnight + 30_000;
}

function boundedMinuteCooldown(errorMessage: string, now: Date): number {
  for (const pattern of RETRY_AFTER_PATTERNS) {
    const match = errorMessage.match(pattern);
    if (match) {
      const seconds = Number(match[1]);
      if (Number.isFinite(seconds) && seconds > 0) {
        return Math.min(now.getTime() + seconds * 1000, now.getTime() + MINUTE_COOLDOWN_MAX_MS);
      }
    }
  }
  return now.getTime() + MINUTE_COOLDOWN_DEFAULT_MS;
}

export function classifyProviderFailure(
  errorMessage: string,
  now: Date = new Date(),
): ProviderFailureClassification | undefined {
  const msg = errorMessage ?? "";
  if (/\b401\b|invalid api key|unauthor|auth ?error|missing_api_key/i.test(msg)) {
    return {
      scope: "provider",
      status: "auth_required",
      retryAfter: Number.POSITIVE_INFINITY,
      reason: "credential rejected (401/auth); provider-scoped because the credential is organization-wide",
    };
  }
  if (/\b429\b|rate.?limit|too many requests/i.test(msg)) {
    if (DAILY_QUOTA_SIGNALS.some((p) => p.test(msg))) {
      return {
        scope: "model",
        status: "quota_exhausted",
        retryAfter: nextDailyResetUtc(now),
        reason: "daily-token/quota wall observed in the 429 body; model-scoped until the daily window resets",
      };
    }
    return {
      scope: "model",
      status: "rate_limited",
      retryAfter: boundedMinuteCooldown(msg, now),
      reason: "minute-level rate limit (RPM/TPM/concurrency); model-scoped bounded cooldown",
    };
  }
  if (/\b5\d{2}\b|overloaded|temporarily unavailable|bad gateway|service unavailable/i.test(msg)) {
    return {
      scope: "provider",
      status: "degraded",
      retryAfter: now.getTime() + MINUTE_COOLDOWN_DEFAULT_MS,
      reason: "provider-side outage signal; provider-scoped bounded degradation",
    };
  }
  return undefined;
}

export interface FailureHealthMarking {
  providerId: string;
  /** Defined only for model-scoped classifications. */
  modelId?: string;
  status: ModelHealthState["status"];
  retryAfter: number | undefined;
  scope: FailureScope;
  reason: string;
}

/** Turn a runtime error string into the health marking(s) ForgeZero should apply. Returns
 * undefined for unclassified errors (no marking — never guess health). */
export function planFailureHealthMarking(
  providerId: string,
  modelId: string | undefined,
  errorMessage: string,
  now: Date = new Date(),
): FailureHealthMarking | undefined {
  const classification = classifyProviderFailure(errorMessage, now);
  if (!classification) return undefined;
  return {
    providerId,
    modelId: classification.scope === "model" ? modelId : undefined,
    status: classification.status,
    retryAfter:
      classification.retryAfter === Number.POSITIVE_INFINITY ? undefined : classification.retryAfter,
    scope: classification.scope,
    reason: classification.reason,
  };
}
