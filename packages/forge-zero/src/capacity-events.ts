import type { CapacityEvent } from "./capacity-types.js";

export function isCapacityEventActive(event: CapacityEvent, at = Date.now()): boolean {
  return Date.parse(event.startsAt) <= at && at < Date.parse(event.endsAt);
}

export function activeEventRouteIds(events: readonly CapacityEvent[], at = Date.now()): readonly string[] {
  return [...new Set(events.filter((event) => isCapacityEventActive(event, at)).flatMap((event) => event.routeIds))];
}

export function eventFallbackRouteIds(events: readonly CapacityEvent[], at = Date.now()): readonly string[] {
  return [...new Set(events.filter((event) => !isCapacityEventActive(event, at)).flatMap((event) => event.fallbackRouteIds))];
}
