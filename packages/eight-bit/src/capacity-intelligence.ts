import {
  DEFAULT_FREE_CAPACITY_POLICY,
  forecastCapacity,
  isFreeRouteEligible,
  type CapacityForecast,
  type CapacityForecastInput,
  type CapacityRoute,
} from "@codeforge/forge-zero";

export interface EightBitCapacityRecommendation {
  advisory: true;
  role: string;
  routeId?: string;
  reason: string;
}

/**
 * 8-Bit can rank capacity, but ForgeZero remains the hard authority for eligibility and spend.
 * This boundary prevents a learned or heuristic recommendation from turning into paid routing.
 */
export class EightBitCapacityIntelligence {
  forecast(input: CapacityForecastInput): CapacityForecast {
    return forecastCapacity(input);
  }

  recommend(routes: readonly CapacityRoute[], role: string): EightBitCapacityRecommendation {
    const candidates = routes
      .filter((route) => route.roles.includes(role) && isFreeRouteEligible(route, DEFAULT_FREE_CAPACITY_POLICY))
      .sort((left, right) => right.qualityScore - left.qualityScore || left.routeId.localeCompare(right.routeId));
    const selected = candidates[0];
    return selected
      ? { advisory: true, role, routeId: selected.routeId, reason: "QUALITY_ORDERED_FREE_ROUTE" }
      : { advisory: true, role, reason: "NO_ELIGIBLE_FREE_ROUTE" };
  }
}

export function createEightBitCapacityIntelligence(): EightBitCapacityIntelligence {
  return new EightBitCapacityIntelligence();
}
