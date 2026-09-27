import {
  type CapacityLedgerOptions,
  type CapacityLedgerSnapshot,
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
    let protectedByFirstRunReserve = false;
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
      const windows = physicalRoute?.windows ?? route.windows;
      const requestWindow = windows.filter((window) => window.unit === "requests").sort((a, b) => a.remaining - b.remaining)[0];
      const inputWindows = windows.filter((window) => window.unit === "input_tokens");
      const outputWindows = windows.filter((window) => window.unit === "output_tokens");
      const concurrencyWindows = windows.filter((window) => window.unit === "concurrency");
      const creditWindows = windows.filter((window) => window.unit === "credits");
      const providerUnitWindows = windows.filter((window) => window.unit === "provider_units");
      // A credit, provider-units, or observed request window proves the provider meters the
      // account; absent dimensions are then unmetered rather than zero (OpenRouter :free
      // publishes request counts only — treating its missing token windows as zero capacity
      // would deny a metered route forever). A route with no windows at all stays unmeasured
      // and is still denied.
      const hasUnitAccounting = creditWindows.length > 0 || providerUnitWindows.length > 0 || requestWindow?.authoritative === true;
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
      if (request.requests <= availableRequests
        && request.inputTokens <= availableInputTokens
        && request.outputTokens <= availableOutputTokens
        && (availableConcurrency === undefined || availableConcurrency >= 1)
        && (availableCredits === undefined || (request.credits ?? 0) <= availableCredits)
        && (availableProviderUnits === undefined || (request.providerUnits ?? 0) <= availableProviderUnits)) {
        this.addIndexed({
          request,
          routeId,
          poolId: route.capacityPoolId,
          expiresAtMs: Date.parse(request.leaseUntil),
          admittedAt: nowIso(this.clock),
        });
        return { admitted: true, reservationId: request.reservationId, routeId, reason: "ADMITTED" };
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
    return {
      admitted: false,
      reservationId: request.reservationId,
      reason: protectedByFirstRunReserve ? "FIRST_RUN_RESERVE_PROTECTED" : "CAPACITY_EXHAUSTED",
      nextAvailableAt: this.nextReset(request.routeIds),
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

  private nextReset(routeIds: readonly string[]): string | undefined {
    const resets = routeIds.flatMap((routeId) => {
      const route = this.routes.get(routeId);
      if (!route) return [];
      return (this.pools.get(route.capacityPoolId)?.windows ?? route.windows).map((window) => Date.parse(window.resetAt));
    }).filter(Number.isFinite);
    const next = Math.min(...resets);
    return Number.isFinite(next) ? new Date(next).toISOString() : undefined;
  }
}
