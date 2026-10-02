import type { CapacityRoute, DataPolicyProfile, RouteDataContext, SupplyClass } from "./capacity-types.js";
import { quotaScopeEvidenceExclusionReason } from "./capacity-independence.js";

export type { RouteDataClass, RouteDataContext } from "./capacity-types.js";

export interface FreeCapacityPolicy {
  paidInferenceAllowed: false;
  /** User-connected accounts are opt-in and must pass a provider-specific free-only guard. */
  allowUserConnectedFree: boolean;
  allowDistributedUserFree: boolean;
  /** Disabled by default: a deposit must never become an invisible product subsidy. */
  allowDepositUnlockedFree: boolean;
  /**
   * Sponsor-funded recurring capacity is admitted only when explicitly enabled: it is $0 to the
   * user but not zero-cost, so it must never be mistaken for baseline free supply.
   */
  allowSponsoredFree: boolean;
}

export const DEFAULT_FREE_CAPACITY_POLICY: FreeCapacityPolicy = {
  paidInferenceAllowed: false,
  allowUserConnectedFree: true,
  allowDistributedUserFree: true,
  allowDepositUnlockedFree: false,
  allowSponsoredFree: false,
};

export const DEFAULT_PRIVATE_CODE_CONTEXT: RouteDataContext = { dataClass: "PRIVATE_CODE" };

export function isDataPolicyEligible(profile: DataPolicyProfile, context: RouteDataContext = DEFAULT_PRIVATE_CODE_CONTEXT): boolean {
  if (profile === "DISALLOWED") return false;
  if (context.dataClass === "PRIVATE_CODE") return profile === "PRIVATE_CODE_ALLOWED" || (profile === "USER_CONSENT_REQUIRED" && context.userConsented === true);
  if (context.dataClass === "PUBLIC_CODE" || context.dataClass === "SYNTHETIC") {
    return profile === "PRIVATE_CODE_ALLOWED" || profile === "PUBLIC_CODE_ONLY" || (profile === "USER_CONSENT_REQUIRED" && context.userConsented === true);
  }
  return false;
}

function supplyEligible(route: CapacityRoute, policy: FreeCapacityPolicy): boolean {
  if (route.supplyClass === "PACKAGED_FREE_PROVIDER_FUNDED") return route.capacityPoolScope === "SHARED_OWNER_POOL";
  if (route.supplyClass === "PACKAGED_FREE_DIRECT") return route.capacityPoolScope === "PER_USER_POOL";
  if (route.supplyClass === "PACKAGED_FREE_SPONSORED") return policy.allowSponsoredFree && route.capacityPoolScope === "SHARED_OWNER_POOL";
  if (route.supplyClass === "USER_ENTITLED_FREE") return policy.allowUserConnectedFree && route.capacityPoolScope === "PER_USER_POOL" && route.freeOnlyAdmissionProven === true;
  if (route.supplyClass === "PURE_MANAGED_FREE") return route.capacityPoolScope === "SHARED_OWNER_POOL";
  if (route.supplyClass === "USER_CONNECTED_FREE") return policy.allowUserConnectedFree && route.capacityPoolScope === "PER_USER_POOL";
  if (route.supplyClass === "COMMUNITY_ANONYMOUS_FREE") return route.capacityPoolScope === "SHARED_OWNER_POOL";
  if (route.supplyClass === "DISTRIBUTED_USER_FREE") return policy.allowDistributedUserFree && route.capacityPoolScope === "PER_USER_POOL";
  if (route.supplyClass === "DEPOSIT_UNLOCKED_FREE") return policy.allowDepositUnlockedFree && route.capacityPoolScope === "SHARED_OWNER_POOL";
  if (route.supplyClass === "SPONSORED_FREE") return policy.allowSponsoredFree && route.capacityPoolScope === "SHARED_OWNER_POOL";
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
  now = Date.now(),
): boolean {
  return freeRouteExclusionReason(route, policy, dataContext, now) === undefined;
}

export function freeRouteExclusionReason(
  route: CapacityRoute,
  policy: FreeCapacityPolicy = DEFAULT_FREE_CAPACITY_POLICY,
  dataContext: RouteDataContext = DEFAULT_PRIVATE_CODE_CONTEXT,
  now = Date.now(),
): string | undefined {
  const scopeExclusion = quotaScopeEvidenceExclusionReason(route, now);
  if (scopeExclusion) return scopeExclusion;
  const newSupply = route.supplyClass === "PACKAGED_FREE_PROVIDER_FUNDED" || route.supplyClass === "PACKAGED_FREE_DIRECT"
    || route.supplyClass === "PACKAGED_FREE_SPONSORED" || route.supplyClass === "USER_ENTITLED_FREE"
    || route.supplyClass === "COMMUNITY_ANONYMOUS_FREE";
  if (newSupply) {
    if (route.marginalCostToCodeForge !== 0) return "CODEFORGE_MARGINAL_COST_NOT_ZERO";
    if (route.quotaDomainType === undefined || route.quotaDomainType === "UNKNOWN" || !route.quotaDomainId) return "QUOTA_DOMAIN_UNVERIFIED";
    if (route.egressMode === undefined) return "EGRESS_MODE_UNVERIFIED";
    if (route.supplyClass === "PACKAGED_FREE_DIRECT" && (route.egressMode !== "CLIENT_DIRECT" || route.quotaDomainType !== "PUBLIC_IP")) return "DIRECT_ROUTE_SCOPE_INVALID";
    // Anonymous community capacity is one global pool: per-user or project-scoped claims are
    // fabricated ownership, and relayed egress would silently centralize a shared resource.
    if (route.supplyClass === "COMMUNITY_ANONYMOUS_FREE" && (route.egressMode !== "CLIENT_DIRECT" || route.quotaDomainType !== "GLOBAL_SHARED")) return "COMMUNITY_ROUTE_SCOPE_INVALID";
    if (route.freePrivacyClass === undefined || route.freePrivacyClass === "UNKNOWN" || route.trainingUse === undefined || route.trainingUse === "UNKNOWN") return "PRIVACY_UNVERIFIED";
    if (route.freePrivacyClass === "PRIVATE_SAFE" && route.trainingUse !== "NO") return "PRIVACY_EVIDENCE_INCONSISTENT";
    if (route.freePrivacyClass !== "PRIVATE_SAFE" && dataContext.dataClass === "PRIVATE_CODE" && dataContext.userConsented !== true) return "PRIVATE_CODE_CONSENT_REQUIRED";
    const receipt = route.admissionReceipt;
    if (!receipt || !receipt.sourceDocumentation || !receipt.termsEvidence || !receipt.priceEvidence || !receipt.privacyEvidence || !receipt.qualificationAt) return "ADMISSION_RECEIPT_MISSING";
    if (!Number.isFinite(Date.parse(receipt.verifiedAt)) || Date.parse(receipt.verifiedAt) > now
      || !Number.isFinite(Date.parse(receipt.qualificationAt)) || Date.parse(receipt.qualificationAt) > now
      || !Number.isFinite(Date.parse(receipt.recheckAt)) || Date.parse(receipt.recheckAt) <= now) return "ADMISSION_EVIDENCE_STALE";
    for (const expiry of [receipt.termsExpiresAt, receipt.privacyExpiresAt, receipt.priceExpiresAt]) {
      if (expiry !== undefined && (!Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= now)) return "ADMISSION_EVIDENCE_STALE";
    }
    if (route.startsAt && (!Number.isFinite(Date.parse(route.startsAt)) || Date.parse(route.startsAt) > now)) return "ROUTE_NOT_STARTED";
    if (route.expiresAt && (!Number.isFinite(Date.parse(route.expiresAt)) || Date.parse(route.expiresAt) <= now)) return "ROUTE_EXPIRED";
  }
  if (route.supplyClass === "PROMOTIONAL_CODEFORGE_FUNDED" || route.supplyClass === "CODEFORGE_PAID" || route.supplyClass === "BYOK_PAID") return "PAID_OR_PROMOTIONAL_NOT_PACKAGED_FREE";
  if (!route.enabled) return "DISABLED";
  if (!route.healthy) return "UNHEALTHY";
  if (!route.explicitZeroPrice && !((route.supplyClass === "USER_CONNECTED_FREE" || route.supplyClass === "USER_ENTITLED_FREE") && route.freeOnlyAdmissionProven === true)) return "PRICE_NOT_EXPLICITLY_ZERO";
  if (!route.paidFallbackDisabled) return "PAID_FALLBACK_NOT_DISABLED";
  if (!route.managedMultiUserAllowed) return "MANAGED_MULTI_USER_TERMS_NOT_CLEARED";
  if (route.lifecycle !== "APPROVED") return `LIFECYCLE_${route.lifecycle}`;
  if (route.capacityScope === "UNKNOWN") return "CAPACITY_SCOPE_UNKNOWN";
  if (!isDataPolicyEligible(route.dataPolicyProfile, dataContext)) return `DATA_POLICY_${route.dataPolicyProfile}`;
  if (route.supplyClass === "PAID") return "PAID_INFERENCE_DENIED";
  if (route.supplyClass === "TRIAL_CREDIT") return "TRIAL_CREDIT_NOT_PRODUCT_FREE";
  if (route.supplyClass === "PROMOTIONAL_FREE") return "PROMOTIONAL_FREE_NOT_BASELINE";
  if (route.supplyClass === "OWNER_DEV_FREE") return "OWNER_DEV_FREE_NOT_PRODUCT_FREE";
  if (route.supplyClass === "OWNER_CREDIT_RESERVE") return "OWNER_CREDIT_RESERVE_NOT_PRODUCT_FREE";
  if (route.supplyClass === "DEPOSIT_UNLOCKED_FREE" && !policy.allowDepositUnlockedFree) return "DEPOSIT_UNLOCKED_FREE_NOT_AUTHORIZED";
  if (route.supplyClass === "SPONSORED_FREE" && !policy.allowSponsoredFree) return "SPONSORED_FREE_NOT_AUTHORIZED";
  if (route.supplyClass === "DISTRIBUTED_USER_FREE" && !policy.allowDistributedUserFree) return "DISTRIBUTED_USER_FREE_NOT_AUTHORIZED";
  if (route.supplyClass === "USER_CONNECTED_FREE" && !policy.allowUserConnectedFree) return "USER_CONNECTED_FREE_NOT_AUTHORIZED";
  if (route.supplyClass === "USER_CONNECTED_FREE" && route.freeOnlyAdmissionProven !== true) return "USER_CONNECTED_FREE_ONLY_GUARD_NOT_PROVEN";
  if (!supplyEligible(route, policy)) return "SUPPLY_POOL_SCOPE_INVALID";
  return undefined;
}

/** Whether a supply class is a zero-cash inference class, irrespective of product eligibility. */
export function supplyClassIsZeroCash(source: SupplyClass): boolean {
  // SPONSORED_FREE is deliberately absent: a sponsor pays real money upstream, so the class is
  // $0 to the user but not zero-cash. Eligibility is governed by allowSponsoredFree instead.
  return source === "PACKAGED_FREE_PROVIDER_FUNDED" || source === "PACKAGED_FREE_DIRECT" || source === "USER_ENTITLED_FREE" || source === "PACKAGED_FREE_SPONSORED" || source === "PURE_MANAGED_FREE" || source === "USER_CONNECTED_FREE" || source === "COMMUNITY_ANONYMOUS_FREE" || source === "DISTRIBUTED_USER_FREE" || source === "DEPOSIT_UNLOCKED_FREE" || source === "PROMOTIONAL_FREE" || source === "OWNER_DEV_FREE";
}
