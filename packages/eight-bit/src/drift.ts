import { z } from "zod";
import type { FreeModelRecord } from "@codeforge/forge-zero";
import type { RouteKey } from "./types.js";
import { routeKeyOf } from "./types.js";

export const CatalogDriftKindSchema = z.enum([
  "ROUTE_APPEARED",
  "ROUTE_DISAPPEARED",
  "ROUTE_RENAMED_OR_REPLACED",
  "FREE_TERMS_CHANGED",
  "CAPABILITIES_CHANGED",
  "ROUTE_STALE",
  "REPLACEMENT_PROMOTED",
]);
export type CatalogDriftKind = z.infer<typeof CatalogDriftKindSchema>;

export const CatalogDriftEventSchema = z.object({
  eventId: z.string().min(1),
  timestamp: z.string().datetime(),
  driftKind: CatalogDriftKindSchema,
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  reason: z.string().min(1),
  previousRoute: z.object({ providerId: z.string(), modelId: z.string() }).optional(),
  replacementRoute: z.object({ providerId: z.string(), modelId: z.string() }).optional(),
  evidence: z.record(z.unknown()).optional(),
});
export type CatalogDriftEvent = z.infer<typeof CatalogDriftEventSchema>;

export interface DetectCatalogDriftOptions {
  previousModels: FreeModelRecord[];
  currentModels: FreeModelRecord[];
  /** Optional explicit replacement map: "providerId::oldModelId" -> "providerId::newModelId" */
  knownReplacements?: Record<string, string>;
  /** Max age of free tier verification in milliseconds before classified as STALE (default: 7 days) */
  maxVerificationAgeMs?: number;
}

/**
 * 8-Bit catalog drift tracker.
 *
 * Observes and records provider catalog evolution over time:
 * - Route appeared (new free model offered)
 * - Route disappeared (upstream model retired or removed)
 * - Route renamed or replaced (model version bump / slug replacement)
 * - Free terms changed (transition from free to paid or vice versa)
 * - Capabilities changed (context length, tool support, structured output)
 * - Route became stale (free-verification age expired)
 * - Replacement promoted (active route rotated to qualified candidate)
 *
 * Invariant (§40): Temporary quota conditions (e.g. daily neuron exhaustion / HTTP 429)
 * are tracked in route health and NEVER treated as route removal or disappearance.
 */
export class CatalogDriftTracker {
  private readonly events: CatalogDriftEvent[] = [];

  recordDriftEvent(event: Omit<CatalogDriftEvent, "eventId" | "timestamp"> & { timestamp?: string; eventId?: string }): CatalogDriftEvent {
    const fullEvent: CatalogDriftEvent = {
      eventId: event.eventId ?? `drift-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: event.timestamp ?? new Date().toISOString(),
      ...event,
    };
    CatalogDriftEventSchema.parse(fullEvent);
    this.events.push(fullEvent);
    return fullEvent;
  }

  getDriftEvents(filter?: { providerId?: string; modelId?: string; driftKind?: CatalogDriftKind }): CatalogDriftEvent[] {
    return this.events.filter((e) => {
      if (filter?.providerId && e.providerId !== filter.providerId) return false;
      if (filter?.modelId && e.modelId !== filter.modelId) return false;
      if (filter?.driftKind && e.driftKind !== filter.driftKind) return false;
      return true;
    });
  }

  detectCatalogDrift(options: DetectCatalogDriftOptions): CatalogDriftEvent[] {
    const { previousModels, currentModels, knownReplacements = {}, maxVerificationAgeMs = 7 * 24 * 60 * 60 * 1000 } = options;
    const detected: CatalogDriftEvent[] = [];
    const prevMap = new Map<string, FreeModelRecord>();
    for (const m of previousModels) prevMap.set(routeKeyOf(m.providerId, m.modelId), m);
    const currMap = new Map<string, FreeModelRecord>();
    for (const m of currentModels) currMap.set(routeKeyOf(m.providerId, m.modelId), m);

    // 1. Detect newly appeared routes
    for (const [key, curr] of currMap.entries()) {
      if (!prevMap.has(key)) {
        detected.push(
          this.recordDriftEvent({
            driftKind: "ROUTE_APPEARED",
            providerId: curr.providerId,
            modelId: curr.modelId,
            reason: `New route ${key} appeared in provider free catalog`,
            evidence: {
              accessClass: curr.accessClass,
              contextWindow: curr.contextWindow,
              capabilities: curr.capabilities,
            },
          }),
        );
      }
    }

    // 2. Detect disappeared or replaced routes
    for (const [key, prev] of prevMap.entries()) {
      if (!currMap.has(key)) {
        // INVARIANT (§40): Do not treat temporary quota conditions as route removal!
        if (prev.health?.status === "quota_exhausted") {
          continue;
        }

        const replacementKey = knownReplacements[key];
        if (replacementKey && currMap.has(replacementKey)) {
          const repl = currMap.get(replacementKey)!;
          detected.push(
            this.recordDriftEvent({
              driftKind: "ROUTE_RENAMED_OR_REPLACED",
              providerId: prev.providerId,
              modelId: prev.modelId,
              reason: `Route ${key} was renamed or replaced upstream by ${replacementKey}`,
              previousRoute: { providerId: prev.providerId, modelId: prev.modelId },
              replacementRoute: { providerId: repl.providerId, modelId: repl.modelId },
              evidence: {
                previousKey: key,
                replacementKey,
              },
            }),
          );
        } else {
          detected.push(
            this.recordDriftEvent({
              driftKind: "ROUTE_DISAPPEARED",
              providerId: prev.providerId,
              modelId: prev.modelId,
              reason: `Route ${key} disappeared from provider catalog`,
              evidence: {
                lastSeenHealth: prev.health?.status ?? "unknown",
              },
            }),
          );
        }
      }
    }

    // 3. Detect terms, capability, and staleness changes for routes present in both
    const now = Date.now();
    for (const [key, curr] of currMap.entries()) {
      const prev = prevMap.get(key);
      if (!prev) continue;

      // Terms changed
      if (prev.accessClass !== curr.accessClass || prev.costProfile.isFree !== curr.costProfile.isFree) {
        detected.push(
          this.recordDriftEvent({
            driftKind: "FREE_TERMS_CHANGED",
            providerId: curr.providerId,
            modelId: curr.modelId,
            reason: `Free terms changed for ${key}: ${prev.accessClass} -> ${curr.accessClass}`,
            evidence: {
              previousAccessClass: prev.accessClass,
              currentAccessClass: curr.accessClass,
              previousIsFree: prev.costProfile.isFree,
              currentIsFree: curr.costProfile.isFree,
            },
          }),
        );
      }

      // Capabilities changed
      const capsChanged =
        prev.capabilities.toolCalling !== curr.capabilities.toolCalling ||
        prev.capabilities.structuredOutput !== curr.capabilities.structuredOutput ||
        prev.capabilities.vision !== curr.capabilities.vision ||
        prev.contextWindow !== curr.contextWindow;

      if (capsChanged) {
        detected.push(
          this.recordDriftEvent({
            driftKind: "CAPABILITIES_CHANGED",
            providerId: curr.providerId,
            modelId: curr.modelId,
            reason: `Capabilities changed for ${key}`,
            evidence: {
              previousCapabilities: prev.capabilities,
              currentCapabilities: curr.capabilities,
              previousContextWindow: prev.contextWindow,
              currentContextWindow: curr.contextWindow,
            },
          }),
        );
      }

      // Staleness check
      if (curr.freeStatusVerifiedAt) {
        const ageMs = now - new Date(curr.freeStatusVerifiedAt).getTime();
        if (ageMs > maxVerificationAgeMs) {
          detected.push(
            this.recordDriftEvent({
              driftKind: "ROUTE_STALE",
              providerId: curr.providerId,
              modelId: curr.modelId,
              reason: `Route ${key} free status verification has expired (${Math.floor(ageMs / 86400000)} days old)`,
              evidence: {
                freeStatusVerifiedAt: curr.freeStatusVerifiedAt,
                ageMs,
                maxVerificationAgeMs,
              },
            }),
          );
        }
      }
    }

    return detected;
  }

  recordPromotion(scope: { role: string; sessionId?: string }, previous: RouteKey, replacement: RouteKey, reason: string): CatalogDriftEvent {
    return this.recordDriftEvent({
      driftKind: "REPLACEMENT_PROMOTED",
      providerId: replacement.providerId,
      modelId: replacement.modelId,
      reason,
      previousRoute: previous,
      replacementRoute: replacement,
      evidence: {
        role: scope.role,
        sessionId: scope.sessionId,
      },
    });
  }
}
