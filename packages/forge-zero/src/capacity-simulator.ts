import {
  type CapacityRoute,
  type ScaleScenario,
  type ScaleSimulationResult,
  type TaskDemandProfile,
} from "./capacity-types.js";
import { forecastCapacity } from "./capacity-forecast.js";
import { DEFAULT_FREE_CAPACITY_POLICY, isFreeRouteEligible } from "./capacity-policy.js";

export interface ScaleSimulationInput {
  routes: readonly CapacityRoute[];
  scenarios: readonly ScaleScenario[];
  qualityFloor?: number;
}

function safeRate(success: number, demand: number): number {
  return demand > 0 ? Number((success / demand).toFixed(6)) : 1;
}

function demandForScenario(scenario: ScaleScenario): { total: number; firstRun: number; normal: number; profile: TaskDemandProfile } {
  const total = Math.max(0, Math.floor(scenario.dailyActiveUsers * scenario.tasksPerActiveUser));
  const firstRun = Math.min(total, Math.max(0, scenario.newUsers));
  const normal = total - firstRun;
  const multiplier = 1 + Math.max(0, scenario.heavyUsers ?? 0) * Math.max(0, (scenario.hugeTaskMultiplier ?? 1) - 1) / Math.max(1, scenario.dailyActiveUsers);
  return {
    total: Math.ceil(total * multiplier),
    firstRun: Math.ceil(firstRun * multiplier),
    normal: Math.ceil(normal * multiplier),
    profile: {
      ...scenario.taskDemand,
      requests: Math.max(1, Math.ceil(scenario.taskDemand.requests * multiplier)),
      inputTokens: Math.max(1, Math.ceil(scenario.taskDemand.inputTokens * multiplier)),
      outputTokens: Math.max(0, Math.ceil(scenario.taskDemand.outputTokens * multiplier)),
    },
  };
}

export function simulateScale(input: ScaleSimulationInput): readonly ScaleSimulationResult[] {
  const qualityFloor = input.qualityFloor ?? 60;
  return input.scenarios.map((scenario) => {
    const demand = demandForScenario(scenario);
    const scenarioRoutes = input.routes.map((route) => {
      const failed = (scenario.failedProviders ?? []).includes(route.providerId) || (scenario.failedGateways ?? []).includes(route.gateway);
      const promotionEnded = (scenario.endedPromotions ?? []).includes(route.routeId);
      return failed || promotionEnded ? { ...route, healthy: failed ? false : route.healthy, enabled: promotionEnded ? false : route.enabled } : route;
    });
    const activeRoutes = scenarioRoutes.filter((route) => isFreeRouteEligible(route, DEFAULT_FREE_CAPACITY_POLICY));
    const forecast = forecastCapacity({ routes: scenarioRoutes, taskDemand: demand.profile, now: scenario.now });
    const capacity = forecast.estimatedTaskUnits;
    const firstRunCapacity = Math.min(capacity, Math.max(forecast.firstRunTaskUnits, Math.ceil(capacity * 0.1)));
    const normalCapacity = Math.max(0, capacity - firstRunCapacity);
    const firstRunSuccess = Math.min(demand.firstRun, firstRunCapacity);
    const normalSuccess = Math.min(demand.normal, normalCapacity);
    const failedRouteCount = input.routes.filter((route) => (scenario.failedProviders ?? []).includes(route.providerId) || (scenario.failedGateways ?? []).includes(route.gateway)).length;
    const remainingRouteCount = activeRoutes.length;
    const failoverCoverage = failedRouteCount === 0 ? 1 : safeRate(Math.max(0, remainingRouteCount), Math.max(1, failedRouteCount));
    const totalBlocks = Math.max(0, demand.total - firstRunSuccess - normalSuccess);
    const p95WaitMinutes = totalBlocks === 0 ? 0 : Math.ceil((totalBlocks / Math.max(1, capacity)) * 60);
    const qualityFloorPass = activeRoutes.length > 0 && activeRoutes.every((route) => route.qualityScore >= qualityFloor);
    const alerts = [...forecast.alerts];
    if (totalBlocks > 0) alerts.push(`${totalBlocks} tasks capacity-blocked in ${scenario.id}`);
    if (scenario.registeredUsers > 373) alerts.push("registered-user scale exceeds the 373-user early-access proof population");
    if (failedRouteCount > 0 && remainingRouteCount === 0) alerts.push("no failover route remains");
    return {
      scenarioId: scenario.id,
      registeredUsers: scenario.registeredUsers,
      dailyActiveUsers: scenario.dailyActiveUsers,
      demand: { totalTasks: demand.total, firstRunTasks: demand.firstRun, normalTasks: demand.normal },
      capacity: { totalTasks: capacity, firstRunTasks: firstRunCapacity, normalTasks: normalCapacity },
      outcomes: {
        firstRunSuccessRate: safeRate(firstRunSuccess, demand.firstRun),
        normalSuccessRate: safeRate(normalSuccess, demand.normal),
        capacityBlocks: totalBlocks,
        failoverCoverage: Math.min(1, failoverCoverage),
        p95WaitMinutes,
        qualityFloorPass,
      },
      forecast,
      alerts,
    };
  });
}
