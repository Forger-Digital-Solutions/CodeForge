import { describe, expect, it } from "vitest";
import type { CapacityRoute, ProviderCapacityPool } from "@codeforge/forge-zero";
import type { EightBitRouteHealthAuthority, RouteHealthAssessment } from "@codeforge/eight-bit";
import { buildCapacityConfidence, evaluateMissionAdmission, TOPOLOGY_CALL_ESTIMATE, type CapacityConfidenceReport } from "../src/capacity-confidence.js";
import type { TopologyCapacityProjection } from "../src/provider-topology-capacity.js";

const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);

function route(providerId: string, modelId: string, poolId: string): CapacityRoute {
  return {
    routeId: `fabric:${providerId}:${modelId}`,
    providerId,
    modelId,
    canonicalModelId: modelId,
    family: "test",
    gateway: providerId,
    supplyClass: "PURE_MANAGED_FREE",
    capacityPoolId: poolId,
    capacityPoolScope: "SHARED_OWNER_POOL",
    capacityScope: "ORG",
    dataPolicyProfile: "PRIVATE_CODE_ALLOWED",
    lifecycle: "APPROVED",
    explicitZeroPrice: true,
    paidFallbackDisabled: true,
    managedMultiUserAllowed: true,
    privacyClass: "standard",
    roles: [],
    qualityScore: 50,
    healthy: true,
    enabled: true,
    windows: [],
  } as CapacityRoute;
}

function pool(poolId: string, providerId: string, windows: Array<Partial<ProviderCapacityPool["windows"][number]>> = []): ProviderCapacityPool {
  return {
    poolId,
    providerId,
    scope: "SHARED_OWNER_POOL",
    supplyClass: "PURE_MANAGED_FREE",
    windows: windows.map((w) => ({
      unit: "requests",
      limit: 100,
      remaining: 50,
      resetAt: new Date(NOW + 3_600_000).toISOString(),
      scope: "ORG",
      observedAt: new Date(NOW).toISOString(),
      authoritative: true,
      ...w,
    })) as ProviderCapacityPool["windows"],
    observedAt: new Date(NOW).toISOString(),
    authoritative: true,
  };
}

function assessment(state: RouteHealthAssessment["state"], opts: { expiresAt?: number; hardExclude?: boolean } = {}): RouteHealthAssessment {
  return {
    providerId: "p", modelId: "m", state,
    hardExclude: opts.hardExclude ?? false,
    scoreAdjustment: 0, confidence: 0.8, reasonCodes: [], sampleSize: 3,
    activeConditions: state === "HEALTHY" || state === "UNKNOWN" ? [] : [{ state, since: new Date(NOW - 60_000).toISOString(), expiresAt: opts.expiresAt ?? NOW + 300_000, confidence: 0.8, sampleSize: 1, reasonCode: state }],
    window: { calls: 3, successes: 2, failures: 1, rateLimits: 1, capacityErrors: 0, malformedToolCalls: 0, toolCalls: 1, latencyP50Ms: 100, latencyP95Ms: 200 },
    ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
  } as RouteHealthAssessment;
}

function fixture(input: {
  routes: CapacityRoute[];
  pools?: ProviderCapacityPool[];
  states: Record<string, RouteHealthAssessment>;
  holds?: Record<string, number>;
}): CapacityConfidenceReport {
  const projection: TopologyCapacityProjection = {
    capacityRoutes: () => input.routes,
    capacityPools: () => input.pools ?? [],
    routesForUser: () => [],
  };
  const routeHealth = {
    assess: (providerId: string, modelId: string) => input.states[`${providerId}/${modelId}`] ?? assessment("UNKNOWN"),
  } as unknown as EightBitRouteHealthAuthority;
  const freeFabric = input.holds ? { reservationSnapshot: () => ({ byPool: input.holds }) } as unknown as FreeFabric : undefined;
  return buildCapacityConfidence({ freeCloud: projection, routeHealth, freeFabric, now: () => NOW });
}

import type { FreeFabric } from "@codeforge/eight-bit";

describe("R46 §12 capacity confidence + §13/§16 mission admission", () => {
  it("A: provider-scoped 429 cools the whole shared pool — admission parks instead of sibling churn", () => {
    // OpenRouter-style shared account: model A 429s, siblings B/C share the account bucket.
    const conf = fixture({
      routes: [route("openrouter", "a", "shared:openrouter"), route("openrouter", "b", "shared:openrouter"), route("openrouter", "c", "shared:openrouter")],
      pools: [pool("shared:openrouter", "openrouter")],
      states: {
        "openrouter/a": assessment("RATE_LIMITED", { expiresAt: NOW + 600_000 }),
        "openrouter/b": assessment("RATE_LIMITED", { expiresAt: NOW + 600_000 }),
        "openrouter/c": assessment("RATE_LIMITED", { expiresAt: NOW + 600_000 }),
      },
    });
    const verdict = evaluateMissionAdmission({ topology: "normal", confidence: conf });
    expect(verdict.verdict).toBe("TEMPORARILY_PARKED");
    const poolState = conf.pools.find((p) => p.poolId === "shared:openrouter")!;
    expect(poolState.state).toBe("COOLDOWN");
    expect(poolState.earliestRecoveryAtMs).toBe(NOW + 600_000);
  });

  it("B: model-scoped 429 leaves an independent model quota pool usable", () => {
    // Groq-style per-model windows: model A limited, model B independent.
    const conf = fixture({
      routes: [route("groq", "a", "shared:groq:model:a"), route("groq", "b", "shared:groq:model:b")],
      pools: [pool("shared:groq:model:a", "groq"), pool("shared:groq:model:b", "groq")],
      states: {
        "groq/a": assessment("RATE_LIMITED", { expiresAt: NOW + 120_000 }),
        "groq/b": assessment("HEALTHY"),
      },
    });
    const verdict = evaluateMissionAdmission({ topology: "normal", confidence: conf });
    expect(verdict.verdict).toBe("ADMIT");
    expect(conf.pools.find((p) => p.poolId === "shared:groq:model:b")!.state).toBe("HEALTHY");
  });

  it("C: dead provider + healthy provider admits on the healthy pool", () => {
    const conf = fixture({
      routes: [route("openrouter", "a", "shared:openrouter"), route("mistral", "m1", "shared:mistral")],
      pools: [pool("shared:openrouter", "openrouter"), pool("shared:mistral", "mistral")],
      states: {
        "openrouter/a": assessment("DAILY_QUOTA_EXHAUSTED", { expiresAt: null as unknown as number }),
        "mistral/m1": assessment("HEALTHY"),
      },
    });
    const verdict = evaluateMissionAdmission({ topology: "normal", confidence: conf });
    expect(verdict.verdict).toBe("ADMIT");
    expect(conf.pools.find((p) => p.providerId === "openrouter")!.state).toBe("EXHAUSTED");
    expect(conf.usablePools.map((p) => p.providerId)).toEqual(["mistral"]);
  });

  it("D: all pools cooling reports the earliest recovery, not a false fail-closed", () => {
    const conf = fixture({
      routes: [route("openrouter", "a", "shared:openrouter"), route("groq", "b", "shared:groq")],
      pools: [pool("shared:openrouter", "openrouter"), pool("shared:groq", "groq")],
      states: {
        "openrouter/a": assessment("RATE_LIMITED", { expiresAt: NOW + 90_000 }),
        "groq/b": assessment("RATE_LIMITED", { expiresAt: NOW + 45_000 }),
      },
    });
    const verdict = evaluateMissionAdmission({ topology: "normal", confidence: conf });
    expect(verdict.verdict).toBe("TEMPORARILY_PARKED");
    if (verdict.verdict === "TEMPORARILY_PARKED") {
      expect(verdict.earliestRecoveryAtMs).toBe(NOW + 45_000);
    }
  });

  it("E: provable window below the plan's call need parks — the verify tail is priced in", () => {
    const conf = fixture({
      routes: [route("mistral", "m1", "shared:mistral")],
      pools: [pool("shared:mistral", "mistral", [{ remaining: 3 }])],
      states: { "mistral/m1": assessment("HEALTHY") },
    });
    const verdict = evaluateMissionAdmission({ topology: "complex", confidence: conf });
    // complex ≈ 8 calls; a 3-call provider window cannot cover the plan + verify tail.
    expect(verdict.verdict).toBe("TEMPORARILY_PARKED");
    if (verdict.verdict === "TEMPORARILY_PARKED") expect(verdict.provableCalls).toBe(3);
  });

  it("E2: provable window covering the plan admits with the accounting visible", () => {
    const conf = fixture({
      routes: [route("mistral", "m1", "shared:mistral"), route("groq", "g1", "shared:groq")],
      pools: [pool("shared:mistral", "mistral", [{ remaining: 8 }]), pool("shared:groq", "groq", [{ remaining: 4 }])],
      states: { "mistral/m1": assessment("HEALTHY"), "groq/g1": assessment("HEALTHY") },
    });
    const verdict = evaluateMissionAdmission({ topology: "normal", confidence: conf });
    expect(verdict.verdict).toBe("ADMIT");
    if (verdict.verdict === "ADMIT") expect(verdict.provableCalls).toBe(12);
  });

  it("holds against a pool subtract from provable capacity", () => {
    const conf = fixture({
      routes: [route("mistral", "m1", "shared:mistral")],
      pools: [pool("shared:mistral", "mistral", [{ remaining: 6 }])],
      states: { "mistral/m1": assessment("HEALTHY") },
      holds: { "shared:mistral": 4 },
    });
    const verdict = evaluateMissionAdmission({ topology: "normal", confidence: conf });
    // 6 declared − 4 held = 2 provable < 6 required → parked, not double-spent.
    expect(verdict.verdict).toBe("TEMPORARILY_PARKED");
  });

  it("unmeasured capacity admits honestly — the fabric fails closed per turn, we never park on a guess", () => {
    const conf = fixture({
      routes: [route("openrouter", "a", "shared:openrouter")],
      states: { "openrouter/a": assessment("HEALTHY") },
    });
    const verdict = evaluateMissionAdmission({ topology: "complex", confidence: conf });
    expect(verdict.verdict).toBe("ADMIT");
  });

  it("zero admissible routes is NO_FREE_CAPACITY, not a park", () => {
    const conf = fixture({
      routes: [route("openrouter", "a", "shared:openrouter")],
      pools: [pool("shared:openrouter", "openrouter")],
      states: { "openrouter/a": assessment("DAILY_QUOTA_EXHAUSTED", { expiresAt: null as unknown as number }) },
    });
    const verdict = evaluateMissionAdmission({ topology: "tiny", confidence: conf });
    expect(verdict.verdict).toBe("NO_FREE_CAPACITY");
  });

  it("topology call estimates stay aligned with the R45 measurements", () => {
    expect(TOPOLOGY_CALL_ESTIMATE.tiny).toBe(4);
    expect(TOPOLOGY_CALL_ESTIMATE.normal).toBe(6);
    expect(TOPOLOGY_CALL_ESTIMATE.complex).toBe(8);
  });
});
