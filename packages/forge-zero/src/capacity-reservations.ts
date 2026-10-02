import {
  type CapacityLedgerOptions,
  type CapacityLedgerSnapshot,
  type CapacityWindow,
  type CapacityReservation,
  type CapacityReservationDecision,
  type CapacityReservationRequest,
  type CapacityRoute,
  type ProviderCapacityPool,
} from "./capacity-types.js";
import { freeRouteExclusionReason, DEFAULT_FREE_CAPACITY_POLICY, type FreeCapacityPolicy } from "./capacity-policy.js";

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

/** Summed demand held against one accounting domain (a pool, or a user inside a pool). */
interface PoolDemand {
  count: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  credits: number;
  providerUnits: number;
}

interface IndexedReservation extends CapacityReservation {
  /** Physical pool the hold was counted against at admit time. Storing it (rather than
   * re-deriving through the route table on every check) keeps a live hold billed to its pool
   * even if updateRoutes() later drops or renames the route entry. */
  poolId: string;
  expiresAtMs: number;
}

const ZERO_DEMAND: PoolDemand = { count: 0, requests: 0, inputTokens: 0, outputTokens: 0, credits: 0, providerUnits: 0 };

function demandOf(request: CapacityReservationRequest): PoolDemand {
  return {
    count: 1,
    requests: request.requests,
    inputTokens: request.inputTokens,
    outputTokens: request.outputTokens,
    credits: request.credits ?? 0,
    providerUnits: request.providerUnits ?? 0,
  };
}

function addTo(target: PoolDemand, delta: PoolDemand, sign: 1 | -1): void {
  target.count += sign * delta.count;
  target.requests += sign * delta.requests;
  target.inputTokens += sign * delta.inputTokens;
  target.outputTokens += sign * delta.outputTokens;
  target.credits += sign * delta.credits;
  target.providerUnits += sign * delta.providerUnits;
}

function bump(map: Map<string, PoolDemand>, key: string, delta: PoolDemand, sign: 1 | -1): void {
  const existing = map.get(key) ?? { ...ZERO_DEMAND };
  addTo(existing, delta, sign);
  map.set(key, existing);
}

export class CapacityReservationLedger {
  private readonly routes: Map<string, CapacityRoute>;
  private readonly pools: Map<string, ProviderCapacityPool>;
  private readonly reservations = new Map<string, IndexedReservation>();
  private readonly firstRunReserveRequests: number;
  private readonly firstRunReserveTokens: number;
  private readonly maxActiveReservationsPerUser: number;
  private readonly clock: () => number;
  private readonly dataContext: CapacityLedgerOptions["dataContext"];
  private readonly policy: FreeCapacityPolicy;

  // Admission is on the hot path of every turn and every failover re-decide. These indexes
  // make reserve() O(candidate routes) instead of O(active reservations): at one million
  // concurrent leases the old full-map scans cost ~0.5s per admission — a quadratic wall the
  // R33 scale probe measured directly — while indexed admission stays sub-millisecond.
  private readonly userCount = new Map<string, number>();
  private readonly poolDemand = new Map<string, PoolDemand>();
  private readonly userPoolDemand = new Map<string, PoolDemand>();
  /** leaseUntil ms → live reservation ids expiring then; scanned keys stay sorted. */
  private readonly expiryBuckets = new Map<number, Set<string>>();
  private readonly expiryTimes: number[] = [];

  constructor(options: CapacityLedgerOptions) {
    this.routes = new Map(options.routes.map((route) => [route.routeId, route]));
    this.pools = new Map((options.pools ?? []).map((pool) => [pool.poolId, pool]));
    this.firstRunReserveRequests = Math.max(0, options.firstRunReserveRequests ?? 0);
    this.firstRunReserveTokens = Math.max(0, options.firstRunReserveTokens ?? 0);
    this.maxActiveReservationsPerUser = Math.max(1, options.maxActiveReservationsPerUser ?? 3);
    this.clock = options.now ?? (() => Date.now());
    this.dataContext = options.dataContext;
    this.policy = options.policy ?? DEFAULT_FREE_CAPACITY_POLICY;
  }

  /**
   * Replace the route/pool tables while keeping live reservations. Route sets refresh as
   * providers connect, qualify, or lose supply — fairness state (who holds what lease) must
   * survive those refreshes or every catalog sync would double-admit the same capacity.
   */
  updateRoutes(routes: readonly CapacityRoute[], pools?: readonly ProviderCapacityPool[]): void {
    this.routes.clear();
    for (const route of routes) this.routes.set(route.routeId, route);
    if (pools !== undefined) {
      this.pools.clear();
      for (const pool of pools) this.pools.set(pool.poolId, pool);
    }
  }

  reserve(request: CapacityReservationRequest): CapacityReservationDecision {
    this.recoverExpired();
    if (request.requests < 1 || request.inputTokens < 0 || request.outputTokens < 0 || (request.credits ?? 0) < 0 || (request.providerUnits ?? 0) < 0 || request.routeIds.length === 0) {
      return { admitted: false, reservationId: request.reservationId, reason: "INVALID_REQUEST" };
    }
    // A repeated reserve() with the same reservationId replaces its own hold: dropping the
    // prior reservation's index entries first means it can never count against the caller's
    // own concurrency cap or the pool budget (a failover re-decide would otherwise deny a
    // rotation the request already paid for).
    if (this.reservations.has(request.reservationId)) this.removeIndexed(request.reservationId);
    const activeForUser = this.userCount.get(request.userId) ?? 0;
    if (activeForUser >= this.maxActiveReservationsPerUser) {
      return { admitted: false, reservationId: request.reservationId, reason: "USER_CONCURRENCY_LIMIT" };
    }

    let sawEligibleRoute = false;
    let sawUsablePool = false;
    let sawUnmeasured = false;
    let sawMeasuredDenial = false;
    let protectedByFirstRunReserve = false;
    let bindingResetMs: number | undefined;
    for (const routeId of request.routeIds) {
      const route = this.routes.get(routeId);
      // R37: probation-tier roles reserve capacity too — the fabric only ranks them behind
      // qualified peers; eligibility (qualified OR fallback) is what this check mirrors.
      if (!route || !(route.roles.includes(request.role) || route.fallbackRoles?.includes(request.role) === true) || freeRouteExclusionReason(route, this.policy, request.dataContext ?? this.dataContext) !== undefined) continue;
      if (route.capacityPoolScope === "PER_USER_POOL" && route.capacityIdentity !== undefined && request.capacityIdentity !== route.capacityIdentity) continue;
      sawEligibleRoute = true;
      // Two model routes backed by one provider account must contend for the same reservation
      // budget. Distributed pools are deliberately isolated by their natural end user.
      const active = route.capacityPoolScope === "SHARED_OWNER_POOL"
        ? (this.poolDemand.get(route.capacityPoolId) ?? ZERO_DEMAND)
        : (this.userPoolDemand.get(`${request.userId}${route.capacityPoolId}`) ?? ZERO_DEMAND);
      const physicalRoute = this.pools.get(route.capacityPoolId);
      if (physicalRoute && (physicalRoute.providerId !== route.providerId
        || physicalRoute.scope !== route.capacityPoolScope
        || physicalRoute.supplyClass !== route.supplyClass
        || (physicalRoute.capacityIdentity !== undefined && route.capacityIdentity !== undefined && physicalRoute.capacityIdentity !== route.capacityIdentity))) {
        continue;
      }
      sawUsablePool = true;
      // A pool row with no windows carries no observation at all — it must not shadow the
      // route's own observed windows (?? would keep the empty array). Matches the ledger
      // projection's non-empty-pool-wins rule.
      const windows = physicalRoute && physicalRoute.windows.length > 0 ? physicalRoute.windows : route.windows;
      const requestWindow = windows.filter((window) => window.unit === "requests").sort((a, b) => a.remaining - b.remaining)[0];
      const inputWindows = windows.filter((window) => window.unit === "input_tokens");
      const outputWindows = windows.filter((window) => window.unit === "output_tokens");
      const concurrencyWindows = windows.filter((window) => window.unit === "concurrency");
      const creditWindows = windows.filter((window) => window.unit === "credits");
      const providerUnitWindows = windows.filter((window) => window.unit === "provider_units");
      // Any observed quota-dimension window proves the provider meters the account; absent
      // dimensions are then unmetered rather than zero (OpenRouter :free publishes request
      // counts only — treating its missing token windows as zero capacity would deny a
      // metered route forever). R51: a route with NO windows at all is UNMEASURED — denied,
      // but classified truthfully so callers can measure it instead of parking as if it
      // were exhausted. Non-authoritative (documented) windows still gate by their declared
      // numbers — they are measured-by-declaration, not unmeasured.
      if (windows.length === 0) {
        sawUnmeasured = true;
        continue;
      }
      const hasUnitAccounting = creditWindows.length > 0 || providerUnitWindows.length > 0 || requestWindow?.authoritative === true
        || (route.supplyClass === "PACKAGED_FREE_DIRECT" && requestWindow !== undefined)
        // Community pools are metered by standing concurrency (the account's max parallel
        // generations), not request/token budgets; an authoritative concurrency window is the
        // real meter. Requests/tokens are then honestly unmetered — the queue is the throttle.
        || (route.supplyClass === "COMMUNITY_ANONYMOUS_FREE" && concurrencyWindows.some((window) => window.authoritative));
      const inputRemaining = inputWindows.length === 0
        ? (hasUnitAccounting ? Number.MAX_SAFE_INTEGER : 0)
        : Math.min(...inputWindows.map((window) => window.remaining));
      // A provider that reports one undifferentiated token window can still serve output; use
      // the input window as the conservative shared ceiling until a separate output header exists.
      const outputRemaining = outputWindows.length === 0 ? inputRemaining : Math.min(...outputWindows.map((window) => window.remaining));
      const concurrencyRemaining = concurrencyWindows.length === 0 ? undefined : Math.min(...concurrencyWindows.map((window) => window.remaining));
      const requestRemaining = requestWindow?.remaining ?? (hasUnitAccounting ? Number.MAX_SAFE_INTEGER : 0);
      const creditRemaining = creditWindows.length === 0 ? undefined : Math.min(...creditWindows.map((window) => window.remaining));
      const providerUnitsRemaining = providerUnitWindows.length === 0 ? undefined : Math.min(...providerUnitWindows.map((window) => window.remaining));
      const reservedFloorRequests = request.isNewUser ? 0 : this.firstRunReserveRequests;
      const reservedFloorTokens = request.isNewUser ? 0 : this.firstRunReserveTokens;
      const availableRequests = requestRemaining - active.requests - reservedFloorRequests;
      const availableInputTokens = inputRemaining - active.inputTokens - reservedFloorTokens;
      const availableOutputTokens = outputRemaining - active.outputTokens - reservedFloorTokens;
      const availableConcurrency = concurrencyRemaining === undefined ? undefined : concurrencyRemaining - active.count;
      const availableCredits = creditRemaining === undefined ? undefined : creditRemaining - active.credits;
      const availableProviderUnits = providerUnitsRemaining === undefined ? undefined : providerUnitsRemaining - active.providerUnits;
      const unitLimit = (unitWindows: readonly CapacityWindow[]): number | undefined =>
        unitWindows.length === 0 ? undefined : Math.min(...unitWindows.map((window) => window.limit));
      const inputLimit = unitLimit(inputWindows);
      const outputLimit = unitLimit(outputWindows) ?? inputLimit;
      const creditLimit = unitLimit(creditWindows);
      const providerUnitLimit = unitLimit(providerUnitWindows);
      // R59: an estimated demand past the window's declared limit can never be satisfied by
      // a refill — but cannot be disproven by one either (chars/4 × a borrowed tokenizer
      // ratio inflates what the provider will actually bill, so the estimate alone cannot
      // prove the request infeasible). The reservation clamps to what the window can
      // dispense: an over-limit demand needs the WHOLE window, so it is admissible exactly
      // when the window is currently unspent — and the provider's wire response (the rule
      // the pacing governor's tokenBucketDecision already applies) arbitrates fit. A
      // partially spent window denies until its own reset, when it could serve again.
      // Hard-count units (requests, concurrency) never clamp.
      const clampToLimit = (demand: number, limit: number | undefined): number =>
        limit === undefined ? demand : Math.min(demand, limit);
      const effectiveInput = clampToLimit(request.inputTokens, inputLimit);
      const effectiveOutput = clampToLimit(request.outputTokens, outputLimit);
      const effectiveCredits = clampToLimit(request.credits ?? 0, creditLimit);
      const effectiveProviderUnits = clampToLimit(request.providerUnits ?? 0, providerUnitLimit);
      if (request.requests <= availableRequests
        && effectiveInput <= availableInputTokens
        && effectiveOutput <= availableOutputTokens
        && (availableConcurrency === undefined || availableConcurrency >= 1)
        && (availableCredits === undefined || effectiveCredits <= availableCredits)
        && (availableProviderUnits === undefined || effectiveProviderUnits <= availableProviderUnits)) {
        this.addIndexed({
          request: { ...request, inputTokens: effectiveInput, outputTokens: effectiveOutput, credits: effectiveCredits, providerUnits: effectiveProviderUnits },
          routeId,
          poolId: route.capacityPoolId,
          expiresAtMs: Date.parse(request.leaseUntil),
          admittedAt: nowIso(this.clock),
        });
        return { admitted: true, reservationId: request.reservationId, routeId, reason: "ADMITTED" };
      }
      sawMeasuredDenial = true;
      // R59: the recovery horizon must be the reset of the dimension that actually denied —
      // a request-window reset does not speak for a token-window denial (the old
      // min-over-all-windows advertised a horizon that could never serve the demand). A
      // route serves when EVERY denied unit recovers, so per route the horizon is the
      // latest denied-unit horizon; the request is servable at the earliest such route
      // horizon. Window-short units recover at their declared reset; hold-short units when
      // the pool's current leases free. A denied unit with no declared horizon (unparseable
      // reset, permanent hold, a floor that never frees) means the route cannot be
      // scheduled — it contributes no horizon rather than a fabricated one.
      const bindingHorizons: number[] = [];
      let routeUnschedulable = false;
      const collectHorizon = (
        demand: number,
        unitWindows: readonly CapacityWindow[],
        available: number | undefined,
        remaining: number,
      ): void => {
        if (available === undefined || demand <= available) return;
        const binding = [...unitWindows].sort((a, b) => a.remaining - b.remaining)[0]?.resetAt;
        const resetMs = binding === undefined ? Number.NaN : Date.parse(binding);
        if (demand <= remaining) {
          // The window itself can hold it — the shortage is live holds (or a floor). The
          // unit recovers when current leases free OR the window refills, whichever is
          // first; a unit with neither cannot be scheduled on this route.
          const leaseEnd = this.lastPoolLeaseMs(route.capacityPoolId);
          const horizons = [leaseEnd, ...(Number.isFinite(resetMs) ? [resetMs] : [])].filter((h): h is number => h !== undefined);
          if (horizons.length === 0) routeUnschedulable = true;
          else bindingHorizons.push(Math.min(...horizons));
          return;
        }
        if (Number.isFinite(resetMs)) bindingHorizons.push(resetMs);
        else routeUnschedulable = true;
      };
      collectHorizon(request.requests, requestWindow === undefined ? [] : [requestWindow], availableRequests, requestRemaining);
      collectHorizon(effectiveInput, inputWindows, availableInputTokens, inputRemaining);
      collectHorizon(effectiveOutput, outputWindows.length > 0 ? outputWindows : inputWindows, availableOutputTokens, outputRemaining);
      collectHorizon(1, concurrencyWindows, availableConcurrency, concurrencyRemaining ?? 0);
      collectHorizon(effectiveCredits, creditWindows, availableCredits, creditRemaining ?? 0);
      collectHorizon(effectiveProviderUnits, providerUnitWindows, availableProviderUnits, providerUnitsRemaining ?? 0);
      if (!routeUnschedulable && bindingHorizons.length > 0) {
        const serveAtMs = Math.max(...bindingHorizons);
        bindingResetMs = bindingResetMs === undefined ? serveAtMs : Math.min(bindingResetMs, serveAtMs);
      }
      if (!request.isNewUser
        && (this.firstRunReserveRequests > 0 || this.firstRunReserveTokens > 0)
        && requestRemaining - active.requests >= request.requests
        && inputRemaining - active.inputTokens >= request.inputTokens
        && outputRemaining - active.outputTokens >= request.outputTokens) {
        protectedByFirstRunReserve = true;
      }
    }

    if (!sawEligibleRoute) return { admitted: false, reservationId: request.reservationId, reason: "NO_ELIGIBLE_ROUTE" };
    if (!sawUsablePool) return { admitted: false, reservationId: request.reservationId, reason: "CAPACITY_POOL_IDENTITY_MISMATCH" };
    // An unmeasured-only denial names the truth: capacity exists but was never observed —
    // no invented reset, no fabricated "exhausted". A measured denial keeps the real reset.
    if (sawUnmeasured && !sawMeasuredDenial) {
      return { admitted: false, reservationId: request.reservationId, reason: "CAPACITY_UNMEASURED" };
    }
    return {
      admitted: false,
      reservationId: request.reservationId,
      reason: protectedByFirstRunReserve ? "FIRST_RUN_RESERVE_PROTECTED" : "CAPACITY_EXHAUSTED",
      nextAvailableAt: bindingResetMs === undefined ? undefined : new Date(bindingResetMs).toISOString(),
    };
  }

  release(reservationId: string): boolean {
    return this.removeIndexed(reservationId);
  }

  recoverExpired(at = this.clock()): number {
    let removed = 0;
    while (this.expiryTimes.length > 0 && this.expiryTimes[0]! <= at) {
      const time = this.expiryTimes.shift()!;
      const bucket = this.expiryBuckets.get(time);
      if (!bucket) continue;
      this.expiryBuckets.delete(time);
      for (const id of bucket) {
        if (this.removeIndexed(id)) removed++;
      }
    }
    return removed;
  }

  snapshot(): CapacityLedgerSnapshot {
    const byUser: Record<string, number> = {};
    const byRoute: Record<string, number> = {};
    const byPool: Record<string, number> = {};
    for (const reservation of this.reservations.values()) {
      byUser[reservation.request.userId] = (byUser[reservation.request.userId] ?? 0) + 1;
      byRoute[reservation.routeId] = (byRoute[reservation.routeId] ?? 0) + 1;
      byPool[reservation.poolId] = (byPool[reservation.poolId] ?? 0) + 1;
    }
    return {
      generatedAt: nowIso(this.clock),
      activeReservations: this.reservations.size,
      byUser,
      byRoute,
      byPool,
      protectedFirstRunRequests: this.firstRunReserveRequests,
      protectedFirstRunTokens: this.firstRunReserveTokens,
    };
  }

  private addIndexed(reservation: IndexedReservation): void {
    this.reservations.set(reservation.request.reservationId, reservation);
    const demand = demandOf(reservation.request);
    this.userCount.set(reservation.request.userId, (this.userCount.get(reservation.request.userId) ?? 0) + 1);
    bump(this.poolDemand, reservation.poolId, demand, 1);
    bump(this.userPoolDemand, `${reservation.request.userId}${reservation.poolId}`, demand, 1);
    if (Number.isFinite(reservation.expiresAtMs)) {
      const bucket = this.expiryBuckets.get(reservation.expiresAtMs);
      if (bucket) {
        bucket.add(reservation.request.reservationId);
      } else {
        this.expiryBuckets.set(reservation.expiresAtMs, new Set([reservation.request.reservationId]));
        this.insertExpiryTime(reservation.expiresAtMs);
      }
    }
  }

  private removeIndexed(reservationId: string): boolean {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) return false;
    this.reservations.delete(reservationId);
    const demand = demandOf(reservation.request);
    const userTotal = (this.userCount.get(reservation.request.userId) ?? 1) - 1;
    if (userTotal <= 0) this.userCount.delete(reservation.request.userId);
    else this.userCount.set(reservation.request.userId, userTotal);
    bump(this.poolDemand, reservation.poolId, demand, -1);
    bump(this.userPoolDemand, `${reservation.request.userId}${reservation.poolId}`, demand, -1);
    const bucket = this.expiryBuckets.get(reservation.expiresAtMs);
    if (bucket?.delete(reservationId) && bucket.size === 0) {
      this.expiryBuckets.delete(reservation.expiresAtMs);
      const at = this.expiryTimes.indexOf(reservation.expiresAtMs);
      if (at !== -1) this.expiryTimes.splice(at, 1);
    }
    return true;
  }

  private insertExpiryTime(time: number): void {
    // Distinct lease deadlines cluster (one lease duration), so a sorted-array insert keeps
    // expiry drains amortized O(expired) instead of scanning every live reservation.
    let lo = 0;
    let hi = this.expiryTimes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.expiryTimes[mid]! < time) lo = mid + 1;
      else hi = mid;
    }
    this.expiryTimes.splice(lo, 0, time);
  }

  /** Latest lease expiry among reservations holding this pool — the point at which a
   *  hold-short or whole-window-demand request can be retried. Undefined when a live
   *  lease never expires (a permanent hold is no horizon) or nothing holds the pool. */
  private lastPoolLeaseMs(poolId: string): number | undefined {
    let latest: number | undefined;
    for (const reservation of this.reservations.values()) {
      if (reservation.poolId !== poolId) continue;
      if (!Number.isFinite(reservation.expiresAtMs)) return undefined;
      if (latest === undefined || reservation.expiresAtMs > latest) latest = reservation.expiresAtMs;
    }
    return latest;
  }
}
