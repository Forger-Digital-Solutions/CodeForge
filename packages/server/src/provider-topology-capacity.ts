import type { ProviderTopologyCapacity } from "@codeforge/forge-green";
import type { CapacityRoute, ProviderCapacityPool } from "@codeforge/forge-zero";
import type { EightBitRouteHealthAuthority, FreeFabric } from "@codeforge/eight-bit";

/** The slice of the Free Cloud registry topology advice reads — FreeCloudService satisfies it. */
export interface TopologyCapacityProjection {
  capacityRoutes(): CapacityRoute[];
  capacityPools(): ProviderCapacityPool[];
  routesForUser(userId: string): CapacityRoute[];
}

/**
 * R24: the live provider-capacity view ForgeGreen topology advice consumes. It reflects the
 * same universe the Free Fabric's decide() sees for the requesting user — shared/managed pools
 * plus per-user pools the stamped owner actually holds — so a topology never plans parallel
 * work against capacity the run could not be admitted to.
 *
 * Only provably concurrent capacity justifies parallel spawn: a pool with no declared
 * concurrency window contributes its one provably-safe stream minus live holds, and
 * health-hard-excluded routes do not count. Returns undefined when no Free Cloud registry is
 * attached — capacity is then honestly UNOBSERVED rather than guessed.
 */
export function buildProviderTopologyCapacity(input: {
  freeCloud: TopologyCapacityProjection | undefined;
  routeHealth: EightBitRouteHealthAuthority;
  freeFabric?: FreeFabric;
  /** Fairness identity owning per-user pools; when absent they are correctly invisible. */
  localUserId?: string;
}): ProviderTopologyCapacity | undefined {
  const { freeCloud, routeHealth, freeFabric, localUserId } = input;
  if (!freeCloud) return undefined;
  const routes = [
    ...freeCloud.capacityRoutes().filter((route) => route.capacityPoolScope !== "PER_USER_POOL"),
    ...(localUserId ? freeCloud.routesForUser(localUserId) : []),
  ];
  const admissible = routes.filter((route) => route.healthy && !routeHealth.assess(route.providerId, route.modelId, {}).hardExclude);
  const saturatedRoutes = admissible.filter((route) => routeHealth.assess(route.providerId, route.modelId, {}).state === "SATURATED").length;
  if (admissible.length === 0) {
    return { distinctHealthyProviders: 0, minimumRouteConcurrency: 0, saturatedRoutes };
  }
  const holds = freeFabric?.reservationSnapshot()?.byPool ?? {};
  const poolsById = new Map(freeCloud.capacityPools().map((pool) => [pool.poolId, pool]));
  const concurrencyByPool = new Map<string, number>();
  for (const route of admissible) {
    if (concurrencyByPool.has(route.capacityPoolId)) continue;
    const window = poolsById.get(route.capacityPoolId)?.windows.find((w) => w.unit === "concurrency");
    concurrencyByPool.set(route.capacityPoolId, Math.max(0, (window?.remaining ?? 1) - (holds[route.capacityPoolId] ?? 0)));
  }
  return {
    distinctHealthyProviders: new Set(admissible.map((route) => route.providerId)).size,
    minimumRouteConcurrency: Math.min(...concurrencyByPool.values()),
    saturatedRoutes,
  };
}
