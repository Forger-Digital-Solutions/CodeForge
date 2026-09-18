import { describe, expect, it } from "vitest";
import {
  CapacityReservationLedger,
  OllamaUserConnectedFreeFleet,
  buildOllamaUserCapacityPool,
  buildOllamaUserRoute,
  evaluateOllamaFreeOnlyAdmission,
  estimateOllamaUsageUsd,
  forecastCapacity,
  hashUserAccountIdentity,
  simulateOllamaAdoption,
  userConnectedPoolId,
} from "../src/index.js";

const observedAt = "2026-09-18T12:00:00.000Z";
const resetAt = "2026-10-18T12:00:00.000Z";

function usage(overrides: Partial<Parameters<typeof evaluateOllamaFreeOnlyAdmission>[0]["usage"]> = {}) {
  return {
    includedLimitUsd: 10,
    includedRemainingUsd: 10,
    includedResetAt: resetAt,
    purchasedUsageCreditsUsd: 0,
    starterModels: ["gpt-oss:120b"],
    concurrencyLimit: 1,
    observedAt,
    capacityConfidence: "HIGH" as const,
    includedUsageDistinguishable: true,
    hardStopProven: true,
    ...overrides,
  };
}

describe("Ollama user-connected Free boundary", () => {
  it("admits included usage and never treats purchased credits as Free capacity", () => {
    expect(evaluateOllamaFreeOnlyAdmission({ usage: usage(), estimatedUsageUsd: 1 }).allowed).toBe(true);
    expect(evaluateOllamaFreeOnlyAdmission({ usage: usage({ includedRemainingUsd: 0 }), estimatedUsageUsd: 1 }).state).toBe("EXHAUSTED");
    expect(evaluateOllamaFreeOnlyAdmission({ usage: usage({ includedRemainingUsd: 0, purchasedUsageCreditsUsd: 20 }), estimatedUsageUsd: 1 }).allowed).toBe(false);
    expect(evaluateOllamaFreeOnlyAdmission({ usage: usage({ includedRemainingUsd: undefined, purchasedUsageCreditsUsd: 20, hardStopProven: false }), estimatedUsageUsd: 1 }).state).toBe("UNKNOWN_BALANCE");
  });

  it("keeps accounts independent and scopes capacity identities without exposing raw ids", () => {
    expect(userConnectedPoolId("user-a")).not.toBe(userConnectedPoolId("user-b"));
    expect(hashUserAccountIdentity("user-a")).not.toContain("user-a");
    const pool = buildOllamaUserCapacityPool({ userId: "user-a", capacityIdentity: hashUserAccountIdentity("user-a"), capacityPoolId: userConnectedPoolId("user-a"), supplyClass: "USER_CONNECTED_FREE" }, usage());
    expect(pool.scope).toBe("PER_USER_POOL");
    expect(pool.capacityIdentity).toBe(hashUserAccountIdentity("user-a"));
    expect(pool.windows.find((w) => w.unit === "concurrency")?.remaining).toBe(1);
  });

  it("uses token rates for reservations and enforces one concurrent request", () => {
    const credits = estimateOllamaUsageUsd(1_000_000, 0, { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 });
    expect(credits).toBe(0.15);
    const route = buildOllamaUserRoute({
      userId: "user-a",
      modelId: "gpt-oss:120b",
      canonicalModelId: "openai/gpt-oss-120b",
      family: "gpt-oss",
      roles: ["coder"],
      freeOnlyAdmissionProven: true,
      termsAllowed: true,
      windows: [
        { unit: "requests", limit: 2, remaining: 2, resetAt, scope: "USER_ACCOUNT", observedAt, authoritative: true },
        { unit: "credits", limit: 2, remaining: 2, resetAt, scope: "USER_ACCOUNT", observedAt, authoritative: true },
        { unit: "concurrency", limit: 1, remaining: 1, resetAt, scope: "USER_ACCOUNT", observedAt, authoritative: true },
      ],
    });
    expect(forecastCapacity({ routes: [route], taskDemand: { taskKind: "code", requests: 1, inputTokens: 0, outputTokens: 0, credits: 1, concurrency: 1, roleRequests: { coder: 1 } }, now: Date.parse(observedAt) }).estimatedTaskUnits).toBe(1);
    const ledger = new CapacityReservationLedger({ routes: [route], firstRunReserveRequests: 0, firstRunReserveTokens: 0, now: () => Date.parse(observedAt) });
    const request = (id: string) => ({ reservationId: id, userId: "user-a", routeIds: [route.routeId], role: "coder", taskKind: "code", requests: 1, inputTokens: 0, outputTokens: 0, credits: 1, isNewUser: true, priority: "normal" as const, createdAt: observedAt, leaseUntil: "2026-09-18T12:05:00.000Z" });
    expect(ledger.reserve(request("one")).admitted).toBe(true);
    expect(ledger.reserve(request("two")).reason).toBe("CAPACITY_EXHAUSTED");
  });

  it("keeps the 8-Bit fleet projection isolated per connected user", () => {
    const fleet = new OllamaUserConnectedFreeFleet();
    const connection = (userId: string) => ({
      providerId: "ollama-cloud" as const,
      userId,
      authType: "API_KEY" as const,
      encryptedCredentialRef: `secure:${userId}`,
      supplyClass: "USER_CONNECTED_FREE" as const,
      capacityScope: "USER_ACCOUNT" as const,
      capacityPoolId: userConnectedPoolId(userId),
      capacityIdentity: hashUserAccountIdentity(userId),
      freeOnly: true as const,
      paidFallbackDisabled: true as const,
      status: "CONNECTED" as const,
      termsStatus: "USER_CONNECTED_FREE_ALLOWED" as const,
    });
    const model = {
      modelId: "gpt-oss:120b",
      canonicalModelId: "openai/gpt-oss-120b",
      family: "gpt-oss",
      roles: ["coder"],
    };

    fleet.connect(connection("user-a"), usage(), [model]);
    fleet.connect(connection("user-b"), usage(), [model]);

    expect(fleet.connectedUsers()).toEqual(["user-a", "user-b"]);
    expect(fleet.routesForUser("user-a")[0]?.capacityIdentity).toBe(hashUserAccountIdentity("user-a"));
    expect(fleet.routesForUser("user-a")[0]?.capacityIdentity).not.toBe(hashUserAccountIdentity("user-b"));
    expect(fleet.poolsForUser("user-a")[0]?.poolId).toBe(userConnectedPoolId("user-a"));
    expect(fleet.disconnect("user-b")).toBe(true);
    expect(fleet.routesForUser("user-a")).toHaveLength(1);
    expect(fleet.routesForUser("user-b")).toHaveLength(0);
  });

  it("models adoption as per-user capacity, not a central company pool", () => {
    const scenarios = simulateOllamaAdoption({ dailyActiveUsers: 373, includedUsageUsdPerUser: 2, taskUsageUsd: 1, sharedTasksPerDay: 100 });
    expect(scenarios.map((s) => s.connectedUsers)).toEqual([0, 37, 93, 186, 279]);
    expect(scenarios[0]?.additionalFreeTasks).toBe(0);
    expect(scenarios[4]?.additionalFreeTasks).toBe(558);
    expect(scenarios[4]?.sharedProviderPressureOffloaded).toBe(100);
  });
});
