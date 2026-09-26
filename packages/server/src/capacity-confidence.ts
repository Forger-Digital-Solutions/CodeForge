import type { CapacityRoute, ProviderCapacityPool } from "@codeforge/forge-zero";
import type { EightBitRouteHealthAuthority, FreeFabric } from "@codeforge/eight-bit";
import type { TopologyCapacityProjection } from "./provider-topology-capacity.js";

/**
 * R46 §12: bounded, interpretable capacity confidence. Every state is explained by the
 * evidence behind it — never a score. Route states come from the route-health authority's
 * measured conditions; pool states aggregate the sibling routes that share one physical
 * quota bucket, so a provider-wide 429 is not mistaken for twenty independent failures.
 */
export type CapacityConfidence =
  | "HEALTHY"
  | "LIKELY_AVAILABLE"
  | "UNCERTAIN"
  | "PRESSURED"
  | "COOLDOWN"
  | "EXHAUSTED"
  | "UNKNOWN";

export interface RouteConfidence {
  providerId: string;
  modelId: string;
  poolId: string;
  state: CapacityConfidence;
  reasons: string[];
  /** Epoch ms after which a transient state recovers, when evidence supplies one. */
  recoverAtMs?: number;
}

export interface PoolConfidence {
  poolId: string;
  providerId: string;
  state: CapacityConfidence;
  reasons: string[];
  /** Provider-stated or measured request budget left in this bucket, when declared. */
  provableRemainingCalls?: number;
  /** Active fabric holds against this bucket — capacity already spoken for. */
  activeHolds: number;
  earliestRecoveryAtMs?: number;
}

export interface CapacityConfidenceReport {
  routes: RouteConfidence[];
  pools: PoolConfidence[];
  /** Routes whose evidence does not currently exclude them. */
  admissibleRoutes: RouteConfidence[];
  /** Pools with at least one admissible route and no terminal exhaustion evidence. */
  usablePools: PoolConfidence[];
}

const COOLDOWN_STATES = new Set(["RATE_LIMITED", "SATURATED", "TEMPORARY_CAPACITY", "DEGRADED"]);
const EXHAUSTED_STATES = new Set(["DAILY_QUOTA_EXHAUSTED", "QUOTA_EXHAUSTED"]);
const UNUSABLE_STATES = new Set(["COOLDOWN", "EXHAUSTED"]);

export function buildCapacityConfidence(input: {
  freeCloud: TopologyCapacityProjection;
  routeHealth: EightBitRouteHealthAuthority;
  freeFabric?: FreeFabric;
  localUserId?: string;
  now?: () => number;
}): CapacityConfidenceReport {
  const { freeCloud, routeHealth, freeFabric, localUserId } = input;
  const now = (input.now ?? Date.now)();
  const routes: CapacityRoute[] = [
    ...freeCloud.capacityRoutes().filter((route) => route.capacityPoolScope !== "PER_USER_POOL"),
    ...(localUserId ? freeCloud.routesForUser(localUserId) : []),
  ];
  const holds = freeFabric?.reservationSnapshot()?.byPool ?? {};

  const routeStates = routes.map((route): RouteConfidence => {
    const reasons: string[] = [];
    if (!route.healthy) reasons.push("registry marks route unhealthy/ineligible");
    const assessment = routeHealth.assess(route.providerId, route.modelId, { now });
    if (assessment.hardExclude) reasons.push(`health hard-exclude (${assessment.state})`);
    const active = assessment.activeConditions.find((c) => c.expiresAt === null || c.expiresAt > now);
    let state: CapacityConfidence;
    if (assessment.state === "UNKNOWN" && assessment.lastObservedAt === undefined) {
      state = "UNKNOWN";
      reasons.push("no measured traffic for this route");
    } else if (assessment.state === "HEALTHY") {
      state = "HEALTHY";
      reasons.push(`healthy; ${assessment.window.successes} observed success(es)`);
    } else if (active && EXHAUSTED_STATES.has(assessment.state)) {
      state = "EXHAUSTED";
      reasons.push(`${assessment.state} since ${active.since}`);
    } else if (COOLDOWN_STATES.has(assessment.state)) {
      state = "COOLDOWN";
      reasons.push(`${assessment.state} since ${active?.since ?? "?"}`);
    } else if (assessment.state === "UNKNOWN") {
      state = "UNCERTAIN";
      reasons.push("measured evidence too thin for a confident call");
    } else {
      // Capability/authority exclusions (AUTH_REQUIRED, QUARANTINED, MODEL_RETIRED, ...)
      // make the route simply inadmissible — UNKNOWN keeps the wording honest.
      state = "UNKNOWN";
      reasons.push(`route state ${assessment.state}`);
    }
    const recoverAtMs = active?.expiresAt ?? undefined;
    return { providerId: route.providerId, modelId: route.modelId, poolId: route.capacityPoolId, state, reasons, ...(recoverAtMs !== undefined ? { recoverAtMs } : {}) };
  });

  const poolsById = new Map<string, ProviderCapacityPool>(freeCloud.capacityPools().map((pool) => [pool.poolId, pool]));
  const poolRoutes = new Map<string, RouteConfidence[]>();
  for (const route of routeStates) {
    const list = poolRoutes.get(route.poolId) ?? [];
    list.push(route);
    poolRoutes.set(route.poolId, list);
  }

  const pools: PoolConfidence[] = [];
  for (const [poolId, siblings] of poolRoutes) {
    const pool = poolsById.get(poolId);
    const activeHolds = holds[poolId] ?? 0;
    const reqWindow = pool?.windows.find((w) => w.unit === "requests" && w.authoritative);
    const provable = reqWindow !== undefined ? Math.max(0, reqWindow.remaining - activeHolds) : undefined;
    const reasons: string[] = [];
    const usable = siblings.filter((r) => !UNUSABLE_STATES.has(r.state));
    let state: CapacityConfidence;
    let earliestRecoveryAtMs: number | undefined;
    if (provable === 0) {
      state = "EXHAUSTED";
      reasons.push("provider-stated request window fully consumed");
    } else if (usable.length === 0) {
      if (siblings.every((r) => r.state === "EXHAUSTED")) {
        state = "EXHAUSTED";
        reasons.push("every route on this pool reports quota exhaustion");
      } else {
        state = "COOLDOWN";
        earliestRecoveryAtMs = Math.min(...siblings.map((r) => r.recoverAtMs ?? Number.POSITIVE_INFINITY));
        if (!Number.isFinite(earliestRecoveryAtMs)) earliestRecoveryAtMs = undefined;
        reasons.push(`all ${siblings.length} sibling routes share this pool's cooldown`);
      }
    } else if (usable.every((r) => r.state === "HEALTHY")) {
      state = "HEALTHY";
      reasons.push(`${usable.length}/${siblings.length} routes healthy`);
    } else {
      state = "LIKELY_AVAILABLE";
      reasons.push(`${usable.length}/${siblings.length} routes usable; ${siblings.length - usable.length} pressured or exhausted`);
    }
    pools.push({ poolId, providerId: pool?.providerId ?? siblings[0]!.providerId, state, reasons, ...(provable !== undefined ? { provableRemainingCalls: provable } : {}), activeHolds, ...(earliestRecoveryAtMs !== undefined ? { earliestRecoveryAtMs } : {}) });
  }

  const admissibleRoutes = routeStates.filter((r) => !UNUSABLE_STATES.has(r.state));
  const usablePools = pools.filter((p) => p.state !== "EXHAUSTED" && p.state !== "COOLDOWN");
  return { routes: routeStates, pools, admissibleRoutes, usablePools };
}

/** R45-measured topology call economics — observed harness values, not provider truth. */
export const TOPOLOGY_CALL_ESTIMATE: Readonly<Record<string, number>> = {
  tiny: 4,
  normal: 6,
  complex: 8,
  vision: 6,
  fixed_r1: 8,
};

export type MissionAdmissionVerdict =
  | { verdict: "ADMIT"; reason: string; provableCalls?: number; requiredCalls: number }
  | { verdict: "TEMPORARILY_PARKED"; reason: string; earliestRecoveryAtMs?: number; provableCalls?: number; requiredCalls: number }
  | { verdict: "NO_FREE_CAPACITY"; reason: string; provableCalls?: number; requiredCalls: number };

/**
 * R46 §13/§16: mission-aware admission. The gate only refuses when insufficiency is provable —
 * zero admissible routes, every usable pool cooling/exhausted, or every pool's provider-stated
 * remaining window below the topology's measured call need. Unmeasured capacity is admitted
 * (the fabric fails closed per turn if the guess was wrong); we never park on a guess.
 * `requiredCalls` covers the whole plan — including the ForgeVerify tail — because admitting
 * only the next request is exactly how the verify tail starves.
 */
export function evaluateMissionAdmission(input: {
  topology: string;
  confidence: CapacityConfidenceReport;
  requiredCalls?: number;
}): MissionAdmissionVerdict {
  const requiredCalls = input.requiredCalls ?? TOPOLOGY_CALL_ESTIMATE[input.topology] ?? 6;
  const { confidence } = input;
  if (confidence.usablePools.length === 0) {
    // No pool can serve a call right now. Park when supply is provably recovering
    // (a cooldown with an expiry, or a cooling pool without one); EXHAUSTED pools
    // recover on provider quota timescales a mission cannot wait out, so all-exhausted
    // supply is honest NO_FREE_CAPACITY, not a park.
    const cooling = confidence.pools.filter((p) => p.state !== "EXHAUSTED");
    const timed = cooling.map((p) => p.earliestRecoveryAtMs).filter((t): t is number => t !== undefined);
    const earliest = timed.length > 0 ? Math.min(...timed) : undefined;
    if (cooling.length > 0) {
      return {
        verdict: "TEMPORARILY_PARKED",
        reason: "every independent quota pool is cooling or windowless — launching now would burn zero calls against real work",
        ...(earliest !== undefined ? { earliestRecoveryAtMs: earliest } : {}),
        requiredCalls,
      };
    }
    return {
      verdict: "NO_FREE_CAPACITY",
      reason: confidence.admissibleRoutes.length === 0
        ? "no admissible free route: every verified-free route is exhausted or excluded"
        : "no usable independent quota pool remains",
      requiredCalls,
    };
  }
  // Provable-window check only applies when EVERY usable pool declares a request window —
  // a provider that never reports remaining quota cannot prove insufficiency.
  const measured = confidence.usablePools.every((p) => p.provableRemainingCalls !== undefined);
  if (measured) {
    const provableCalls = confidence.usablePools.reduce((sum, p) => sum + (p.provableRemainingCalls ?? 0), 0);
    if (provableCalls === 0) {
      return { verdict: "NO_FREE_CAPACITY", reason: "all usable pools report zero remaining requests in provider windows", provableCalls, requiredCalls };
    }
    if (provableCalls < requiredCalls) {
      return { verdict: "TEMPORARILY_PARKED", reason: `provable window (${provableCalls} calls) cannot cover the ${input.topology} plan (~${requiredCalls} calls incl. verification tail)`, provableCalls, requiredCalls };
    }
    return { verdict: "ADMIT", reason: `provable window covers plan (${provableCalls} >= ~${requiredCalls})`, provableCalls, requiredCalls };
  }
  const measuredCalls = confidence.usablePools.reduce((sum, p) => sum + (p.provableRemainingCalls ?? 0), 0);
  return { verdict: "ADMIT", reason: `${confidence.usablePools.length} usable pool(s); capacity unmeasured — fabric enforces per-turn admission`, ...(measuredCalls > 0 ? { provableCalls: measuredCalls } : {}), requiredCalls };
}
