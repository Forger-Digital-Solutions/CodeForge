import { describe, expect, it } from "vitest";
import { CapacityReservationLedger, ForgeZero, createGenericFreeRecord, deriveCapacityIndependence, freeRouteExclusionReason, type CapacityWindow } from "@codeforge/forge-zero";
import { createFreeFabric } from "@codeforge/eight-bit";
import type { RosterCandidate } from "../src/forgeauto-roster.js";
import type { PersonalAccountAuthority } from "../src/personal-account-policy.js";
import { projectPersonalFreeCapacity } from "../src/personal-free-capacity.js";

const NOW = Date.now();
const AT = new Date(NOW - 60_000).toISOString();
const UNTIL = new Date(NOW + 3_600_000).toISOString();
const IDENTITY = "a".repeat(64);
const window = (remaining = 50, extra: Partial<CapacityWindow> = {}): CapacityWindow => ({ unit: "requests", limit: 50, remaining, resetAt: UNTIL, scope: "USER_ACCOUNT", observedAt: AT, authoritative: true, period: "DAILY_RESET", ...extra });
const candidate = (connectionId = "conn-a", extra: Partial<RosterCandidate> = {}): RosterCandidate => ({ modelId: `personal-${connectionId}-model`, providerId: `user-api-${connectionId}`, providerModelId: "model-a", familyId: "fixture", version: "1", sourceClass: "USER_API", lifecycle: "QUALIFIED", available: true, approved: true, qualifiedRoles: ["CODER", "REVIEWER"], ownerUserId: "alice", personalConnectionId: connectionId, personalAdmission: "FREE_VERIFIED", qualificationAt: AT, dataPolicy: { privateCode: true, userConsentRequired: true }, ...extra });
const account = (connectionId = "conn-a", extra: Partial<PersonalAccountAuthority> = {}): PersonalAccountAuthority => ({ ownerUserId: "alice", connectionId, providerId: "openrouter", credentialRef: connectionId, accountClass: "FREE_VERIFIED", accountIdentityHash: IDENTITY, quotaDomainId: `openrouter:USER_ACCOUNT:${IDENTITY}`, quotaScopeVerified: true, enabled: true, paidSpendingEnabled: false, authState: "ok", verifiedAt: AT, recheckAt: UNTIL, freeAdmissionVerified: true, admissionEvidence: { sourceDocumentation: "https://openrouter.ai/docs/guides/overview/auth/oauth", termsEvidence: "https://openrouter.ai/terms", privacyEvidence: "https://openrouter.ai/privacy", priceEvidence: "https://openrouter.ai/api/v1/models", verifiedAt: AT, recheckAt: UNTIL }, capacityWindows: [window()], quotaScopeEvidence: { scope: "USER_ACCOUNT", identityHash: IDENTITY, source: "https://openrouter.ai/api/v1/key", verifiedAt: AT, recheckAt: UNTIL }, ...extra });
const projection = (candidates: readonly RosterCandidate[], accounts: readonly PersonalAccountAuthority[], owner = "alice") => projectPersonalFreeCapacity(owner, candidates, (user, id) => accounts.find(item => item.ownerUserId === user && item.connectionId === id), NOW);

describe("personal Free capacity uses the production FreeFabric and ForgeZero gates", () => {
  it("admits a measured, owner-bound, consented personal route with a real reservation", () => {
    const projected = projection([candidate()], [account()]);
    expect(projected.routes).toHaveLength(1);
    const route = projected.routes[0]!;
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: route.providerId, modelId: route.modelId, displayName: "Fixture" }));
    expect(firewall.verify(route.providerId, route.modelId).ok).toBe(true);
    expect(freeRouteExclusionReason(route, undefined, { dataClass: "PUBLIC_CODE", userConsented: true }, NOW)).toBeUndefined();
    expect(deriveCapacityIndependence(route, NOW)).toMatchObject({ key: `openrouter:USER_ACCOUNT:${IDENTITY}`, scopeVerified: true });
    const fabric = createFreeFabric({ managedRoutes: () => [], managedPools: () => [], userSources: [{ routesForUser: user => user === "alice" ? projected.routes : [], poolsForUser: user => user === "alice" ? projected.pools : [] }], reservations: new CapacityReservationLedger({ routes: [], pools: [], now: () => NOW }), now: () => NOW });
    const decision = fabric.decide({ requestId: "task-a", userId: "alice", userIdentities: projected.identities, role: "REVIEWER", dataContext: { dataClass: "PUBLIC_CODE", userConsented: true }, demand: { requests: 1, inputTokens: 1, outputTokens: 1 } });
    expect(decision.outcome, JSON.stringify(decision.explanation)).toBe("ADMITTED");
    expect(decision.selected?.reservationId).toBeTruthy();
    expect(decision.selected?.independenceKey).toBe(`openrouter:USER_ACCOUNT:${IDENTITY}`);
  });

  it("keeps owner scope, provider terms, consent and role qualification authoritative", () => {
    expect(projection([candidate()], [account()], "bob").routes).toEqual([]);
    const route = projection([candidate()], [account()]).routes[0]!;
    expect(freeRouteExclusionReason(route, undefined, { dataClass: "PRIVATE_CODE" }, NOW)).toBe("PRIVATE_CODE_CONSENT_REQUIRED");
    expect(freeRouteExclusionReason(route, undefined, { dataClass: "PUBLIC_CODE" }, NOW)).toBe("DATA_POLICY_USER_CONSENT_REQUIRED");
    const unresolvedTerms = projection([candidate()], [account("conn-a", { admissionEvidence: { ...account().admissionEvidence!, sourceDocumentation: "https://unverified.example/authorization" } })]).routes[0]!;
    expect(freeRouteExclusionReason(unresolvedTerms, undefined, { dataClass: "PUBLIC_CODE", userConsented: true }, NOW)).toBe("MANAGED_MULTI_USER_TERMS_NOT_CLEARED");
    const projected = projection([candidate("conn-a", { qualifiedRoles: ["CODER"] })], [account()]);
    const fabric = createFreeFabric({ managedRoutes: () => [], userSources: [{ routesForUser: () => projected.routes, poolsForUser: () => projected.pools }], now: () => NOW });
    expect(fabric.decide({ requestId: "review", userId: "alice", userIdentities: projected.identities, role: "REVIEWER", dataContext: { dataClass: "PUBLIC_CODE", userConsented: true } }).outcome).toBe("DENIED_NO_SUPPLY");
    expect(fabric.decide({ requestId: "foreign", userId: "bob", userIdentities: [], role: "PRIMARY_CODING_AGENT", dataContext: { dataClass: "PUBLIC_CODE", userConsented: true } }).outcome).toBe("DENIED_NO_SUPPLY");
  });

  it("rejects unavailable, unapproved, paid, stale, future and uncertified candidates", () => {
    for (const patch of [{ available: false }, { approved: false }, { personalAdmission: "PAID_AUTHORIZED" as const }, { qualificationAt: new Date(NOW + 1).toISOString() }, { qualificationAt: new Date(NOW - 30 * 86_400_000).toISOString() }]) expect(projection([candidate("conn-a", patch)], [account()]).routes).toEqual([]);
    for (const patch of [{ accountClass: "PAID" as const }, { freeAdmissionVerified: false }, { quotaScopeVerified: false }, { recheckAt: new Date(NOW).toISOString() }, { enabled: false }, { authState: "revoked" }, { admissionEvidence: undefined }, { quotaScopeEvidence: undefined }]) expect(projection([candidate()], [account("conn-a", patch)]).routes).toEqual([]);
  });

  it("denies stale physical quota evidence at the final firewall boundary", () => {
    const projected = projection([candidate()], [account("conn-a", { quotaScopeEvidence: { ...account().quotaScopeEvidence!, recheckAt: new Date(NOW).toISOString() } })]);
    if (projected.routes.length) expect(freeRouteExclusionReason(projected.routes[0]!, undefined, { dataClass: "PUBLIC_CODE", userConsented: true }, NOW)).toBe("QUOTA_SCOPE_EVIDENCE_STALE");
    else expect(projected.pools).toEqual([]);
  });

  it("counts shared physical quota once and propagates its minimum to every transport alias", () => {
    const projected = projection([candidate(), candidate("conn-b")], [account(), account("conn-b", { capacityWindows: [window(7)] })]);
    expect(projected.routes).toHaveLength(2);
    expect(projected.pools).toHaveLength(1);
    expect(projected.identities).toEqual([IDENTITY]);
    expect(projected.pools[0]!.windows[0]!.remaining).toBe(7);
    for (const route of projected.routes) {
      expect(route.windows[0]!.remaining).toBe(7);
      expect(deriveCapacityIndependence(route, NOW).key).toBe(`openrouter:USER_ACCOUNT:${IDENTITY}`);
    }
  });

  it("retains every measured upstream restriction when another key observes fewer windows", () => {
    const tokenWindow = window(100, { unit: "input_tokens", limit: 1_000, period: "MINUTE_RESET" });
    const projected = projection([candidate(), candidate("conn-b")], [account("conn-a", { capacityWindows: [window(30), tokenWindow] }), account("conn-b", { capacityWindows: [window(7)] })]);
    expect(projected.pools[0]!.windows).toContainEqual(tokenWindow);
    for (const route of projected.routes) expect(route.windows).toContainEqual(tokenWindow);
  });

  it("admits separate physical account pools only with distinct upstream identities", () => {
    const otherIdentity = "b".repeat(64);
    const projected = projection([candidate(), candidate("conn-b")], [account(), account("conn-b", { accountIdentityHash: otherIdentity, quotaScopeEvidence: { ...account().quotaScopeEvidence!, identityHash: otherIdentity } })]);
    expect(projected.pools).toHaveLength(2);
    expect(new Set(projected.routes.map(route => deriveCapacityIndependence(route, NOW).key)).size).toBe(2);
  });

  it("reserves one shared upstream allowance across aliases and legitimate owners of the same domain", () => {
    const alice = projection([candidate()], [account("conn-a", { capacityWindows: [window(1)] })]);
    const bob = projection([candidate("conn-b", { ownerUserId: "bob" })], [account("conn-b", { ownerUserId: "bob", capacityWindows: [window(1)] })], "bob");
    const fabric = createFreeFabric({ managedRoutes: () => [], userSources: [{ routesForUser: owner => owner === "alice" ? alice.routes : bob.routes, poolsForUser: owner => owner === "alice" ? alice.pools : bob.pools }], reservations: new CapacityReservationLedger({ routes: [], pools: [], now: () => NOW }), now: () => NOW });
    const first = fabric.decide({ requestId: "alice-task", userId: "alice", userIdentities: alice.identities, role: "REVIEWER", dataContext: { dataClass: "PUBLIC_CODE", userConsented: true }, demand: { requests: 1, inputTokens: 1, outputTokens: 1 } });
    const second = fabric.decide({ requestId: "bob-task", userId: "bob", userIdentities: bob.identities, role: "REVIEWER", dataContext: { dataClass: "PUBLIC_CODE", userConsented: true }, demand: { requests: 1, inputTokens: 1, outputTokens: 1 } });
    expect(first.outcome, JSON.stringify(first.explanation)).toBe("ADMITTED");
    expect(second.outcome, JSON.stringify(second.explanation)).toBe("QUEUED_FOR_CAPACITY");
  });
});
