import type { EightBitHealthTracker } from "./health.js";
import { classifyFailure } from "./health.js";
import type { EightBitRouter, SelectRouteOptions } from "./router.js";
import type { EightBitDecisionStore } from "./persistence.js";
import { newReceiptId } from "./persistence.js";
import type { DecisionReceipt, EightBitRole, FailureReason, RouteKey } from "./types.js";

/** Consecutive same-route failures required before a `bounded_retry`-classified reason (e.g.
 * a single timeout) escalates into an actual rotation. A single transient failure must never
 * cause a route change — see FAILURE_POLICY / SUSTAINED_FAILURE_THRESHOLD in health.ts. */
const BOUNDED_RETRY_ESCALATION_THRESHOLD = 3;

export interface FailoverRequest {
  sessionId: string;
  turnId: string;
  role: EightBitRole;
  workstreamId?: string;
  runId?: string;
  agentId?: string;
  current: RouteKey;
  isExactPin: boolean;
  policyMode: SelectRouteOptions["policyMode"];
  error: unknown;
  estimatedContextTokens?: number;
  hasAdapter: (providerId: string) => boolean;
}

export type FailoverOutcome =
  | { action: "retry_same"; reason: FailureReason }
  | { action: "rotate"; reason: FailureReason; replacement: RouteKey; receipt: DecisionReceipt }
  | { action: "no_replacement"; reason: FailureReason; receipt: DecisionReceipt }
  | { action: "surface"; reason: FailureReason };

/**
 * Orchestrates the safe active-run failover flow: classify → mark health → decide (bounded
 * retry vs cooldown+rotate vs remove+refresh vs surface) → for a rotation, select a
 * policy-eligible replacement (never crossing free→paid, never silently replacing an exact
 * pin) → persist a decision receipt. Does NOT touch approval/question/steer/verification
 * state, does NOT retry or replay any side effect itself — it only decides the next route and
 * records why; the caller (the actual turn loop) is responsible for continuing execution with
 * the SAME in-memory conversation/tool-call state, which is what makes side effects exactly-once.
 */
export class EightBitFailoverCoordinator {
  constructor(
    private readonly health: EightBitHealthTracker,
    private readonly router: EightBitRouter,
    private readonly store: EightBitDecisionStore,
  ) {}

  async handleFailure(req: FailoverRequest): Promise<FailoverOutcome> {
    const reason = classifyFailure(req.error);
    const health = this.health.recordFailure(req.current.providerId, req.current.modelId, reason);
    const policy = this.health.policyFor(reason);

    if (policy === "surface_only") {
      return { action: "surface", reason };
    }

    if (policy === "bounded_retry" && health.consecutiveFailures < BOUNDED_RETRY_ESCALATION_THRESHOLD) {
      return { action: "retry_same", reason };
    }

    if (req.isExactPin) {
      const receipt = this.buildReceipt(req, "EXACT_PIN_FAILED", [reason, "EXACT_PIN_NOT_AUTO_REPLACED"]);
      await this.store.recordReceipt(receipt);
      return { action: "no_replacement", reason, receipt };
    }

    const options: SelectRouteOptions = {
      scope: { sessionId: req.sessionId, role: req.role, workstreamId: req.workstreamId },
      policyMode: req.policyMode,
      estimatedContextTokens: req.estimatedContextTokens,
      hasAdapter: req.hasAdapter,
    };
    const result = this.router.selectReplacement(options, req.current);

    if (result.outcome === "no_eligible_route") {
      const receipt = this.buildReceipt(req, "NO_ELIGIBLE_ROUTE", [reason, ...result.reasonCodes]);
      await this.store.recordReceipt(receipt);
      return { action: "no_replacement", reason, receipt };
    }

    const replacement: RouteKey = { providerId: result.model.providerId, modelId: result.model.modelId };
    const receipt = this.buildReceipt(req, "ROTATE", [reason, "REPLACEMENT_ELIGIBLE"], replacement);
    await this.store.recordReceipt(receipt);
    return { action: "rotate", reason, replacement, receipt };
  }

  private buildReceipt(
    req: FailoverRequest,
    action: DecisionReceipt["action"],
    reasonCodes: string[],
    selected?: RouteKey,
  ): DecisionReceipt {
    return {
      receiptId: newReceiptId(),
      createdAt: new Date().toISOString(),
      sessionId: req.sessionId,
      runId: req.runId,
      agentId: req.agentId,
      turnId: req.turnId,
      workstreamId: req.workstreamId,
      role: req.role,
      action,
      policyMode: req.isExactPin ? "exact-pin" : "adaptive",
      previous: req.current,
      selected,
      reasonCodes,
    };
  }
}

export function createEightBitFailoverCoordinator(
  health: EightBitHealthTracker,
  router: EightBitRouter,
  store: EightBitDecisionStore,
): EightBitFailoverCoordinator {
  return new EightBitFailoverCoordinator(health, router, store);
}
