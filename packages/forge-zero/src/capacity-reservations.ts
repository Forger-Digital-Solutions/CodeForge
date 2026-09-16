import {
  type CapacityLedgerOptions,
  type CapacityLedgerSnapshot,
  type CapacityReservation,
  type CapacityReservationDecision,
  type CapacityReservationRequest,
  type CapacityRoute,
} from "./capacity-types.js";
import { freeRouteExclusionReason, isFreeRouteEligible, DEFAULT_FREE_CAPACITY_POLICY } from "./capacity-policy.js";

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

function routeWindow(route: CapacityRoute, unit: "requests" | "tokens") {
  const units = unit === "requests" ? ["requests"] : ["input_tokens", "output_tokens"];
  return route.windows.filter((window) => units.includes(window.unit));
}

export class CapacityReservationLedger {
  private readonly routes: Map<string, CapacityRoute>;
  private readonly reservations = new Map<string, CapacityReservation>();
  private readonly firstRunReserveRequests: number;
  private readonly firstRunReserveTokens: number;
  private readonly maxActiveReservationsPerUser: number;
  private readonly clock: () => number;

  constructor(options: CapacityLedgerOptions) {
    this.routes = new Map(options.routes.map((route) => [route.routeId, route]));
    this.firstRunReserveRequests = Math.max(0, options.firstRunReserveRequests ?? 0);
    this.firstRunReserveTokens = Math.max(0, options.firstRunReserveTokens ?? 0);
    this.maxActiveReservationsPerUser = Math.max(1, options.maxActiveReservationsPerUser ?? 3);
    this.clock = options.now ?? (() => Date.now());
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
    let protectedByFirstRunReserve = false;
    for (const routeId of request.routeIds) {
      const route = this.routes.get(routeId);
      if (!route || !isFreeRouteEligible(route, DEFAULT_FREE_CAPACITY_POLICY) || freeRouteExclusionReason(route)) continue;
      sawEligibleRoute = true;
      const active = [...this.reservations.values()].filter((item) => item.routeId === routeId);
      const activeRequests = active.reduce((sum, item) => sum + item.request.requests, 0);
      const activeTokens = active.reduce((sum, item) => sum + item.request.inputTokens + item.request.outputTokens, 0);
      const requestWindow = routeWindow(route, "requests").sort((a, b) => a.remaining - b.remaining)[0];
      const tokenWindows = routeWindow(route, "tokens");
      const tokenRemaining = tokenWindows.length === 0
        ? 0
        : Math.min(...tokenWindows.map((window) => window.remaining));
      const requestRemaining = requestWindow?.remaining ?? 0;
      const reservedFloorRequests = request.isNewUser ? 0 : this.firstRunReserveRequests;
      const reservedFloorTokens = request.isNewUser ? 0 : this.firstRunReserveTokens;
      const availableRequests = requestRemaining - activeRequests - reservedFloorRequests;
      const availableTokens = tokenRemaining - activeTokens - reservedFloorTokens;
      if (request.requests <= availableRequests && request.inputTokens + request.outputTokens <= availableTokens) {
        this.reservations.set(request.reservationId, { request, routeId, admittedAt: nowIso(this.clock) });
        return { admitted: true, reservationId: request.reservationId, routeId, reason: "ADMITTED" };
      }
      if (!request.isNewUser && (requestRemaining - activeRequests >= request.requests || tokenRemaining - activeTokens >= request.inputTokens + request.outputTokens)) {
        protectedByFirstRunReserve = true;
      }
    }

    if (!sawEligibleRoute) return { admitted: false, reservationId: request.reservationId, reason: "NO_ELIGIBLE_ROUTE" };
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
    for (const reservation of this.reservations.values()) {
      byUser[reservation.request.userId] = (byUser[reservation.request.userId] ?? 0) + 1;
      byRoute[reservation.routeId] = (byRoute[reservation.routeId] ?? 0) + 1;
    }
    return {
      generatedAt: nowIso(this.clock),
      activeReservations: this.reservations.size,
      byUser,
      byRoute,
      protectedFirstRunRequests: this.firstRunReserveRequests,
      protectedFirstRunTokens: this.firstRunReserveTokens,
    };
  }

  private nextReset(routeIds: readonly string[]): string | undefined {
    const resets = routeIds.flatMap((routeId) => this.routes.get(routeId)?.windows.map((window) => Date.parse(window.resetAt)) ?? []).filter(Number.isFinite);
    const next = Math.min(...resets);
    return Number.isFinite(next) ? new Date(next).toISOString() : undefined;
  }
}
