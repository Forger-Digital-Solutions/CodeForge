import {
  type CapacityLedgerOptions,
  type CapacityLedgerSnapshot,
  type CapacityReservation,
  type CapacityReservationDecision,
  type CapacityReservationRequest,
  type CapacityRoute,
  type ProviderCapacityPool,
} from "./capacity-types.js";
import { freeRouteExclusionReason, isFreeRouteEligible, DEFAULT_FREE_CAPACITY_POLICY } from "./capacity-policy.js";

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

export class CapacityReservationLedger {
  private readonly routes: Map<string, CapacityRoute>;
  private readonly pools: Map<string, ProviderCapacityPool>;
  private readonly reservations = new Map<string, CapacityReservation>();
  private readonly firstRunReserveRequests: number;
  private readonly firstRunReserveTokens: number;
  private readonly maxActiveReservationsPerUser: number;
  private readonly clock: () => number;
  private readonly dataContext: CapacityLedgerOptions["dataContext"];

  constructor(options: CapacityLedgerOptions) {
    this.routes = new Map(options.routes.map((route) => [route.routeId, route]));
    this.pools = new Map((options.pools ?? []).map((pool) => [pool.poolId, pool]));
    this.firstRunReserveRequests = Math.max(0, options.firstRunReserveRequests ?? 0);
    this.firstRunReserveTokens = Math.max(0, options.firstRunReserveTokens ?? 0);
    this.maxActiveReservationsPerUser = Math.max(1, options.maxActiveReservationsPerUser ?? 3);
    this.clock = options.now ?? (() => Date.now());
    this.dataContext = options.dataContext;
  }

  reserve(request: CapacityReservationRequest): CapacityReservationDecision {
    this.recoverExpired();
    if (request.requests < 1 || request.inputTokens < 0 || request.outputTokens < 0 || request.routeIds.length === 0) {
      return { admitted: false, reservationId: request.reservationId, reason: "INVALID_REQUEST" };
    }
    const activeForUser = [...this.reservations.values()].filter((item) => item.request.userId === request.userId).length;
    if (activeForUser >= this.maxActiveReservationsPerUser) {
      return { admitted: false, reservationId: request.reservationId, reason: "USER_CONCURRENCY_LIMIT" };
    }

    let sawEligibleRoute = false;
    let sawUsablePool = false;
    let protectedByFirstRunReserve = false;
    for (const routeId of request.routeIds) {
      const route = this.routes.get(routeId);
      if (!route || !route.roles.includes(request.role) || !isFreeRouteEligible(route, DEFAULT_FREE_CAPACITY_POLICY, this.dataContext) || freeRouteExclusionReason(route, DEFAULT_FREE_CAPACITY_POLICY, this.dataContext)) continue;
      sawEligibleRoute = true;
      // Two model routes backed by one provider account must contend for the same reservation
      // budget. Distributed pools are deliberately isolated by their natural end user.
      const active = [...this.reservations.values()].filter((item) => {
        const reservedRoute = this.routes.get(item.routeId);
        if (!reservedRoute || reservedRoute.capacityPoolId !== route.capacityPoolId) return false;
        return route.capacityPoolScope === "SHARED_OWNER_POOL" || item.request.userId === request.userId;
      });
      const activeRequests = active.reduce((sum, item) => sum + item.request.requests, 0);
      const activeInputTokens = active.reduce((sum, item) => sum + item.request.inputTokens, 0);
      const activeOutputTokens = active.reduce((sum, item) => sum + item.request.outputTokens, 0);
      const physicalRoute = this.pools.get(route.capacityPoolId);
      if (physicalRoute && (physicalRoute.providerId !== route.providerId
        || physicalRoute.scope !== route.capacityPoolScope
        || physicalRoute.supplyClass !== route.supplyClass)) {
        continue;
      }
      sawUsablePool = true;
      const windows = physicalRoute?.windows ?? route.windows;
      const requestWindow = windows.filter((window) => window.unit === "requests").sort((a, b) => a.remaining - b.remaining)[0];
      const inputWindows = windows.filter((window) => window.unit === "input_tokens");
      const outputWindows = windows.filter((window) => window.unit === "output_tokens");
      const concurrencyWindows = windows.filter((window) => window.unit === "concurrency");
      const inputRemaining = inputWindows.length === 0
        ? 0
        : Math.min(...inputWindows.map((window) => window.remaining));
      // A provider that reports one undifferentiated token window can still serve output; use
      // the input window as the conservative shared ceiling until a separate output header exists.
      const outputRemaining = outputWindows.length === 0 ? inputRemaining : Math.min(...outputWindows.map((window) => window.remaining));
      const concurrencyRemaining = concurrencyWindows.length === 0 ? undefined : Math.min(...concurrencyWindows.map((window) => window.remaining));
      const requestRemaining = requestWindow?.remaining ?? 0;
      const reservedFloorRequests = request.isNewUser ? 0 : this.firstRunReserveRequests;
      const reservedFloorTokens = request.isNewUser ? 0 : this.firstRunReserveTokens;
      const availableRequests = requestRemaining - activeRequests - reservedFloorRequests;
      const availableInputTokens = inputRemaining - activeInputTokens - reservedFloorTokens;
      const availableOutputTokens = outputRemaining - activeOutputTokens - reservedFloorTokens;
      const availableConcurrency = concurrencyRemaining === undefined ? undefined : concurrencyRemaining - active.length;
      if (request.requests <= availableRequests
        && request.inputTokens <= availableInputTokens
        && request.outputTokens <= availableOutputTokens
        && (availableConcurrency === undefined || availableConcurrency >= 1)) {
        this.reservations.set(request.reservationId, { request, routeId, admittedAt: nowIso(this.clock) });
        return { admitted: true, reservationId: request.reservationId, routeId, reason: "ADMITTED" };
      }
      if (!request.isNewUser
        && (this.firstRunReserveRequests > 0 || this.firstRunReserveTokens > 0)
        && requestRemaining - activeRequests >= request.requests
        && inputRemaining - activeInputTokens >= request.inputTokens
        && outputRemaining - activeOutputTokens >= request.outputTokens) {
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
    return this.reservations.delete(reservationId);
  }

  recoverExpired(at = this.clock()): number {
    let removed = 0;
    for (const [id, reservation] of this.reservations) {
      if (Date.parse(reservation.request.leaseUntil) <= at) {
        this.reservations.delete(id);
        removed++;
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
      const route = this.routes.get(reservation.routeId);
      if (route) byPool[route.capacityPoolId] = (byPool[route.capacityPoolId] ?? 0) + 1;
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
