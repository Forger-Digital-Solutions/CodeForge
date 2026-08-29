import type { WorkspaceEvent } from "@codeforge/protocol";

/**
 * Session isolation predicate. A workspace event is accepted into the active view only when it
 * belongs to the active session AND is newer than the last-seen seq. This prevents Session A's
 * live stream from bleeding into Session B when the user switches conversations, and prevents
 * duplicate rendering across SSE reconnects/replays.
 */
export function isEventForSession(
  event: Pick<WorkspaceEvent, "sessionId" | "seq">,
  activeSessionId: string,
  lastSeq: number,
): boolean {
  if (event.sessionId !== activeSessionId) return false;
  if (event.seq <= lastSeq) return false;
  return true;
}

/**
 * Append an event to the list, deduped by seq (idempotent across replays). Returns the same
 * array reference when the event is a duplicate so callers can skip a re-render.
 */
export function mergeEvent(events: WorkspaceEvent[], event: WorkspaceEvent): WorkspaceEvent[] {
  if (events.some((e) => e.seq === event.seq && e.sessionId === event.sessionId)) return events;
  return [...events, event];
}
