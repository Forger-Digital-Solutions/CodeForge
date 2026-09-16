import {
  type CapacityForecast,
  type CapacityForecastInput,
  type CapacityForecastRoute,
  type CapacityRoute,
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

export function forecastCapacity(input: CapacityForecastInput): CapacityForecast {
  const at = input.now ?? Date.now();
  const generatedAt = new Date(at).toISOString();
  const eligibleRoutes = input.routes.filter((route) => isFreeRouteEligible(route, DEFAULT_FREE_CAPACITY_POLICY));
  const routeCapacity: CapacityForecastRoute[] = [];
  const capacityByRoute: Record<string, number> = {};
  const alerts: string[] = [];
  for (const route of input.routes) {
    const exclusionReason = freeRouteExclusionReason(route, DEFAULT_FREE_CAPACITY_POLICY);
    if (!isFreeRouteEligible(route, DEFAULT_FREE_CAPACITY_POLICY)) {
      routeCapacity.push({ routeId: route.routeId, eligible: false, exclusionReason, availableRequests: 0, availableTokens: 0, estimatedTaskUnits: 0, concentrationShare: 0 });
      if (exclusionReason === "PAID_INFERENCE_DENIED") alerts.push(`${route.routeId}: paid inference excluded`);
      continue;
    }
    const requestWindows = route.windows.filter((window) => window.unit === "requests");
    const tokenWindows = route.windows.filter((window) => window.unit === "input_tokens" || window.unit === "output_tokens");
    const availableRequests = requestWindows.length === 0 ? 0 : Math.max(0, Math.min(...requestWindows.map((window) => window.remaining)));
    const availableTokens = tokenWindows.length === 0 ? Number.MAX_SAFE_INTEGER : Math.max(0, Math.min(...tokenWindows.map((window) => window.remaining)));
    const taskUnits = Math.min(
      input.taskDemand.requests > 0 ? Math.floor(availableRequests / input.taskDemand.requests) : Number.POSITIVE_INFINITY,
      input.taskDemand.inputTokens > 0 ? Math.floor(availableTokens / input.taskDemand.inputTokens) : Number.POSITIVE_INFINITY,
    );
    const finiteTaskUnits = Number.isFinite(taskUnits) ? taskUnits : 0;
    capacityByRoute[route.routeId] = finiteTaskUnits;
    const resetValues = route.windows.map((window) => Date.parse(window.resetAt)).filter((value) => value > at);
    routeCapacity.push({
      routeId: route.routeId,
      eligible: true,
      availableRequests,
      availableTokens,
      estimatedTaskUnits: finiteTaskUnits,
      ...(resetValues.length > 0 ? { resetAt: new Date(Math.min(...resetValues)).toISOString() } : {}),
      concentrationShare: 0,
    });
    if (route.capacityScope === "UNKNOWN") alerts.push(`${route.routeId}: capacity scope is unknown`);
    if (tokenWindows.length === 0) alerts.push(`${route.routeId}: token capacity is not observed; request window is the only counted limit`);
  }
  const totalUnits = Object.values(capacityByRoute).reduce((sum, value) => sum + value, 0);
  const reserveRequests = Math.max(0, input.firstRunReserveRequests ?? 0);
  const reserveTokens = Math.max(0, input.firstRunReserveTokens ?? 0);
  const firstRunTaskUnits = Math.min(
    reserveRequests > 0 ? Math.floor(reserveRequests / input.taskDemand.requests) : 0,
    reserveTokens > 0 ? Math.floor(reserveTokens / Math.max(1, input.taskDemand.inputTokens)) : Number.POSITIVE_INFINITY,
  );
  const finiteFirstRun = Number.isFinite(firstRunTaskUnits) ? firstRunTaskUnits : 0;
  const normalTaskUnits = Math.max(0, totalUnits - finiteFirstRun);
  const byProvider = concentration(eligibleRoutes, capacityByRoute, (route) => route.providerId);
  const byGateway = concentration(eligibleRoutes, capacityByRoute, (route) => route.gateway);
  const byFamily = concentration(eligibleRoutes, capacityByRoute, (route) => route.family);
  const maxConcentration = Math.max(0, ...Object.values(byProvider));
  if (maxConcentration > 0.8) alerts.push(`provider concentration ${(maxConcentration * 100).toFixed(1)}% exceeds 80%`);
  const roleScarcity: Record<string, number> = {};
  for (const role of Object.keys(input.taskDemand.roleRequests)) {
    const roleCapable = eligibleRoutes.filter((route) => route.roles.includes(role));
    const roleUnits = roleCapable.reduce((sum, route) => sum + (capacityByRoute[route.routeId] ?? 0), 0);
    roleScarcity[role] = ratio(roleUnits, Math.max(1, totalUnits));
    if (roleCapable.length === 0) alerts.push(`role ${role} has no eligible route`);
  }
  const routeWithShares = routeCapacity.map((route) => ({ ...route, concentrationShare: ratio(route.estimatedTaskUnits, totalUnits) }));
  return {
    generatedAt,
    policy: "DETERMINISTIC_HARD_ACCOUNTING",
    routes: routeWithShares,
    estimatedTaskUnits: totalUnits,
    firstRunTaskUnits: Math.min(finiteFirstRun, totalUnits),
    normalTaskUnits,
    roleScarcity,
    providerConcentration: byProvider,
    gatewayConcentration: byGateway,
    familyConcentration: byFamily,
    alerts,
  };
}
