import type { ForgeZero, FreeModelRecord } from "@codeforge/forge-zero";
import { ForgeRouter, type RoutingRequest } from "@codeforge/router";
import { EightBitEligibilityPolicy, type EligibilityContext, type EightBitPolicyMode } from "./eligibility.js";
import type { EightBitHealthTracker } from "./health.js";
import type { EightBitReliabilityTracker } from "./reliability.js";
import { routeKeyOf, type EightBitRole, type RouteKey } from "./types.js";
import type { EightBitShadowObserver } from "./shadow.js";

/** Sticky binding scope: a session may bind different routes per role/workstream. */
export interface BindingScope {
  sessionId: string;
  role: EightBitRole;
  workstreamId?: string;
}

function scopeKey(scope: BindingScope): string {
  return `${scope.sessionId}::${scope.role}::${scope.workstreamId ?? "-"}`;
}

/** A newly-ranked alternative must beat the sticky incumbent by this many ForgeRouter score
 * points before 8-Bit switches away from it. Prevents flapping on noise-level score deltas
 * (e.g. a 0.001 difference) while still allowing a clearly-better route to win. */
const PROMOTION_MARGIN = 10;

export interface SelectRouteOptions {
  scope: BindingScope;
  policyMode: EightBitPolicyMode;
  estimatedContextTokens?: number;
  requiredCapabilities?: string[];
  taskType?: string;
  /** FG-4 advisory capability requirement. Hard eligibility remains owned by 8-Bit. */
  capabilityGuidance?: { minimumRole: EightBitRole; reasonCodes?: string[] };
  /** Providers with a registered adapter — an eligible model with no backend cannot execute. */
  hasAdapter: (providerId: string) => boolean;
  /**
   * R1: extra per-route admission filter supplied by the 8-Bit Free Cloud Registry (qualification,
   * shared cross-session health, plan attestation). Absent = ForgeZero eligibility alone.
   */
  routeFilter?: (providerId: string, modelId: string) => boolean;
  /**
   * Deterministic capacity input from 8-Bit. It can only rank among routes that have already
   * passed ForgeZero and all admission filters; it never creates eligibility or crosses policy.
   */
  capacityScoreAdjustment?: (providerId: string, modelId: string) => { scoreAdjustment: number; reasonCodes: string[] };
}

export type SelectRouteResult =
  | { outcome: "selected"; model: FreeModelRecord; sticky: boolean; score: number; reasons: string[] }
  | { outcome: "no_eligible_route"; reasonCodes: string[] };

/**
 * Role-aware adaptive router. Layers on top of the certified `ForgeRouter` (still the ranking
 * authority for score) with: (1) a hard role/policy eligibility gate evaluated first, (2)
 * live health/reliability filtering, (3) session/workstream-scoped stickiness with a
 * promotion margin so a marginally-higher score does not cause route flapping.
 */
export class EightBitRouter {
  private readonly bindings = new Map<string, RouteKey>();
  private readonly eligibility = new EightBitEligibilityPolicy();

  constructor(
    private readonly firewall: ForgeZero,
    private readonly health: EightBitHealthTracker,
    private readonly reliability: EightBitReliabilityTracker,
    private readonly shadowObserver?: EightBitShadowObserver,
  ) {}

  /** Restore a persisted sticky binding (e.g. after restart) without re-ranking. Caller is
   * responsible for verifying it is still eligible before relying on it for a new turn. */
  hydrateBinding(scope: BindingScope, route: RouteKey): void {
    this.bindings.set(scopeKey(scope), route);
  }

  currentBinding(scope: BindingScope): RouteKey | undefined {
    return this.bindings.get(scopeKey(scope));
  }

  clearBinding(scope: BindingScope): void {
    this.bindings.delete(scopeKey(scope));
  }

  /** Rank an already-admitted set. Capacity advice is deliberately applied here, after every
   * ForgeZero, health, adapter, and route-admission check. It can demote a scarce route but can
   * never make an ineligible route executable. */
  private rankEligible(scope: BindingScope, options: SelectRouteOptions, eligible: readonly FreeModelRecord[]): Array<{
    model: FreeModelRecord;
    score: number;
    effectiveScore: number;
    reasons: string[];
    capacityReasons: string[];
  }> {
    const req: RoutingRequest = {
      taskType: options.taskType ?? (options.capabilityGuidance?.minimumRole ?? scope.role).toLowerCase(),
      estimatedContextTokens: options.estimatedContextTokens ?? 8_000,
      requiredCapabilities: options.requiredCapabilities ?? [],
    };
    const router = new ForgeRouter({ firewall: this.firewall });
    return router
      .rank(req)
      .filter((ranked) => eligible.some((model) => model.providerId === ranked.model.providerId && model.modelId === ranked.model.modelId))
      .map((ranked) => {
        const capacity = options.capacityScoreAdjustment?.(ranked.model.providerId, ranked.model.modelId) ?? { scoreAdjustment: 0, reasonCodes: [] };
        return { ...ranked, effectiveScore: ranked.score + capacity.scoreAdjustment, capacityReasons: capacity.reasonCodes };
      })
      // Match ForgeRouter.rank()'s documented tiebreak contract (score desc, then modelId asc)
      // so capacity advice can only reorder distinct scores, never relitigate an existing tie;
      // providerId is a last-resort disambiguator for the same modelId served by two providers.
      .sort((left, right) => right.effectiveScore - left.effectiveScore || left.model.modelId.localeCompare(right.model.modelId) || left.model.providerId.localeCompare(right.model.providerId));
  }

  private eligibleForRole(scope: BindingScope, options: SelectRouteOptions): FreeModelRecord[] {
    const eligibilityRole = options.capabilityGuidance?.minimumRole ?? scope.role;
    return this.firewall.eligibleModels().filter((model) => {
      if (!options.hasAdapter(model.providerId)) return false;
      if (this.health.isInCooldown(model.providerId, model.modelId)) return false;
      if (options.routeFilter && !options.routeFilter(model.providerId, model.modelId)) return false;
      const ctx: EligibilityContext = {
        role: eligibilityRole,
        policyMode: options.policyMode,
        estimatedContextTokens: options.estimatedContextTokens,
        reliability: this.reliability.score(model.providerId, model.modelId),
      };
      return this.eligibility.evaluate(model, ctx).eligible;
    });
  }

  selectRoute(options: SelectRouteOptions): SelectRouteResult {
    const scope = options.scope;
    const eligible = this.eligibleForRole(scope, options);
    if (eligible.length === 0) {
      return { outcome: "no_eligible_route", reasonCodes: ["NO_ELIGIBLE_FREE_MODEL"] };
    }

    const ranked = this.rankEligible(scope, options, eligible);

    if (ranked.length === 0) {
      return { outcome: "no_eligible_route", reasonCodes: ["NO_ELIGIBLE_FREE_MODEL"] };
    }

    const best = ranked[0]!;
    const incumbentKey = this.bindings.get(scopeKey(scope));
    if (incumbentKey) {
      const incumbentRanked = ranked.find((r) => r.model.providerId === incumbentKey.providerId && r.model.modelId === incumbentKey.modelId);
      if (incumbentRanked && incumbentRanked.effectiveScore + PROMOTION_MARGIN >= best.effectiveScore) {
        const result = { outcome: "selected" as const, model: incumbentRanked.model, sticky: true, score: incumbentRanked.effectiveScore, reasons: this.guidanceReasons(options, [...incumbentRanked.reasons, ...incumbentRanked.capacityReasons]) };
        this.observeShadow(options, result.model.providerId, result.model.modelId, result.score);
        return result;
      }
      // Incumbent is gone from the eligible set (unhealthy/ineligible/cooled-down) or a
      // meaningfully better route exists — fall through to (re)binding the best candidate.
    }

    this.bindings.set(scopeKey(scope), { providerId: best.model.providerId, modelId: best.model.modelId });
    const result = { outcome: "selected" as const, model: best.model, sticky: false, score: best.effectiveScore, reasons: this.guidanceReasons(options, [...best.reasons, ...best.capacityReasons]) };
    this.observeShadow(options, result.model.providerId, result.model.modelId, result.score);
    return result;
  }

  private guidanceReasons(options: SelectRouteOptions, reasons: string[]): string[] {
    if (!options.capabilityGuidance) return reasons;
    return [...new Set([...reasons, `FG4_CAPABILITY:${options.capabilityGuidance.minimumRole}`, ...(options.capabilityGuidance.reasonCodes ?? [])])];
  }

  private observeShadow(options: SelectRouteOptions, providerId: string, modelId: string, deterministicScore: number): void {
    try {
      this.shadowObserver?.observe({
        sessionId: options.scope.sessionId,
        role: options.scope.role,
        ...(options.scope.workstreamId === undefined ? {} : { workstreamId: options.scope.workstreamId }),
        policyMode: options.policyMode,
        ...(options.taskType === undefined ? {} : { taskType: options.taskType }),
        ...(options.estimatedContextTokens === undefined ? {} : { estimatedContextTokens: options.estimatedContextTokens }),
        providerId,
        modelId,
        deterministicScore,
      });
    } catch {
      // The observer is non-authoritative and must be failure-isolated from routing.
    }
  }

  /** Used by failover: force-rebind away from a known-bad route to the next eligible one,
   * excluding the failed route even if it would otherwise still rank/pass health checks
   * (e.g. mid-turn, before the health tracker's cooldown state has propagated). */
  selectReplacement(options: SelectRouteOptions, exclude: RouteKey, prefer?: RouteKey[]): SelectRouteResult {
    const scope = options.scope;
    const eligible = this.eligibleForRole(scope, options).filter(
      (m) => !(m.providerId === exclude.providerId && m.modelId === exclude.modelId),
    );
    if (eligible.length === 0) {
      return { outcome: "no_eligible_route", reasonCodes: ["NO_ELIGIBLE_FREE_MODEL"] };
    }
    // R1 §76: same-canonical-model alternates first — a provider swap keeps model behaviour
    // stable mid-task, so an eligible preferred route wins over any cross-model candidate.
    if (prefer && prefer.length > 0) {
      for (const p of prefer) {
        const match = eligible.find((m) => m.providerId === p.providerId && m.modelId === p.modelId);
        if (match) {
          this.bindings.set(scopeKey(scope), { providerId: match.providerId, modelId: match.modelId });
          const result = { outcome: "selected" as const, model: match, sticky: false, score: 0, reasons: this.guidanceReasons(options, ["same_model_alternate_route"]) };
          this.observeShadow(options, result.model.providerId, result.model.modelId, result.score);
          return result;
        }
      }
    }
    const ranked = this.rankEligible(scope, options, eligible);
    const best = ranked[0];
    if (!best) return { outcome: "no_eligible_route", reasonCodes: ["NO_ELIGIBLE_FREE_MODEL"] };
    this.bindings.set(scopeKey(scope), { providerId: best.model.providerId, modelId: best.model.modelId });
    const result = { outcome: "selected" as const, model: best.model, sticky: false, score: best.effectiveScore, reasons: this.guidanceReasons(options, [...best.reasons, ...best.capacityReasons]) };
    this.observeShadow(options, result.model.providerId, result.model.modelId, result.score);
    return result;
  }
}

export function routeKeyEquals(a: RouteKey, b: RouteKey): boolean {
  return routeKeyOf(a.providerId, a.modelId) === routeKeyOf(b.providerId, b.modelId);
}

export function createEightBitRouter(
  firewall: ForgeZero,
  health: EightBitHealthTracker,
  reliability: EightBitReliabilityTracker,
  shadowObserver?: EightBitShadowObserver,
): EightBitRouter {
  return new EightBitRouter(firewall, health, reliability, shadowObserver);
}
