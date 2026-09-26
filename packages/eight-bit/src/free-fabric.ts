import {
  CapacityReservationLedger,
  DEFAULT_FREE_CAPACITY_POLICY,
  type CapacityRoute,
  type FreeCapacityPolicy,
  type ProviderCapacityPool,
  type RouteDataContext,
  type SupplyClass,
} from "@codeforge/forge-zero";
import {
  buildRouteLedger,
  forgeAutoSupplyPlan,
  FORGEAUTO_DOMAIN_ORDER,
  type QuotaOwnerKind,
  type RouteLedgerEntry,
} from "./route-ledger.js";
import type { EightBitRouteHealthAuthority, RouteHealthCondition } from "./route-health-authority.js";
import type { EightBitRole } from "./types.js";

/**
 * R24 Mission B — the Free Fabric. One composition over the pieces that already exist:
 *
 *   route ledger (policy + ownership facts)  →  per-user supply plan (domain order,
 *   cross-user isolation)  →  temporal health authority (Mission A)  →  reservation
 *   ledger (fair admission, first-run reserve, per-user concurrency caps)
 *
 * The fabric decides whether a request may spend free capacity NOW and on which route, and
 * returns a structured explanation — never a bare model name and never a paid suggestion.
 * It is a router, not a scheduler: durable queueing stays with the hosted admission
 * authority; fair in-process admission stays with CapacityReservationLedger (§27).
 */

/** A per-user route projection (Ollama / Copilot fleets). It must only ever return routes
 * that belong to the queried user — ownership is additionally enforced by identity match. */
export interface UserRouteSource {
  routesForUser(userId: string): readonly CapacityRoute[];
  poolsForUser(userId: string): readonly ProviderCapacityPool[];
}

export interface FabricRequest {
  /** Admission idempotency identity — a turnId / runId / queue id. A repeated decide() with
   * the same id replaces its own reservation instead of double-spending quota. */
  requestId: string;
  userId: string;
  /** Capacity identities this user owns (one per connected account, e.g. the Copilot and
   * Ollama pool identities). Without a match a PER_USER_POOL route is never a candidate. */
  userIdentities?: readonly string[];
  /** Role contract the work needs, in the routes' own role vocabulary (ModelRole). */
  role: string;
  /** The work's role in the health authority's vocabulary when the caller knows it. The
   *  fabric boundary sees product roles (SUBAGENT covers explorer and tool-agent work);
   *  without this hint, role-scoped health evidence tagged with the real role is invisible
   *  to the request that produced it. */
  healthRole?: EightBitRole;
  /** Prefer a different physical quota pool from the implementation route for review.
   *  The same pool remains eligible only after independent routes fail admission. */
  preferIndependentFromPoolId?: string;
  taskKind?: string;
  /** Capacity this request intends to reserve. Defaults: 1 request, modest token budget. */
  demand?: {
    requests?: number;
    inputTokens?: number;
    outputTokens?: number;
    /**
     * R34 Mission E: caller-measured serialized-request estimate (system + messages +
     * tool schemas, e.g. `estimatePromptOnlyTokens`). When set, the fabric scales it by each
     * candidate provider's learned tokenizer ratio instead of holding a flat worst-case
     * ceiling — a small real turn can then admit an 8k TPM pool it could never reach under
     * a fixed 16k demand, while a genuinely large turn still fails closed against it.
     */
    estimatedPromptTokens?: number;
    credits?: number;
    providerUnits?: number;
  };
  isNewUser?: boolean;
  /** Lease the reservation holds for; the caller releases on completion (or it expires). */
  leaseMs?: number;
  dataContext?: RouteDataContext;
}

export type FabricCandidateStatus =
  | "SELECTED"
  /** Eligible and ranked, but a better route admitted first. Its health/quota facts still show. */
  | "STANDBY"
  | "CAPACITY_DENIED"
  | "HEALTH_EXCLUDED"
  | "POLICY_EXCLUDED"
  | "ROLE_INELIGIBLE"
  | "NOT_USER_OWNED"
  | "RESERVATION_DENIED";

export interface FabricCandidateReport {
  routeId: string;
  providerId: string;
  modelId: string;
  canonicalModelId: string;
  supplyClass: SupplyClass;
  quotaOwner: QuotaOwnerKind;
  quotaOwnerIdentity?: string;
  status: FabricCandidateStatus;
  reasonCodes: string[];
  healthState?: RouteHealthCondition;
  scoreAdjustment?: number;
  /** R37 Mission AH: negative when the route was demoted to preserve oversized capacity. */
  rightFitPenalty?: number;
}

export type FabricOutcome =
  /** A route is selected and (when a reservation ledger is attached) reserved. */
  | "ADMITTED"
  /** Eligible routes exist but every one is capacity-blocked right now — wait for reset,
   *  never fall back to a paid route. */
  | "QUEUED_FOR_CAPACITY"
  /** No route in this user's fabric can serve the request (policy/role/ownership). */
  | "DENIED_NO_SUPPLY";

export interface FabricRouteDecision {
  outcome: FabricOutcome;
  requestId: string;
  userId: string;
  role: string;
  generatedAt: string;
  selected?: {
    routeId: string;
    providerId: string;
    modelId: string;
    canonicalModelId: string;
    supplyClass: SupplyClass;
    quotaOwner: QuotaOwnerKind;
    capacityPoolId: string;
    reservationId?: string;
  };
  explanation: {
    /** One sentence a human can read in a log — never credential material. */
    summary: string;
    reasonCodes: string[];
    domainOrder: readonly QuotaOwnerKind[];
    isolationViolations: readonly string[];
    candidates: FabricCandidateReport[];
  };
  /** Earliest provider-stated reset when the decision is QUEUED_FOR_CAPACITY. */
  nextAvailableAt?: string;
  /** Actionable, zero-cost suggestions (e.g. connect an account) — never "pay for it". */
  suggestions: string[];
}

export interface FreeFabricOptions {
  /** Live projection of managed/shared supply (CodeForge-managed + sponsored). */
  managedRoutes: () => readonly CapacityRoute[];
  managedPools?: () => readonly ProviderCapacityPool[];
  /** Per-user supply projections, each already scoped to the queried user. */
  userSources?: readonly UserRouteSource[];
  /** Mission A temporal health — ranking/exclusion input only, never eligibility. */
  health?: EightBitRouteHealthAuthority;
  /** Fair admission. When attached, its route table is refreshed on every decide(). */
  reservations?: CapacityReservationLedger;
  policy?: FreeCapacityPolicy;
  dataContext?: RouteDataContext;
  /** Map the request role into the health authority's role vocabulary. Default: identity. */
  healthRoleFor?: (role: string) => EightBitRole;
  /** Health penalty at/below which a route is demoted behind the next supply domain
   *  (a saturated shared route yields to the user's own healthy supply). */
  domainDemotionScore?: number;
  /**
   * R34 Mission E: learned per-provider tokenizer ratio (provider-reported prompt tokens /
   * serialized estimate). The fabric calls it per candidate so a dense tokenizer (e.g. a
   * Qwen-family model at ~1.8×) reserves more than a sparse one for the same request. Return
   * undefined when unlearned — the conservative unlearned floor applies.
   */
  tokenizerRatioFor?: (providerId: string, modelId: string) => number | undefined;
  now?: () => number;
}

const DEFAULT_LEASE_MS = 10 * 60_000;
const DEFAULT_DOMAIN_DEMOTION_SCORE = -50;

/** Ratio floor for a provider whose tokenizer is unmeasured: above the ~1.0 sparse tokenizers
 *  observed on agent traffic, short of the ~1.8 measured on a dense one — the first real
 *  response teaches the governor the truth and the next decision uses it. */
const UNLEARNED_TOKENIZER_RATIO = 1.5;
/** The serialized estimate is chars/4; a learned ratio below 1 would mean the provider
 *  tokenizes sparser than that heuristic — accepted only as measured evidence, never below. */
const MIN_TOKENIZER_RATIO = 1;
/** Sanity ceiling: a corrupted EMA must never inflate demand into permanent self-denial. */
const MAX_TOKENIZER_RATIO = 3;
/** Margin over the ratio-scaled estimate (the same floor the pacing governor applies). */
const TOKENIZER_RESERVE_MARGIN = 1.15;

/** Product/agent role names → the health authority's role vocabulary. Unmapped roles assess
 *  role-agnostically (undefined), which is the correct conservative default. */
const FABRIC_HEALTH_ROLE: Readonly<Record<string, EightBitRole>> = {
  CODER: "CODER", PRIMARY_CODING_AGENT: "CODER", coder: "CODER",
  REASONER: "REASONER",
  PLANNER: "PLANNER", planner: "PLANNER",
  REVIEWER: "REVIEWER", reviewer: "REVIEWER", VERIFIER_ASSIST: "REVIEWER",
  FAST_WORKER: "FAST_WORKER", FAST_REASONER: "FAST_WORKER",
  LONG_CONTEXT: "LONG_CONTEXT",
  VISION: "VISION",
  TOOL_AGENT: "TOOL_AGENT", SUBAGENT: "TOOL_AGENT", SEARCH_ASSIST: "TOOL_AGENT",
  EXPLORER: "EXPLORER", explorer: "EXPLORER",
  ANALYST: "ANALYST", SUMMARIZER: "ANALYST",
};

function supplyLabel(owner: QuotaOwnerKind): string {
  switch (owner) {
    case "USER_ENTITLEMENT": return "your connected account";
    case "SPONSORED": return "sponsored free capacity";
    case "OWNER_DEV": return "owner development supply";
    default: return "shared managed free capacity";
  }
}

export class FreeFabric {
  private readonly opts: Required<Pick<FreeFabricOptions, "policy" | "domainDemotionScore">> & FreeFabricOptions;

  constructor(options: FreeFabricOptions) {
    this.opts = { policy: DEFAULT_FREE_CAPACITY_POLICY, domainDemotionScore: DEFAULT_DOMAIN_DEMOTION_SCORE, ...options };
  }

  /** Fairness/admission view for hosts (queue depth, per-user holds, pool contention). */
  reservationSnapshot() {
    return this.opts.reservations?.snapshot();
  }

  /** Release a reservation early (turn finished before its lease). Idempotent. */
  release(reservationId: string): boolean {
    return this.opts.reservations?.release(reservationId) ?? false;
  }

  decide(request: FabricRequest): FabricRouteDecision {
    const now = this.opts.now?.() ?? Date.now();
    const generatedAt = new Date(now).toISOString();
    const managedRoutes = this.opts.managedRoutes();
    const userRoutes = (this.opts.userSources ?? []).flatMap((s) => s.routesForUser(request.userId));
    const pools = [...(this.opts.managedPools?.() ?? []), ...(this.opts.userSources ?? []).flatMap((s) => s.poolsForUser(request.userId))];
    const routes = [...managedRoutes, ...userRoutes];
    const dataContext = request.dataContext ?? this.opts.dataContext;

    // The reservation ledger sees exactly the route set this decision sees — its fairness
    // accounting can never be computed over a stale fleet.
    this.opts.reservations?.updateRoutes(routes, pools);

    const ledger = buildRouteLedger({ routes, pools, policy: this.opts.policy, dataContext, now });
    const owned = new Set(request.userIdentities ?? []);
    const plan = forgeAutoSupplyPlan(ledger.entries, request.role, [...owned]);
    const planned = new Map(plan.routes.map((e) => [e.routeId, e]));

    const reports = new Map<string, FabricCandidateReport>();
    for (const entry of ledger.entries) {
      if (planned.has(entry.routeId)) continue;
      reports.set(entry.routeId, this.explainExcluded(entry, request.role, owned));
    }

    const demand = {
      requests: Math.max(1, request.demand?.requests ?? 1),
      inputTokens: Math.max(0, request.demand?.inputTokens ?? 4_000),
      outputTokens: Math.max(0, request.demand?.outputTokens ?? 1_000),
      credits: request.demand?.credits,
      providerUnits: request.demand?.providerUnits,
    };
    // R34 Mission E: when the caller measured the actual serialized request, reserve that
    // size per candidate scaled by the provider's learned tokenizer ratio — the same request
    // honestly costs a dense tokenizer more than a sparse one. Without a measurement the
    // caller-supplied (or default) flat demand applies to every candidate as before.
    const measuredPromptTokens = request.demand?.estimatedPromptTokens;
    const inputDemandFor = (entry: RouteLedgerEntry): number => {
      if (measuredPromptTokens === undefined) return demand.inputTokens;
      const ratio = Math.min(
        MAX_TOKENIZER_RATIO,
        Math.max(MIN_TOKENIZER_RATIO,
          this.opts.tokenizerRatioFor?.(entry.providerId, entry.modelId) ?? UNLEARNED_TOKENIZER_RATIO),
      );
      return Math.ceil(measuredPromptTokens * ratio * TOKENIZER_RESERVE_MARGIN);
    };
    /**
     * R37 Mission AH — capacity preservation. A request that fits comfortably should not burn
     * a scarce large-context route when a sufficient smaller one exists in the same supply
     * domain. The penalty is deliberately bounded (≤12): it right-sizes near-ties, it never
     * overrides a domain boundary or a real capability gap, and it is advisory — it cannot
     * make an ineligible route eligible or deny admission outright.
     */
    const rightFitPenalty = (entry: RouteLedgerEntry): number => {
      if (entry.contextWindow === undefined) return 0;
      const need = inputDemandFor(entry) + demand.outputTokens;
      const oversize = entry.contextWindow / Math.max(1, need);
      if (oversize <= 4) return 0;
      return -Math.min(12, Math.round(Math.log2(oversize)));
    };

    // Mission A health: hard exclusions remove candidates; strong penalties demote a route
    // behind the next supply domain (saturated shared supply yields to a healthy user pool).
    const healthRole = request.healthRole ?? this.opts.healthRoleFor?.(request.role) ?? FABRIC_HEALTH_ROLE[request.role];
    const ranked: Array<{ entry: RouteLedgerEntry; healthState?: RouteHealthCondition; scoreAdjustment: number; fitPenalty: number; effectiveScore: number; domainRank: number }> = [];
    for (const entry of plan.routes) {
      const assess = this.opts.health?.assess(entry.providerId, entry.modelId, { role: healthRole });
      const adjustment = assess?.scoreAdjustment ?? 0;
      if (assess?.hardExclude) {
        reports.set(entry.routeId, {
          routeId: entry.routeId, providerId: entry.providerId, modelId: entry.modelId,
          canonicalModelId: entry.canonicalModelId, supplyClass: entry.supplyClass,
          quotaOwner: entry.quotaOwner, quotaOwnerIdentity: entry.quotaOwnerIdentity,
          status: "HEALTH_EXCLUDED", reasonCodes: ["HEALTH_HARD_EXCLUDED", ...assess.reasonCodes],
          healthState: assess.state, scoreAdjustment: adjustment,
        });
        continue;
      }
      // A deeply unhealthy route is demoted behind every undemoted supply domain — a saturated
      // shared route yields to the user's own healthy pool, not just to sponsored supply.
      const domainRank = FORGEAUTO_DOMAIN_ORDER.indexOf(entry.quotaOwner)
        + (adjustment <= this.opts.domainDemotionScore ? FORGEAUTO_DOMAIN_ORDER.length : 0);
      const fit = rightFitPenalty(entry);
      ranked.push({ entry, healthState: assess?.state, scoreAdjustment: adjustment, fitPenalty: fit, effectiveScore: entry.qualityScore + adjustment + fit, domainRank });
    }
    ranked.sort((a, b) => {
      const priorPool = request.preferIndependentFromPoolId;
      const independenceOrder = priorPool === undefined ? 0
        : Number(a.entry.capacityPoolId === priorPool) - Number(b.entry.capacityPoolId === priorPool);
      return independenceOrder || a.domainRank - b.domainRank
        || b.effectiveScore - a.effectiveScore || a.entry.routeId.localeCompare(b.entry.routeId);
    });

    let selected: FabricRouteDecision["selected"];
    let queued: { nextAvailableAt?: string; reasonCodes: string[] } | undefined;
    let concurrencyLimited = false;

    for (const candidate of ranked) {
      const { entry } = candidate;
      if (!this.opts.reservations) {
        // No fair-admission ledger: the fabric still orders and reports, but cannot hold
        // capacity — single-caller hosts use this shape.
        selected = {
          routeId: entry.routeId, providerId: entry.providerId, modelId: entry.modelId,
          canonicalModelId: entry.canonicalModelId, supplyClass: entry.supplyClass,
          quotaOwner: entry.quotaOwner, capacityPoolId: entry.capacityPoolId,
        };
        reports.set(entry.routeId, this.reportFor(entry, "SELECTED", ["AUTHORIZED", "ROLE_QUALIFIED", "HEALTH_ACCEPTED", ...this.independenceReason(request, entry)], candidate.healthState, candidate.scoreAdjustment, candidate.fitPenalty));
        break;
      }
      const decision = this.opts.reservations.reserve({
        reservationId: request.requestId,
        userId: request.userId,
        routeIds: [entry.routeId],
        role: request.role,
        taskKind: request.taskKind ?? "task",
        requests: demand.requests,
        inputTokens: inputDemandFor(entry),
        outputTokens: demand.outputTokens,
        credits: demand.credits,
        providerUnits: demand.providerUnits,
        // For the user's own pool the route's identity IS the request's right to it —
        // the candidate only reached this point because ownership was already verified.
        // Shared routes carry no owner identity and none is stamped onto the reservation.
        capacityIdentity: entry.quotaOwnerIdentity,
        // The reservation re-checks route eligibility — it must judge under the same data
        // class the plan admitted this request under.
        dataContext,
        isNewUser: request.isNewUser ?? false,
        priority: request.isNewUser ? "first_run" : "normal",
        createdAt: generatedAt,
        leaseUntil: new Date(now + (request.leaseMs ?? DEFAULT_LEASE_MS)).toISOString(),
      });
      if (decision.admitted) {
        selected = {
          routeId: entry.routeId, providerId: entry.providerId, modelId: entry.modelId,
          canonicalModelId: entry.canonicalModelId, supplyClass: entry.supplyClass,
          quotaOwner: entry.quotaOwner, capacityPoolId: entry.capacityPoolId,
          reservationId: decision.reservationId,
        };
        reports.set(entry.routeId, this.reportFor(entry, "SELECTED", ["AUTHORIZED", "ROLE_QUALIFIED", "QUOTA_RESERVED", decision.reason, ...this.independenceReason(request, entry)], candidate.healthState, candidate.scoreAdjustment, candidate.fitPenalty));
        break;
      }
      reports.set(entry.routeId, this.reportFor(entry, decision.reason === "CAPACITY_EXHAUSTED" || decision.reason === "FIRST_RUN_RESERVE_PROTECTED" ? "CAPACITY_DENIED" : "RESERVATION_DENIED", [decision.reason, ...(candidate.fitPenalty < 0 ? ["RIGHT_SIZE_PRESERVED"] : [])], candidate.healthState, candidate.scoreAdjustment, candidate.fitPenalty));
      if (decision.reason === "USER_CONCURRENCY_LIMIT") {
        concurrencyLimited = true;
        queued = { reasonCodes: ["USER_CONCURRENCY_LIMIT"], nextAvailableAt: decision.nextAvailableAt };
        break;
      }
      queued = {
        reasonCodes: [...new Set([...(queued?.reasonCodes ?? []), decision.reason])],
        nextAvailableAt: [queued?.nextAvailableAt, decision.nextAvailableAt].filter((v): v is string => v !== undefined).sort()[0],
      };
    }

    // Ranked candidates the admission loop never reached still get a row — an explanation
    // that silently drops a demoted route hides the very failover evidence it exists to show.
    for (const candidate of ranked) {
      if (reports.has(candidate.entry.routeId)) continue;
      const demoted = candidate.scoreAdjustment <= this.opts.domainDemotionScore;
      reports.set(candidate.entry.routeId, this.reportFor(
        candidate.entry,
        "STANDBY",
        demoted
          ? ["HEALTH_DEMOTED", "RANKED_BEHIND_SELECTED", ...(candidate.fitPenalty < 0 ? ["RIGHT_SIZE_PRESERVED"] : [])]
          : ["RANKED_BEHIND_SELECTED", ...(candidate.fitPenalty < 0 ? ["RIGHT_SIZE_PRESERVED"] : [])],
        candidate.healthState,
        candidate.scoreAdjustment,
        candidate.fitPenalty,
      ));
    }

    const healthBlockedOnly = !selected && ranked.length === 0
      && [...reports.values()].some((r) => r.status === "HEALTH_EXCLUDED");

    const outcome: FabricOutcome = selected
      ? "ADMITTED"
      : plan.hasSupply || queued !== undefined || concurrencyLimited || healthBlockedOnly
        ? "QUEUED_FOR_CAPACITY"
        : "DENIED_NO_SUPPLY";

    const suggestions = this.suggestionsFor(outcome, userRoutes, ranked.length);
    const summary = selected
      ? `Selected ${supplyLabel(selected.quotaOwner)} route ${selected.providerId}/${selected.modelId}: ` +
        `role-qualified${candidateHealthSuffix(ranked, selected.routeId)}; quota reserved; ` +
        (selected.quotaOwner === "USER_ENTITLEMENT" ? "shared managed pool could not serve — using your own quota" : "your personal entitlement is preserved")
      : outcome === "QUEUED_FOR_CAPACITY"
        ? concurrencyLimited
          ? "You already hold the maximum concurrent free reservations — queued, not sent to a paid route."
          : healthBlockedOnly && queued === undefined
            ? "Every eligible free route is temporarily unhealthy — queued until a route recovers, never a paid route."
            : "All eligible free capacity is currently reserved — queued for the next window, never a paid fallback."
        : "No free supply can serve this request — nothing eligible, nothing paid substituted.";

    return {
      outcome,
      requestId: request.requestId,
      userId: request.userId,
      role: request.role,
      generatedAt,
      ...(selected ? { selected } : {}),
      explanation: {
        summary,
        reasonCodes: selected
          ? (reports.get(selected.routeId)?.reasonCodes ?? [])
          : queued?.reasonCodes ?? (healthBlockedOnly ? ["ALL_ELIGIBLE_ROUTES_UNHEALTHY"] : ["NO_ELIGIBLE_ROUTE"]),
        domainOrder: FORGEAUTO_DOMAIN_ORDER,
        isolationViolations: ledger.summary.isolationViolations,
        candidates: [...reports.values()],
      },
      ...(queued?.nextAvailableAt ? { nextAvailableAt: queued.nextAvailableAt } : {}),
      suggestions,
    };
  }

  private reportFor(entry: RouteLedgerEntry, status: FabricCandidateStatus, reasonCodes: string[], healthState?: RouteHealthCondition, scoreAdjustment?: number, rightFitPenalty?: number): FabricCandidateReport {
    return {
      routeId: entry.routeId, providerId: entry.providerId, modelId: entry.modelId,
      canonicalModelId: entry.canonicalModelId, supplyClass: entry.supplyClass,
      quotaOwner: entry.quotaOwner, quotaOwnerIdentity: entry.quotaOwnerIdentity,
      status, reasonCodes, healthState, scoreAdjustment,
      ...(rightFitPenalty !== undefined && rightFitPenalty !== 0 ? { rightFitPenalty } : {}),
    };
  }

  private independenceReason(request: FabricRequest, entry: RouteLedgerEntry): string[] {
    if (request.preferIndependentFromPoolId === undefined) return [];
    return [entry.capacityPoolId === request.preferIndependentFromPoolId
      ? "SAME_POOL_FALLBACK" : "INDEPENDENT_POOL_PREFERRED"];
  }

  private explainExcluded(entry: RouteLedgerEntry, role: string, owned: ReadonlySet<string>): FabricCandidateReport {
    if (!entry.freeEligible) {
      return this.reportFor(entry, "POLICY_EXCLUDED", [entry.exclusionReason ?? "NOT_FREE_ELIGIBLE"]);
    }
    if (!entry.roleSuitability.includes(role)) {
      return this.reportFor(entry, "ROLE_INELIGIBLE", ["ROLE_NOT_QUALIFIED"]);
    }
    if (entry.quotaOwner === "USER_ENTITLEMENT" && !(entry.quotaOwnerIdentity !== undefined && owned.has(entry.quotaOwnerIdentity))) {
      return this.reportFor(entry, "NOT_USER_OWNED", ["SOMEONE_ELSES_ENTITLEMENT"]);
    }
    return this.reportFor(entry, "POLICY_EXCLUDED", ["NOT_IN_SUPPLY_PLAN"]);
  }

  private suggestionsFor(outcome: FabricOutcome, userRoutes: readonly CapacityRoute[], eligibleCount: number): string[] {
    const suggestions: string[] = [];
    if (outcome === "ADMITTED") return suggestions;
    if (userRoutes.length === 0) {
      suggestions.push("Connect a user-owned free account (Ollama Cloud, GitHub Copilot) to add capacity that is yours alone.");
    }
    if (outcome === "QUEUED_FOR_CAPACITY") {
      suggestions.push("Wait for the provider window reset — the request stays free; CodeForge never falls back to paid inference.");
      if (eligibleCount > 0) suggestions.push("Other work in this session already holds reservations; finishing or cancelling it frees capacity.");
    } else {
      suggestions.push("No eligible free route exists for this role — check provider connections and qualification state.");
    }
    return suggestions;
  }
}

function candidateHealthSuffix(ranked: readonly { entry: RouteLedgerEntry; healthState?: RouteHealthCondition }[], routeId: string): string {
  const state = ranked.find((r) => r.entry.routeId === routeId)?.healthState;
  return state === undefined ? "" : `; health ${state.toLowerCase()}`;
}

export function createFreeFabric(options: FreeFabricOptions): FreeFabric {
  return new FreeFabric(options);
}
