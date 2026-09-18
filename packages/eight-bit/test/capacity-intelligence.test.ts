import { describe, expect, it } from "vitest";
import { EightBitCapacityIntelligence } from "../src/capacity-intelligence.js";
import type { CapacityRoute } from "@codeforge/forge-zero";

function route(id: string, qualityScore: number, overrides: Partial<CapacityRoute> = {}): CapacityRoute {
  return {
    routeId: id,
    providerId: id,
    modelId: `${id}-free`,
    canonicalModelId: `${id}-free`,
    family: id,
    gateway: id,
    supplyClass: "PURE_MANAGED_FREE",
    capacityPoolId: `${id}-pool`,
    capacityPoolScope: "SHARED_OWNER_POOL",
    capacityScope: "ORG",
    dataPolicyProfile: "PRIVATE_CODE_ALLOWED",
    lifecycle: "APPROVED",
    explicitZeroPrice: true,
    paidFallbackDisabled: true,
    managedMultiUserAllowed: true,
    privacyClass: "standard",
    roles: ["coder"],
    qualityScore,
    healthy: true,
    enabled: true,
    windows: [{ unit: "requests", limit: 10, remaining: 10, resetAt: "2026-09-16T00:00:00.000Z", scope: "ORG", observedAt: "2026-09-15T00:00:00.000Z", authoritative: true }, { unit: "input_tokens", limit: 1_000, remaining: 1_000, resetAt: "2026-09-16T00:00:00.000Z", scope: "ORG", observedAt: "2026-09-15T00:00:00.000Z", authoritative: true }],
    ...overrides,
  };
}

describe("8-Bit capacity intelligence boundary", () => {
  it("is advisory and cannot recommend a paid or unhealthy route", () => {
    const intelligence = new EightBitCapacityIntelligence();
    expect(intelligence.recommend([route("paid", 100, { supplyClass: "PAID" }), route("free", 80)], "coder")).toEqual({ advisory: true, role: "coder", routeId: "free", reason: "QUALITY_ORDERED_FREE_ROUTE" });
    expect(intelligence.recommend([route("blocked", 100, { healthy: false })], "coder").routeId).toBeUndefined();
  });

  it("returns the ForgeZero hard-accounting forecast unchanged", () => {
    const intelligence = new EightBitCapacityIntelligence();
    const forecast = intelligence.forecast({ routes: [route("free", 80)], taskDemand: { taskKind: "tiny", requests: 1, inputTokens: 100, outputTokens: 0, roleRequests: { coder: 1 } } });
    expect(forecast.policy).toBe("DETERMINISTIC_HARD_ACCOUNTING");
    expect(forecast.estimatedTaskUnits).toBe(10);
  });
});
