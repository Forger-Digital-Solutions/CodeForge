export interface ForgeActivityState {
  isRunning: boolean;
  isPaused: boolean;
  activePhase: string;
  pendingApproval: unknown;
  isEventStreamConnected: boolean;
}

/** Presentation-only projection of authoritative runtime state. */
export function isForgeWorkActive(state: ForgeActivityState): boolean {
  if (!state.isRunning || state.isPaused || !state.isEventStreamConnected || state.pendingApproval) return false;
  return !["awaiting_approval", "complete", "completed", "failed", "failed_safely", "cancelled"].includes(state.activePhase);
}
