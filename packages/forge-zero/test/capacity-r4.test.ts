import { describe, expect, it } from "vitest";
import {
  CapacityReservationLedger,
  forecastCapacity,
  isCapacityEventActive,
  isFreeRouteEligible,
  simulateScale,
  type CapacityRoute,
  type ScaleScenario,
} from "../src/index.js";

const NOW = Date.parse("2026-09-15T12:00:00.000Z");
const RESET = "2026-09-16T00:00:00.000Z";

function route(overrides: Partial<CapacityRoute> = {}): CapacityRoute {
  return {
    routeId: "groq-oss",
    providerId: "groq",
    modelId: "openai/gpt-oss-120b",
    canonicalModelId: "openai/gpt-oss-120b",
    family: "gpt-oss",
    gateway: "direct",
    capacityClass: "RECURRING_SHARED_FREE",
    capacityScope: "ORG",
    economicSource: "RETAIL_FREE",
    explicitZeroPrice: true,
    privacyClass: "standard",
    roles: ["coder", "reviewer"],
    qualityScore: 80,
    healthy: true,
    enabled: true,
    windows: [
      { unit: "requests", limit: 200, remaining: 200, resetAt: RESET, scope: "ORG", observedAt: new Date(NOW).toISOString(), authoritative: true },
      { unit: "input_tokens", limit: 20_000, remaining: 20_000, resetAt: RESET, scope: "ORG", observedAt: new Date(NOW).toISOString(), authoritative: true },
      { unit: "output_tokens", limit: 20_000, remaining: 20_000, resetAt: RESET, scope: "ORG", observedAt: new Date(NOW).toISOString(), authoritative: true },
    ],
    ...overrides,
  };
}

const demand = {
  taskKind: "normal",
  requests: 2,
  inputTokens: 100,
  outputTokens: 50,
  roleRequests: { coder: 1, reviewer: 1 },
};

describe("R4 ForgeZero capacity accounting", () => {
  it("fails closed for paid, unknown-scope, and non-explicit routes", () => {
    expect(isFreeRouteEligible(route())).toBe(true);
    expect(isFreeRouteEligible(route({ economicSource: "PAID", capacityClass: "PAID" }))).toBe(false);
    expect(isFreeRouteEligible(route({ capacityScope: "UNKNOWN" }))).toBe(false);
    expect(isFreeRouteEligible(route({ explicitZeroPrice: false }))).toBe(false);
  });

  it("forecasts deterministic task units and exposes concentration", () => {
    const result = forecastCapacity({ routes: [route(), route({ routeId: "cloudflare", providerId: "cloudflare", gateway: "workers-ai", capacityScope: "ACCOUNT", qualityScore: 70 })], taskDemand: demand, firstRunReserveRequests: 20, firstRunReserveTokens: 1_000, now: NOW });
    expect(result.policy).toBe("DETERMINISTIC_HARD_ACCOUNTING");
    expect(result.estimatedTaskUnits).toBe(200);
    expect(result.firstRunTaskUnits).toBe(10);
    expect(result.providerConcentration.groq).toBe(0.5);
    expect(result.providerConcentration.cloudflare).toBe(0.5);
  });

  it("protects first-run capacity, enforces per-user concurrency, and recovers leases", () => {
    let clock = NOW;
    const ledger = new CapacityReservationLedger({ routes: [route({ windows: [{ unit: "requests", limit: 1, remaining: 1, resetAt: RESET, scope: "ORG", observedAt: new Date(NOW).toISOString(), authoritative: true }, { unit: "input_tokens", limit: 1_000, remaining: 1_000, resetAt: RESET, scope: "ORG", observedAt: new Date(NOW).toISOString(), authoritative: true }] })], firstRunReserveRequests: 1, firstRunReserveTokens: 100, maxActiveReservationsPerUser: 1, now: () => clock });
    const request = (id: string, userId: string, isNewUser: boolean) => ({ reservationId: id, userId, routeIds: ["groq-oss"], taskKind: "normal", requests: 1, inputTokens: 50, outputTokens: 0, isNewUser, priority: isNewUser ? "first_run" as const : "normal" as const, createdAt: new Date(clock).toISOString(), leaseUntil: new Date(clock + 10_000).toISOString() });
    expect(ledger.reserve(request("normal-1", "heavy", false)).reason).toBe("FIRST_RUN_RESERVE_PROTECTED");
    expect(ledger.reserve(request("new-1", "new", true)).admitted).toBe(true);
    expect(ledger.reserve(request("new-2", "new", true)).reason).toBe("USER_CONCURRENCY_LIMIT");
    clock += 11_000;
    expect(ledger.recoverExpired()).toBe(1);
    expect(ledger.snapshot().activeReservations).toBe(0);
  });

  it("simulates outage, promotion expiry, and heavy-user pressure without paid fallback", () => {
    const routes = [route(), route({ routeId: "promo", providerId: "promo", capacityClass: "PROMOTIONAL_FREE", economicSource: "PROMOTIONAL_FREE", gateway: "promo-gateway", qualityScore: 65 })];
    const scenarios: ScaleScenario[] = [{ id: "outage", registeredUsers: 373, dailyActiveUsers: 75, newUsers: 25, tasksPerActiveUser: 2, taskDemand: demand, failedProviders: ["groq"] }, { id: "promo-ended", registeredUsers: 373, dailyActiveUsers: 75, newUsers: 25, tasksPerActiveUser: 2, taskDemand: demand, endedPromotions: ["promo"] }, { id: "heavy", registeredUsers: 100, dailyActiveUsers: 50, newUsers: 0, tasksPerActiveUser: 1, taskDemand: demand, heavyUsers: 50, hugeTaskMultiplier: 8 }];
    const results = simulateScale({ routes, scenarios });
    expect(results).toHaveLength(3);
    expect(results[0]?.forecast.routes.find((item) => item.routeId === "groq-oss")?.eligible).toBe(false);
    expect(results[1]?.forecast.routes.find((item) => item.routeId === "promo")?.eligible).toBe(false);
    expect(results[2]?.outcomes.capacityBlocks).toBeGreaterThan(0);
    expect(results.every((item) => !item.alerts.some((alert) => alert.includes("paid")))).toBe(true);
  });

  it("treats event end as an exact expiry boundary", () => {
    const event = { id: "boost", source: "PROMOTIONAL_FREE" as const, startsAt: "2026-09-15T11:00:00.000Z", endsAt: "2026-09-15T12:00:00.000Z", routeIds: ["promo"], eligibleRoles: ["coder"], eligiblePrivacy: ["standard" as const], fallbackRouteIds: ["groq-oss"] };
    expect(isCapacityEventActive(event, NOW - 1)).toBe(true);
    expect(isCapacityEventActive(event, NOW)).toBe(false);
  });
});
