import type { WorkspaceEvent } from "@codeforge/protocol";
import type { ActivityAssetName } from "./emoji-assets.js";

/**
 * 8-Bit runtime → UI status mapping. Mandatory direction only: authoritative backend event →
 * semantic mapping → certified asset. This module never decides routing/health/eligibility —
 * it only renders what the backend already decided. A missing/unrecognized event maps to a
 * safe neutral fallback and never throws; nothing here can affect runtime state.
 *
 * Reuses the certified 8-bit "personality/provider" assets already shipped in
 * packages/ui/src/assets/activity-emoji/8bit/20/ (see emoji-assets.ts `ASSET_URLS`) — no new
 * artwork, no modification to the standalone pack.
 */

export type EightBitStatusEventType =
  | "CATALOG_SCAN_STARTED"
  | "ROUTE_DEGRADED"
  | "ROUTE_COOLDOWN"
  | "PROVIDER_OFFLINE"
  | "PROVIDER_ONLINE"
  | "FREE_ELIGIBILITY_REMOVED"
  | "ROUTE_ROTATION_STARTED"
  | "ROUTE_ROTATED"
  | "ROUTE_READY"
  | "NO_ELIGIBLE_FREE_MODEL";

export interface EightBitStatusPayload {
  event: EightBitStatusEventType;
  role: string;
  previous?: { providerId: string; modelId: string };
  selected?: { providerId: string; modelId: string };
  reasonCodes: string[];
  accessibleText: string;
}

const EVENT_ASSET_MAP: Record<EightBitStatusEventType, ActivityAssetName> = {
  CATALOG_SCAN_STARTED: "8bit-loading",
  ROUTE_DEGRADED: "8bit-warning",
  ROUTE_COOLDOWN: "8bit-waiting",
  PROVIDER_OFFLINE: "8bit-offline",
  PROVIDER_ONLINE: "8bit-online",
  FREE_ELIGIBILITY_REMOVED: "8bit-warning",
  ROUTE_ROTATION_STARTED: "8bit-swapping-model",
  ROUTE_ROTATED: "8bit-success",
  ROUTE_READY: "8bit-online",
  NO_ELIGIBLE_FREE_MODEL: "8bit-error",
};

/** Safe fallback for any event value this build does not recognize (e.g. an older client
 * talking to a newer server). Never throws, never blocks rendering. */
const FALLBACK_ASSET: ActivityAssetName = "8bit-tool-use";

export function resolveEightBitStatusAsset(event: string): ActivityAssetName {
  return (EVENT_ASSET_MAP as Record<string, ActivityAssetName>)[event] ?? FALLBACK_ASSET;
}

export function isEightBitStatusEvent(e: WorkspaceEvent): e is Extract<WorkspaceEvent, { type: "eightbit.status" }> {
  return e.type === "eightbit.status";
}

/** Latest 8-Bit status derived from a live event stream — pure, deterministic, and safe to
 * call every render. Returns undefined when no 8-Bit event has occurred yet (nothing to show,
 * not an error state). */
export function deriveLatestEightBitStatus(events: WorkspaceEvent[] | undefined): EightBitStatusPayload | undefined {
  if (!events || events.length === 0) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && isEightBitStatusEvent(e)) return e.payload as EightBitStatusPayload;
  }
  return undefined;
}
