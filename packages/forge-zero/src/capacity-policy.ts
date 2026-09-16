import type { CapacityRoute, EconomicSource } from "./capacity-types.js";

export interface FreeCapacityPolicy {
  paidInferenceAllowed: false;
  allowCloudCredit: boolean;
  allowSponsored: boolean;
}

export const DEFAULT_FREE_CAPACITY_POLICY: FreeCapacityPolicy = {
  paidInferenceAllowed: false,
  allowCloudCredit: false,
  allowSponsored: true,
};

const RETAIL_ZERO_SOURCES: readonly EconomicSource[] = [
  "RETAIL_FREE",
  "USER_SCALED_FREE",
  "PROMOTIONAL_FREE",
];

export function isFreeRouteEligible(
  route: CapacityRoute,
  policy: FreeCapacityPolicy = DEFAULT_FREE_CAPACITY_POLICY,
): boolean {
  if (!route.enabled || !route.healthy || !route.explicitZeroPrice) return false;
  if (route.capacityScope === "UNKNOWN") return false;
  if (route.capacityClass === "PAID" || route.economicSource === "PAID") return false;
  if (route.economicSource === "CLOUD_CREDIT") return policy.allowCloudCredit;
  if (route.economicSource === "SPONSORED") return policy.allowSponsored;
  return RETAIL_ZERO_SOURCES.includes(route.economicSource);
}

export function freeRouteExclusionReason(
  route: CapacityRoute,
  policy: FreeCapacityPolicy = DEFAULT_FREE_CAPACITY_POLICY,
): string | undefined {
  if (!route.enabled) return "DISABLED";
  if (!route.healthy) return "UNHEALTHY";
  if (!route.explicitZeroPrice) return "PRICE_NOT_EXPLICITLY_ZERO";
  if (route.capacityClass === "PAID" || route.economicSource === "PAID") return "PAID_INFERENCE_DENIED";
  if (route.economicSource === "CLOUD_CREDIT" && !policy.allowCloudCredit) return "CLOUD_CREDIT_NOT_AUTHORIZED";
  if (route.economicSource === "SPONSORED" && !policy.allowSponsored) return "SPONSORED_NOT_AUTHORIZED";
  if (route.capacityScope === "UNKNOWN") return "CAPACITY_SCOPE_UNKNOWN";
  return undefined;
}

export function capacitySourceIsFree(source: EconomicSource): boolean {
  return source !== "PAID";
}
