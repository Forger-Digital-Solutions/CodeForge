import { describe, expect, it } from "vitest";
import {
  CapacityReservationLedger,
  forecastCapacity,
  isCapacityEventActive,
  isFreeRouteEligible,
  preflightCapacity,
  simulateScale,
  type CapacityRoute,
  type ProviderCapacityPool,
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
    supplyClass: "PURE_MANAGED_FREE",
    capacityPoolId: "groq-org",
    capacityPoolScope: "SHARED_OWNER_POOL",
    capacityScope: "ORG",
    dataPolicyProfile: "PRIVATE_CODE_ALLOWED",
    lifecycle: "APPROVED",
    explicitZeroPrice: true,
    paidFallbackDisabled: true,
    managedMultiUserAllowed: true,
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
    expect(isFreeRouteEligible(route({ supplyClass: "PAID" }))).toBe(false);
    expect(isFreeRouteEligible(route({ capacityScope: "UNKNOWN" }))).toBe(false);
    expect(isFreeRouteEligible(route({ explicitZeroPrice: false }))).toBe(false);
  });

  it("forecasts deterministic task units and exposes concentration", () => {
    const result = forecastCapacity({ routes: [route(), route({ routeId: "cloudflare", providerId: "cloudflare", gateway: "workers-ai", capacityPoolId: "cloudflare-account", capacityScope: "ACCOUNT", qualityScore: 70 })], taskDemand: demand, firstRunReserveRequests: 20, firstRunReserveTokens: 1_000, now: NOW });
    expect(result.policy).toBe("DETERMINISTIC_HARD_ACCOUNTING");
    expect(result.estimatedTaskUnits).toBe(200);
    expect(result.firstRunTaskUnits).toBe(10);
    expect(result.providerConcentration.groq).toBe(0.5);
    expect(result.providerConcentration.cloudflare).toBe(0.5);
  });

  it("counts a shared provider pool once and keeps promotions and owner reserves outside Free", () => {
    const shared = route({ routeId: "groq-qwen", modelId: "qwen/qwen3.8-27b", capacityPoolId: "groq-org", qualityScore: 90 });
    const forecast = forecastCapacity({ routes: [route(), shared], taskDemand: demand, now: NOW });
    expect(forecast.estimatedTaskUnits).toBe(100);
    expect(forecast.routes.filter((item) => item.countedInPool)).toHaveLength(1);
    expect(isFreeRouteEligible(route({ supplyClass: "PROMOTIONAL_FREE" }))).toBe(false);
    expect(isFreeRouteEligible(route({ supplyClass: "OWNER_CREDIT_RESERVE" }))).toBe(false);
    expect(isFreeRouteEligible(route({ paidFallbackDisabled: false }))).toBe(false);
  });

  it("uses an authoritative physical pool once across models and separately protects output quota", () => {
    const pool: ProviderCapacityPool = {
      poolId: "groq-org",
      providerId: "groq",
      scope: "SHARED_OWNER_POOL",
      supplyClass: "PURE_MANAGED_FREE",
      observedAt: new Date(NOW).toISOString(),
      authoritative: true,
      windows: [
        { unit: "requests", limit: 2, remaining: 2, resetAt: RESET, scope: "ORG", observedAt: new Date(NOW).toISOString(), authoritative: true },
        { unit: "input_tokens", limit: 1_000, remaining: 1_000, resetAt: RESET, scope: "ORG", observedAt: new Date(NOW).toISOString(), authoritative: true },
        { unit: "output_tokens", limit: 50, remaining: 50, resetAt: RESET, scope: "ORG", observedAt: new Date(NOW).toISOString(), authoritative: true },
      ],
    };
    const alternate = route({ routeId: "groq-qwen", modelId: "qwen/qwen3.8-27b", qualityScore: 90 });
    const forecast = forecastCapacity({ routes: [route(), alternate], pools: [pool], taskDemand: demand, now: NOW });
    expect(forecast.estimatedTaskUnits).toBe(1);
    expect(forecast.routes.filter((item) => item.countedInPool)).toHaveLength(1);

    const ledger = new CapacityReservationLedger({ routes: [route(), alternate], pools: [pool], firstRunReserveRequests: 0, firstRunReserveTokens: 0, now: () => NOW });
    const request = (id: string, routeId: string) => ({ reservationId: id, userId: id, routeIds: [routeId], role: "coder", taskKind: "normal", requests: 1, inputTokens: 100, outputTokens: 40, isNewUser: true, priority: "first_run" as const, createdAt: new Date(NOW).toISOString(), leaseUntil: new Date(NOW + 10_000).toISOString() });
    expect(ledger.reserve(request("first", "groq-oss")).admitted).toBe(true);
    expect(ledger.reserve(request("second", "groq-qwen")).reason).toBe("CAPACITY_EXHAUSTED");
    expect(ledger.snapshot().byPool["groq-org"]).toBe(1);
  });

  it("rejects a pool observation that does not belong to the selected route", () => {
    const ledger = new CapacityReservationLedger({
      routes: [route()],
      pools: [{ poolId: "groq-org", providerId: "other", scope: "SHARED_OWNER_POOL", supplyClass: "PURE_MANAGED_FREE", windows: [], observedAt: new Date(NOW).toISOString(), authoritative: true }],
      now: () => NOW,
    });
    const decision = ledger.reserve({ reservationId: "mismatch", userId: "user", routeIds: ["groq-oss"], role: "coder", taskKind: "normal", requests: 1, inputTokens: 1, outputTokens: 0, isNewUser: true, priority: "first_run", createdAt: new Date(NOW).toISOString(), leaseUntil: new Date(NOW + 10_000).toISOString() });
    expect(decision.reason).toBe("CAPACITY_POOL_IDENTITY_MISMATCH");
  });

  it("preflights a task or benchmark without dispatching it", () => {
    const pool: ProviderCapacityPool = {
      poolId: "groq-org",
      providerId: "groq",
      scope: "SHARED_OWNER_POOL",
      supplyClass: "PURE_MANAGED_FREE",
      observedAt: new Date(NOW).toISOString(),
      authoritative: true,
      windows: [
        { unit: "requests", limit: 4, remaining: 4, resetAt: RESET, scope: "ORG", observedAt: new Date(NOW).toISOString(), authoritative: true },
        { unit: "input_tokens", limit: 1_000, remaining: 1_000, resetAt: RESET, scope: "ORG", observedAt: new Date(NOW).toISOString(), authoritative: true },
        { unit: "output_tokens", limit: 1_000, remaining: 1_000, resetAt: RESET, scope: "ORG", observedAt: new Date(NOW).toISOString(), authoritative: true },
      ],
    };
    const estimate = { taskKind: "agent", topology: "explorer-coder-reviewer", expectedModelTurns: 2, expectedRetryCalls: 1, expectedVerificationCalls: 1, expectedToolCalls: 4, expectedInputTokens: 100, expectedOutputTokens: 100, roleRequests: { coder: 1 } };
    const alternate = route({ routeId: "other-oss", providerId: "other", modelId: "other/oss", capacityPoolId: "other-org", gateway: "other", capacityScope: "ACCOUNT" });
    const alternatePool: ProviderCapacityPool = { ...pool, poolId: "other-org", providerId: "other", windows: pool.windows.map((window) => ({ ...window, scope: "ACCOUNT" })) };
    const ready = preflightCapacity({ routes: [route(), alternate], pools: [pool, alternatePool], estimate, plannedTasks: 1, now: NOW });
    expect(ready.status).toBe("READY");
    expect(ready.safeTaskUnits).toBe(2);
    expect(ready.nextResetAt).toBe(RESET);

    const insufficient = preflightCapacity({ routes: [route(), alternate], pools: [pool, alternatePool], estimate, plannedTasks: 3, now: NOW });
    expect(insufficient.status).toBe("INSUFFICIENT_CAPACITY");
    expect(insufficient.reasons).toContain("PLANNED_TASKS_EXCEED_SAFE_CAPACITY");

    const atRisk = preflightCapacity({ routes: [route()], pools: [pool], estimate, plannedTasks: 1, minimumIndependentProviders: 2, now: NOW });
    expect(atRisk.status).toBe("AT_RISK");
    expect(atRisk.reasons).toContain("INSUFFICIENT_INDEPENDENT_PROVIDERS");
  });

  it("requires explicit user consent for disclosure-gated public routes and isolates per-user pools", () => {
    const distributed = route({
      routeId: "distributed",
      supplyClass: "DISTRIBUTED_USER_FREE",
      capacityPoolId: "distributed-user",
      capacityPoolScope: "PER_USER_POOL",
      capacityScope: "END_USER",
      dataPolicyProfile: "USER_CONSENT_REQUIRED",
      windows: [
        { unit: "requests", limit: 10, remaining: 10, resetAt: RESET, scope: "END_USER", observedAt: new Date(NOW).toISOString(), authoritative: true },
        { unit: "input_tokens", limit: 1_000, remaining: 1_000, resetAt: RESET, scope: "END_USER", observedAt: new Date(NOW).toISOString(), authoritative: true },
      ],
    });
    expect(isFreeRouteEligible(distributed)).toBe(false);
    expect(isFreeRouteEligible(distributed, undefined, { dataClass: "PUBLIC_CODE", userConsented: true })).toBe(true);
    const ledger = new CapacityReservationLedger({ routes: [distributed], dataContext: { dataClass: "PUBLIC_CODE", userConsented: true }, firstRunReserveRequests: 0, firstRunReserveTokens: 0, maxActiveReservationsPerUser: 2, now: () => NOW });
    const request = (id: string, userId: string) => ({ reservationId: id, userId, routeIds: ["distributed"], role: "coder", taskKind: "normal", requests: 10, inputTokens: 100, outputTokens: 0, isNewUser: false, priority: "normal" as const, createdAt: new Date(NOW).toISOString(), leaseUntil: new Date(NOW + 10_000).toISOString() });
    expect(ledger.reserve(request("u1", "user-one")).admitted).toBe(true);
    expect(ledger.reserve(request("u2", "user-two")).admitted).toBe(true);
  });

  it("protects first-run capacity, enforces per-user concurrency, and recovers leases", () => {
    let clock = NOW;
    const ledger = new CapacityReservationLedger({ routes: [route({ windows: [{ unit: "requests", limit: 1, remaining: 1, resetAt: RESET, scope: "ORG", observedAt: new Date(NOW).toISOString(), authoritative: true }, { unit: "input_tokens", limit: 1_000, remaining: 1_000, resetAt: RESET, scope: "ORG", observedAt: new Date(NOW).toISOString(), authoritative: true }] })], firstRunReserveRequests: 1, firstRunReserveTokens: 100, maxActiveReservationsPerUser: 1, now: () => clock });
    const request = (id: string, userId: string, isNewUser: boolean) => ({ reservationId: id, userId, routeIds: ["groq-oss"], role: "coder", taskKind: "normal", requests: 1, inputTokens: 50, outputTokens: 0, isNewUser, priority: isNewUser ? "first_run" as const : "normal" as const, createdAt: new Date(clock).toISOString(), leaseUntil: new Date(clock + 10_000).toISOString() });
    expect(ledger.reserve(request("normal-1", "heavy", false)).reason).toBe("FIRST_RUN_RESERVE_PROTECTED");
    expect(ledger.reserve(request("new-1", "new", true)).admitted).toBe(true);
    expect(ledger.reserve(request("new-2", "new", true)).reason).toBe("USER_CONCURRENCY_LIMIT");
    clock += 11_000;
    expect(ledger.recoverExpired()).toBe(1);
    expect(ledger.snapshot().activeReservations).toBe(0);
  });

  it("simulates outage, promotion expiry, and heavy-user pressure without paid fallback", () => {
    const routes = [route(), route({ routeId: "promo", providerId: "promo", supplyClass: "PROMOTIONAL_FREE", capacityPoolId: "promo-pool", gateway: "promo-gateway", qualityScore: 65 })];
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
