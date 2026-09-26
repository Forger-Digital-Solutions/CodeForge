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

/**
 * R46 §20: the inferred rate-limit class behind a 429. Provider bodies name different
 * buckets — "tokens per minute" is a minute wall on throughput, "requests per day" is an
 * allocation wall, "insufficient quota" is account exhaustion, concurrency errors are a
 * burst shape. When the body carries no signal the class is UNKNOWN: honest, never guessed.
 */
export type RateLimitClass = "RPM" | "TPM" | "DAILY" | "ACCOUNT" | "BURST" | "UNKNOWN";

export interface ProviderFailureClassification {
  scope: FailureScope;
  status: ModelHealthState["status"];
  retryAfter: number;
  reason: string;
  /** Present only when the failure was a 429-class event. */
  rateLimitClass?: RateLimitClass;
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

/** Account-allocation signals: the account itself is out, not a per-minute bucket. Checked
 * before the daily/minute signals because "quota exhausted" bodies often say both. */
const ACCOUNT_QUOTA_SIGNALS: RegExp[] = [
  /insufficient[_ ]?quota/i,
  /exceeded your (current )?quota/i,
  /credit balance/i,
  /billing/i,
  /account.{0,40}(quota|limit).{0,40}(exhaust|exceed|reach)/i,
  // OpenRouter's daily free bucket is account-wide: every `:free` sibling shares it.
  /free-models-per-day/i,
  /models?\s+per\s+day/i,
];
const TPM_SIGNALS: RegExp[] = [/tokens?\s+per\s+minute/i, /\btpm\b/i, /tokens?\/min/i];
const RPM_SIGNALS: RegExp[] = [/requests?\s+per\s+minute/i, /\brpm\b/i, /requests?\/min/i];
const BURST_SIGNALS: RegExp[] = [/burst/i, /concurren/i];

/**
 * Order is evidential: an account wall outranks every time-window signal (the body may
 * mention the window it exceeded), daily walls outrank minute windows (a TPD body often
 * prints the TPM figure too), and burst/concurrency is only claimed when named.
 */
export function classifyRateLimit(errorMessage: string): RateLimitClass {
  const msg = errorMessage ?? "";
  if (ACCOUNT_QUOTA_SIGNALS.some((p) => p.test(msg))) return "ACCOUNT";
  if (DAILY_QUOTA_SIGNALS.some((p) => p.test(msg))) return "DAILY";
  if (TPM_SIGNALS.some((p) => p.test(msg))) return "TPM";
  if (RPM_SIGNALS.some((p) => p.test(msg))) return "RPM";
  if (BURST_SIGNALS.some((p) => p.test(msg))) return "BURST";
  return "UNKNOWN";
}

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
    const rateLimitClass = classifyRateLimit(msg);
    if (rateLimitClass === "DAILY") {
      return {
        scope: "model",
        status: "quota_exhausted",
        retryAfter: nextDailyResetUtc(now),
        reason: "daily-token/quota wall observed in the 429 body; model-scoped until the daily window resets",
        rateLimitClass,
      };
    }
    if (rateLimitClass === "ACCOUNT") {
      return {
        scope: "provider",
        status: "quota_exhausted",
        retryAfter: nextDailyResetUtc(now),
        reason: "account-allocation wall observed in the 429 body; provider-scoped because siblings share the account quota",
        rateLimitClass,
      };
    }
    return {
      scope: "model",
      status: "rate_limited",
      retryAfter: boundedMinuteCooldown(msg, now),
      reason: `${rateLimitClass === "UNKNOWN" ? "rate limit (class undetermined)" : `${rateLimitClass} rate limit`} observed in the 429 body; model-scoped bounded cooldown`,
      rateLimitClass,
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
  rateLimitClass?: RateLimitClass;
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
    ...(classification.rateLimitClass !== undefined ? { rateLimitClass: classification.rateLimitClass } : {}),
  };
}
