import { routeKeyOf, type EightBitRole, type FailureReason } from "./types.js";
import type { ToolCallOutcome } from "./reliability.js";
import { classifyRateLimit, type RateLimitClass } from "@codeforge/forge-zero";

/**
 * 8-Bit Route Health Authority (R24 Mission A).
 *
 * R23 closed with a confirmed gap: `EightBitMeasuredHealthTracker` existed, but no production
 * component emitted measurements, probe-gate verdicts lived in a bench-side JSONL, and ForgeAuto
 * ranked routes on catalog capability plus quota headers alone — a route Nvidia had saturated
 * two minutes ago still won on its capability score. This module is the single live health
 * authority every producer feeds and every consumer reads:
 *
 *   producers  → `observe(NormalizedObservation)`  (runtime calls, probe gates, rate-limit
 *                 headers, daily allowances, tool outcomes, catalog/entitlement facts, governor)
 *   consumers  → `assess(route, { role, now })`     (ForgeAuto ranking + hard exclusion)
 *              → `probeAdvice(route, …)`            (is a live probe worth its cost right now?)
 *              → `snapshot()`                       (ledger / UI / evidence)
 *
 * Health is TEMPORAL. Every condition carries an observation time, an expiry (TTL), a confidence
 * and a sample size; transient conditions (saturation, per-minute rate limits, capacity blips)
 * decay, while permanent conditions (retired model, access restricted, billing unverifiable)
 * hold until a catalog change explicitly clears them. Nothing here grants eligibility: policy,
 * cost and terms admission stay with ForgeZero / the Free Cloud registry. This authority can only
 * exclude or re-rank routes that were already admitted.
 */

// --- Route health states (§6) ------------------------------------------------------------------

export type RouteHealthCondition =
  | "HEALTHY"
  | "DEGRADED"
  | "SATURATED"
  | "RATE_LIMITED"
  | "DAILY_QUOTA_EXHAUSTED"
  | "TEMPORARY_CAPACITY"
  | "ACCESS_RESTRICTED"
  | "MODEL_RETIRED"
  | "AUTH_REQUIRED"
  | "USER_CONNECTION_REQUIRED"
  | "BILLING_VERIFICATION_REQUIRED"
  | "TOOL_UNRELIABLE"
  | "CAPABILITY_LIMITED"
  | "QUARANTINED"
  | "UNKNOWN";

/** Conditions that never expire on their own (§8). Only `catalogChanged` / explicit recovery clears them. */
export const PERMANENT_STATES: ReadonlySet<RouteHealthCondition> = new Set([
  "MODEL_RETIRED",
  "ACCESS_RESTRICTED",
  "BILLING_VERIFICATION_REQUIRED",
]);

/** Conditions that hard-exclude a route from routing while active (§10). */
export const HARD_EXCLUDE_STATES: ReadonlySet<RouteHealthCondition> = new Set([
  "MODEL_RETIRED",
  "ACCESS_RESTRICTED",
  "BILLING_VERIFICATION_REQUIRED",
  "AUTH_REQUIRED",
  "USER_CONNECTION_REQUIRED",
  "QUARANTINED",
  "DAILY_QUOTA_EXHAUSTED",
  "RATE_LIMITED",
]);

/** Precedence when several conditions are simultaneously active: first match wins. */
const STATE_PRECEDENCE: readonly RouteHealthCondition[] = [
  "MODEL_RETIRED",
  "ACCESS_RESTRICTED",
  "BILLING_VERIFICATION_REQUIRED",
  "AUTH_REQUIRED",
  "USER_CONNECTION_REQUIRED",
  "QUARANTINED",
  "DAILY_QUOTA_EXHAUSTED",
  "RATE_LIMITED",
  "SATURATED",
  "TEMPORARY_CAPACITY",
  "TOOL_UNRELIABLE",
  "CAPABILITY_LIMITED",
  "DEGRADED",
  "HEALTHY",
  "UNKNOWN",
];

/** Roles whose work depends on well-formed tool calls; TOOL_UNRELIABLE bites them hardest. */
export const TOOL_DEPENDENT_ROLES: ReadonlySet<EightBitRole> = new Set(["CODER", "TOOL_AGENT", "FAST_WORKER", "EXPLORER"]);

// --- Normalized observations (§55) -------------------------------------------------------------

export type RequestShape = "bare" | "production";
export type ObservationSource = "runtime" | "probe" | "registry" | "bench" | "governor" | "entitlement" | "hydrate";

interface ObservationBase {
  providerId: string;
  modelId: string;
  /** ISO-8601 time the fact was observed (not ingested). */
  observedAt: string;
  source: ObservationSource;
  role?: EightBitRole;
  requestShape?: RequestShape;
  /** Non-secret correlation: runId / sessionId / campaign id. Never a prompt. */
  correlationId?: string;
}

export type NormalizedObservation =
  | (ObservationBase & { kind: "probe_gate"; served: boolean; latencyMs: number; toolCalls?: number; failureReason?: FailureReason; failureMessage?: string })
  | (ObservationBase & { kind: "call_success"; latencyMs: number; inputTokens?: number; outputTokens?: number; retriedSameRoute?: number })
  | (ObservationBase & { kind: "call_failure"; reason: FailureReason; status?: number; retryAfterMs?: number; message?: string })
  | (ObservationBase & {
      kind: "rate_limit_headers";
      requestsLimit?: number;
      requestsRemaining?: number;
      requestsResetAt?: string;
      tokensLimit?: number;
      tokensRemaining?: number;
      tokensResetAt?: string;
      retryAfterMs?: number;
      status?: number;
    })
  | (ObservationBase & { kind: "daily_allowance"; unit: "requests" | "tokens"; limit: number; remaining: number; resetAt: string })
  | (ObservationBase & { kind: "tool_outcome"; outcome: ToolCallOutcome })
  | (ObservationBase & { kind: "role_outcome"; outcome: RoleOutcomeKind; failureClass?: RoleFailureClass })
  | (ObservationBase & { kind: "catalog"; fact: "retired" | "not_found" | "access_restricted" | "billing_unverifiable" | "billing_verified" | "present" })
  | (ObservationBase & { kind: "entitlement"; fact: "connected" | "connection_required" | "auth_required" | "quota_exhausted" | "overage_blocked"; resetAt?: string })
  | (ObservationBase & { kind: "governor_pressure"; pacingWaitMs: number; inFlight: number; bucketRemainingTokens?: number })
  | (ObservationBase & { kind: "quarantine"; action: "set" | "clear"; reason: string });

export type ObservationKind = NormalizedObservation["kind"];

/**
 * R50 §4: the role-level verdict vocabulary. Capacity/transport failures NEVER arrive here —
 * they are `call_failure` with a `FailureReason`. `role_outcome` only carries what the served
 * model itself did or failed to do for this role.
 *
 *   verified_complete    independent verification accepted the role's work (gate + integration)
 *   converged            the role finished within budget (weaker than verified — no gate yet)
 *   verification_failed  the work failed verification (ForgeVerify/tests rejected it)
 *   role_failed          the run ended on a model-quality failure (unusable output, loop)
 *   security_blocked     the role attempted a boundary violation (path escape, denied permission)
 *   budget_exhausted     the role consumed its working budget without converging
 */
export type RoleOutcomeKind =
  | "verified_complete"
  | "converged"
  | "verification_failed"
  | "role_failed"
  | "security_blocked"
  | "budget_exhausted";

/** R50 §4: why a role-level outcome happened — model/tool quality classes only, never supply. */
export type RoleFailureClass =
  | "NON_CONVERGENCE"
  | "EMPTY_COMPLETION"
  | "MALFORMED_STRUCTURED_OUTPUT"
  | "REPETITION_LOOP"
  | "INVALID_TOOL_CALL"
  | "WORKSPACE_ESCAPE_ATTEMPT"
  | "TOOL_PERMISSION_VIOLATION"
  | "ROLE_BUDGET_EXHAUSTED"
  | "VERIFIER_REJECTED_OUTPUT"
  | "CAPABILITY_DROPPED";

// --- Conditions and assessments ------------------------------------------------------------------

export interface RouteCondition {
  state: RouteHealthCondition;
  /** ISO time the condition was (last) established. */
  since: string;
  /** Epoch ms after which the condition no longer applies; `null` = permanent (§8). */
  expiresAt: number | null;
  /** 0-1. Grows with sample size / repeated observations, shrinks with age (see `assess`). */
  confidence: number;
  sampleSize: number;
  reasonCode: string;
  /** Provider-stated or modelled time the condition should lift (rate-limit reset, daily reset). */
  resetEstimate?: string;
  source: ObservationSource;
  /** Role-scoped conditions (TOOL_UNRELIABLE, CAPABILITY_LIMITED) only bind the roles listed. */
  roles?: EightBitRole[];
  /** R46 §20: the inferred 429 bucket when this condition is a rate limit — RPM/TPM/DAILY/
   * ACCOUNT/BURST, or UNKNOWN when the body carried no signal (never guessed). */
  rateLimitClass?: RateLimitClass;
}

export interface RouteHealthAssessment {
  providerId: string;
  modelId: string;
  state: RouteHealthCondition;
  /** True when routing must not use this route for the requested role right now. */
  hardExclude: boolean;
  /** Ranking delta applied to the ForgeRouter score (never creates eligibility). */
  scoreAdjustment: number;
  confidence: number;
  reasonCodes: string[];
  /** Epoch ms when the governing condition expires (undefined = permanent or none). */
  expiresAt?: number;
  resetEstimate?: string;
  sampleSize: number;
  lastObservedAt?: string;
  /** Every currently-active condition, precedence order, for diagnostics / ledger. */
  activeConditions: RouteCondition[];
  /** Rolling call statistics that backed the assessment. */
  window: RouteWindowStats;
}

export interface RouteWindowStats {
  calls: number;
  successes: number;
  failures: number;
  rateLimits: number;
  capacityErrors: number;
  malformedToolCalls: number;
  toolCalls: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  /** Oldest / newest observation in the window (ISO). */
  from?: string;
  to?: string;
}

export interface ProbeAdvice {
  shouldProbe: boolean;
  reasonCodes: string[];
  /** 0-1: how much a probe now would change what routing believes. */
  informationGain: number;
  /** Probability the route's state changed since the last observation (age-driven). */
  stateChangeProbability: number;
  estimatedCost: { requests: number; tokens: number };
  /** Epoch ms before which probing is pointless (permanent → undefined, "never"). */
  notBefore?: number;
  never: boolean;
}

export interface ProbeAdviceInput {
  now?: number;
  role?: EightBitRole;
  /** How much routing needs this route: 1 = only candidate for the role, 0 = many alternates. */
  importance?: number;
  remainingRequests?: number;
  remainingTokens?: number;
  /** Production-shaped probe cost; defaults to the R23-measured shape (~3.2–4.9k tokens, 1 request). */
  probeCost?: { requests: number; tokens: number };
}

// --- Policy --------------------------------------------------------------------------------------

export interface RouteHealthPolicy {
  /** Rolling window used for rate computations. */
  windowMs: number;
  /** Max observations kept per route. */
  windowSize: number;
  /** Positive evidence keeps HEALTHY this long without new calls. */
  healthyTtlMs: number;
  /** How long a saturation observation holds without reinforcement (R23: NVIDIA windows flip in 2–30 min). */
  saturationTtlMs: number;
  temporaryCapacityTtlMs: number;
  /** Fallback when a 429 carries neither retry-after nor a reset header. */
  rateLimitDefaultTtlMs: number;
  /** Fallback when a daily-quota signal carries no reset. */
  dailyQuotaDefaultTtlMs: number;
  authRequiredTtlMs: number;
  /** Failure rate over the window that marks DEGRADED (min samples apply). */
  degradedFailureRate: number;
  /**
   * Malformed share of tool calls that marks TOOL_UNRELIABLE. R23 measured gpt-oss at ~9–13% of
   * calls and every rejection costs a bounded retry, so a route that misfires on one call in
   * twenty is already measurably worse for tool roles than one that never does; the penalty is
   * a ranking delta scaled by confidence, not an exclusion (the reliability tracker's 0.6/0.8
   * floors remain the hard gates).
   */
  toolUnreliableRate: number;
  minSamplesForRates: number;
  /** Consecutive malformed tool calls that quarantine regardless of the rolling rate. */
  quarantineStreak: number;
  /** Consecutive AUTH failures before the route stops retrying automatically (R1 §21). */
  authFailureStreak: number;
  latencyTargetMs: number;
  /** Reserve of requests/tokens a probe may never dip into. */
  probeRequestReserve: number;
  probeTokenReserve: number;
  /** Mean time-to-change for transient conditions; drives state-change probability. */
  transientChangeTauMs: number;
}

export const DEFAULT_ROUTE_HEALTH_POLICY: RouteHealthPolicy = {
  windowMs: 60 * 60_000,
  windowSize: 200,
  healthyTtlMs: 30 * 60_000,
  saturationTtlMs: 5 * 60_000,
  temporaryCapacityTtlMs: 3 * 60_000,
  rateLimitDefaultTtlMs: 60_000,
  dailyQuotaDefaultTtlMs: 6 * 60 * 60_000,
  authRequiredTtlMs: 24 * 60 * 60_000,
  degradedFailureRate: 0.2,
  toolUnreliableRate: 0.05,
  minSamplesForRates: 5,
  quarantineStreak: 4,
  authFailureStreak: 3,
  latencyTargetMs: 10_000,
  probeRequestReserve: 20,
  probeTokenReserve: 20_000,
  transientChangeTauMs: 10 * 60_000,
};

/** Production-shaped probe cost as measured in R23 (groq 3.2k, openrouter 4.8k input tokens). */
export const DEFAULT_PROBE_COST = { requests: 1, tokens: 4_000 } as const;

/** Ranking deltas by state (§10). Role-scoped states are resolved in `assess`. */
const SCORE_ADJUSTMENT: Readonly<Record<RouteHealthCondition, number>> = {
  HEALTHY: 8,
  DEGRADED: -25,
  SATURATED: -60,
  RATE_LIMITED: -100,
  DAILY_QUOTA_EXHAUSTED: -100,
  TEMPORARY_CAPACITY: -40,
  ACCESS_RESTRICTED: -100,
  MODEL_RETIRED: -100,
  AUTH_REQUIRED: -100,
  USER_CONNECTION_REQUIRED: -100,
  BILLING_VERIFICATION_REQUIRED: -100,
  TOOL_UNRELIABLE: -50,
  CAPABILITY_LIMITED: -40,
  QUARANTINED: -100,
  UNKNOWN: -5,
};

// --- Internal state ----------------------------------------------------------------------------------

interface CallSample {
  at: number;
  ok: boolean;
  latencyMs?: number;
  reason?: FailureReason;
  role?: EightBitRole;
  shape?: RequestShape;
}

interface ToolSample {
  at: number;
  outcome: ToolCallOutcome;
  role?: EightBitRole;
}

/**
 * R50 §6/§8: one graded per-role evidence sample. Weight is assigned at ingest from the
 * outcome/failure class, then linearly decayed over the rolling window at read time — one
 * unlucky run can never permanently blacklist a route, and later verified work restores it.
 * `correlationId` keys the dedup set so replayed or double-emitted outcomes count once.
 */
export interface RoleOutcomeSample {
  at: number;
  role: EightBitRole;
  outcome: RoleOutcomeKind;
  failureClass?: RoleFailureClass;
  weight: number;
  correlationId?: string;
}

interface RouteState {
  providerId: string;
  modelId: string;
  calls: CallSample[];
  tools: ToolSample[];
  /** R50: bounded per-role graded outcome evidence (windowMs + windowSize scoped). */
  roleEvidence: RoleOutcomeSample[];
  /** R50 §29: `${correlationId}|${role}|${outcome}|${failureClass}` keys already ingested —
   *  a double-emitted or replayed outcome for the same run counts exactly once. */
  roleEvidenceKeys: Set<string>;
  conditions: Map<RouteHealthCondition, RouteCondition>;
  consecutiveFailures: number;
  consecutiveAuthFailures: number;
  consecutiveMalformed: number;
  lastObservedAt?: number;
  lastSuccessAt?: number;
  lastProbeAt?: number;
  /** Latest rate-limit / allowance facts (for the ledger and probe budgeting). */
  quota: {
    requestsRemaining?: number;
    requestsLimit?: number;
    tokensRemaining?: number;
    tokensLimit?: number;
    resetAt?: string;
    observedAt?: string;
  };
  governor?: { pacingWaitMs: number; inFlight: number; observedAt: string };
}

/** Serializable per-route snapshot (persisted by the ledger; hydrated on restart). */
export interface RouteHealthSnapshot {
  providerId: string;
  modelId: string;
  conditions: RouteCondition[];
  /** R50 §27: durable per-role graded evidence (timestamps serialized ISO). */
  roleEvidence?: Array<Omit<RoleOutcomeSample, "at"> & { at: string }>;
  window: RouteWindowStats;
  consecutiveFailures: number;
  consecutiveAuthFailures: number;
  consecutiveMalformed: number;
  lastObservedAt?: string;
  lastSuccessAt?: string;
  lastProbeAt?: string;
  quota: RouteState["quota"];
  governor?: RouteState["governor"];
  /** Precedence-resolved state at snapshot time (role-agnostic). */
  state: RouteHealthCondition;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isCapacityReason(reason: FailureReason): boolean {
  return reason === "TEMPORARY_CAPACITY" || reason === "PROVIDER_OUTAGE";
}

/**
 * R50 §8: ingest-time weights for graded role evidence. Bounded and asymmetric — a boundary
 * violation counts more than an ordinary failure, and recovery requires MORE than one success
 * because positives are individually weaker than the failures they must outweigh.
 */
const ROLE_OUTCOME_WEIGHT: Readonly<Record<RoleOutcomeKind, number>> = {
  verified_complete: 1,
  converged: 0.5,
  role_failed: -0.75,
  verification_failed: -1,
  budget_exhausted: -0.75,
  security_blocked: -1.5,
};

/** R50 §9: severity multipliers inside the negative outcomes (clamped to [-2, +2] overall). */
const ROLE_FAILURE_CLASS_FACTOR: Partial<Record<RoleFailureClass, number>> = {
  WORKSPACE_ESCAPE_ATTEMPT: 1.5,
  TOOL_PERMISSION_VIOLATION: 1.25,
  REPETITION_LOOP: 1.25,
  MALFORMED_STRUCTURED_OUTPUT: 1,
  NON_CONVERGENCE: 1,
  ROLE_BUDGET_EXHAUSTED: 1,
  VERIFIER_REJECTED_OUTPUT: 1,
  EMPTY_COMPLETION: 0.75,
  INVALID_TOOL_CALL: 0.75,
  CAPABILITY_DROPPED: 1,
};

function roleOutcomeWeight(outcome: RoleOutcomeKind, failureClass: RoleFailureClass | undefined): number {
  const base = ROLE_OUTCOME_WEIGHT[outcome];
  if (base <= 0 && failureClass !== undefined) {
    return Math.max(-2, base * (ROLE_FAILURE_CLASS_FACTOR[failureClass] ?? 1));
  }
  return base;
}

/** R50: bounds for the graded per-role delta (subordinate to the ±12 receipt quality). */
const MAX_ROLE_EVIDENCE_ADJUSTMENT = 16;
const ROLE_EVIDENCE_SCALE = 6;
const ROLE_EVIDENCE_FULL_CONFIDENCE_SAMPLES = 4;

function isDailyQuotaMessage(message: string | undefined): boolean {
  return message !== undefined && /per[\s-]?day|daily|free-models-per-day|tokens per day|\btpd\b|\brpd\b|quota/i.test(message);
}

/**
 * The authority. One instance per host (shared across sessions); the runtime hydrates it from
 * the durable ledger at start and every producer feeds it. Deterministic given the same
 * observations and clock — no randomness, no learning: this is evidence-driven adaptive
 * scoring, not training (§56).
 */
export class EightBitRouteHealthAuthority {
  private readonly routes = new Map<string, RouteState>();
  private readonly listeners = new Set<(observation: NormalizedObservation, snapshot: RouteHealthSnapshot) => void>();

  constructor(
    private readonly policy: RouteHealthPolicy = DEFAULT_ROUTE_HEALTH_POLICY,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Observation sink for durable ledgers / evidence writers. Listeners are failure-isolated. */
  subscribe(listener: (observation: NormalizedObservation, snapshot: RouteHealthSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private stateFor(providerId: string, modelId: string): RouteState {
    const key = routeKeyOf(providerId, modelId);
    let state = this.routes.get(key);
    if (!state) {
      state = { providerId, modelId, calls: [], tools: [], roleEvidence: [], roleEvidenceKeys: new Set(), conditions: new Map(), consecutiveFailures: 0, consecutiveAuthFailures: 0, consecutiveMalformed: 0, quota: {} };
      this.routes.set(key, state);
    }
    return state;
  }

  private setCondition(state: RouteState, condition: RouteCondition): void {
    const prior = state.conditions.get(condition.state);
    // Reinforcement: an already-active transient condition keeps its `since`, extends its expiry
    // and gains confidence; it never silently shortens because a later weaker signal arrived.
    if (prior && prior.expiresAt !== null && condition.expiresAt !== null) {
      state.conditions.set(condition.state, {
        ...condition,
        since: prior.since,
        expiresAt: Math.max(prior.expiresAt, condition.expiresAt),
        confidence: clamp01(Math.max(prior.confidence, condition.confidence) + 0.1),
        sampleSize: prior.sampleSize + condition.sampleSize,
        roles: condition.roles ?? prior.roles,
      });
      return;
    }
    state.conditions.set(condition.state, condition);
  }

  private clearCondition(state: RouteState, name: RouteHealthCondition): void {
    state.conditions.delete(name);
  }

  private prune(state: RouteState, now: number): void {
    const horizon = now - this.policy.windowMs;
    state.calls = state.calls.filter((c) => c.at >= horizon).slice(-this.policy.windowSize);
    state.tools = state.tools.filter((t) => t.at >= horizon).slice(-this.policy.windowSize);
    state.roleEvidence = state.roleEvidence.filter((s) => s.at >= horizon).slice(-this.policy.windowSize);
    // Evicted samples can no longer dedup — rebuild the key set from what survived so a stale
    // key cannot suppress a legitimately new observation forever.
    if (state.roleEvidenceKeys.size > 0) {
      const live = new Set<string>();
      for (const s of state.roleEvidence) {
        if (s.correlationId) live.add(`${s.correlationId}|${s.role}|${s.outcome}|${s.failureClass ?? "-"}`);
      }
      state.roleEvidenceKeys = live;
    }
    for (const [name, condition] of state.conditions) {
      if (condition.expiresAt !== null && condition.expiresAt <= now) state.conditions.delete(name);
    }
  }

  /** Ingest one normalized observation. Returns the route's post-ingest snapshot. */
  observe(observation: NormalizedObservation): RouteHealthSnapshot {
    const state = this.stateFor(observation.providerId, observation.modelId);
    const at = Date.parse(observation.observedAt);
    const now = Number.isFinite(at) ? at : this.now();
    const iso = new Date(now).toISOString();
    state.lastObservedAt = Math.max(state.lastObservedAt ?? 0, now);
    this.prune(state, this.now());

    switch (observation.kind) {
      case "probe_gate": {
        state.lastProbeAt = now;
        state.calls.push({ at: now, ok: observation.served, latencyMs: observation.latencyMs, reason: observation.failureReason, role: observation.role, shape: observation.requestShape ?? "production" });
        if (observation.served) {
          this.onSuccess(state, now, iso, "probe", observation.requestShape ?? "production");
        } else {
          this.onFailure(state, now, iso, observation.failureReason ?? "UNKNOWN", observation.failureMessage, undefined, undefined, "probe", observation.role);
        }
        break;
      }
      case "call_success": {
        state.calls.push({ at: now, ok: true, latencyMs: observation.latencyMs, role: observation.role, shape: observation.requestShape ?? "production" });
        this.onSuccess(state, now, iso, observation.source, observation.requestShape ?? "production");
        break;
      }
      case "call_failure": {
        state.calls.push({ at: now, ok: false, reason: observation.reason, role: observation.role, shape: observation.requestShape ?? "production" });
        this.onFailure(state, now, iso, observation.reason, observation.message, observation.retryAfterMs, observation.status, observation.source, observation.role);
        break;
      }
      case "rate_limit_headers": {
        state.quota = {
          requestsRemaining: observation.requestsRemaining ?? state.quota.requestsRemaining,
          requestsLimit: observation.requestsLimit ?? state.quota.requestsLimit,
          tokensRemaining: observation.tokensRemaining ?? state.quota.tokensRemaining,
          tokensLimit: observation.tokensLimit ?? state.quota.tokensLimit,
          resetAt: observation.tokensResetAt ?? observation.requestsResetAt ?? state.quota.resetAt,
          observedAt: iso,
        };
        const exhausted = observation.requestsRemaining === 0 || observation.tokensRemaining === 0;
        if (observation.status === 429 || exhausted) {
          const resetAt = observation.tokensRemaining === 0 ? observation.tokensResetAt : observation.requestsResetAt;
          const resetMs = resetAt ? Date.parse(resetAt) : Number.NaN;
          const ttl = observation.retryAfterMs ?? (Number.isFinite(resetMs) ? Math.max(0, resetMs - now) : this.policy.rateLimitDefaultTtlMs);
          this.setCondition(state, { state: "RATE_LIMITED", since: iso, expiresAt: now + ttl, confidence: 0.9, sampleSize: 1, reasonCode: exhausted ? "HEADER_WINDOW_EXHAUSTED" : "HTTP_429", resetEstimate: resetAt ?? new Date(now + ttl).toISOString(), source: observation.source });
        }
        break;
      }
      case "daily_allowance": {
        if (observation.unit === "requests") {
          state.quota.requestsRemaining = observation.remaining;
          state.quota.requestsLimit = observation.limit;
        } else {
          state.quota.tokensRemaining = observation.remaining;
          state.quota.tokensLimit = observation.limit;
        }
        state.quota.resetAt = observation.resetAt;
        state.quota.observedAt = iso;
        const resetMs = Date.parse(observation.resetAt);
        if (observation.remaining <= 0) {
          this.setCondition(state, { state: "DAILY_QUOTA_EXHAUSTED", since: iso, expiresAt: Number.isFinite(resetMs) ? resetMs : now + this.policy.dailyQuotaDefaultTtlMs, confidence: 1, sampleSize: 1, reasonCode: `DAILY_${observation.unit.toUpperCase()}_EXHAUSTED`, resetEstimate: observation.resetAt, source: observation.source });
        } else {
          this.clearCondition(state, "DAILY_QUOTA_EXHAUSTED");
        }
        break;
      }
      case "tool_outcome": {
        state.tools.push({ at: now, outcome: observation.outcome, role: observation.role });
        if (observation.outcome === "valid") {
          state.consecutiveMalformed = 0;
        } else {
          // R50 §9: a boundary violation weighs double in the streak — two consecutive
          // escape attempts quarantine where four formatting slips would.
          state.consecutiveMalformed += observation.outcome === "boundary_violation" ? 2 : 1;
          if (state.consecutiveMalformed >= this.policy.quarantineStreak) {
            this.setCondition(state, { state: "QUARANTINED", since: iso, expiresAt: null, confidence: 1, sampleSize: state.consecutiveMalformed, reasonCode: "MALFORMED_TOOL_CALL_STREAK", source: observation.source });
          }
        }
        this.recomputeToolReliability(state, now, iso, observation.source);
        break;
      }
      case "role_outcome": {
        if (!observation.role) break;
        const role = observation.role;
        // R50 §29: idempotent ingest — a re-emitted or replayed outcome for the same
        // correlation (run) must not double-penalize or double-reward the route.
        const dedupKey = observation.correlationId
          ? `${observation.correlationId}|${role}|${observation.outcome}|${observation.failureClass ?? "-"}`
          : undefined;
        if (dedupKey !== undefined && state.roleEvidenceKeys.has(dedupKey)) break;
        state.roleEvidence.push({
          at: now,
          role,
          outcome: observation.outcome,
          failureClass: observation.failureClass,
          weight: roleOutcomeWeight(observation.outcome, observation.failureClass),
          correlationId: observation.correlationId,
        });
        if (dedupKey !== undefined) state.roleEvidenceKeys.add(dedupKey);
        if (observation.outcome === "verified_complete") {
          const prior = state.conditions.get("CAPABILITY_LIMITED");
          if (prior?.roles) {
            const roles = prior.roles.filter((r) => r !== role);
            if (roles.length === 0) this.clearCondition(state, "CAPABILITY_LIMITED");
            else state.conditions.set("CAPABILITY_LIMITED", { ...prior, roles });
          }
        } else if (observation.outcome === "converged") {
          // Weaker than verified: worth positive evidence, never a condition mutation — a
          // converged-but-unverified run does not clear a security or capability verdict.
          break;
        } else {
          // Negative role outcomes are model-quality evidence. A boundary/security failure
          // weighs more than an ordinary non-convergence: the model did not merely fail to
          // finish, it proposed an action the authority boundary had to refuse.
          const severe = observation.outcome === "security_blocked";
          const prior = state.conditions.get("CAPABILITY_LIMITED");
          const roles = new Set(prior?.roles ?? []);
          roles.add(role);
          this.setCondition(state, {
            state: "CAPABILITY_LIMITED",
            since: iso,
            expiresAt: now + this.policy.healthyTtlMs * (severe ? 8 : 4),
            confidence: severe ? 0.85 : 0.5,
            sampleSize: 1,
            reasonCode: observation.failureClass ? `ROLE_${observation.failureClass}` : `ROLE_${observation.outcome.toUpperCase()}`,
            source: observation.source,
            roles: [...roles],
          });
        }
        break;
      }
      case "catalog": {
        switch (observation.fact) {
          case "retired":
          case "not_found":
            this.setCondition(state, { state: "MODEL_RETIRED", since: iso, expiresAt: null, confidence: 1, sampleSize: 1, reasonCode: observation.fact === "retired" ? "CATALOG_RETIRED" : "CATALOG_NOT_FOUND", source: observation.source });
            break;
          case "access_restricted":
            this.setCondition(state, { state: "ACCESS_RESTRICTED", since: iso, expiresAt: null, confidence: 1, sampleSize: 1, reasonCode: "CATALOG_ACCESS_RESTRICTED", source: observation.source });
            break;
          case "billing_unverifiable":
            this.setCondition(state, { state: "BILLING_VERIFICATION_REQUIRED", since: iso, expiresAt: null, confidence: 1, sampleSize: 1, reasonCode: "BILLING_PLAN_UNVERIFIABLE", source: observation.source });
            break;
          case "billing_verified":
            this.clearCondition(state, "BILLING_VERIFICATION_REQUIRED");
            break;
          case "present":
            // A catalog refresh that still lists the route clears retirement/not-found only —
            // access restriction is a provider policy the catalog does not reveal.
            this.clearCondition(state, "MODEL_RETIRED");
            break;
        }
        break;
      }
      case "entitlement": {
        switch (observation.fact) {
          case "connected":
            this.clearCondition(state, "USER_CONNECTION_REQUIRED");
            this.clearCondition(state, "AUTH_REQUIRED");
            break;
          case "connection_required":
            this.setCondition(state, { state: "USER_CONNECTION_REQUIRED", since: iso, expiresAt: now + this.policy.authRequiredTtlMs, confidence: 1, sampleSize: 1, reasonCode: "USER_CONNECTION_REQUIRED", source: observation.source });
            break;
          case "auth_required":
            this.setCondition(state, { state: "AUTH_REQUIRED", since: iso, expiresAt: now + this.policy.authRequiredTtlMs, confidence: 1, sampleSize: 1, reasonCode: "ENTITLEMENT_AUTH_REQUIRED", source: observation.source });
            break;
          case "quota_exhausted":
          case "overage_blocked": {
            const resetMs = observation.resetAt ? Date.parse(observation.resetAt) : Number.NaN;
            this.setCondition(state, { state: "DAILY_QUOTA_EXHAUSTED", since: iso, expiresAt: Number.isFinite(resetMs) ? resetMs : now + this.policy.dailyQuotaDefaultTtlMs, confidence: 1, sampleSize: 1, reasonCode: observation.fact === "overage_blocked" ? "ENTITLEMENT_OVERAGE_BLOCKED" : "ENTITLEMENT_QUOTA_EXHAUSTED", resetEstimate: observation.resetAt, source: observation.source });
            break;
          }
        }
        break;
      }
      case "governor_pressure": {
        state.governor = { pacingWaitMs: observation.pacingWaitMs, inFlight: observation.inFlight, observedAt: iso };
        if (observation.bucketRemainingTokens !== undefined) state.quota.tokensRemaining = observation.bucketRemainingTokens;
        break;
      }
      case "quarantine": {
        if (observation.action === "set") {
          this.setCondition(state, { state: "QUARANTINED", since: iso, expiresAt: null, confidence: 1, sampleSize: 1, reasonCode: observation.reason, source: observation.source });
        } else {
          this.clearCondition(state, "QUARANTINED");
          state.consecutiveMalformed = 0;
        }
        break;
      }
    }

    const snapshot = this.snapshotRoute(state, this.now());
    for (const listener of this.listeners) {
      try {
        listener(observation, snapshot);
      } catch {
        // Ledger/evidence sinks are observational; they never break routing.
      }
    }
    return snapshot;
  }

  private onSuccess(state: RouteState, now: number, iso: string, source: ObservationSource, shape: RequestShape): void {
    state.consecutiveFailures = 0;
    state.consecutiveAuthFailures = 0;
    state.lastSuccessAt = now;
    // A served production-shaped request is direct evidence against saturation / capacity /
    // short rate limits / auth. Daily quota, catalog and quarantine facts are NOT contradicted
    // by one success — a served call can precede exhaustion by seconds.
    if (shape === "production") {
      this.clearCondition(state, "SATURATED");
      this.clearCondition(state, "TEMPORARY_CAPACITY");
    }
    this.clearCondition(state, "AUTH_REQUIRED");
    const recentRateLimit = state.conditions.get("RATE_LIMITED");
    if (recentRateLimit && recentRateLimit.reasonCode !== "HEADER_WINDOW_EXHAUSTED") this.clearCondition(state, "RATE_LIMITED");
    const successes = state.calls.filter((c) => c.ok).length;
    this.setCondition(state, { state: "HEALTHY", since: iso, expiresAt: now + this.policy.healthyTtlMs, confidence: clamp01(0.4 + successes / 10), sampleSize: 1, reasonCode: shape === "production" ? "SERVED_PRODUCTION_SHAPE" : "SERVED_BARE_PROBE", source });
    this.recomputeDegradation(state, now, iso, source);
  }

  private onFailure(state: RouteState, now: number, iso: string, reason: FailureReason, message: string | undefined, retryAfterMs: number | undefined, status: number | undefined, source: ObservationSource, role?: EightBitRole): void {
    state.consecutiveFailures += 1;
    this.clearCondition(state, "HEALTHY");
    switch (reason) {
      case "TEMPORARY_CAPACITY": {
        // Shared-worker saturation (R23 F3: "Worker local total request limit reached (16/16)").
        const isSaturation = message !== undefined && /request limit reached|worker local|resource ?exhausted|at capacity|over capacity/i.test(message);
        const target: RouteHealthCondition = isSaturation ? "SATURATED" : "TEMPORARY_CAPACITY";
        const ttl = isSaturation ? this.policy.saturationTtlMs : this.policy.temporaryCapacityTtlMs;
        this.setCondition(state, { state: target, since: iso, expiresAt: now + ttl, confidence: clamp01(0.5 + 0.15 * state.consecutiveFailures), sampleSize: 1, reasonCode: isSaturation ? "SHARED_CAPACITY_SATURATED" : "PROVIDER_CAPACITY_BLIP", resetEstimate: new Date(now + ttl).toISOString(), source });
        break;
      }
      case "PROVIDER_OUTAGE": {
        this.setCondition(state, { state: "TEMPORARY_CAPACITY", since: iso, expiresAt: now + this.policy.temporaryCapacityTtlMs, confidence: clamp01(0.4 + 0.15 * state.consecutiveFailures), sampleSize: 1, reasonCode: "PROVIDER_OUTAGE", source });
        break;
      }
      case "RATE_LIMITED": {
        const rateLimitClass = classifyRateLimit(message ?? "");
        if (isDailyQuotaMessage(message) || rateLimitClass === "DAILY") {
          const ttl = retryAfterMs ?? this.policy.dailyQuotaDefaultTtlMs;
          this.setCondition(state, { state: "DAILY_QUOTA_EXHAUSTED", since: iso, expiresAt: now + ttl, confidence: 0.9, sampleSize: 1, reasonCode: "DAILY_LIMIT_429", resetEstimate: new Date(now + ttl).toISOString(), source, rateLimitClass });
        } else {
          const ttl = retryAfterMs ?? this.policy.rateLimitDefaultTtlMs;
          this.setCondition(state, { state: "RATE_LIMITED", since: iso, expiresAt: now + ttl, confidence: 0.9, sampleSize: 1, reasonCode: "HTTP_429", resetEstimate: new Date(now + ttl).toISOString(), source, rateLimitClass });
        }
        break;
      }
      case "QUOTA_EXHAUSTED": {
        const ttl = retryAfterMs ?? this.policy.dailyQuotaDefaultTtlMs;
        const rateLimitClass = classifyRateLimit(message ?? "");
        this.setCondition(state, { state: "DAILY_QUOTA_EXHAUSTED", since: iso, expiresAt: now + ttl, confidence: 0.95, sampleSize: 1, reasonCode: "QUOTA_EXHAUSTED", resetEstimate: new Date(now + ttl).toISOString(), source, rateLimitClass });
        break;
      }
      case "AUTH_FAILURE": {
        state.consecutiveAuthFailures += 1;
        if (state.consecutiveAuthFailures >= this.policy.authFailureStreak || status === 401) {
          this.setCondition(state, { state: "AUTH_REQUIRED", since: iso, expiresAt: now + this.policy.authRequiredTtlMs, confidence: 1, sampleSize: state.consecutiveAuthFailures, reasonCode: "AUTH_FAILURE_STREAK", source });
        } else {
          this.setCondition(state, { state: "DEGRADED", since: iso, expiresAt: now + this.policy.temporaryCapacityTtlMs, confidence: 0.5, sampleSize: 1, reasonCode: "AUTH_FAILURE_SINGLE", source });
        }
        break;
      }
      case "ACCESS_RESTRICTED":
        this.setCondition(state, { state: "ACCESS_RESTRICTED", since: iso, expiresAt: null, confidence: 1, sampleSize: 1, reasonCode: "PROVIDER_ACCESS_RESTRICTED", source });
        break;
      case "MODEL_RETIRED":
      case "MODEL_NOT_FOUND":
      case "FREE_ELIGIBILITY_REMOVED":
        this.setCondition(state, { state: "MODEL_RETIRED", since: iso, expiresAt: null, confidence: 1, sampleSize: 1, reasonCode: reason, source });
        break;
      case "PAID_PLAN_REQUIRED":
      case "FREE_TIER_NOT_AVAILABLE":
        this.setCondition(state, { state: "BILLING_VERIFICATION_REQUIRED", since: iso, expiresAt: null, confidence: 1, sampleSize: 1, reasonCode: reason, source });
        break;
      case "INVALID_TOOL_OUTPUT":
      case "STRUCTURED_OUTPUT_FAILURE": {
        // Provider-side tool validation is the model's fault, not the route's supply health;
        // it feeds the tool-reliability projection, never saturation. The observation's role
        // scopes the condition (a model can misfire as CODER and still reason fine as ANALYST).
        state.tools.push({ at: now, outcome: reason === "INVALID_TOOL_OUTPUT" ? "malformed" : "structured_output_failure", role });
        state.consecutiveMalformed += 1;
        if (state.consecutiveMalformed >= this.policy.quarantineStreak) {
          this.setCondition(state, { state: "QUARANTINED", since: iso, expiresAt: null, confidence: 1, sampleSize: state.consecutiveMalformed, reasonCode: "MALFORMED_TOOL_CALL_STREAK", source });
        }
        this.recomputeToolReliability(state, now, iso, source);
        break;
      }
      default:
        break;
    }
    this.recomputeDegradation(state, now, iso, source);
  }

  private recomputeDegradation(state: RouteState, now: number, iso: string, source: ObservationSource): void {
    const window = this.windowStats(state, now);
    if (window.calls < this.policy.minSamplesForRates) return;
    // Model-fault rejections are excluded here (they live in TOOL_UNRELIABLE); supply failures only.
    const supplyFailures = state.calls.filter((c) => !c.ok && c.reason !== "INVALID_TOOL_OUTPUT" && c.reason !== "STRUCTURED_OUTPUT_FAILURE").length;
    const rate = supplyFailures / window.calls;
    if (rate >= this.policy.degradedFailureRate) {
      this.setCondition(state, { state: "DEGRADED", since: iso, expiresAt: now + this.policy.healthyTtlMs, confidence: clamp01(0.3 + window.calls / 20), sampleSize: window.calls, reasonCode: "WINDOW_FAILURE_RATE", source });
    } else {
      const existing = state.conditions.get("DEGRADED");
      if (existing?.reasonCode === "WINDOW_FAILURE_RATE") this.clearCondition(state, "DEGRADED");
    }
  }

  private recomputeToolReliability(state: RouteState, now: number, iso: string, source: ObservationSource): void {
    const samples = state.tools;
    if (samples.length < this.policy.minSamplesForRates) return;
    const malformed = samples.filter((t) => t.outcome !== "valid").length;
    const rate = malformed / samples.length;
    if (rate >= this.policy.toolUnreliableRate) {
      const roles = [...new Set(samples.filter((t) => t.outcome !== "valid" && t.role).map((t) => t.role!))];
      this.setCondition(state, { state: "TOOL_UNRELIABLE", since: iso, expiresAt: now + this.policy.healthyTtlMs * 2, confidence: clamp01(0.3 + samples.length / 20), sampleSize: samples.length, reasonCode: `MALFORMED_TOOL_RATE_${Math.round(rate * 100)}PCT`, source, roles: roles.length > 0 ? roles : undefined });
    } else {
      this.clearCondition(state, "TOOL_UNRELIABLE");
    }
  }

  private windowStats(state: RouteState, now: number): RouteWindowStats {
    const horizon = now - this.policy.windowMs;
    const calls = state.calls.filter((c) => c.at >= horizon);
    const tools = state.tools.filter((t) => t.at >= horizon);
    const latencies = calls.map((c) => c.latencyMs).filter((v): v is number => typeof v === "number" && v >= 0).sort((a, b) => a - b);
    return {
      calls: calls.length,
      successes: calls.filter((c) => c.ok).length,
      failures: calls.filter((c) => !c.ok).length,
      rateLimits: calls.filter((c) => c.reason === "RATE_LIMITED" || c.reason === "QUOTA_EXHAUSTED").length,
      capacityErrors: calls.filter((c) => c.reason !== undefined && isCapacityReason(c.reason)).length,
      malformedToolCalls: tools.filter((t) => t.outcome !== "valid").length,
      toolCalls: tools.length,
      latencyP50Ms: percentile(latencies, 0.5),
      latencyP95Ms: percentile(latencies, 0.95),
      from: calls.length > 0 ? new Date(Math.min(...calls.map((c) => c.at))).toISOString() : undefined,
      to: calls.length > 0 ? new Date(Math.max(...calls.map((c) => c.at))).toISOString() : undefined,
    };
  }

  /** Active conditions in precedence order, with confidence decayed by age for transient ones. */
  private activeConditions(state: RouteState, now: number, role?: EightBitRole): RouteCondition[] {
    const active: RouteCondition[] = [];
    for (const name of STATE_PRECEDENCE) {
      const condition = state.conditions.get(name);
      if (!condition) continue;
      if (condition.expiresAt !== null && condition.expiresAt <= now) continue;
      if (condition.roles && role !== undefined && !condition.roles.includes(role)) continue;
      if (condition.expiresAt === null) {
        active.push(condition);
        continue;
      }
      const sinceMs = Date.parse(condition.since);
      const span = Math.max(1, condition.expiresAt - (Number.isFinite(sinceMs) ? sinceMs : now));
      const remaining = clamp01((condition.expiresAt - now) / span);
      active.push({ ...condition, confidence: clamp01(condition.confidence * (0.5 + 0.5 * remaining)) });
    }
    return active;
  }

  /**
   * The routing verdict for one route and (optionally) one role. Hard exclusions come from the
   * governing condition; the score delta blends the governing state, role-specific penalties,
   * latency and freshness. Absent evidence is UNKNOWN — mildly penalised so known-good routes win.
   */
  assess(providerId: string, modelId: string, options: { role?: EightBitRole; now?: number } = {}): RouteHealthAssessment {
    const now = options.now ?? this.now();
    const state = this.routes.get(routeKeyOf(providerId, modelId));
    const empty: RouteWindowStats = { calls: 0, successes: 0, failures: 0, rateLimits: 0, capacityErrors: 0, malformedToolCalls: 0, toolCalls: 0, latencyP50Ms: null, latencyP95Ms: null };
    if (!state) {
      return { providerId, modelId, state: "UNKNOWN", hardExclude: false, scoreAdjustment: SCORE_ADJUSTMENT.UNKNOWN, confidence: 0, reasonCodes: ["NO_HEALTH_EVIDENCE"], sampleSize: 0, activeConditions: [], window: empty };
    }
    this.prune(state, now);
    const active = this.activeConditions(state, now, options.role);
    const window = this.windowStats(state, now);
    const governing = active[0];
    const reasonCodes: string[] = [];
    let stateName: RouteHealthCondition = "UNKNOWN";
    let scoreAdjustment = 0;
    let confidence = 0;

    if (governing) {
      stateName = governing.state;
      confidence = governing.confidence;
      reasonCodes.push(`${governing.state}:${governing.reasonCode}`);
      scoreAdjustment += SCORE_ADJUSTMENT[governing.state] * (PERMANENT_STATES.has(governing.state) || HARD_EXCLUDE_STATES.has(governing.state) ? 1 : Math.max(0.35, governing.confidence));
      // Secondary active conditions still shape the rank (e.g. HEALTHY route with TOOL_UNRELIABLE for coders).
      for (const secondary of active.slice(1)) {
        if (secondary.state === "HEALTHY" || secondary.state === "UNKNOWN") continue;
        const roleScaled = secondary.state === "TOOL_UNRELIABLE" && options.role !== undefined && !TOOL_DEPENDENT_ROLES.has(options.role) ? 0.2 : 1;
        scoreAdjustment += SCORE_ADJUSTMENT[secondary.state] * Math.max(0.35, secondary.confidence) * 0.5 * roleScaled;
        reasonCodes.push(`${secondary.state}:${secondary.reasonCode}`);
      }
      if (governing.state === "TOOL_UNRELIABLE" && options.role !== undefined && !TOOL_DEPENDENT_ROLES.has(options.role)) {
        // A read-mostly role tolerates a chatty writer: down-weight to a mild penalty (§10, §35).
        scoreAdjustment = SCORE_ADJUSTMENT.TOOL_UNRELIABLE * 0.2 * Math.max(0.35, governing.confidence);
        reasonCodes.push("TOOL_UNRELIABLE_ROLE_TOLERANT");
      }
    } else {
      reasonCodes.push(state.lastObservedAt ? "EVIDENCE_EXPIRED" : "NO_HEALTH_EVIDENCE");
      scoreAdjustment = SCORE_ADJUSTMENT.UNKNOWN;
    }

    if (window.latencyP95Ms !== null && window.latencyP95Ms > this.policy.latencyTargetMs) {
      scoreAdjustment -= Math.min(20, Math.round(10 * (window.latencyP95Ms / this.policy.latencyTargetMs - 1)));
      reasonCodes.push("LATENCY_P95_ABOVE_TARGET");
    }
    if (state.governor && state.governor.pacingWaitMs > 30_000) {
      scoreAdjustment -= 10;
      reasonCodes.push("GOVERNOR_PACING_PRESSURE");
    }

    const hardExclude = governing !== undefined && HARD_EXCLUDE_STATES.has(governing.state);
    return {
      providerId,
      modelId,
      state: stateName,
      hardExclude,
      scoreAdjustment: Math.round(scoreAdjustment),
      confidence: Number(confidence.toFixed(3)),
      reasonCodes,
      expiresAt: governing?.expiresAt ?? undefined,
      resetEstimate: governing?.resetEstimate,
      sampleSize: governing?.sampleSize ?? window.calls,
      lastObservedAt: state.lastObservedAt ? new Date(state.lastObservedAt).toISOString() : undefined,
      activeConditions: active,
      window,
    };
  }

  /**
   * R50 §6: the route's graded runtime evidence for ONE role — the decayed, deduplicated sum of
   * observed outcomes in the rolling window, scaled by sample confidence and bounded to
   * ±MAX_ROLE_EVIDENCE_ADJUSTMENT. Zero evidence is neutral (cold-start §28: a qualified route
   * with no runtime history must not lose by default); a single failure is small; repeated
   * failures saturate the bound; verified work gradually outweighs failures. This is advisory
   * ranking input only — it can never create eligibility or overturn a verdict floor.
   */
  roleQualityDelta(providerId: string, modelId: string, role: EightBitRole, now: number = this.now()): { scoreAdjustment: number; reasonCodes: string[]; samples: number; netEvidence: number } {
    const state = this.routes.get(routeKeyOf(providerId, modelId));
    if (!state) return { scoreAdjustment: 0, reasonCodes: ["ROLE_RUNTIME_EVIDENCE_ABSENT"], samples: 0, netEvidence: 0 };
    this.prune(state, now);
    const samples = state.roleEvidence.filter((s) => s.role === role);
    if (samples.length === 0) return { scoreAdjustment: 0, reasonCodes: ["ROLE_RUNTIME_EVIDENCE_ABSENT"], samples: 0, netEvidence: 0 };
    let net = 0;
    const classes = new Map<string, number>();
    for (const s of samples) {
      const decay = Math.max(0, 1 - (now - s.at) / this.policy.windowMs);
      net += s.weight * decay;
      const key = s.failureClass ?? s.outcome.toUpperCase();
      classes.set(key, (classes.get(key) ?? 0) + 1);
    }
    const confidence = Math.min(1, samples.length / ROLE_EVIDENCE_FULL_CONFIDENCE_SAMPLES);
    const scoreAdjustment = Math.max(-MAX_ROLE_EVIDENCE_ADJUSTMENT, Math.min(MAX_ROLE_EVIDENCE_ADJUSTMENT, Math.round(net * ROLE_EVIDENCE_SCALE * confidence)));
    const dominant = [...classes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const reasonCodes = [
      net > 0 ? "ROLE_RUNTIME_POSITIVE" : net < 0 ? "ROLE_RUNTIME_NEGATIVE" : "ROLE_RUNTIME_NEUTRAL",
      ...(dominant !== undefined ? [`ROLE_RUNTIME_DOMINANT_${dominant}`] : []),
    ];
    return { scoreAdjustment, reasonCodes, samples: samples.length, netEvidence: Number(net.toFixed(3)) };
  }

  /** R50: the graded per-role evidence behind a routing/explainer surface (bounded copy). */
  roleEvidenceFor(providerId: string, modelId: string, role: EightBitRole, now: number = this.now()): RoleOutcomeSample[] {
    const state = this.routes.get(routeKeyOf(providerId, modelId));
    if (!state) return [];
    this.prune(state, now);
    return state.roleEvidence.filter((s) => s.role === role);
  }

  /**
   * Probe budgeting (§9): is a live production-shaped probe worth spending now? Weighs the
   * information gain (how uncertain routing is about this route), the probability the state has
   * changed since the last observation, the route's importance, and the remaining allowance.
   */
  probeAdvice(providerId: string, modelId: string, input: ProbeAdviceInput = {}): ProbeAdvice {
    const now = input.now ?? this.now();
    const cost = input.probeCost ?? DEFAULT_PROBE_COST;
    const importance = clamp01(input.importance ?? 0.5);
    const assessment = this.assess(providerId, modelId, { now, role: input.role });
    const reasonCodes: string[] = [];
    const state = this.routes.get(routeKeyOf(providerId, modelId));
    const refuse = (never: boolean, notBefore?: number, gain = 0, changeProbability = 0): ProbeAdvice => ({ shouldProbe: false, reasonCodes, informationGain: gain, stateChangeProbability: changeProbability, estimatedCost: cost, notBefore, never });

    if (PERMANENT_STATES.has(assessment.state)) {
      reasonCodes.push("PERMANENT_CONDITION_NO_PROBE");
      return refuse(true);
    }
    if (assessment.state === "QUARANTINED" || assessment.state === "AUTH_REQUIRED" || assessment.state === "USER_CONNECTION_REQUIRED") {
      reasonCodes.push("REQUIRES_EXPLICIT_RECOVERY");
      return refuse(true);
    }
    if (assessment.state === "DAILY_QUOTA_EXHAUSTED" || assessment.state === "RATE_LIMITED") {
      reasonCodes.push("WAIT_FOR_RESET");
      return refuse(false, assessment.expiresAt);
    }
    const remainingRequests = input.remainingRequests ?? state?.quota.requestsRemaining;
    const remainingTokens = input.remainingTokens ?? state?.quota.tokensRemaining;
    if (remainingRequests !== undefined && remainingRequests - cost.requests < this.policy.probeRequestReserve) {
      reasonCodes.push("REQUEST_RESERVE_PROTECTED");
      return refuse(false, state?.quota.resetAt ? Date.parse(state.quota.resetAt) : undefined);
    }
    if (remainingTokens !== undefined && remainingTokens - cost.tokens < this.policy.probeTokenReserve) {
      reasonCodes.push("TOKEN_RESERVE_PROTECTED");
      return refuse(false, state?.quota.resetAt ? Date.parse(state.quota.resetAt) : undefined);
    }

    const lastObserved = state?.lastObservedAt;
    const ageMs = lastObserved === undefined ? Number.POSITIVE_INFINITY : now - lastObserved;
    const stateChangeProbability = lastObserved === undefined ? 1 : clamp01(1 - Math.exp(-ageMs / this.policy.transientChangeTauMs));
    // Uncertainty: no evidence → 1; fresh HEALTHY with many samples → low; transient negative
    // condition near expiry → high (routing would like to know whether it lifted).
    let uncertainty: number;
    if (assessment.state === "UNKNOWN") uncertainty = 1;
    else if (assessment.state === "HEALTHY") uncertainty = clamp01(0.15 + 0.85 * stateChangeProbability) * clamp01(1 - assessment.confidence * 0.5);
    else {
      const expiresAt = assessment.expiresAt ?? now;
      const remainingMs = Math.max(0, expiresAt - now);
      uncertainty = clamp01(0.5 + 0.5 * (1 - remainingMs / Math.max(remainingMs, this.policy.saturationTtlMs)));
    }
    const informationGain = clamp01(uncertainty * (0.5 + 0.5 * importance));
    if (assessment.state === "HEALTHY" && ageMs < this.policy.healthyTtlMs / 2 && importance < 0.9) {
      reasonCodes.push("FRESH_HEALTHY_EVIDENCE");
      return refuse(false, lastObserved! + this.policy.healthyTtlMs / 2, informationGain, stateChangeProbability);
    }
    if (assessment.state === "SATURATED" || assessment.state === "TEMPORARY_CAPACITY") {
      const expiresAt = assessment.expiresAt ?? now;
      if (expiresAt - now > this.policy.saturationTtlMs / 2 && importance < 0.9) {
        reasonCodes.push("TRANSIENT_CONDITION_STILL_FRESH");
        return refuse(false, expiresAt - this.policy.saturationTtlMs / 2, informationGain, stateChangeProbability);
      }
    }
    const threshold = 0.35 - 0.25 * importance;
    if (informationGain < threshold) {
      reasonCodes.push("INFORMATION_GAIN_BELOW_THRESHOLD");
      return refuse(false, now + this.policy.transientChangeTauMs / 2, informationGain, stateChangeProbability);
    }
    reasonCodes.push(assessment.state === "UNKNOWN" ? "NO_EVIDENCE_PROBE_WORTHWHILE" : "STATE_LIKELY_CHANGED");
    return { shouldProbe: true, reasonCodes, informationGain, stateChangeProbability, estimatedCost: cost, never: false };
  }

  /** A catalog refresh proved the route is served again (or the provider policy changed). */
  catalogChanged(providerId: string, modelId: string, reason = "CATALOG_REFRESH"): void {
    const state = this.routes.get(routeKeyOf(providerId, modelId));
    if (!state) return;
    for (const name of PERMANENT_STATES) state.conditions.delete(name);
    state.conditions.delete("QUARANTINED");
    state.consecutiveMalformed = 0;
    state.consecutiveAuthFailures = 0;
    state.conditions.set("UNKNOWN", { state: "UNKNOWN", since: new Date(this.now()).toISOString(), expiresAt: this.now() + this.policy.healthyTtlMs, confidence: 0.2, sampleSize: 0, reasonCode: reason, source: "registry" });
  }

  /** Explicit human recovery for AUTH_REQUIRED / USER_CONNECTION_REQUIRED (credential changed). */
  credentialChanged(providerId: string, modelId?: string): void {
    for (const state of this.routes.values()) {
      if (state.providerId !== providerId) continue;
      if (modelId !== undefined && state.modelId !== modelId) continue;
      state.conditions.delete("AUTH_REQUIRED");
      state.conditions.delete("USER_CONNECTION_REQUIRED");
      state.consecutiveAuthFailures = 0;
    }
  }

  private snapshotRoute(state: RouteState, now: number): RouteHealthSnapshot {
    const active = this.activeConditions(state, now);
    return {
      providerId: state.providerId,
      modelId: state.modelId,
      conditions: [...state.conditions.values()].map((c) => ({ ...c, roles: c.roles ? [...c.roles] : undefined })),
      roleEvidence: state.roleEvidence.map((s) => ({ ...s, at: new Date(s.at).toISOString() })),
      window: this.windowStats(state, now),
      consecutiveFailures: state.consecutiveFailures,
      consecutiveAuthFailures: state.consecutiveAuthFailures,
      consecutiveMalformed: state.consecutiveMalformed,
      lastObservedAt: state.lastObservedAt ? new Date(state.lastObservedAt).toISOString() : undefined,
      lastSuccessAt: state.lastSuccessAt ? new Date(state.lastSuccessAt).toISOString() : undefined,
      lastProbeAt: state.lastProbeAt ? new Date(state.lastProbeAt).toISOString() : undefined,
      quota: { ...state.quota },
      governor: state.governor ? { ...state.governor } : undefined,
      state: active[0]?.state ?? (state.lastObservedAt ? "UNKNOWN" : "UNKNOWN"),
    };
  }

  snapshot(now: number = this.now()): RouteHealthSnapshot[] {
    return [...this.routes.values()].map((state) => this.snapshotRoute(state, now));
  }

  get(providerId: string, modelId: string, now: number = this.now()): RouteHealthSnapshot | undefined {
    const state = this.routes.get(routeKeyOf(providerId, modelId));
    return state ? this.snapshotRoute(state, now) : undefined;
  }

  /**
   * Restore a persisted snapshot (restart / cross-session). Conditions keep their original
   * expiry, so a saturation recorded 20 minutes ago is already gone and a retirement is still
   * there. The call/tool windows are NOT restored (they are re-observed live); rolling rates start
   * fresh while the durable conditions carry over.
   */
  hydrate(snapshot: RouteHealthSnapshot): void {
    const state = this.stateFor(snapshot.providerId, snapshot.modelId);
    for (const condition of snapshot.conditions) {
      if (condition.expiresAt !== null && condition.expiresAt <= this.now()) continue;
      state.conditions.set(condition.state, { ...condition, source: "hydrate", roles: condition.roles ? [...condition.roles] : undefined });
    }
    state.consecutiveFailures = snapshot.consecutiveFailures;
    state.consecutiveAuthFailures = snapshot.consecutiveAuthFailures;
    state.consecutiveMalformed = snapshot.consecutiveMalformed;
    // R50: restore the graded per-role evidence (window pruning applies at first use) and
    // rebuild dedup keys so replayed observations cannot re-count after a restart.
    for (const sample of snapshot.roleEvidence ?? []) {
      const at = Date.parse(sample.at);
      if (!Number.isFinite(at)) continue;
      state.roleEvidence.push({ ...sample, at });
      if (sample.correlationId) {
        state.roleEvidenceKeys.add(`${sample.correlationId}|${sample.role}|${sample.outcome}|${sample.failureClass ?? "-"}`);
      }
    }
    state.lastObservedAt = snapshot.lastObservedAt ? Date.parse(snapshot.lastObservedAt) : state.lastObservedAt;
    state.lastSuccessAt = snapshot.lastSuccessAt ? Date.parse(snapshot.lastSuccessAt) : state.lastSuccessAt;
    state.lastProbeAt = snapshot.lastProbeAt ? Date.parse(snapshot.lastProbeAt) : state.lastProbeAt;
    state.quota = { ...snapshot.quota };
    state.governor = snapshot.governor ? { ...snapshot.governor } : undefined;
  }
}

export function createEightBitRouteHealthAuthority(policy?: Partial<RouteHealthPolicy>, now?: () => number): EightBitRouteHealthAuthority {
  return new EightBitRouteHealthAuthority({ ...DEFAULT_ROUTE_HEALTH_POLICY, ...policy }, now);
}

// --- Helpers for producers ---------------------------------------------------------------------------

/** Build a `rate_limit_headers` observation from raw quota headers (x-ratelimit-*, retry-after). */
export function rateLimitObservationFromHeaders(input: {
  providerId: string;
  modelId: string;
  status: number;
  headers: ReadonlyArray<readonly [string, string]>;
  observedAt: number;
  source?: ObservationSource;
}): Extract<NormalizedObservation, { kind: "rate_limit_headers" }> | undefined {
  const map = new Map(input.headers.map(([k, v]) => [k.toLowerCase(), v]));
  const num = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = map.get(key);
      if (value === undefined) continue;
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  };
  const resetIso = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = map.get(key);
      if (value === undefined) continue;
      const trimmed = value.trim();
      // Groq style durations: "2m59.56s", "7.66s", "600ms"; epoch seconds/ms; ISO.
      const duration = trimmed.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/);
      if (duration && trimmed.length > 0 && /[hms]$/.test(trimmed)) {
        const ms = (Number(duration[1] ?? 0) * 3_600 + Number(duration[2] ?? 0) * 60 + Number(duration[3] ?? 0)) * 1000 + Number(duration[4] ?? 0);
        return new Date(input.observedAt + ms).toISOString();
      }
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) {
        if (numeric > 1e12) return new Date(numeric).toISOString();
        if (numeric > 1e9) return new Date(numeric * 1000).toISOString();
        return new Date(input.observedAt + numeric * 1000).toISOString();
      }
      const parsed = Date.parse(trimmed);
      if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    }
    return undefined;
  };
  // Mistral's per-minute windows use -req-minute / -tokens-minute suffixes (measured live
  // 2026-09-24); Groq/OpenRouter/Cerebras use the standard names. Both shapes are the same
  // evidence class: the provider's own declared window.
  const requestsLimit = num("x-ratelimit-limit-requests", "ratelimit-limit", "x-rate-limit-limit", "x-ratelimit-limit-req-minute");
  const requestsRemaining = num("x-ratelimit-remaining-requests", "ratelimit-remaining", "x-rate-limit-remaining", "x-ratelimit-remaining-req-minute");
  const tokensLimit = num("x-ratelimit-limit-tokens", "x-ratelimit-limit-tokens-minute");
  const tokensRemaining = num("x-ratelimit-remaining-tokens", "x-ratelimit-remaining-tokens-minute");
  const retryAfterRaw = map.get("retry-after");
  let retryAfterMs: number | undefined;
  if (retryAfterRaw !== undefined) {
    const seconds = Number(retryAfterRaw);
    if (Number.isFinite(seconds)) retryAfterMs = Math.max(0, Math.round(seconds * 1000));
    else {
      const date = Date.parse(retryAfterRaw);
      if (Number.isFinite(date)) retryAfterMs = Math.max(0, date - input.observedAt);
    }
  }
  if (requestsLimit === undefined && requestsRemaining === undefined && tokensLimit === undefined && tokensRemaining === undefined && retryAfterMs === undefined && input.status !== 429) return undefined;
  return {
    kind: "rate_limit_headers",
    providerId: input.providerId,
    modelId: input.modelId,
    observedAt: new Date(input.observedAt).toISOString(),
    source: input.source ?? "runtime",
    requestsLimit,
    requestsRemaining,
    requestsResetAt: resetIso("x-ratelimit-reset-requests", "x-ratelimit-reset", "ratelimit-reset", "x-rate-limit-reset"),
    tokensLimit,
    tokensRemaining,
    tokensResetAt: resetIso("x-ratelimit-reset-tokens"),
    retryAfterMs,
    status: input.status,
  };
}

/** Product-facing wording (§52). Never exposes the raw internal state vocabulary to end users. */
export type UserFacingRouteStatus =
  | "Ready"
  | "Connected"
  | "Optional connection"
  | "Temporarily busy"
  | "Daily free capacity used"
  | "Connection expired"
  | "Needs authorization"
  | "Unavailable"
  | "Retired";

export function userFacingRouteStatus(state: RouteHealthCondition): UserFacingRouteStatus {
  switch (state) {
    case "HEALTHY":
    case "UNKNOWN":
    case "DEGRADED":
    case "TOOL_UNRELIABLE":
    case "CAPABILITY_LIMITED":
      return "Ready";
    case "SATURATED":
    case "RATE_LIMITED":
    case "TEMPORARY_CAPACITY":
      return "Temporarily busy";
    case "DAILY_QUOTA_EXHAUSTED":
      return "Daily free capacity used";
    case "AUTH_REQUIRED":
      return "Connection expired";
    case "USER_CONNECTION_REQUIRED":
      return "Optional connection";
    case "BILLING_VERIFICATION_REQUIRED":
      return "Needs authorization";
    case "MODEL_RETIRED":
      return "Retired";
    case "ACCESS_RESTRICTED":
    case "QUARANTINED":
      return "Unavailable";
  }
}

/** Compact routing explanation (§53) — one line, no internal scoring. */
export function routingExplanation(input: { providerLabel: string; supplyLabel: "free capacity" | "your connected account" | "your entitlement" | "your API key"; state: RouteHealthCondition; queued?: boolean }): string {
  if (input.queued) return `Free route temporarily busy — queued`;
  const status = userFacingRouteStatus(input.state);
  if (status === "Temporarily busy") return `${input.providerLabel} is temporarily busy — trying another free route`;
  if (status === "Daily free capacity used") return `${input.providerLabel} daily free capacity used — switching routes`;
  return `Using ${input.providerLabel} ${input.supplyLabel}`;
}
