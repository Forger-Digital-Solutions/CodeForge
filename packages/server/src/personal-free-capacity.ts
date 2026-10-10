import type { CapacityRoute, ProviderCapacityPool } from "@codeforge/forge-zero";
import type { RosterCandidate } from "./forgeauto-roster.js";
import type { PersonalAccountAuthority } from "./personal-account-policy.js";

export function projectPersonalFreeCapacity(
  ownerUserId: string,
  candidates: readonly RosterCandidate[],
  authorityFor: (ownerUserId: string, connectionId: string) => PersonalAccountAuthority | undefined,
  now = Date.now(),
): { routes: CapacityRoute[]; pools: ProviderCapacityPool[]; identities: string[] } {
  const routes: CapacityRoute[] = [];
  const pools = new Map<string, ProviderCapacityPool>();
  const identities = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.ownerUserId !== ownerUserId || !candidate.personalConnectionId || candidate.personalAdmission !== "FREE_VERIFIED" || !candidate.available || !candidate.approved) continue;
    const authority = authorityFor(ownerUserId, candidate.personalConnectionId);
    if (!authority || authority.ownerUserId !== ownerUserId || authority.connectionId !== candidate.personalConnectionId || !authority.enabled || authority.authState !== "ok"
      || authority.accountClass !== "FREE_VERIFIED" || !authority.freeAdmissionVerified || !authority.quotaScopeVerified || !authority.accountIdentityHash || !authority.admissionEvidence || !authority.quotaScopeEvidence) continue;
    if (!Number.isFinite(Date.parse(authority.recheckAt ?? "")) || Date.parse(authority.recheckAt!) <= now
      || !Number.isFinite(Date.parse(candidate.qualificationAt ?? "")) || Date.parse(candidate.qualificationAt!) > now || now - Date.parse(candidate.qualificationAt!) >= 30 * 86_400_000) continue;
    const windows = authority.capacityWindows?.filter(window => window.authoritative && Number.isFinite(window.limit) && Number.isFinite(window.remaining)
      && window.limit > 0 && window.remaining >= 0 && window.remaining <= window.limit && Date.parse(window.observedAt) <= now && Date.parse(window.resetAt) > now);
    if (!windows?.some(window => window.unit === "requests")) continue;
    const independenceKey = `${authority.providerId}:${authority.quotaScopeEvidence.scope}:${authority.quotaScopeEvidence.identityHash}`;
    const poolId = `personal:${independenceKey}`;
    const prior = pools.get(poolId);
    // Two credentials observing the same physical quota cannot sum their remaining counters.
    const sharedWindows = [...(prior?.windows ?? [])];
    for (const window of windows) {
      const index = sharedWindows.findIndex(item => item.unit === window.unit && item.period === window.period && item.scope === window.scope);
      const other = sharedWindows[index];
      const merged = other ? { ...window, limit: Math.min(window.limit, other.limit), remaining: Math.min(window.remaining, other.remaining),
        resetAt: Date.parse(other.resetAt) > Date.parse(window.resetAt) ? other.resetAt : window.resetAt } : window;
      if (index >= 0) sharedWindows[index] = merged;
      else sharedWindows.push(merged);
    }
    pools.set(poolId, { poolId, providerId: authority.providerId, scope: "PER_USER_POOL", supplyClass: "USER_ENTITLED_FREE", windows: sharedWindows,
      observedAt: authority.verifiedAt!, authoritative: true, capacityIdentity: authority.accountIdentityHash, independenceKey, quotaScopeEvidence: authority.quotaScopeEvidence });
    identities.add(authority.accountIdentityHash);
    const roleMap: Record<string, string> = { CODER: "PRIMARY_CODING_AGENT", EXPLORER: "SUBAGENT", TESTER: "SUBAGENT", PLANNER: "PLANNER", REVIEWER: "REVIEWER", LEAD: "FAST_REASONER" };
    routes.push({ routeId: `${candidate.providerId}:${candidate.providerModelId}`, providerId: candidate.providerId, modelId: candidate.providerModelId,
      quotaProviderId: authority.providerId,
      canonicalModelId: candidate.modelId, family: candidate.familyId, gateway: authority.providerId, upstreamProvider: authority.providerId,
      supplyClass: "USER_ENTITLED_FREE", quotaDomainType: "USER_ACCOUNT", quotaDomainId: independenceKey, independenceKey, quotaScopeEvidence: authority.quotaScopeEvidence,
      egressMode: "USER_DELEGATED", marginalCostToCodeForge: 0, freePrivacyClass: "PROVIDER_RETENTION", trainingUse: "YES",
      admissionReceipt: { ...authority.admissionEvidence, qualificationAt: candidate.qualificationAt! },
      capacityPoolId: poolId, capacityPoolScope: "PER_USER_POOL", capacityScope: "USER_ACCOUNT", capacityIdentity: authority.accountIdentityHash,
      dataPolicyProfile: candidate.dataPolicy.privateCode ? candidate.dataPolicy.userConsentRequired ? "USER_CONSENT_REQUIRED" : "PRIVATE_CODE_ALLOWED" : "PUBLIC_CODE_ONLY",
      lifecycle: "APPROVED", explicitZeroPrice: true, freeOnlyAdmissionProven: true, paidFallbackDisabled: true, managedMultiUserAllowed: authority.providerId === "openrouter" && authority.admissionEvidence.sourceDocumentation === "https://openrouter.ai/docs/guides/overview/auth/oauth",
      privacyClass: "permissive", roles: [...new Set(candidate.qualifiedRoles.map(role => roleMap[role]).filter((role): role is string => !!role))],
      qualityScore: candidate.personalPreference === "PREFERRED" ? 10 : candidate.personalPreference === "FALLBACK" ? -10 : 0, healthy: true, enabled: true, windows: sharedWindows });
  }
  for (const route of routes) route.windows = pools.get(route.capacityPoolId!)!.windows;
  return { routes, pools: [...pools.values()], identities: [...identities] };
}
