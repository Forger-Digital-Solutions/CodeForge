import type { ForgeZero, FreeModelRecord } from "@codeforge/forge-zero";
import { ForgeRouter, type RoutingRequest } from "@codeforge/router";
import { EightBitEligibilityPolicy, type EligibilityContext, type EightBitPolicyMode } from "./eligibility.js";
import type { EightBitHealthTracker } from "./health.js";
import type { EightBitReliabilityTracker } from "./reliability.js";
import { routeKeyOf, type EightBitRole, type RouteKey } from "./types.js";

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

  private eligibleForRole(scope: BindingScope, options: SelectRouteOptions): FreeModelRecord[] {
    const eligibilityRole = options.capabilityGuidance?.minimumRole ?? scope.role;
    return this.firewall.eligibleModels().filter((model) => {
      if (!options.hasAdapter(model.providerId)) return false;
      if (this.health.isInCooldown(model.providerId, model.modelId)) return false;
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

    const req: RoutingRequest = {
      taskType: options.taskType ?? (options.capabilityGuidance?.minimumRole ?? scope.role).toLowerCase(),
      estimatedContextTokens: options.estimatedContextTokens ?? 8_000,
      requiredCapabilities: options.requiredCapabilities ?? [],
    };
    const router = new ForgeRouter({ firewall: this.firewall });
    const ranked = router
      .rank(req)
      .filter((r) => eligible.some((m) => m.providerId === r.model.providerId && m.modelId === r.model.modelId));

    if (ranked.length === 0) {
      return { outcome: "no_eligible_route", reasonCodes: ["NO_ELIGIBLE_FREE_MODEL"] };
    }

    const best = ranked[0]!;
    const incumbentKey = this.bindings.get(scopeKey(scope));
    if (incumbentKey) {
      const incumbentRanked = ranked.find((r) => r.model.providerId === incumbentKey.providerId && r.model.modelId === incumbentKey.modelId);
      if (incumbentRanked && incumbentRanked.score + PROMOTION_MARGIN >= best.score) {
        return { outcome: "selected", model: incumbentRanked.model, sticky: true, score: incumbentRanked.score, reasons: this.guidanceReasons(options, incumbentRanked.reasons) };
      }
      // Incumbent is gone from the eligible set (unhealthy/ineligible/cooled-down) or a
      // meaningfully better route exists — fall through to (re)binding the best candidate.
    }

    this.bindings.set(scopeKey(scope), { providerId: best.model.providerId, modelId: best.model.modelId });
    return { outcome: "selected", model: best.model, sticky: false, score: best.score, reasons: this.guidanceReasons(options, best.reasons) };
  }

  private guidanceReasons(options: SelectRouteOptions, reasons: string[]): string[] {
    if (!options.capabilityGuidance) return reasons;
    return [...new Set([...reasons, `FG4_CAPABILITY:${options.capabilityGuidance.minimumRole}`, ...(options.capabilityGuidance.reasonCodes ?? [])])];
  }

  /** Used by failover: force-rebind away from a known-bad route to the next eligible one,
   * excluding the failed route even if it would otherwise still rank/pass health checks
   * (e.g. mid-turn, before the health tracker's cooldown state has propagated). */
  selectReplacement(options: SelectRouteOptions, exclude: RouteKey): SelectRouteResult {
    const scope = options.scope;
    const eligible = this.eligibleForRole(scope, options).filter(
      (m) => !(m.providerId === exclude.providerId && m.modelId === exclude.modelId),
    );
    if (eligible.length === 0) {
      return { outcome: "no_eligible_route", reasonCodes: ["NO_ELIGIBLE_FREE_MODEL"] };
    }
    const req: RoutingRequest = {
      taskType: options.taskType ?? (options.capabilityGuidance?.minimumRole ?? scope.role).toLowerCase(),
      estimatedContextTokens: options.estimatedContextTokens ?? 8_000,
      requiredCapabilities: options.requiredCapabilities ?? [],
    };
    const router = new ForgeRouter({ firewall: this.firewall });
    const ranked = router
      .rank(req)
      .filter((r) => eligible.some((m) => m.providerId === r.model.providerId && m.modelId === r.model.modelId));
    const best = ranked[0];
    if (!best) return { outcome: "no_eligible_route", reasonCodes: ["NO_ELIGIBLE_FREE_MODEL"] };
    this.bindings.set(scopeKey(scope), { providerId: best.model.providerId, modelId: best.model.modelId });
    return { outcome: "selected", model: best.model, sticky: false, score: best.score, reasons: this.guidanceReasons(options, best.reasons) };
  }
}

export function routeKeyEquals(a: RouteKey, b: RouteKey): boolean {
  return routeKeyOf(a.providerId, a.modelId) === routeKeyOf(b.providerId, b.modelId);
}

export function createEightBitRouter(
  firewall: ForgeZero,
  health: EightBitHealthTracker,
  reliability: EightBitReliabilityTracker,
): EightBitRouter {
  return new EightBitRouter(firewall, health, reliability);
}
