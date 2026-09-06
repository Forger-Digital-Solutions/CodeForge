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

export interface EightBitRuntimeOptions {
  firewall: ForgeZero;
  persistence: ISessionPersistence;
  now?: () => number;
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

  constructor(private readonly options: EightBitRuntimeOptions) {
    this.health = new EightBitHealthTracker(options.firewall, options.now);
    this.reliability = new EightBitReliabilityTracker();
    this.router = new EightBitRouter(options.firewall, this.health, this.reliability);
    this.store = new EightBitDecisionStore(options.persistence);
    this.failover = new EightBitFailoverCoordinator(this.health, this.router, this.store);
    this.handoff = new EightBitHandoffBuilder(options.persistence);
  }

  /** Restores persisted route bindings + health snapshots for a session into the live
   * ForgeZero/health state, so a process restart does not forget an active rotation or
   * cooldown. Idempotent; safe to call once per AgentRuntime construction. */
  async hydrate(sessionId: string): Promise<void> {
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

  recordToolCallOutcome(providerId: string, modelId: string, outcome: ToolCallOutcome): void {
    this.reliability.record(providerId, modelId, outcome);
  }

  recordSuccess(providerId: string, modelId: string): void {
    this.health.recordSuccess(providerId, modelId);
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
