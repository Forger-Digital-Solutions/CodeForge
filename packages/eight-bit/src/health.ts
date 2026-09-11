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
 * Classifies a raw error (message/status) into a `FailureReason`. Kept deliberately simple and
 * pattern-based (mirrors the existing 401/429 detection already used in agent-runtime.ts) —
 * this is the single place that pattern lives for 8-Bit, so it can be tested and extended
 * without touching call sites.
 */
export function classifyFailure(error: unknown): FailureReason {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (/\b401\b|invalid api key|unauthor|auth ?error|missing_api_key/.test(msg)) return "AUTH_FAILURE";
  if (/\b429\b|rate.?limit/.test(msg)) return "RATE_LIMITED";
  if (/quota|insufficient_quota|credits? exhausted/.test(msg)) return "QUOTA_EXHAUSTED";
  if (/\b404\b|model_not_found|model not found|unknown model/.test(msg)) return "MODEL_NOT_FOUND";
  if (/deprecated|retired|no longer (available|supported)/.test(msg)) return "MODEL_RETIRED";
  if (/context.?length|context.?limit|too many tokens|maximum context/.test(msg)) return "CONTEXT_LIMIT";
  if (/timed? ?out|timeout/.test(msg)) return "TIMEOUT";
  if (/\b5\d\d\b|upstream|bad gateway|service unavailable|provider (error|outage)/.test(msg)) return "PROVIDER_OUTAGE";
  if (/econnreset|econnrefused|enotfound|network|fetch failed/.test(msg)) return "TRANSIENT_NETWORK";
  if (/invalid.*tool.*(call|output)|malformed.*tool/.test(msg)) return "INVALID_TOOL_OUTPUT";
  if (/structured output|schema validation failed|json parse/.test(msg)) return "STRUCTURED_OUTPUT_FAILURE";
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
  if (reason === "AUTH_FAILURE" || reason === "PROVIDER_OUTAGE") {
    return Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** Math.min(4, consecutiveFailures - 1));
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
      return "UNAVAILABLE";
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
   * per-route consecutive-failure counter; resets on the next recorded success. */
  recordFailure(providerId: string, modelId: string, reason: FailureReason): EightBitRouteHealth {
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
      cooldownUntil: cooldownMs > 0 ? this.now() + cooldownMs : prior.cooldownUntil,
      status,
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
    this.firewall.markProviderHealth(providerId, "available");
  }

  /** A successful call clears the consecutive-failure streak (bounded retry succeeded /
   * route recovered) without erasing history of what happened — just the live streak. */
  recordSuccess(providerId: string, modelId: string): void {
    const key = routeKeyOf(providerId, modelId);
    const prior = this.routes.get(key);
    if (!prior || prior.consecutiveFailures === 0) return;
    this.routes.set(key, { providerId, modelId, consecutiveFailures: 0, status: "HEALTHY" });
    this.firewall.markProviderHealth(providerId, "available");
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
    this.firewall.markProviderHealth(health.providerId, status, {
      retryAfter: health.cooldownUntil,
      lastError: health.lastFailureReason,
    });
  }
}

export function createEightBitHealthTracker(firewall: ForgeZero, now?: () => number): EightBitHealthTracker {
  return new EightBitHealthTracker(firewall, now);
}
