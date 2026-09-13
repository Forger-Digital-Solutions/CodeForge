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
/**
 * Momentary upstream capacity failures (a 502/503 "temporarily overloaded" from the provider
 * behind a free route) that justify retrying the SAME route when there is nothing to rotate to.
 * A user with one admitted free route — the normal first-day state — otherwise lost the whole
 * task to a blip the route recovered from seconds later (observed in R5). Rate limits, quota,
 * auth and eligibility failures are never retried this way.
 */
const NO_TARGET_TRANSIENT_RETRY_REASONS: ReadonlySet<FailureReason> = new Set(["TEMPORARY_CAPACITY", "PROVIDER_OUTAGE"]);
/** Upper bound on the wait before such a retry; the route's own cooldown is honoured up to it. */
const NO_TARGET_RETRY_MAX_WAIT_MS = 8_000;

export interface FailoverRequest {
  sessionId: string;
  turnId: string;
  role: EightBitRole;
  workstreamId?: string;
  runId?: string;
  agentId?: string;
  current: RouteKey;
  /** Legacy: true = exact route pin (no automatic replacement). Superseded by `pinMode`. */
  isExactPin: boolean;
  /**
   * R1 §124 lock semantics. `auto` (ForgeAuto): model and route may change. `model` (user picked
   * a canonical model): only same-model alternate routes may replace the failed one. `route`:
   * never replaced automatically (== isExactPin).
   */
  pinMode?: "auto" | "model" | "route";
  /** Eligible routes serving the same canonical model as `current`, best first. */
  sameModelAlternates?: RouteKey[];
  policyMode: SelectRouteOptions["policyMode"];
  error: unknown;
  estimatedContextTokens?: number;
  hasAdapter: (providerId: string) => boolean;
  routeFilter?: (providerId: string, modelId: string) => boolean;
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
    private readonly clock: { now: () => number; sleep: (ms: number) => Promise<void> } = {
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  ) {}

  /**
   * No replacement route exists for a transient capacity failure: wait out a bounded slice of
   * the route's cooldown and retry it. The third consecutive failure escalates to the caller's
   * ordinary NO_ELIGIBLE_ROUTE / EXACT_PIN_FAILED path, so the retry is bounded like every other.
   */
  private async retrySameAfterCapacityBlip(req: FailoverRequest, reason: FailureReason, consecutiveFailures: number, cooldownUntil: number | undefined): Promise<FailoverOutcome | null> {
    if (!NO_TARGET_TRANSIENT_RETRY_REASONS.has(reason) || consecutiveFailures >= BOUNDED_RETRY_ESCALATION_THRESHOLD) return null;
    const now = this.clock.now();
    const waitMs = Math.max(0, Math.min(NO_TARGET_RETRY_MAX_WAIT_MS, (cooldownUntil ?? 0) - now));
    // The bounded wait is the cooldown: the route (and ForgeZero's provider projection) must be
    // eligible again by the time the retry issues its next model call.
    this.health.shortenCooldown(req.current.providerId, req.current.modelId, now + waitMs);
    const receipt = this.buildReceipt(req, "COOLDOWN", [reason, "NO_REPLACEMENT_ROUTE", "BOUNDED_SAME_ROUTE_RETRY"]);
    receipt.evidence = { ...(receipt.evidence ?? {}), waitMs, consecutiveFailures };
    await this.store.recordReceipt(receipt);
    if (waitMs > 0) await this.clock.sleep(waitMs);
    return { action: "retry_same", reason };
  }

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

    const pinMode = req.pinMode ?? (req.isExactPin ? "route" : "auto");
    if (pinMode === "route") {
      const retry = await this.retrySameAfterCapacityBlip(req, reason, health.consecutiveFailures, health.cooldownUntil);
      if (retry) return retry;
      const receipt = this.buildReceipt(req, "EXACT_PIN_FAILED", [reason, "EXACT_PIN_NOT_AUTO_REPLACED"]);
      await this.store.recordReceipt(receipt);
      return { action: "no_replacement", reason, receipt };
    }

    const options: SelectRouteOptions = {
      scope: { sessionId: req.sessionId, role: req.role, workstreamId: req.workstreamId },
      policyMode: req.policyMode,
      estimatedContextTokens: req.estimatedContextTokens,
      hasAdapter: req.hasAdapter,
      routeFilter: req.routeFilter,
    };
    const alternates = req.sameModelAlternates ?? [];

    if (pinMode === "model") {
      // A user-selected model keeps its identity: only a same-model route swap is allowed. With
      // no alternate route known for this model, the pin behaves exactly like a route pin — the
      // failure is surfaced, never silently replaced by a different model.
      if (alternates.length === 0) {
        const retry = await this.retrySameAfterCapacityBlip(req, reason, health.consecutiveFailures, health.cooldownUntil);
        if (retry) return retry;
        const receipt = this.buildReceipt(req, "EXACT_PIN_FAILED", [reason, "EXACT_PIN_NOT_AUTO_REPLACED", "MODEL_PIN_NO_ALTERNATE_ROUTE"]);
        await this.store.recordReceipt(receipt);
        return { action: "no_replacement", reason, receipt };
      }
      const restricted: SelectRouteOptions = {
        ...options,
        routeFilter: (providerId, modelId) =>
          alternates.some((a) => a.providerId === providerId && a.modelId === modelId) && (req.routeFilter?.(providerId, modelId) ?? true),
      };
      const result = this.router.selectReplacement(restricted, req.current, alternates);
      if (result.outcome === "no_eligible_route") {
        const retry = await this.retrySameAfterCapacityBlip(req, reason, health.consecutiveFailures, health.cooldownUntil);
        if (retry) return retry;
        const receipt = this.buildReceipt(req, "NO_ELIGIBLE_ROUTE", [reason, "MODEL_PIN_NO_ALTERNATE_ROUTE"]);
        await this.store.recordReceipt(receipt);
        return { action: "no_replacement", reason, receipt };
      }
      const replacement: RouteKey = { providerId: result.model.providerId, modelId: result.model.modelId };
      const receipt = this.buildReceipt(req, "ROTATE", [reason, "SAME_MODEL_ALTERNATE_ROUTE"], replacement);
      await this.store.recordReceipt(receipt);
      return { action: "rotate", reason, replacement, receipt };
    }

    const result = this.router.selectReplacement(options, req.current, alternates);

    if (result.outcome === "no_eligible_route") {
      const retry = await this.retrySameAfterCapacityBlip(req, reason, health.consecutiveFailures, health.cooldownUntil);
      if (retry) return retry;
      const receipt = this.buildReceipt(req, "NO_ELIGIBLE_ROUTE", [reason, ...result.reasonCodes]);
      await this.store.recordReceipt(receipt);
      return { action: "no_replacement", reason, receipt };
    }

    const replacement: RouteKey = { providerId: result.model.providerId, modelId: result.model.modelId };
    const sameModel = alternates.some((a) => a.providerId === replacement.providerId && a.modelId === replacement.modelId);
    const receipt = this.buildReceipt(req, "ROTATE", [reason, sameModel ? "SAME_MODEL_ALTERNATE_ROUTE" : "CROSS_MODEL_REPLACEMENT", "REPLACEMENT_ELIGIBLE"], replacement);
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
      policyMode: (req.pinMode ?? (req.isExactPin ? "route" : "auto")) === "route" ? "exact-pin" : "adaptive",
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
