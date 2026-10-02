import { createHash } from "node:crypto";
import type { CapacityRoute, CapacityScope, QuotaDomainType } from "./capacity-types.js";
import { isFreeRouteEligible, type FreeCapacityPolicy } from "./capacity-policy.js";
import type { RouteDataContext } from "./capacity-types.js";

export interface CapacityIndependence {
  key: string;
  scopeVerified: boolean;
  reason: "VERIFIED_QUOTA_SCOPE" | "CONSERVATIVE_SHARED_SCOPE";
}

const DOMAIN_SCOPES: Partial<Record<QuotaDomainType, readonly CapacityScope[]>> = {
  PUBLIC_IP: ["SOURCE_IP"],
  USER_ACCOUNT: ["ACCOUNT", "USER_ACCOUNT", "END_USER", "ORG"],
  PROVIDER_ACCOUNT: ["ACCOUNT", "ORG"],
  PROVIDER_PROJECT: ["PROJECT", "ACCOUNT", "ORG"],
  SPONSOR_POOL: ["SPONSORED", "ACCOUNT", "ORG"],
  CODEFORGE_ACCOUNT: ["ACCOUNT", "ORG"],
  GLOBAL_SHARED: ["GLOBAL"],
};

export function hashQuotaScope(providerId: string, scope: CapacityScope, ownerIdentity: string): string {
  if (!providerId || !ownerIdentity) throw new Error("Quota scope requires a provider and physical owner");
  return createHash("sha256").update(JSON.stringify([providerId, scope, ownerIdentity])).digest("hex");
}

export function quotaScopeEvidenceExclusionReason(route: CapacityRoute, now = Date.now()): string | undefined {
  const evidence = route.quotaScopeEvidence;
  if (!evidence) return undefined;
  if (!route.quotaDomainType || !DOMAIN_SCOPES[route.quotaDomainType]?.includes(evidence.scope)
    || !/^[a-f0-9]{64}$/.test(evidence.identityHash) || !evidence.source.trim()) return "QUOTA_SCOPE_EVIDENCE_INVALID";
  const verified = Date.parse(evidence.verifiedAt);
  const recheck = Date.parse(evidence.recheckAt);
  if (!Number.isFinite(verified) || verified > now || !Number.isFinite(recheck) || recheck <= now
    || recheck <= verified) return "QUOTA_SCOPE_EVIDENCE_STALE";
  const key = `${route.providerId}:${evidence.scope}:${evidence.identityHash}`;
  if (route.independenceKey !== undefined && route.independenceKey !== key) return "INDEPENDENCE_KEY_MISMATCH";
  return undefined;
}

export function deriveCapacityIndependence(route: CapacityRoute, now = Date.now()): CapacityIndependence {
  const evidence = route.quotaScopeEvidence;
  if (evidence && quotaScopeEvidenceExclusionReason(route, now) === undefined) {
    return { key: `${route.providerId}:${evidence.scope}:${evidence.identityHash}`, scopeVerified: true, reason: "VERIFIED_QUOTA_SCOPE" };
  }
  // An account key, model name, installation or session cannot prove independent quota.
  // Unknown egress scopes are pooled together so NAT users can never inflate capacity.
  return { key: `${route.providerId}:${route.quotaDomainType ?? "UNKNOWN"}:shared-unverified`, scopeVerified: false, reason: "CONSERVATIVE_SHARED_SCOPE" };
}

export function capacityIndependenceKey(route: CapacityRoute, now = Date.now()): string {
  return deriveCapacityIndependence(route, now).key;
}

export function haveIndependentQuotaScopes(a: CapacityRoute, b: CapacityRoute, now = Date.now()): boolean {
  const left = deriveCapacityIndependence(a, now);
  const right = deriveCapacityIndependence(b, now);
  return left.scopeVerified && right.scopeVerified && left.key !== right.key;
}

export interface CapacityIndependenceSnapshot {
  admittedDomains: number;
  independentCapacityGroups: number;
  verifiedIndependentCapacityGroups: number;
  healthyGroups: number;
  unverifiedScopeRoutes: number;
  groups: readonly { key: string; providerId: string; scopeVerified: boolean; routeCount: number; healthy: boolean }[];
}

export function capacityIndependenceSnapshot(
  routes: readonly CapacityRoute[], policy?: FreeCapacityPolicy, dataContext?: RouteDataContext, now = Date.now(),
): CapacityIndependenceSnapshot {
  const admitted = routes.filter((route) => isFreeRouteEligible(route, policy, dataContext, now));
  const groups = new Map<string, { key: string; providerId: string; scopeVerified: boolean; routeCount: number; healthy: boolean }>();
  for (const route of admitted) {
    const independence = deriveCapacityIndependence(route, now);
    const group = groups.get(independence.key) ?? { key: independence.key, providerId: route.providerId, scopeVerified: independence.scopeVerified, routeCount: 0, healthy: false };
    group.routeCount += 1;
    group.healthy ||= route.healthy;
    groups.set(independence.key, group);
  }
  const entries = [...groups.values()];
  return {
    admittedDomains: new Set(admitted.map((route) => route.quotaDomainId ?? route.capacityPoolId)).size,
    independentCapacityGroups: entries.length,
    verifiedIndependentCapacityGroups: entries.filter((group) => group.scopeVerified).length,
    healthyGroups: entries.filter((group) => group.healthy).length,
    unverifiedScopeRoutes: admitted.filter((route) => !deriveCapacityIndependence(route, now).scopeVerified).length,
    groups: entries,
  };
}
