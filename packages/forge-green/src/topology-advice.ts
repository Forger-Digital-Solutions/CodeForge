/**
 * ForgeGreen's provider-aware topology advice. It is intentionally a resource recommendation,
 * not a route-selection or eligibility authority: 8-Bit / ForgeAuto still decide whether an
 * individual free route can execute, and ForgeVerify remains required by every topology.
 */
export interface ProviderTopologyCapacity {
  /** Distinct healthy provider identities that may satisfy the assigned roles. */
  distinctHealthyProviders: number;
  /** Lowest current concurrency limit among routes contemplated for parallel work. */
  minimumRouteConcurrency: number;
  /** Number of otherwise known routes currently in a SATURATED state. */
  saturatedRoutes?: number;
}

/**
 * Production topologies plan at most 2 parallel agents today (`resolveAdaptiveTopology`). The
 * wider range exists so this advisory function stays correct and directly reusable — not
 * reimplemented — for research/ablation comparisons (R13 FG topology proof) that model larger
 * parallel counts before any such topology is ever proposed for production.
 */
export type PlannedParallelAgents = 1 | 2 | 3 | 4;

export interface ProviderTopologyAdvice {
  plannedParallelAgents: PlannedParallelAgents;
  recommendedParallelAgents: PlannedParallelAgents;
  shouldReduceParallelism: boolean;
  reasonCodes: string[];
}

export function adviseProviderAwareTopology(
  plannedParallelAgents: PlannedParallelAgents,
  capacity: ProviderTopologyCapacity | undefined,
): ProviderTopologyAdvice {
  if (!capacity) {
    return {
      plannedParallelAgents,
      recommendedParallelAgents: plannedParallelAgents,
      shouldReduceParallelism: false,
      reasonCodes: ["PROVIDER_CAPACITY_UNOBSERVED"],
    };
  }
  const reasons: string[] = [];
  if (!Number.isInteger(capacity.distinctHealthyProviders) || capacity.distinctHealthyProviders < 0 || !Number.isInteger(capacity.minimumRouteConcurrency) || capacity.minimumRouteConcurrency < 0) {
    return {
      plannedParallelAgents,
      recommendedParallelAgents: 1,
      shouldReduceParallelism: plannedParallelAgents > 1,
      reasonCodes: ["PROVIDER_CAPACITY_INVALID"],
    };
  }
  if ((capacity.saturatedRoutes ?? 0) > 0) reasons.push("SATURATED_ROUTE_EXCLUDED");
  if (plannedParallelAgents > capacity.minimumRouteConcurrency) reasons.push("CAPACITY_CONCURRENCY_LIMIT");
  if (plannedParallelAgents > capacity.distinctHealthyProviders) reasons.push("PROVIDER_CONCENTRATION");
  const shouldReduceParallelism = reasons.includes("CAPACITY_CONCURRENCY_LIMIT") || reasons.includes("PROVIDER_CONCENTRATION");
  // Step down to whatever the observed capacity can actually support rather than always
  // collapsing to solo — e.g. 4 planned against 2 distinct healthy providers recommends 2, not 1;
  // capacity that supports none of the plan (0 concurrency or 0 healthy providers) still floors at 1.
  const supportable = Math.max(1, Math.min(plannedParallelAgents, capacity.minimumRouteConcurrency, capacity.distinctHealthyProviders));
  const recommendedParallelAgents = (shouldReduceParallelism ? supportable : plannedParallelAgents) as PlannedParallelAgents;
  return {
    plannedParallelAgents,
    recommendedParallelAgents,
    shouldReduceParallelism,
    reasonCodes: reasons.length > 0 ? reasons : ["PROVIDER_CAPACITY_DIVERSE"],
  };
}
