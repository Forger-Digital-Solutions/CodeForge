import {
  type CapacityPreflight,
  type CapacityPreflightInput,
  type TaskDemandProfile,
} from "./capacity-types.js";
import { forecastCapacity } from "./capacity-forecast.js";

function demandFrom(estimate: CapacityPreflightInput["estimate"]): TaskDemandProfile {
  return {
    taskKind: estimate.taskKind,
    requests: Math.max(1, Math.ceil(estimate.expectedModelTurns + estimate.expectedRetryCalls + estimate.expectedVerificationCalls)),
    inputTokens: Math.max(0, Math.ceil(estimate.expectedInputTokens)),
    outputTokens: Math.max(0, Math.ceil(estimate.expectedOutputTokens)),
    ...(estimate.expectedConcurrentRequests !== undefined ? { concurrency: Math.max(1, Math.ceil(estimate.expectedConcurrentRequests)) } : {}),
    ...(estimate.expectedCredits !== undefined ? { credits: Math.max(0, estimate.expectedCredits) } : {}),
    ...(estimate.expectedProviderUnits !== undefined ? { providerUnits: Math.max(0, estimate.expectedProviderUnits) } : {}),
    roleRequests: estimate.roleRequests,
  };
}

function earliestReset(values: readonly (string | undefined)[]): string | undefined {
  const resets = values
    .filter((value): value is string => value !== undefined)
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  if (resets.length === 0) return undefined;
  return new Date(Math.min(...resets)).toISOString();
}

/**
 * Determines whether a task or benchmark has enough currently eligible physical Free capacity to
 * start. It cannot reserve or dispatch work, and never manufactures capacity from model aliases.
 */
export function preflightCapacity(input: CapacityPreflightInput): CapacityPreflight {
  const plannedTasks = Math.max(0, Math.floor(input.plannedTasks));
  const forecast = forecastCapacity({
    routes: input.routes,
    pools: input.pools,
    activeUsers: input.activeUsers,
    taskDemand: demandFrom(input.estimate),
    firstRunReserveRequests: input.firstRunReserveRequests,
    firstRunReserveTokens: input.firstRunReserveTokens,
    now: input.now,
  });
  const eligibleRoutes = input.routes.filter((route) => forecast.routes.find((view) => view.routeId === route.routeId)?.eligible === true);
  const providers = new Set(eligibleRoutes.map((route) => route.providerId));
  const pools = new Set(eligibleRoutes.map((route) => route.capacityPoolId));
  const reasons = [...forecast.alerts];

  if (plannedTasks < 1) reasons.push("PLANNED_TASKS_INVALID");
  if (eligibleRoutes.length === 0) reasons.push("NO_ELIGIBLE_FREE_ROUTE");
  if (forecast.estimatedTaskUnits === 0) reasons.push("NO_SAFE_CAPACITY");
  if (forecast.estimatedTaskUnits < plannedTasks) reasons.push("PLANNED_TASKS_EXCEED_SAFE_CAPACITY");

  const minimumProviders = Math.max(1, Math.floor(input.minimumIndependentProviders ?? 1));
  if (providers.size < minimumProviders) reasons.push("INSUFFICIENT_INDEPENDENT_PROVIDERS");
  const maximumConcentration = Math.min(1, Math.max(0, input.maximumProviderConcentration ?? 1));
  if (Math.max(0, ...Object.values(forecast.providerConcentration)) > maximumConcentration) {
    reasons.push("PROVIDER_CONCENTRATION_TOO_HIGH");
  }

  const insufficient = plannedTasks < 1
    || eligibleRoutes.length === 0
    || forecast.estimatedTaskUnits === 0
    || forecast.estimatedTaskUnits < plannedTasks;
  const risk = !insufficient && (providers.size < minimumProviders
    || Math.max(0, ...Object.values(forecast.providerConcentration)) > maximumConcentration
    || forecast.alerts.length > 0);

  return {
    status: insufficient ? "INSUFFICIENT_CAPACITY" : risk ? "AT_RISK" : "READY",
    plannedTasks,
    safeTaskUnits: forecast.estimatedTaskUnits,
    eligiblePoolCount: pools.size,
    independentProviderCount: providers.size,
    ...(earliestReset(forecast.routes.map((route) => route.resetAt)) ? { nextResetAt: earliestReset(forecast.routes.map((route) => route.resetAt)) } : {}),
    reasons,
    forecast,
  };
}
