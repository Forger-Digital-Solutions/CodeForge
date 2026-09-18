import type { CapacityRoute, DataPolicyProfile, RouteDataContext, SupplyClass } from "./capacity-types.js";

export type { RouteDataClass, RouteDataContext } from "./capacity-types.js";

export interface FreeCapacityPolicy {
  paidInferenceAllowed: false;
  allowDistributedUserFree: boolean;
  /** Disabled by default: a deposit must never become an invisible product subsidy. */
  allowDepositUnlockedFree: boolean;
}

export const DEFAULT_FREE_CAPACITY_POLICY: FreeCapacityPolicy = {
  paidInferenceAllowed: false,
  allowDistributedUserFree: true,
  allowDepositUnlockedFree: false,
};

export const DEFAULT_PRIVATE_CODE_CONTEXT: RouteDataContext = { dataClass: "PRIVATE_CODE" };

export function isDataPolicyEligible(profile: DataPolicyProfile, context: RouteDataContext = DEFAULT_PRIVATE_CODE_CONTEXT): boolean {
  if (profile === "DISALLOWED") return false;
  if (context.dataClass === "PRIVATE_CODE") return profile === "PRIVATE_CODE_ALLOWED";
  if (context.dataClass === "PUBLIC_CODE" || context.dataClass === "SYNTHETIC") {
    return profile === "PRIVATE_CODE_ALLOWED" || profile === "PUBLIC_CODE_ONLY" || (profile === "USER_CONSENT_REQUIRED" && context.userConsented === true);
  }
  return false;
}

function supplyEligible(route: CapacityRoute, policy: FreeCapacityPolicy): boolean {
  if (route.supplyClass === "PURE_MANAGED_FREE") return route.capacityPoolScope === "SHARED_OWNER_POOL";
  if (route.supplyClass === "DISTRIBUTED_USER_FREE") return policy.allowDistributedUserFree && route.capacityPoolScope === "PER_USER_POOL";
  if (route.supplyClass === "DEPOSIT_UNLOCKED_FREE") return policy.allowDepositUnlockedFree && route.capacityPoolScope === "SHARED_OWNER_POOL";
  return false;
}

/**
 * The final ForgeAuto/Free gate. It is deliberately fail-closed: only an approved, contractually
 * cleared, exact-$0 route with paid fallback disabled can serve a task, and only for data it is
 * allowed to receive.
 */
export function isFreeRouteEligible(
  route: CapacityRoute,
  policy: FreeCapacityPolicy = DEFAULT_FREE_CAPACITY_POLICY,
  dataContext: RouteDataContext = DEFAULT_PRIVATE_CODE_CONTEXT,
): boolean {
  return freeRouteExclusionReason(route, policy, dataContext) === undefined;
}

export function freeRouteExclusionReason(
  route: CapacityRoute,
  policy: FreeCapacityPolicy = DEFAULT_FREE_CAPACITY_POLICY,
  dataContext: RouteDataContext = DEFAULT_PRIVATE_CODE_CONTEXT,
): string | undefined {
  if (!route.enabled) return "DISABLED";
  if (!route.healthy) return "UNHEALTHY";
  if (!route.explicitZeroPrice) return "PRICE_NOT_EXPLICITLY_ZERO";
  if (!route.paidFallbackDisabled) return "PAID_FALLBACK_NOT_DISABLED";
  if (!route.managedMultiUserAllowed) return "MANAGED_MULTI_USER_TERMS_NOT_CLEARED";
  if (route.lifecycle !== "APPROVED") return `LIFECYCLE_${route.lifecycle}`;
  if (route.capacityScope === "UNKNOWN") return "CAPACITY_SCOPE_UNKNOWN";
  if (!isDataPolicyEligible(route.dataPolicyProfile, dataContext)) return `DATA_POLICY_${route.dataPolicyProfile}`;
  if (route.supplyClass === "PAID") return "PAID_INFERENCE_DENIED";
  if (route.supplyClass === "TRIAL_CREDIT") return "TRIAL_CREDIT_NOT_PRODUCT_FREE";
  if (route.supplyClass === "PROMOTIONAL_FREE") return "PROMOTIONAL_FREE_NOT_BASELINE";
  if (route.supplyClass === "OWNER_CREDIT_RESERVE") return "OWNER_CREDIT_RESERVE_NOT_PRODUCT_FREE";
  if (route.supplyClass === "DEPOSIT_UNLOCKED_FREE" && !policy.allowDepositUnlockedFree) return "DEPOSIT_UNLOCKED_FREE_NOT_AUTHORIZED";
  if (route.supplyClass === "DISTRIBUTED_USER_FREE" && !policy.allowDistributedUserFree) return "DISTRIBUTED_USER_FREE_NOT_AUTHORIZED";
  if (!supplyEligible(route, policy)) return "SUPPLY_POOL_SCOPE_INVALID";
  return undefined;
}

/** Whether a supply class is a zero-cash inference class, irrespective of product eligibility. */
export function supplyClassIsZeroCash(source: SupplyClass): boolean {
  return source === "PURE_MANAGED_FREE" || source === "DISTRIBUTED_USER_FREE" || source === "DEPOSIT_UNLOCKED_FREE" || source === "PROMOTIONAL_FREE";
}
