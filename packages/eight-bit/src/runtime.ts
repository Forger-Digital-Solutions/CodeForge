import type { ForgeZero, RouteDataContext } from "@codeforge/forge-zero";
import type { ISessionPersistence } from "@codeforge/sessions";
import { EightBitHealthTracker } from "./health.js";
import { EightBitReliabilityTracker, type ToolCallOutcome } from "./reliability.js";
import { EightBitRouter, type BindingScope, type SelectRouteOptions, type SelectRouteResult } from "./router.js";
import { EightBitDecisionStore, newReceiptId } from "./persistence.js";
import { EightBitFailoverCoordinator, type FailoverOutcome, type FailoverRequest } from "./failover.js";
import { EightBitHandoffBuilder } from "./handoff.js";
import type { DecisionReceipt, EightBitRole, RouteKey } from "./types.js";
import type { EightBitPolicyMode } from "./eligibility.js";
import { EightBitCapacityIntelligence } from "./capacity-intelligence.js";
import type { CapacityForecast, CapacityForecastInput, CapacityPreflight, CapacityPreflightInput } from "@codeforge/forge-zero";
import { EightBitRouteHealthAuthority, DEFAULT_ROUTE_HEALTH_POLICY, type NormalizedObservation, type RouteHealthPolicy } from "./route-health-authority.js";
import { EightBitRouteHealthLedger } from "./route-health-ledger.js";
import { classifyFailure } from "./health.js";
import type { FabricRequest, FabricRouteDecision, FreeFabric } from "./free-fabric.js";

/** R24: what a host knows about the requesting user for one fabric admission. Derived from
 * real provider-connection/account records by the host — never fabricated here. */
export interface FabricAdmissionContext {
  /** Fairness identity for this request (session user, hosted user, or "anonymous"). */
  userId: string;
  /** Non-secret capacity identities this user owns (one per connected account). */
  userIdentities?: readonly string[];
  isNewUser?: boolean;
  dataContext?: RouteDataContext;
  /** How long the reservation lease runs before expiry. */
  leaseMs?: number;
}

/** Maps an admission to the requesting user's fabric context. The host (server/desktop)
 * supplies it; absent, admissions fall back to the request's own userId with no owned
 * identities — per-user pools simply stay unreachable, never misattributed. */
export type FabricContextProvider = (req: {
  sessionId: string;
  role: EightBitRole;
  requestId: string;
  userId?: string;
}) => FabricAdmissionContext;

export interface EightBitRuntimeOptions {
  firewall: ForgeZero;
  persistence: ISessionPersistence;
  now?: () => number;
  /**
   * R24: a host-shared route-health authority. When several runtimes (sessions) run in one
   * process they should share ONE instance so a saturation seen by session A re-ranks routing
   * for session B immediately; absent, the runtime creates its own and hydrates it from the
   * durable ledger.
   */
  routeHealth?: EightBitRouteHealthAuthority;
  routeHealthPolicy?: Partial<RouteHealthPolicy>;
  /** Persist normalized observations (learning data) in addition to snapshots. Default true. */
  persistRouteObservations?: boolean;
  /**
   * R24 Mission C: the Free Fabric — admission authority for automatic free routing. When
   * attached, `selectInitialRoute` and auto-mode failover decide through `fabric.decide()`
   * instead of bare ranking: a decision holds a real reservation, refuses another user's
   * pool, and answers QUEUED_FOR_CAPACITY / DENIED_NO_SUPPLY instead of a paid suggestion.
   * Explicit model/route pins never consult it.
   */
  freeFabric?: FreeFabric;
  fabricContext?: FabricContextProvider;
}

/**
 * EightBitRole → the fabric's route-role vocabulary (the registry's ModelRole names, which
 * capacity routes carry in `roleSuitability`). Unmapped roles cannot exist — EightBitRole is
 * a closed enum, so every runtime role lands on a defined ModelRole.
 */
export const FABRIC_MODEL_ROLE: Readonly<Record<EightBitRole, string>> = {
  CODER: "PRIMARY_CODING_AGENT",
  REASONER: "FAST_REASONER",
  PLANNER: "PLANNER",
  REVIEWER: "REVIEWER",
  FAST_WORKER: "FAST_REASONER",
  LONG_CONTEXT: "PRIMARY_CODING_AGENT",
  VISION: "VISION",
  TOOL_AGENT: "SUBAGENT",
  ANALYST: "SEARCH_ASSIST",
  // Explorer agents execute as subagents over read/search tools — SUBAGENT is the product
  // role their capacity routes must declare.
  EXPLORER: "SUBAGENT",
};

/**
 * Top-level facade wiring 8-Bit's collaborators together (registry/eligibility awareness via
 * ForgeZero+ForgeRouter, health, reliability, routing, failover, handoff, persistence). This
 * is intentionally thin — logic lives in the collaborator it names; this class only sequences
 * calls and persists results, so each collaborator stays independently testable.
 */
export class EightBitRuntime {
  readonly health: EightBitHealthTracker;
  readonly reliability: EightBitReliabilityTracker;
  readonly router: EightBitRouter;
  readonly store: EightBitDecisionStore;
  readonly failover: EightBitFailoverCoordinator;
  readonly handoff: EightBitHandoffBuilder;
  readonly capacity: EightBitCapacityIntelligence;
  /** R24 Mission A: the temporal, evidence-driven route-health authority ForgeAuto consumes. */
  readonly routeHealth: EightBitRouteHealthAuthority;
  readonly routeHealthLedger: EightBitRouteHealthLedger;
  /** R24 Mission C: the Free Fabric admission authority (absent in tests/legacy hosts). */
  readonly freeFabric?: FreeFabric;
  /** Holds this runtime created, keyed by admission requestId → reservationId. */
  private readonly fabricHolds = new Map<string, string>();

  constructor(private readonly options: EightBitRuntimeOptions) {
    this.health = new EightBitHealthTracker(options.firewall, options.now);
    this.reliability = new EightBitReliabilityTracker();
    this.routeHealth = options.routeHealth ?? new EightBitRouteHealthAuthority({ ...DEFAULT_ROUTE_HEALTH_POLICY, ...options.routeHealthPolicy }, options.now);
    this.routeHealthLedger = new EightBitRouteHealthLedger(options.persistence, { persistObservations: options.persistRouteObservations ?? true });
    // A shared authority is attached to the ledger by whoever owns it; a runtime-private one is
    // attached here so every observation this runtime feeds becomes durable, host-visible truth.
    if (!options.routeHealth) this.routeHealthLedger.attach(this.routeHealth);
    this.router = new EightBitRouter(options.firewall, this.health, this.reliability, undefined, this.routeHealth);
    this.store = new EightBitDecisionStore(options.persistence);
    this.failover = new EightBitFailoverCoordinator(this.health, this.router, this.store);
    this.handoff = new EightBitHandoffBuilder(options.persistence);
    this.capacity = new EightBitCapacityIntelligence();
    this.freeFabric = options.freeFabric;
  }

  get hasFreeFabric(): boolean {
    return this.freeFabric !== undefined;
  }

  /**
   * Ask the Free Fabric whether this request may spend free capacity now, and on which route.
   * Returns undefined when no fabric is attached — callers keep their pre-fabric path. On
   * ADMITTED the fabric's reservation is tracked so `releaseFabricAdmission` can settle it;
   * a repeated call with the same requestId replaces the hold, never double-spends.
   */
  admitThroughFabric(req: {
    requestId: string;
    sessionId: string;
    role: EightBitRole;
    /**
     * Health-evidence scope when it differs from the admission role — e.g. a review turn
     * admits on coding-capable supply but its outcomes belong in REVIEWER-scoped evidence.
     */
    healthRole?: EightBitRole;
    /** R33: prefer a physical quota pool different from this one (reviewer independence).
     *  The same pool remains reachable only after independent routes fail admission. */
    preferIndependentFromPoolId?: string;
    userId?: string;
    taskKind?: string;
    demand?: FabricRequest["demand"];
    /** R41: advisory per-role quality evidence forwarded into the fabric's effective
     *  score (see FabricRequest.roleQualityAdjustment). */
    roleQualityAdjustment?: FabricRequest["roleQualityAdjustment"];
    isNewUser?: boolean;
    leaseMs?: number;
  }): FabricRouteDecision | undefined {
    const fabric = this.options.freeFabric;
    if (!fabric) return undefined;
    const ctx = this.options.fabricContext?.({ sessionId: req.sessionId, role: req.role, requestId: req.requestId, userId: req.userId });
    const decision = fabric.decide({
      requestId: req.requestId,
      userId: ctx?.userId ?? req.userId ?? "anonymous",
      ...(ctx?.userIdentities ? { userIdentities: ctx.userIdentities } : {}),
      role: FABRIC_MODEL_ROLE[req.role],
      // The caller knows the real role; product-role mapping alone would assess explorer work
      // against tool-agent-scoped health evidence (and vice versa).
      healthRole: req.healthRole ?? req.role,
      ...(req.preferIndependentFromPoolId ? { preferIndependentFromPoolId: req.preferIndependentFromPoolId } : {}),
      ...(req.taskKind ? { taskKind: req.taskKind } : {}),
      ...(req.demand ? { demand: req.demand } : {}),
      ...(req.roleQualityAdjustment ? { roleQualityAdjustment: req.roleQualityAdjustment } : {}),
      isNewUser: req.isNewUser ?? ctx?.isNewUser ?? false,
      ...(req.leaseMs ?? ctx?.leaseMs ? { leaseMs: req.leaseMs ?? ctx?.leaseMs } : {}),
      ...(ctx?.dataContext ? { dataContext: ctx.dataContext } : {}),
    });
    if (decision.outcome === "ADMITTED" && decision.selected?.reservationId) {
      this.fabricHolds.set(req.requestId, decision.selected.reservationId);
    }
    return decision;
  }

  /** Settle a fabric admission early (run/turn finished or failed before the lease expired).
   *  Idempotent: unknown/already-released ids return false. */
  releaseFabricAdmission(requestId: string): boolean {
    const reservationId = this.fabricHolds.get(requestId);
    this.fabricHolds.delete(requestId);
    if (!reservationId) return false;
    return this.options.freeFabric?.release(reservationId) ?? false;
  }

  forecastCapacity(input: CapacityForecastInput): CapacityForecast {
    return this.capacity.forecast(input);
  }

  preflightCapacity(input: CapacityPreflightInput): CapacityPreflight {
    return this.capacity.preflight(input);
  }

  /** Restores persisted route bindings + health snapshots for a session into the live
   * ForgeZero/health state, so a process restart does not forget an active rotation or
   * cooldown. Idempotent; safe to call once per AgentRuntime construction. */
  async hydrate(sessionId: string): Promise<void> {
    // R24: the host-scoped route-health authority hydrates first — it is what excludes a retired
    // or quota-exhausted route for EVERY session, not just the one that observed it.
    if (!this.options.routeHealth) {
      try {
        await this.routeHealthLedger.hydrate(this.routeHealth);
      } catch {
        // A missing/unreadable ledger degrades to "no prior evidence" (UNKNOWN), never to a crash.
      }
    }
    // Route health is restored FIRST and from its own dedicated per-route records — a route
    // that failed and was rotated away from must stay excluded even though the current
    // binding row (below) now names its replacement, not the route that actually failed.
    const healthSnapshots = await this.store.loadAllRouteHealth(sessionId);
    for (const health of healthSnapshots) this.health.hydrate(health);

    const states = await this.store.loadAllRouteStates(sessionId);
    for (const state of states) {
      const scope: BindingScope = { sessionId: state.sessionId, role: state.role as EightBitRole, workstreamId: state.workstreamId };
      this.router.hydrateBinding(scope, { providerId: state.providerId, modelId: state.modelId });
      if (state.health) this.health.hydrate(state.health);
    }
  }

  recordToolCallOutcome(providerId: string, modelId: string, outcome: ToolCallOutcome, context: { role?: EightBitRole; correlationId?: string } = {}): void {
    this.reliability.record(providerId, modelId, outcome);
    this.observe({ kind: "tool_outcome", providerId, modelId, observedAt: new Date(this.now()).toISOString(), source: "runtime", outcome, role: context.role, correlationId: context.correlationId });
  }

  recordSuccess(providerId: string, modelId: string, context: { latencyMs?: number; role?: EightBitRole; inputTokens?: number; outputTokens?: number; correlationId?: string; requestShape?: "bare" | "production" } = {}): void {
    this.health.recordSuccess(providerId, modelId);
    this.observe({ kind: "call_success", providerId, modelId, observedAt: new Date(this.now()).toISOString(), source: "runtime", latencyMs: context.latencyMs ?? 0, role: context.role, inputTokens: context.inputTokens, outputTokens: context.outputTokens, correlationId: context.correlationId, requestShape: context.requestShape ?? "production" });
  }

  /** Feed a classified model-turn failure to the authority (the failover path calls this itself). */
  recordFailure(providerId: string, modelId: string, error: unknown, context: { role?: EightBitRole; correlationId?: string; retryAfterMs?: number } = {}): void {
    const reason = classifyFailure(error);
    const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : undefined;
    const message = error instanceof Error ? error.message : String(error ?? "");
    this.observe({ kind: "call_failure", providerId, modelId, observedAt: new Date(this.now()).toISOString(), source: "runtime", reason, status, retryAfterMs: context.retryAfterMs, message: message.slice(0, 300), role: context.role, correlationId: context.correlationId, requestShape: "production" });
  }

  /** Generic sink for every producer (probe gates, headers, allowances, catalog, entitlement, governor). */
  observe(observation: NormalizedObservation): void {
    try {
      this.routeHealth.observe(observation);
    } catch {
      // The authority is routing input; a malformed observation must never break a model turn.
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async selectInitialRoute(
    scope: BindingScope,
    options: Omit<SelectRouteOptions, "scope">,
    context: { runId?: string; agentId?: string },
  ): Promise<SelectRouteResult> {
    // R24 Mission C: when a Free Fabric governs automatic free routing it is the admission
    // authority — its verdict (ADMITTED/QUEUED/DENIED + reservation) determines whether this
    // request may spend free capacity, not a bare ranking. Explicit pins bypass entirely.
    if (this.options.freeFabric && options.policyMode === "adaptive") {
      return this.selectInitialRouteViaFabric(scope, options, context);
    }
    const result = this.router.selectRoute({ ...options, scope });
    if (result.outcome === "selected") {
      await this.persistBinding(scope, { providerId: result.model.providerId, modelId: result.model.modelId }, options.policyMode, false);
      if (!result.sticky) {
        await this.store.recordReceipt(
          this.receipt(scope, context, "INITIAL_SELECTION", options.policyMode, undefined, {
            providerId: result.model.providerId,
            modelId: result.model.modelId,
          }, ["FREE_DEFAULT_ELIGIBLE", ...result.reasons.map((r) => r.toUpperCase())]),
        );
      }
    } else {
      await this.store.recordReceipt(
        this.receipt(scope, context, "NO_ELIGIBLE_ROUTE", options.policyMode, undefined, undefined, result.reasonCodes),
      );
    }
    return result;
  }

  /** The fabric-governed selection path. The fabric's verdict is authoritative: ADMITTED
   *  yields the executable model behind its reserved route; QUEUED_FOR_CAPACITY and
   *  DENIED_NO_SUPPLY are surfaced honestly — never substituted, never a paid route. */
  private async selectInitialRouteViaFabric(
    scope: BindingScope,
    options: Omit<SelectRouteOptions, "scope">,
    context: { runId?: string; agentId?: string },
  ): Promise<SelectRouteResult> {
    const requestId = context.runId ?? `${scope.sessionId}:${scope.role}:${scope.workstreamId ?? "-"}`;
    const decision = this.admitThroughFabric({
      requestId,
      sessionId: scope.sessionId,
      role: scope.role,
      userId: options.userId,
      taskKind: options.taskType,
      // The reservation holds near-term per-call demand, not the run's whole context budget —
      // provider quota headers post-call are the real accounting, and a failover re-decides.
      // R34: when the caller measured the serialized request, reserve that size scaled by
      // each candidate's learned tokenizer ratio instead of the flat worst-case ceiling.
      demand: options.estimatedPromptTokens !== undefined
        ? { requests: 1, estimatedPromptTokens: options.estimatedPromptTokens, outputTokens: options.outputTokenDemand ?? 2_048, outputTokensFor: options.outputTokenDemandFor }
        : { requests: 1, inputTokens: Math.min(options.estimatedContextTokens ?? 16_000, 16_000), outputTokensFor: options.outputTokenDemandFor },
      roleQualityAdjustment: options.roleQualityAdjustment,
    });
    if (!decision) return this.router.selectRoute({ ...options, scope });

    const reasonCodes = decision.explanation.reasonCodes;
    if (decision.outcome !== "ADMITTED" || !decision.selected) {
      const queued = decision.outcome === "QUEUED_FOR_CAPACITY";
      await this.store.recordReceipt(
        this.receipt(scope, context, "NO_ELIGIBLE_ROUTE", options.policyMode, undefined, undefined,
          [`FABRIC_${decision.outcome}`, ...reasonCodes]),
      );
      return {
        outcome: "no_eligible_route",
        reasonCodes: [`FABRIC_${decision.outcome}`, ...reasonCodes],
        ...(queued ? { queued: decision.nextAvailableAt ? { nextAvailableAt: decision.nextAvailableAt } : {} } : {}),
        fabric: decision,
      };
    }

    const selected = decision.selected;
    const model = this.options.firewall.getModel(selected.providerId, selected.modelId);
    // The fabric's route universe is projected from the same registry, so this is a
    // consistency guard, not a policy check: an admitted route with no executable model or
    // no provider adapter is released and fails closed rather than producing a phantom run.
    if (!model || !options.hasAdapter(selected.providerId)) {
      this.releaseFabricAdmission(requestId);
      await this.store.recordReceipt(
        this.receipt(scope, context, "NO_ELIGIBLE_ROUTE", options.policyMode, undefined, undefined,
          ["FABRIC_ROUTE_NOT_EXECUTABLE", ...reasonCodes]),
      );
      return { outcome: "no_eligible_route", reasonCodes: ["FABRIC_ROUTE_NOT_EXECUTABLE", ...reasonCodes], fabric: decision };
    }

    await this.persistBinding(scope, { providerId: selected.providerId, modelId: selected.modelId }, options.policyMode, false);
    // Keep the router's in-memory binding aligned with the durable row — hydrate() and
    // currentBinding() must see the same route the fabric admitted.
    this.router.hydrateBinding(scope, { providerId: selected.providerId, modelId: selected.modelId });
    await this.store.recordReceipt(
      this.receipt(scope, context, "INITIAL_SELECTION", options.policyMode, undefined,
        { providerId: selected.providerId, modelId: selected.modelId },
        ["FABRIC_ADMITTED", `SUPPLY_${selected.supplyClass}`, `OWNER_${selected.quotaOwner}`, ...reasonCodes]),
    );
    const assessment = this.routeHealth.assess(selected.providerId, selected.modelId, { role: scope.role });
    return {
      outcome: "selected",
      model,
      sticky: false,
      score: (model.agentScore ?? model.codingScore ?? 0) + assessment.scoreAdjustment,
      reasons: ["FABRIC_ADMITTED", `SUPPLY_${selected.supplyClass}`, ...reasonCodes],
      health: assessment,
      fabric: decision,
    };
  }

  async handleTurnFailure(req: FailoverRequest & { policyMode: EightBitPolicyMode }): Promise<FailoverOutcome> {
    // R24: every turn failure is health evidence, whatever the failover decides.
    const retryAfter = (req.error as { retryAfter?: unknown })?.retryAfter;
    this.recordFailure(req.current.providerId, req.current.modelId, req.error, { role: req.role, correlationId: req.runId ?? req.turnId, retryAfterMs: typeof retryAfter === "number" ? Math.max(0, retryAfter > 1e12 ? retryAfter - this.now() : retryAfter * 1000) : undefined });
    // R24 Mission C: auto-mode rotation re-decides through the Free Fabric — the failed
    // route's hold is replaced atomically by the next admissible route's reservation (same
    // requestId), so a failover can never execute unadmitted or double-spend the pool.
    const requestId = req.fabricRequestId ?? req.runId ?? req.turnId;
    // R33: remember the fabric's verdict. `no_replacement` must distinguish a durable
    // capacity wait (eligible supply is busy) and a fail-closed absence of eligible supply.
    let lastFabricDecision: FabricRouteDecision | undefined;
    const reqWithFabric: typeof req = this.options.freeFabric && (req.pinMode ?? (req.isExactPin ? "route" : "auto")) === "auto"
      ? {
        ...req,
        fabricReplacement: (exclude) => {
          const decision = this.admitThroughFabric({
            requestId,
            sessionId: req.sessionId,
            role: req.role,
            userId: req.userId,
            taskKind: "failover",
            demand: req.estimatedPromptTokens !== undefined
              ? { requests: 1, estimatedPromptTokens: req.estimatedPromptTokens, outputTokens: req.outputTokenDemand ?? 2_048, outputTokensFor: req.outputTokenDemandFor }
              : { requests: 1, inputTokens: Math.min(req.estimatedContextTokens ?? 16_000, 16_000), outputTokensFor: req.outputTokenDemandFor },
            roleQualityAdjustment: req.roleQualityAdjustment,
          });
          lastFabricDecision = decision;
          if (decision?.outcome !== "ADMITTED" || !decision.selected) return undefined;
          const sel = decision.selected;
          if (!req.hasAdapter(sel.providerId)) {
            // An admitted route with no backend can never execute — release the fresh hold
            // and let the coordinator's bounded same-route path decide honestly.
            this.releaseFabricAdmission(requestId);
            return undefined;
          }
          if (sel.providerId === exclude.providerId && sel.modelId === exclude.modelId) {
            // The failed route re-won admission (demoted but not excluded, and nothing
            // better is admissible). Keep its hold — the bounded same-route retry below
            // executes under exactly this reservation.
            return undefined;
          }
          return { route: { providerId: sel.providerId, modelId: sel.modelId }, reasonCodes: decision.explanation.reasonCodes, capacityPoolId: sel.capacityPoolId };
        },
      }
      : req;
    const outcome = await this.failover.handleFailure(reqWithFabric);
    if (outcome.action === "no_replacement" && lastFabricDecision?.outcome === "QUEUED_FOR_CAPACITY") {
      return {
        ...outcome,
        capacityWait: {
          reasonCodes: lastFabricDecision.explanation.reasonCodes,
          ...(lastFabricDecision.nextAvailableAt ? { nextAvailableAt: lastFabricDecision.nextAvailableAt } : {}),
        },
      };
    }
    // Persist the FAILED route's health regardless of outcome — this is what a restart needs
    // to keep excluding it, independent of whatever the binding row ends up pointing at.
    await this.store.saveRouteHealth(req.sessionId, req.current.providerId, req.current.modelId, this.health.getHealth(req.current.providerId, req.current.modelId));
    if (outcome.action === "rotate") {
      await this.persistBinding(
        { sessionId: req.sessionId, role: req.role, workstreamId: req.workstreamId },
        outcome.replacement,
        req.policyMode,
        false,
      );
      await this.store.saveRouteHealth(req.sessionId, outcome.replacement.providerId, outcome.replacement.modelId, this.health.getHealth(outcome.replacement.providerId, outcome.replacement.modelId));
    }
    return outcome;
  }

  private async persistBinding(scope: BindingScope, route: RouteKey, policyMode: EightBitPolicyMode, isExactPin: boolean): Promise<void> {
    await this.store.saveRouteState(scope, {
      sessionId: scope.sessionId,
      role: scope.role,
      workstreamId: scope.workstreamId,
      providerId: route.providerId,
      modelId: route.modelId,
      policyMode,
      isExactPin,
      health: this.health.getHealth(route.providerId, route.modelId),
    });
  }

  private receipt(
    scope: BindingScope,
    context: { runId?: string; agentId?: string },
    action: DecisionReceipt["action"],
    policyMode: EightBitPolicyMode,
    previous: RouteKey | undefined,
    selected: RouteKey | undefined,
    reasonCodes: string[],
  ): DecisionReceipt {
    return {
      receiptId: newReceiptId(),
      createdAt: new Date().toISOString(),
      sessionId: scope.sessionId,
      runId: context.runId,
      agentId: context.agentId,
      workstreamId: scope.workstreamId,
      role: scope.role,
      action,
      policyMode: policyMode === "adaptive" ? "adaptive" : "exact-pin",
      previous,
      selected,
      reasonCodes,
    };
  }
}

export function createEightBitRuntime(options: EightBitRuntimeOptions): EightBitRuntime {
  return new EightBitRuntime(options);
}
