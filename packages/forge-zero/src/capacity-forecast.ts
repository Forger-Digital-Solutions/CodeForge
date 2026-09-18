import {
  type CapacityForecast,
  type CapacityForecastInput,
  type CapacityForecastRoute,
  type CapacityRoute,
  type CapacityWindow,
  type ProviderCapacityPool,
  type TaskDemandProfile,
} from "./capacity-types.js";
import { DEFAULT_FREE_CAPACITY_POLICY, freeRouteExclusionReason, isFreeRouteEligible } from "./capacity-policy.js";

function ratio(value: number, total: number): number {
  return total > 0 ? Number((value / total).toFixed(6)) : 0;
}

function concentration(routes: readonly CapacityRoute[], capacityByRoute: Readonly<Record<string, number>>, key: (route: CapacityRoute) => string): Readonly<Record<string, number>> {
  const totals: Record<string, number> = {};
  let total = 0;
  for (const route of routes) {
    const amount = capacityByRoute[route.routeId] ?? 0;
    const group = key(route);
    totals[group] = (totals[group] ?? 0) + amount;
    total += amount;
  }
  return Object.fromEntries(Object.entries(totals).map(([group, amount]) => [group, ratio(amount, total)]));
}

function windowsForPool(routes: readonly CapacityRoute[], pool: ProviderCapacityPool | undefined): readonly CapacityWindow[] {
  return pool?.windows ?? routes[0]?.windows ?? [];
}

function available(windows: readonly CapacityWindow[], unit: CapacityWindow["unit"]): number | undefined {
  const matching = windows.filter((window) => window.unit === unit);
  return matching.length === 0 ? undefined : Math.max(0, Math.min(...matching.map((window) => window.remaining)));
}

function taskUnits(windows: readonly CapacityWindow[], demand: TaskDemandProfile, multiplier: number): number {
  const requests = available(windows, "requests");
  const input = available(windows, "input_tokens");
  const output = available(windows, "output_tokens");
  const concurrency = available(windows, "concurrency");
  const credits = available(windows, "credits");
  const providerUnits = available(windows, "provider_units");
  const dimensions = [
    requests === undefined ? Number.POSITIVE_INFINITY : Math.floor(requests / Math.max(1, demand.requests)),
    demand.inputTokens <= 0 || input === undefined ? Number.POSITIVE_INFINITY : Math.floor(input / demand.inputTokens),
    demand.outputTokens <= 0 || output === undefined ? Number.POSITIVE_INFINITY : Math.floor(output / demand.outputTokens),
    demand.concurrency === undefined || concurrency === undefined ? Number.POSITIVE_INFINITY : Math.floor(concurrency / Math.max(1, demand.concurrency)),
    demand.credits === undefined || credits === undefined ? Number.POSITIVE_INFINITY : Math.floor(credits / Math.max(1, demand.credits)),
    demand.providerUnits === undefined || providerUnits === undefined ? Number.POSITIVE_INFINITY : Math.floor(providerUnits / Math.max(1, demand.providerUnits)),
  ];
  const result = Math.min(...dimensions);
  return Number.isFinite(result) ? Math.max(0, result) * multiplier : 0;
}

function nextReset(windows: readonly CapacityWindow[], at: number): string | undefined {
  const values = windows.map((window) => Date.parse(window.resetAt)).filter((value) => value > at);
  return values.length > 0 ? new Date(Math.min(...values)).toISOString() : undefined;
}

function poolConcentration(capacityByPool: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  const total = Object.values(capacityByPool).reduce((sum, capacity) => sum + capacity, 0);
  return Object.fromEntries(Object.entries(capacityByPool).map(([poolId, capacity]) => [poolId, ratio(capacity, total)]));
}

/**
 * Forecast from physical quota pools, not a list of model names. Routes in one pool are
 * alternatives: their shared allowance is assigned to one representative for aggregate counting
 * and never summed. Distributed pools scale only when the caller explicitly supplies a user count.
 */
export function forecastCapacity(input: CapacityForecastInput): CapacityForecast {
  const at = input.now ?? Date.now();
  const generatedAt = new Date(at).toISOString();
  const suppliedPools = new Map((input.pools ?? []).map((pool) => [pool.poolId, pool] as const));
  const routeCapacity = new Map<string, CapacityForecastRoute>();
  const eligibleByPool = new Map<string, CapacityRoute[]>();
  const alerts: string[] = [];

  for (const route of input.routes) {
    const exclusionReason = freeRouteExclusionReason(route, DEFAULT_FREE_CAPACITY_POLICY);
    if (!isFreeRouteEligible(route, DEFAULT_FREE_CAPACITY_POLICY)) {
      routeCapacity.set(route.routeId, {
        routeId: route.routeId,
        eligible: false,
        exclusionReason,
        availableRequests: 0,
        availableTokens: 0,
        availableConcurrent: 0,
        availableCredits: 0,
        availableProviderUnits: 0,
        estimatedTaskUnits: 0,
        capacityPoolId: route.capacityPoolId,
        capacityPoolScope: route.capacityPoolScope,
        countedInPool: false,
        concentrationShare: 0,
      });
      continue;
    }
    const pool = suppliedPools.get(route.capacityPoolId);
    if (pool && (pool.providerId !== route.providerId || pool.scope !== route.capacityPoolScope || pool.supplyClass !== route.supplyClass || (pool.capacityIdentity !== undefined && route.capacityIdentity !== undefined && pool.capacityIdentity !== route.capacityIdentity))) {
      routeCapacity.set(route.routeId, {
        routeId: route.routeId,
        eligible: false,
        exclusionReason: "CAPACITY_POOL_IDENTITY_MISMATCH",
        availableRequests: 0,
        availableTokens: 0,
        availableConcurrent: 0,
        availableCredits: 0,
        availableProviderUnits: 0,
        estimatedTaskUnits: 0,
        capacityPoolId: route.capacityPoolId,
        capacityPoolScope: route.capacityPoolScope,
        countedInPool: false,
        concentrationShare: 0,
      });
      continue;
    }
    const entries = eligibleByPool.get(route.capacityPoolId) ?? [];
    entries.push(route);
    eligibleByPool.set(route.capacityPoolId, entries);
  }

  const capacityByRoute: Record<string, number> = {};
  const capacityByPool: Record<string, number> = {};
  const activeUsers = Math.max(1, Math.floor(input.activeUsers ?? 1));
  for (const [poolId, routes] of eligibleByPool) {
    const pool = suppliedPools.get(poolId);
    const scope = pool?.scope ?? routes[0]!.capacityPoolScope;
    const windows = windowsForPool(routes, pool);
    const multiplier = scope === "PER_USER_POOL" ? activeUsers : 1;
    const units = taskUnits(windows, input.taskDemand, multiplier);
    capacityByPool[poolId] = units;
    if (!pool) alerts.push(`${poolId}: physical capacity pool was inferred from a route; capture a provider pool observation before certification`);
    if (scope === "PER_USER_POOL" && input.activeUsers === undefined) alerts.push(`${poolId}: distributed capacity is projected for one user only`);
    if (windows.length === 0) alerts.push(`${poolId}: no capacity windows observed`);
    const representative = [...routes].sort((left, right) => right.qualityScore - left.qualityScore || left.routeId.localeCompare(right.routeId))[0]!;
    const requestCapacity = available(windows, "requests") ?? 0;
    const inputCapacity = available(windows, "input_tokens");
    const outputCapacity = available(windows, "output_tokens");
    const concurrentCapacity = available(windows, "concurrency") ?? 0;
    const creditsCapacity = available(windows, "credits") ?? 0;
    const providerUnitsCapacity = available(windows, "provider_units") ?? 0;
    const tokenCapacity = inputCapacity === undefined && outputCapacity === undefined
      ? Number.MAX_SAFE_INTEGER
      : Math.min(inputCapacity ?? Number.MAX_SAFE_INTEGER, outputCapacity ?? Number.MAX_SAFE_INTEGER);
    const resetAt = nextReset(windows, at);
    for (const route of routes) {
      const countedInPool = route.routeId === representative.routeId;
      capacityByRoute[route.routeId] = countedInPool ? units : 0;
      routeCapacity.set(route.routeId, {
        routeId: route.routeId,
        eligible: true,
        availableRequests: requestCapacity,
        availableTokens: tokenCapacity,
        availableConcurrent: concurrentCapacity,
        availableCredits: creditsCapacity,
        availableProviderUnits: providerUnitsCapacity,
        estimatedTaskUnits: countedInPool ? units : 0,
        capacityPoolId: poolId,
        capacityPoolScope: scope,
        countedInPool,
        ...(resetAt ? { resetAt } : {}),
        concentrationShare: 0,
      });
    }
  }

  const totalUnits = Object.values(capacityByPool).reduce((sum, value) => sum + value, 0);
  const reserveRequests = Math.max(0, input.firstRunReserveRequests ?? 0);
  const reserveTokens = Math.max(0, input.firstRunReserveTokens ?? 0);
  const firstRunTaskUnits = Math.min(
    reserveRequests > 0 ? Math.floor(reserveRequests / Math.max(1, input.taskDemand.requests)) : 0,
    reserveTokens > 0 ? Math.floor(reserveTokens / Math.max(1, input.taskDemand.inputTokens)) : Number.POSITIVE_INFINITY,
  );
  const finiteFirstRun = Number.isFinite(firstRunTaskUnits) ? firstRunTaskUnits : 0;
  const normalTaskUnits = Math.max(0, totalUnits - finiteFirstRun);
  const eligibleRoutes = input.routes.filter((route) => (capacityByRoute[route.routeId] ?? 0) > 0);
  const byProvider = concentration(eligibleRoutes, capacityByRoute, (route) => route.providerId);
  const byGateway = concentration(eligibleRoutes, capacityByRoute, (route) => route.gateway);
  const byFamily = concentration(eligibleRoutes, capacityByRoute, (route) => route.family);
  const byPool = poolConcentration(capacityByPool);
  const maxConcentration = Math.max(0, ...Object.values(byProvider));
  if (maxConcentration > 0.8) alerts.push(`provider concentration ${(maxConcentration * 100).toFixed(1)}% exceeds 80%`);

  const roleScarcity: Record<string, number> = {};
  for (const role of Object.keys(input.taskDemand.roleRequests)) {
    const rolePools = [...eligibleByPool.entries()].filter(([, routes]) => routes.some((route) => route.roles.includes(role)));
    const roleUnits = rolePools.reduce((sum, [poolId]) => sum + (capacityByPool[poolId] ?? 0), 0);
    roleScarcity[role] = ratio(roleUnits, Math.max(1, totalUnits));
    if (rolePools.length === 0) alerts.push(`role ${role} has no eligible route`);
  }
  const routes = input.routes.map((route) => {
    const view = routeCapacity.get(route.routeId) ?? {
      routeId: route.routeId,
      eligible: false,
      exclusionReason: "NO_CAPACITY_ROUTE",
      availableRequests: 0,
      availableTokens: 0,
      availableConcurrent: 0,
      availableCredits: 0,
      availableProviderUnits: 0,
      estimatedTaskUnits: 0,
      capacityPoolId: route.capacityPoolId,
      capacityPoolScope: route.capacityPoolScope,
      countedInPool: false,
      concentrationShare: 0,
    };
    return { ...view, concentrationShare: ratio(view.estimatedTaskUnits, totalUnits) };
  });

  return {
    generatedAt,
    policy: "DETERMINISTIC_HARD_ACCOUNTING",
    routes,
    estimatedTaskUnits: totalUnits,
    firstRunTaskUnits: Math.min(finiteFirstRun, totalUnits),
    normalTaskUnits,
    roleScarcity,
    providerConcentration: byProvider,
    gatewayConcentration: byGateway,
    familyConcentration: byFamily,
    poolConcentration: byPool,
    alerts,
  };
}
