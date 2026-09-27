import type { EightBitHealthTracker } from "./health.js";
import { classifyFailure, shortRateLimitWaitMs, SHORT_RATE_LIMIT_MAX_WAIT_MS } from "./health.js";
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
const NO_TARGET_TRANSIENT_RETRY_REASONS: ReadonlySet<FailureReason> = new Set(["TEMPORARY_CAPACITY", "PROVIDER_OUTAGE", "TRANSIENT_NETWORK", "TIMEOUT"]);
/**
 * Auto-mode failure classes whose evidence is the route's own transport path, not the model:
 * an independent pool is tried FIRST instead of spending the bounded same-route retries on a
 * connection that just dropped. With nothing else admissible, the shared same-route fallback
 * (NO_TARGET_TRANSIENT_RETRY_REASONS) still bounds the retry — exact/model pins keep the old
 * same-route-first semantics.
 */
const AUTO_ROTATE_FIRST_REASONS: ReadonlySet<FailureReason> = new Set(["TRANSIENT_NETWORK", "TIMEOUT"]);
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
  /** R34 Mission E: measured serialized-request estimate at failure time (live history +
   *  tools). The failover re-decide reserves this size per candidate's tokenizer ratio —
   *  honest demand for the continuation the replacement route would actually serve. */
  estimatedPromptTokens?: number;
  /** R34 Mission K: bounded output allowance; defaults to the writer-sized 2048. */
  outputTokenDemand?: number;
  /**
   * R41: per-candidate completion demand for the re-decide — the bounded output budget this
   * continuation would place on THAT replacement route (see SelectRouteOptions.
   * outputTokenDemandFor). Lets a tight output window admit a lighter qualifying candidate.
   */
  outputTokenDemandFor?: (providerId: string, modelId: string) => number | undefined;
  hasAdapter: (providerId: string) => boolean;
  routeFilter?: (providerId: string, modelId: string) => boolean;
  /** Capacity advice is ranking-only; ForgeZero and routeFilter retain admission authority. */
  capacityScoreAdjustment?: SelectRouteOptions["capacityScoreAdjustment"];
  /** R41: advisory per-role quality for the re-decide — keeps replacement selection
   *  role-aware (see SelectRouteOptions.roleQualityAdjustment). */
  roleQualityAdjustment?: SelectRouteOptions["roleQualityAdjustment"];
  /** R41: the candidate's role qualification tier for the re-decide (see
   *  SelectRouteOptions.roleQualificationTierFor) — a capacity-constrained qualified
   *  incumbent must not block a healthy probation replacement. */
  roleQualificationTierFor?: SelectRouteOptions["roleQualificationTierFor"];
  /** Called before a bounded same-route wait so the caller can tell the user what is happening. */
  onWait?: (info: { waitMs: number; reason: FailureReason }) => void;
  /** R24: the requesting user's fairness identity for fabric re-admission. */
  userId?: string;
  /**
   * R24 Mission C: the admission requestId this failover replaces. When the caller's initial
   * admission used a different stable id than `runId` (e.g. an interactive turn's
   * `forgeauto:<turnId>`), it is carried here so the fabric re-decide replaces — never
   * double-books — the original hold.
   */
  fabricRequestId?: string;
  /**
   * R24 Mission C: when a Free Fabric governs admission, an `auto`-mode rotation is decided
   * by the fabric — it releases/replaces the failed route's reservation atomically and only
   * returns routes the fabric actually admitted. Returning undefined falls back to the
   * bounded same-route path, which still holds the original reservation. `capacityPoolId`
   * identifies the admitted replacement's physical quota pool so callers can keep pool
   * identity truthful across a migration.
   */
  fabricReplacement?: (exclude: RouteKey) => { route: RouteKey; reasonCodes: string[]; capacityPoolId?: string } | undefined;
  /**
   * The physical capacity pool that served the failed call. Forwarded into the fabric re-decide
   * so an auto-mode rotation prefers a different pool — retrying the same pool after a
   * transport failure would re-hit the same outage. Callers never invent one when unknown.
   */
  preferIndependentFromPoolId?: string;
  /**
   * R51: on-demand measurement for candidates the fabric denied as CAPACITY_UNMEASURED.
   * Wired to FreeCloudService.probeRouteCapacity by the host; absent means the host cannot
   * measure and the denial stays terminal. Bounded to one retry pass per failure.
   */
  measureCapacity?: (providerId: string, modelId: string, opts?: { capacityPoolId?: string }) => Promise<boolean>;
  /** Internal once-guard — the runtime sets it on the measure-then-retry re-entry. */
  capacityMeasured?: boolean;
}

export type FailoverOutcome =
  | { action: "retry_same"; reason: FailureReason }
  | { action: "rotate"; reason: FailureReason; replacement: RouteKey; capacityPoolId?: string; receipt: DecisionReceipt }
  | {
    action: "no_replacement";
    reason: FailureReason;
    receipt: DecisionReceipt;
    /**
     * R33: set when the fabric re-decide reported QUEUED_FOR_CAPACITY — eligible free supply
     * exists but is busy, so the caller should park durably instead of terminalizing. Absent
     * means the denial was structural (no eligible route at all) and stays fail-closed.
     */
    capacityWait?: { reasonCodes: string[]; nextAvailableAt?: string };
  }
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
    if (consecutiveFailures >= BOUNDED_RETRY_ESCALATION_THRESHOLD) return null;
    const now = this.clock.now();
    let waitMs: number;
    const reasonCodes = [reason, "NO_REPLACEMENT_ROUTE", "BOUNDED_SAME_ROUTE_RETRY"];
    if (NO_TARGET_TRANSIENT_RETRY_REASONS.has(reason)) {
      waitMs = Math.max(0, Math.min(NO_TARGET_RETRY_MAX_WAIT_MS, (cooldownUntil ?? 0) - now));
    } else if (reason === "RATE_LIMITED") {
      // A per-minute limit on the only admitted route (the normal first-day state on shared free
      // capacity) used to end the whole task on the first 429. The window is short and known, so
      // wait it out once or twice instead — never for daily caps, which stay a closed door.
      const shortWait = shortRateLimitWaitMs(req.error, now);
      if (shortWait === undefined) return null;
      waitMs = Math.min(SHORT_RATE_LIMIT_MAX_WAIT_MS, shortWait);
      reasonCodes.push("SHORT_RATE_LIMIT_WAIT");
    } else {
      return null;
    }
    // The bounded wait is the cooldown: the route (and ForgeZero's provider projection) must be
    // eligible again by the time the retry issues its next model call.
    this.health.shortenCooldown(req.current.providerId, req.current.modelId, now + waitMs);
    const receipt = this.buildReceipt(req, "COOLDOWN", reasonCodes);
    receipt.evidence = { ...receipt.evidence, waitMs, consecutiveFailures };
    await this.store.recordReceipt(receipt);
    req.onWait?.({ waitMs, reason });
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

    const pinMode = req.pinMode ?? (req.isExactPin ? "route" : "auto");
    const rotateFirst = pinMode === "auto" && AUTO_ROTATE_FIRST_REASONS.has(reason);
    if (policy === "bounded_retry" && health.consecutiveFailures < BOUNDED_RETRY_ESCALATION_THRESHOLD && !rotateFirst) {
      return { action: "retry_same", reason };
    }

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
      estimatedPromptTokens: req.estimatedPromptTokens,
      outputTokenDemand: req.outputTokenDemand,
      outputTokenDemandFor: req.outputTokenDemandFor,
      hasAdapter: req.hasAdapter,
      routeFilter: req.routeFilter,
      capacityScoreAdjustment: req.capacityScoreAdjustment,
      roleQualityAdjustment: req.roleQualityAdjustment,
      roleQualificationTierFor: req.roleQualificationTierFor,
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

    // R24 Mission C: fabric-governed rotation. The fabric's admission verdict replaces the
    // ranking selectReplacement — its re-decide already applied the failure's health evidence
    // (recorded before this call) and holds the replacement's reservation.
    if (req.fabricReplacement) {
      const replacement = req.fabricReplacement(req.current);
      if (replacement === undefined) {
        const retry = await this.retrySameAfterCapacityBlip(req, reason, health.consecutiveFailures, health.cooldownUntil);
        if (retry) return retry;
        const receipt = this.buildReceipt(req, "NO_ELIGIBLE_ROUTE", [reason, "FABRIC_NO_ADMISSIBLE_ROUTE"]);
        await this.store.recordReceipt(receipt);
        return { action: "no_replacement", reason, receipt };
      }
      const receipt = this.buildReceipt(req, "ROTATE", [reason, "FABRIC_ADMITTED_REPLACEMENT", ...replacement.reasonCodes], replacement.route);
      await this.store.recordReceipt(receipt);
      return { action: "rotate", reason, replacement: replacement.route, ...(replacement.capacityPoolId ? { capacityPoolId: replacement.capacityPoolId } : {}), receipt };
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
