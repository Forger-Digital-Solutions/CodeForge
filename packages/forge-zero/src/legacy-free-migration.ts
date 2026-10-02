import { freeRouteExclusionReason, type FreeCapacityPolicy, DEFAULT_FREE_CAPACITY_POLICY } from "./capacity-policy.js";
import type { CapacityRoute, RouteDataContext, SupplyClass } from "./capacity-types.js";

export type LegacyMigrationState = "MIGRATED_ACTIVE" | "MIGRATED_QUARANTINED" | "REQUIRES_REVERIFY" | "RETIRED";

export interface LegacyMigrationDecision {
  routeId: string;
  from: SupplyClass;
  state: LegacyMigrationState;
  reason: string;
  migrated?: CapacityRoute;
}

/** Produces a new-schema route only from explicit evidence already present on the old route. */
export function migrateLegacyFreeRoute(
  route: CapacityRoute,
  policy: FreeCapacityPolicy = DEFAULT_FREE_CAPACITY_POLICY,
  context: RouteDataContext = { dataClass: "PRIVATE_CODE" },
): LegacyMigrationDecision {
  const from = route.supplyClass;
  const target = from === "PURE_MANAGED_FREE" ? "PACKAGED_FREE_PROVIDER_FUNDED"
    : from === "USER_CONNECTED_FREE" || from === "DISTRIBUTED_USER_FREE" ? "USER_ENTITLED_FREE"
      : undefined;
  if (!target) return { routeId: route.routeId, from, state: "RETIRED", reason: "NO_RECURRING_ZERO_COST_MIGRATION" };
  if (route.marginalCostToCodeForge === undefined) {
    return { routeId: route.routeId, from, state: "REQUIRES_REVERIFY", reason: "MARGINAL_COST_UNKNOWN" };
  }
  if (route.marginalCostToCodeForge !== 0 || !route.explicitZeroPrice || !route.paidFallbackDisabled) {
    return { routeId: route.routeId, from, state: "MIGRATED_QUARANTINED", reason: "ZERO_COST_UNPROVEN" };
  }
  if (!route.quotaDomainType || route.quotaDomainType === "UNKNOWN" || !route.quotaDomainId || !route.egressMode
    || !route.freePrivacyClass || route.freePrivacyClass === "UNKNOWN" || !route.trainingUse || route.trainingUse === "UNKNOWN"
    || !route.admissionReceipt?.termsEvidence || !route.admissionReceipt.privacyEvidence
    || !route.admissionReceipt.priceEvidence || !route.admissionReceipt.qualificationAt) {
    return { routeId: route.routeId, from, state: "REQUIRES_REVERIFY", reason: "NEW_SCHEMA_EVIDENCE_MISSING" };
  }
  const migrated: CapacityRoute = { ...route, supplyClass: target };
  const exclusion = freeRouteExclusionReason(migrated, policy, context);
  return exclusion
    ? { routeId: route.routeId, from, state: "MIGRATED_QUARANTINED", reason: exclusion }
    : { routeId: route.routeId, from, state: "MIGRATED_ACTIVE", reason: "NEW_SCHEMA_GATE_PASSED", migrated };
}
