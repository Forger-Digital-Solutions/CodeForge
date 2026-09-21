import { describe, expect, it } from "vitest";
import {
  COPILOT_PROVIDER_ID,
  CopilotUserConnectedFreeFleet,
  buildCopilotUserCapacityPool,
  buildCopilotUserRoute,
  copilotHardStopProven,
  copilotPoolId,
  evaluateCopilotFreeOnlyAdmission,
  hashUserAccountIdentity,
  isFreeRouteEligible,
  type CopilotFreeConnection,
  type CopilotModelObservation,
  type CopilotQuotaObservation,
} from "../src/index.js";

/**
 * Copilot user-connected entitlement (R23 M14A-2). The observed account served as the fixture:
 * chat 200/102 used, completions 2000/0, premium 0/0, all post-quota flags false = a proven
 * hard stop. Inference itself needs a "Copilot Requests" token and legal sign-off; these tests
 * pin the supply-side contract — admission math, per-user pools, fleet isolation and the
 * deliberately ineligible-by-default route construction.
 */
const observedAt = "2026-09-21T10:48:00.000Z";

function quota(overrides: Partial<CopilotQuotaObservation> = {}): CopilotQuotaObservation {
  return {
    chat: { entitlementRequests: 200, usedRequests: 102, overageAllowedWithExhaustedQuota: false, usageAllowedWithExhaustedQuota: false, resetDate: "2026-10-01T00:00:00.000Z" },
    completions: { entitlementRequests: 2000, usedRequests: 0, overageAllowedWithExhaustedQuota: false, usageAllowedWithExhaustedQuota: false },
    premiumInteractions: { entitlementRequests: 0, usedRequests: 0, overageAllowedWithExhaustedQuota: false, usageAllowedWithExhaustedQuota: false },
    observedAt,
    capacityConfidence: "HIGH",
    ...overrides,
  };
}

const NOW = Date.parse("2026-09-21T10:50:00.000Z");

function connection(userId: string, termsStatus: CopilotFreeConnection["termsStatus"] = "USER_CONNECTED_FREE_PERMISSION_REQUIRED"): CopilotFreeConnection {
  return {
    providerId: COPILOT_PROVIDER_ID,
    userId,
    authType: "OAUTH",
    encryptedCredentialRef: `secure:${userId}`,
    supplyClass: "USER_CONNECTED_FREE",
    capacityScope: "USER_ACCOUNT",
    capacityPoolId: copilotPoolId(userId),
    capacityIdentity: hashUserAccountIdentity(userId),
    freeOnly: true,
    paidFallbackDisabled: true,
    status: "CONNECTED",
    termsStatus,
  };
}

const toolCapableModel: CopilotModelObservation = {
  modelId: "gpt-5-mini",
  canonicalModelId: "openai/gpt-5-mini",
  family: "gpt-5",
  roles: ["coder"],
  policyEnabled: true,
  supportsToolCalls: true,
};

describe("Copilot free-only admission (account.getQuota semantics)", () => {
  it("admits included quota only with a proven hard stop", () => {
    const result = evaluateCopilotFreeOnlyAdmission({ bucket: quota().chat, estimatedRequests: 10, observedAt, now: NOW });
    expect(result.allowed).toBe(true);
    expect(result.remainingRequests).toBe(98);
  });

  it("refuses plans that can continue past quota as billable usage", () => {
    const overage = evaluateCopilotFreeOnlyAdmission({ bucket: { entitlementRequests: 200, usedRequests: 10, overageAllowedWithExhaustedQuota: true }, estimatedRequests: 1, observedAt, now: NOW });
    expect(overage.state).toBe("PAID_CROSSOVER_BLOCKED");
    const usageAllowed = evaluateCopilotFreeOnlyAdmission({ bucket: { entitlementRequests: 200, usedRequests: 10, usageAllowedWithExhaustedQuota: true }, estimatedRequests: 1, observedAt, now: NOW });
    expect(usageAllowed.state).toBe("PAID_CROSSOVER_BLOCKED");
  });

  it("fails closed on missing or stale quota observations", () => {
    expect(evaluateCopilotFreeOnlyAdmission({ bucket: undefined, estimatedRequests: 1, observedAt, now: NOW }).state).toBe("UNKNOWN_BALANCE");
    expect(evaluateCopilotFreeOnlyAdmission({ bucket: quota().chat, estimatedRequests: 1, observedAt: "2026-09-21T09:00:00.000Z", now: NOW }).state).toBe("STALE_QUOTA");
  });

  it("reports exhaustion against the remainder, never against the entitlement", () => {
    expect(evaluateCopilotFreeOnlyAdmission({ bucket: { entitlementRequests: 200, usedRequests: 200 }, estimatedRequests: 1, observedAt, now: NOW }).state).toBe("EXHAUSTED");
    expect(evaluateCopilotFreeOnlyAdmission({ bucket: { entitlementRequests: 200, usedRequests: 197 }, estimatedRequests: 5, observedAt, now: NOW }).state).toBe("EXHAUSTED");
    expect(evaluateCopilotFreeOnlyAdmission({ bucket: { entitlementRequests: 200, usedRequests: 197 }, estimatedRequests: 3, observedAt, now: NOW }).allowed).toBe(true);
  });

  it("requires every observed bucket to prove the hard stop", () => {
    expect(copilotHardStopProven(quota())).toBe(true);
    expect(copilotHardStopProven(quota({ premiumInteractions: { entitlementRequests: 300, usedRequests: 0, usageAllowedWithExhaustedQuota: true } }))).toBe(false);
    expect(copilotHardStopProven(quota({ chat: { entitlementRequests: 200, usedRequests: 0 } }))).toBe(false);
    expect(copilotHardStopProven({ observedAt, capacityConfidence: "HIGH" })).toBe(false);
  });
});

describe("Copilot user capacity pool", () => {
  it("projects chat as the requests window and premium as provider_units, never conflating buckets", () => {
    const pool = buildCopilotUserCapacityPool(connection("user-a"), quota());
    expect(pool.scope).toBe("PER_USER_POOL");
    expect(pool.supplyClass).toBe("USER_CONNECTED_FREE");
    expect(pool.providerId).toBe(COPILOT_PROVIDER_ID);
    const requests = pool.windows.filter((w) => w.unit === "requests");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.remaining).toBe(98);
    expect(requests[0]?.period).toBe("MONTHLY_RESET");
    const premium = pool.windows.filter((w) => w.unit === "provider_units");
    expect(premium).toHaveLength(1);
    expect(premium[0]?.remaining).toBe(0);
    expect(pool.windows.some((w) => w.unit === "credits")).toBe(false);
  });

  it("keeps accounts independent", () => {
    expect(copilotPoolId("user-a")).not.toBe(copilotPoolId("user-b"));
    expect(copilotPoolId("user-a")).not.toContain("user-a");
  });
});

describe("Copilot route construction and fleet", () => {
  it("builds routes ineligible by default — legal/terms gate and lifecycle, not an accounting detail", () => {
    const pool = buildCopilotUserCapacityPool(connection("user-a"), quota());
    const route = buildCopilotUserRoute({ userId: "user-a", model: toolCapableModel, windows: pool.windows, freeOnlyAdmissionProven: true });
    expect(route.supplyClass).toBe("USER_CONNECTED_FREE");
    expect(route.capacityPoolScope).toBe("PER_USER_POOL");
    expect(route.explicitZeroPrice).toBe(false);
    expect(route.paidFallbackDisabled).toBe(true);
    expect(route.lifecycle).toBe("POLICY_REVIEW");
    expect(route.managedMultiUserAllowed).toBe(false);
    expect(isFreeRouteEligible(route)).toBe(false);
  });

  it("becomes eligible only with terms cleared, lifecycle approved and a proven hard stop", () => {
    const pool = buildCopilotUserCapacityPool(connection("user-a"), quota());
    const route = buildCopilotUserRoute({ userId: "user-a", model: toolCapableModel, windows: pool.windows, freeOnlyAdmissionProven: true, termsAllowed: true, lifecycle: "APPROVED" });
    expect(isFreeRouteEligible(route)).toBe(true);
    const unproven = buildCopilotUserRoute({ userId: "user-a", model: toolCapableModel, windows: pool.windows, freeOnlyAdmissionProven: false, termsAllowed: true, lifecycle: "APPROVED" });
    expect(isFreeRouteEligible(unproven)).toBe(false);
  });

  it("projects only policy-enabled tool-calling models, isolated per connected user", () => {
    const fleet = new CopilotUserConnectedFreeFleet();
    const disabled: CopilotModelObservation = { ...toolCapableModel, modelId: "disabled-model", policyEnabled: false };
    const noTools: CopilotModelObservation = { ...toolCapableModel, modelId: "no-tools", supportsToolCalls: false };
    fleet.connect(connection("user-a"), quota(), [toolCapableModel, disabled, noTools]);
    fleet.connect(connection("user-b"), quota(), [toolCapableModel]);
    expect(fleet.connectedUsers()).toEqual(["user-a", "user-b"]);
    expect(fleet.routesForUser("user-a")).toHaveLength(1);
    expect(fleet.routesForUser("user-a")[0]?.modelId).toBe("gpt-5-mini");
    expect(fleet.routesForUser("user-a")[0]?.capacityIdentity).toBe(hashUserAccountIdentity("user-a"));
    expect(fleet.routesForUser("user-a")[0]?.capacityIdentity).not.toBe(hashUserAccountIdentity("user-b"));
    // Terms are not cleared on these connections — projected routes stay ineligible.
    expect(fleet.routesForUser("user-a")[0]?.managedMultiUserAllowed).toBe(false);
    expect(fleet.routesForUser("user-a")[0]?.freeOnlyAdmissionProven).toBe(true);
    expect(fleet.disconnect("user-b")).toBe(true);
    expect(fleet.routesForUser("user-b")).toHaveLength(0);
  });

  it("marks routes unproven when the account could spill into overage", () => {
    const fleet = new CopilotUserConnectedFreeFleet();
    const spill = quota({ premiumInteractions: { entitlementRequests: 50, usedRequests: 0, usageAllowedWithExhaustedQuota: true } });
    fleet.connect(connection("user-a"), spill, [toolCapableModel]);
    expect(fleet.routesForUser("user-a")[0]?.freeOnlyAdmissionProven).toBe(false);
  });
});
