import type { ForgeZero, ModelHealthState } from "@codeforge/forge-zero";
import { FAILURE_POLICY, routeKeyOf, type EightBitRouteHealth, type FailureReason } from "./types.js";

/** Consecutive failures before a TRANSIENT_NETWORK/TIMEOUT/UNKNOWN failure demotes a route to
 * DEGRADED. A single transient failure must never permanently retire a route. */
const SUSTAINED_FAILURE_THRESHOLD = 3;
const BASE_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 15 * 60_000;
/** Consecutive 401/403s before a route stops retrying automatically and requires explicit
 * credential-change/recovery (R1 legal remediation spec §21-22, ENG-P2-03). Below this count, an
 * AUTH_FAILURE still gets the normal bounded, time-limited cooldown — a single bad response (a
 * transient upstream glitch reported as 401) must not instantly and permanently kill a route. */
const AUTH_FAILURE_PERMANENT_SUSPEND_THRESHOLD = 3;

/**
 * A rate limit with a short window (tokens/requests per minute, or an explicit retry-after of at
 * most this long) is a capacity blip, not a closed door: the route recovers within the minute.
 */
export const SHORT_RATE_LIMIT_MAX_WAIT_MS = 90_000;

/**
 * How long a 429 asks the caller to wait when that wait is short enough to be worth it, else
 * undefined. Daily/monthly caps ("per day", "free-models-per-day", quota) never qualify: waiting
 * a minute does not help, and pretending it might would burn the user's time.
 */
export function shortRateLimitWaitMs(error: unknown, now: number = Date.now()): number | undefined {
  const msg = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  if (/per[\s-]?day|daily|per[\s-]?month|monthly|free-models-per-day|quota/.test(msg)) return undefined;
  const retryAfter = (error as { retryAfter?: unknown })?.retryAfter;
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
    const wait = retryAfter > 1e12 ? retryAfter - now : retryAfter * 1000;
    if (wait >= 0 && wait <= SHORT_RATE_LIMIT_MAX_WAIT_MS) return Math.ceil(wait);
    if (wait > SHORT_RATE_LIMIT_MAX_WAIT_MS) return undefined;
  }
  const explicit = msg.match(/try again in\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?|m|min|minutes?)/);
  if (explicit) {
    const value = Number(explicit[1]);
    const unit = explicit[2]!;
    const ms = unit === "ms" ? value : unit.startsWith("m") ? value * 60_000 : value * 1000;
    return ms <= SHORT_RATE_LIMIT_MAX_WAIT_MS ? Math.ceil(ms) : undefined;
  }
  if (/per[\s-]?minute|\btpm\b|\brpm\b|per[\s-]?second/.test(msg)) return 60_000;
  return undefined;
}

/**
 * Classifies a raw error (message/status) into a `FailureReason`. Kept deliberately simple and
 * pattern-based (mirrors the existing 401/429 detection already used in agent-runtime.ts) —
 * this is the single place that pattern lives for 8-Bit, so it can be tested and extended
 * without touching call sites.
 */
export function classifyFailure(error: unknown): FailureReason {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : undefined;
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : undefined;
  if (status === 402 || code === "PAYMENT_REQUIRED" || /\b402\b|payment required|insufficient (credits|balance)|upgrade (your|to a) (plan|paid)|requires (a )?paid plan|workers paid/.test(msg)) return "PAID_PLAN_REQUIRED";
  if (/free tier (is )?not available|not on the free (tier|plan)|free plan (has )?ended/.test(msg)) return "FREE_TIER_NOT_AVAILABLE";
  // R23 live fixtures: a 403 whose text says the ROUTE is closed to this client class (thinkingmachines
  // inkling: "only available on agentic harnesses") is a permission restriction — permanent for the
  // direct API path, never a credential problem to retry. A bare 401/403 stays AUTH_FAILURE.
  if (/only available (on|to|via|for)|not available (for|to) (this|your) (client|harness|integration|application)|restricted to (approved|partner|agentic)|agentic harness/.test(msg)) return "ACCESS_RESTRICTED";
  // R40/R41: Google's 403 PERMISSION_DENIED envelope carries a CONSUMER_SUSPENDED detail —
  // a confirmed account-level suspension of the API consumer. Structural and permanent for
  // the direct path, not a credential fault to retry. Only that explicit claim qualifies:
  // a bare 403/PERMISSION_DENIED still falls through to AUTH_FAILURE, and no cause beyond
  // the confirmed suspension is inferred.
  if (/consumer[_\s-]?suspended/.test(msg)) return "ACCESS_RESTRICTED";
  if (/\b401\b|invalid api key|unauthor|auth ?error|missing_api_key/.test(msg)) return "AUTH_FAILURE";
  // HTTP 410 is a retirement signal (GitHub Models API brownout, 2026-09-21) — refresh, do not retry.
  if (status === 410 || /\b410\b|has been retired|is being retired|scheduled for retirement/.test(msg)) return "MODEL_RETIRED";
  // A stream the provider terminated before [DONE] is an upstream failure, not an unknown one —
  // without this the dominant free-tier failure mode lands in UNKNOWN and loses cooldown/rotation
  // semantics. Transport-level stream failures (socket errors, local network) stay TRANSIENT_NETWORK.
  // Server-side tool-call validation (Groq `tool_use_failed`, R23 round 3: hallucinated tool
  // names, missing required parameters) is the model's fault, never the route's health. Evaluated
  // before every outage/transport rule: the runtime prefixes thrown stream errors with
  // "Provider error: <code> - …", which the outage fallback below would otherwise match.
  if (code === "INVALID_TOOL_OUTPUT" || /invalid.*tool.*(call|output)|malformed.*tool|tool_use_failed|output_parse_failed|tool call validation failed|not in request\.tools|did not match schema|output that could not be parsed|failed to parse tool call/.test(msg)) return "INVALID_TOOL_OUTPUT";
  if (code === "STREAM_INTERRUPTED" || code === "PROVIDER_STREAM_INTERRUPTED" || /ended before the provider sent|stream disconnect/.test(msg)) return "PROVIDER_OUTAGE";
  if (code === "STREAM_FAILED") return "TRANSIENT_NETWORK";
  if (/\b429\b|rate.?limit/.test(msg)) return "RATE_LIMITED";
  if (/quota|insufficient_quota|credits? exhausted|neurons/.test(msg)) return "QUOTA_EXHAUSTED";
  if (/content_filter|blocked by (the )?(provider|policy)|harmful content|safety (system|filter|policy)/.test(msg)) return "SAFETY_REJECTION";
  // Status/code-level auth signal (after the safety rule: a 403 moderation flag is not a credential fault).
  if (status === 401 || status === 403 || code === "AUTH_ERROR") return "AUTH_FAILURE";
  // Upstream saturation reported inside a 502 envelope (OpenRouter → Nvidia, 2026-09-21:
  // "ResourceExhausted: Worker local total request limit reached (16/16)") is capacity, not an outage.
  if (/\b503\b|overloaded|at capacity|over capacity|capacity (exceeded|limit)|temporarily unavailable|no available (provider|capacity)|resource ?exhausted|request limit reached|worker local/.test(msg)) return "TEMPORARY_CAPACITY";
  if (/\b404\b|model_not_found|model not found|unknown model/.test(msg)) return "MODEL_NOT_FOUND";
  if (/deprecated|retired|no longer (available|supported)/.test(msg)) return "MODEL_RETIRED";
  if (/context.?length|context.?limit|too many tokens|maximum context/.test(msg)) return "CONTEXT_LIMIT";
  if (/timed? ?out|timeout/.test(msg)) return "TIMEOUT";
  if (/\b5\d\d\b|upstream|bad gateway|service unavailable|provider (error|outage)/.test(msg)) return "PROVIDER_OUTAGE";
  // The sanitized `[cause=…]` marker normalizeProviderError appends is an observed transport
  // code — it names the socket/DNS/undici/cert failure class even when the message text is a
  // bare "fetch failed". Only the whitelist pattern matches; arbitrary cause text never does.
  if (/\bcause=(eai_again|enotfound|econnreset|econnrefused|etimedout|und_err_[a-z0-9_]+|cert_[a-z0-9_]+)\b/.test(msg)) return "TRANSIENT_NETWORK";
  if (/econnreset|econnrefused|enotfound|network|fetch failed/.test(msg)) return "TRANSIENT_NETWORK";
  if (/structured output|schema validation failed|json parse/.test(msg)) return "STRUCTURED_OUTPUT_FAILURE";
  if (status === 400 || /\b400\b|bad request|invalid_request_error|unsupported parameter/.test(msg)) return "BAD_REQUEST";
  return "UNKNOWN";
}

/**
 * Not a real cooldown duration — a "forever" stand-in. Deliberately Number.MAX_SAFE_INTEGER
 * rather than Infinity: this value gets persisted through EightBitDecisionStore as JSON
 * (work_items.data JSONB), and JSON.stringify(Infinity) silently becomes `null`, which would
 * corrupt the cooldown on the very next restart and let a permanently-suspended route retry
 * again. isInCooldown() also checks `permanentlySuspended` directly as the authoritative signal,
 * so this value is really only for display/debugging (e.g. an EightBitDecisionStore fixture must
 * never accidentally hydrate a healthy-looking route from an out-of-range value here).
 */
const PERMANENT_SUSPEND_COOLDOWN_MS = Number.MAX_SAFE_INTEGER;

function isPermanentAuthSuspension(reason: FailureReason, consecutiveFailures: number): boolean {
  return reason === "AUTH_FAILURE" && consecutiveFailures >= AUTH_FAILURE_PERMANENT_SUSPEND_THRESHOLD;
}

function cooldownMsFor(reason: FailureReason, consecutiveFailures: number): number {
  if (isPermanentAuthSuspension(reason, consecutiveFailures)) {
    return PERMANENT_SUSPEND_COOLDOWN_MS;
  }
  if (reason === "RATE_LIMITED" || reason === "QUOTA_EXHAUSTED") {
    return Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** Math.min(5, consecutiveFailures - 1));
  }
  if (reason === "AUTH_FAILURE" || reason === "PROVIDER_OUTAGE" || reason === "TEMPORARY_CAPACITY") {
    return Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** Math.min(4, consecutiveFailures - 1));
  }
  if (reason === "PAID_PLAN_REQUIRED" || reason === "FREE_TIER_NOT_AVAILABLE" || reason === "ACCESS_RESTRICTED") {
    // Not a transient condition: keep the route out until the next free-status refresh.
    return MAX_COOLDOWN_MS;
  }
  return 0;
}

function statusFor(reason: FailureReason, consecutiveFailures: number): EightBitRouteHealth["status"] {
  switch (reason) {
    case "RATE_LIMITED":
      return "RATE_LIMITED";
    case "QUOTA_EXHAUSTED":
      return "QUOTA_EXHAUSTED";
    case "AUTH_FAILURE":
      return "SUSPENDED";
    case "MODEL_NOT_FOUND":
    case "MODEL_RETIRED":
    case "FREE_ELIGIBILITY_REMOVED":
    case "PAID_PLAN_REQUIRED":
    case "FREE_TIER_NOT_AVAILABLE":
    case "ACCESS_RESTRICTED":
      return "UNAVAILABLE";
    case "TEMPORARY_CAPACITY":
      return "DEGRADED";
    case "PROVIDER_OUTAGE":
      return consecutiveFailures >= SUSTAINED_FAILURE_THRESHOLD ? "UNAVAILABLE" : "DEGRADED";
    case "TRANSIENT_NETWORK":
    case "TIMEOUT":
    case "UNKNOWN":
      return consecutiveFailures >= SUSTAINED_FAILURE_THRESHOLD ? "DEGRADED" : "HEALTHY";
    default:
      return "HEALTHY";
  }
}

/**
 * Failure classes whose evidence is about state the provider's other routes share: an
 * org-scoped credential rejection, an account tier/quota wall, or an upstream outage —
 * marking siblings is correct because the same call would fail there too. Everything else
 * (per-model rate buckets, quota walls naming the model, retired models, request-shaped
 * failures) is model-scoped: provider-wide marking destroyed within-provider failover when
 * Groq's `gpt-oss-120b` TPD wall cooled the healthy `gpt-oss-20b` sibling (R56).
 */
const PROVIDER_SCOPED_REASONS: ReadonlySet<FailureReason> = new Set([
  "AUTH_FAILURE",
  "PAID_PLAN_REQUIRED",
  "FREE_TIER_NOT_AVAILABLE",
  "ACCESS_RESTRICTED",
  "PROVIDER_OUTAGE",
  "TEMPORARY_CAPACITY",
  "TRANSIENT_NETWORK",
  "TIMEOUT",
  "UNKNOWN",
]);

/**
 * Live health feedback loop. Reuses ForgeZero as the eligibility source of truth (`markProviderHealth`
 * already excludes a bad provider from `eligibleModels()`); this layer is what was missing per the
 * architecture audit — `recentFailureCount` and cooldown state were schema fields nothing ever wrote.
 * A single transient failure never demotes past DEGRADED; only sustained failure escalates further.
 */
export class EightBitHealthTracker {
  private readonly routes = new Map<string, EightBitRouteHealth>();

  constructor(private readonly firewall: ForgeZero, private readonly now: () => number = () => Date.now()) {}

  getHealth(providerId: string, modelId: string): EightBitRouteHealth {
    const key = routeKeyOf(providerId, modelId);
    return (
      this.routes.get(key) ?? {
        providerId,
        modelId,
        consecutiveFailures: 0,
        status: "HEALTHY",
      }
    );
  }

  isInCooldown(providerId: string, modelId: string): boolean {
    const h = this.getHealth(providerId, modelId);
    if (h.permanentlySuspended) return true;
    return h.cooldownUntil !== undefined && h.cooldownUntil > this.now();
  }

  /** Restore a previously-persisted health snapshot (e.g. after a process restart). */
  hydrate(snapshot: EightBitRouteHealth): void {
    this.routes.set(routeKeyOf(snapshot.providerId, snapshot.modelId), snapshot);
    this.applyToFirewall(snapshot);
  }

  /** Record a real failure observed during actual CodeForge operation. Bounded, monotonic
   * per-route consecutive-failure counter; resets on the next recorded success.
   * `opts.scope` carries the caller's failure classification (e.g. planFailureHealthMarking)
   * when the raw error named a per-model or account-level wall; absent evidence falls back
   * to the reason's default scope, never to a guessed marking. `opts.cooldownUntil` carries
   * the classified reset horizon (a TPD wall holds until its daily reset rather than
   * re-probing the route every generic cooldown tick and burning a request each time). */
  recordFailure(providerId: string, modelId: string, reason: FailureReason, opts?: { scope?: "model" | "provider"; cooldownUntil?: number }): EightBitRouteHealth {
    const key = routeKeyOf(providerId, modelId);
    const prior = this.getHealth(providerId, modelId);
    // A route already permanently suspended stays that way — credentials don't become valid
    // again just because another request was attempted against them.
    if (prior.permanentlySuspended) return prior;
    const consecutiveFailures = prior.consecutiveFailures + 1;
    const status = statusFor(reason, consecutiveFailures);
    const cooldownMs = cooldownMsFor(reason, consecutiveFailures);
    const updated: EightBitRouteHealth = {
      providerId,
      modelId,
      consecutiveFailures,
      lastFailureReason: reason,
      lastFailureAt: new Date(this.now()).toISOString(),
      cooldownUntil: opts?.cooldownUntil !== undefined && Number.isFinite(opts.cooldownUntil)
        ? Math.max(opts.cooldownUntil, this.now())
        : cooldownMs > 0 ? this.now() + cooldownMs : prior.cooldownUntil,
      status,
      scope: opts?.scope ?? (PROVIDER_SCOPED_REASONS.has(reason) ? "provider" : "model"),
      permanentlySuspended: isPermanentAuthSuspension(reason, consecutiveFailures) || undefined,
    };
    this.routes.set(key, updated);
    this.applyToFirewall(updated);
    return updated;
  }

  /**
   * Explicit recovery from a permanent auth suspension — the human-in-the-loop counterpart to
   * recordFailure()'s automatic escalation. Call this when the user actually changes/re-enters
   * the credential for `providerId` (R1 spec §21: "stop automatic retry → require credential
   * change / explicit recovery"). A no-op if the route was never permanently suspended, so it is
   * always safe to call unconditionally after any credential update.
   */
  clearPermanentSuspension(providerId: string, modelId: string): void {
    const key = routeKeyOf(providerId, modelId);
    const prior = this.routes.get(key);
    if (!prior?.permanentlySuspended) return;
    const cleared: EightBitRouteHealth = { providerId, modelId, consecutiveFailures: 0, status: "HEALTHY" };
    this.routes.set(key, cleared);
    // Route-scoped recovery: clearing this route must not erase a sibling's live cooldown —
    // a recovered model is evidence about itself, not about the provider's other routes.
    this.firewall.markModelHealth(providerId, modelId, "available");
  }

  /** A successful call clears the consecutive-failure streak (bounded retry succeeded /
   * route recovered) without erasing history of what happened — just the live streak. */
  recordSuccess(providerId: string, modelId: string): void {
    const key = routeKeyOf(providerId, modelId);
    const prior = this.routes.get(key);
    if (!prior || prior.consecutiveFailures === 0) return;
    this.routes.set(key, { providerId, modelId, consecutiveFailures: 0, status: "HEALTHY" });
    this.firewall.markModelHealth(providerId, modelId, "available");
  }

  /**
   * Shorten (never extend) a route's cooldown so a bounded same-route retry can proceed once it
   * has waited that long: the wait *is* the cooldown. ForgeZero's projection follows, since the
   * agent loop re-verifies eligibility before every model call.
   */
  shortenCooldown(providerId: string, modelId: string, until: number): void {
    const key = routeKeyOf(providerId, modelId);
    const prior = this.routes.get(key);
    if (!prior || prior.cooldownUntil === undefined || prior.cooldownUntil <= until) return;
    const next: EightBitRouteHealth = { ...prior, cooldownUntil: until };
    this.routes.set(key, next);
    this.applyToFirewall(next);
  }

  policyFor(reason: FailureReason): (typeof FAILURE_POLICY)[FailureReason] {
    return FAILURE_POLICY[reason];
  }

  snapshotAll(): EightBitRouteHealth[] {
    return [...this.routes.values()];
  }

  private applyToFirewall(health: EightBitRouteHealth): void {
    const status: ModelHealthState["status"] =
      health.status === "RATE_LIMITED"
        ? "rate_limited"
        : health.status === "QUOTA_EXHAUSTED"
          ? "quota_exhausted"
          : health.status === "SUSPENDED"
            ? "auth_required"
            : health.status === "UNAVAILABLE"
              ? "offline"
              : health.status === "DEGRADED"
                ? "degraded"
                : "available";
    const scope = health.scope
      ?? (health.lastFailureReason !== undefined && PROVIDER_SCOPED_REASONS.has(health.lastFailureReason) ? "provider" : "model");
    if (scope === "provider") {
      this.firewall.markProviderHealth(health.providerId, status, {
        retryAfter: health.cooldownUntil,
        lastError: health.lastFailureReason,
      });
    } else {
      this.firewall.markModelHealth(health.providerId, health.modelId, status, {
        retryAfter: health.cooldownUntil,
        lastError: health.lastFailureReason,
      });
    }
  }
}

export function createEightBitHealthTracker(firewall: ForgeZero, now?: () => number): EightBitHealthTracker {
  return new EightBitHealthTracker(firewall, now);
}
