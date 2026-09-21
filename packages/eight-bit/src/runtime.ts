import type { ForgeZero } from "@codeforge/forge-zero";
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
}

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

  async handleTurnFailure(req: FailoverRequest & { policyMode: EightBitPolicyMode }): Promise<FailoverOutcome> {
    // R24: every turn failure is health evidence, whatever the failover decides.
    const retryAfter = (req.error as { retryAfter?: unknown })?.retryAfter;
    this.recordFailure(req.current.providerId, req.current.modelId, req.error, { role: req.role, correlationId: req.runId ?? req.turnId, retryAfterMs: typeof retryAfter === "number" ? Math.max(0, retryAfter > 1e12 ? retryAfter - this.now() : retryAfter * 1000) : undefined });
    const outcome = await this.failover.handleFailure(req);
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
