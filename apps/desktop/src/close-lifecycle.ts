/**
 * Pure decision logic for the window-close/quit/tray lifecycle, extracted out of `main.ts` so it
 * has direct unit-test coverage instead of relying solely on manual verification of Electron
 * main-process code (which cannot run outside a real Electron process in this environment). Also
 * shared with `CloseDialog.tsx` (via `summarizeActiveWork`) so the dialog and the tray tooltip
 * describe active work identically — one canonical description, not two that could drift.
 */

export type CloseBehavior = "ask" | "tray" | "quit-safe";
export type CloseAction = "quit" | "tray" | "ask";

export interface CloseActionStatus {
  activeWork: boolean;
  recoverable: boolean;
}

/**
 * The core close-request policy matrix. Given the authoritative runtime status and the user's
 * persisted close preference, decides what `requestClose()` should do — independent of the
 * surrounding Electron mechanics (whether a window exists, IPC, etc.), which `main.ts` still
 * handles itself.
 *
 * Truth table:
 *  - No active work                      -> behavior "tray" ? tray : quit (nothing to protect,
 *                                            respect the user's normal preference)
 *  - Active work, recoverable, "tray"     -> tray (silently, no dialog — already the remembered choice)
 *  - Active work, recoverable, "quit-safe"-> quit (silently — already the remembered choice)
 *  - Anything else (unrecoverable, or
 *    behavior is "ask")                   -> ask (show the dialog)
 */
export function resolveCloseAction(status: CloseActionStatus, behavior: CloseBehavior): CloseAction {
  if (!status.activeWork) {
    return behavior === "tray" ? "tray" : "quit";
  }
  if (status.recoverable && behavior === "tray") return "tray";
  if (status.recoverable && behavior === "quit-safe") return "quit";
  return "ask";
}

export interface ActiveWorkCounts {
  activeWorkflows: number;
  activeAgentTurns: number;
  activeCommands: number;
  pendingApprovals: number;
  activeVerifications: number;
  hostedContinuations: number;
  backgroundTasks: number;
}

/** Human-readable breakdown of what's active, used by both the close dialog and the tray tooltip. */
export function summarizeActiveWork(status: ActiveWorkCounts): string {
  const items: string[] = [];
  if (status.activeWorkflows) items.push(`${status.activeWorkflows} workflow${status.activeWorkflows === 1 ? "" : "s"}`);
  if (status.activeAgentTurns) items.push(`${status.activeAgentTurns} agent turn${status.activeAgentTurns === 1 ? "" : "s"}`);
  if (status.activeCommands) items.push(`${status.activeCommands} local command${status.activeCommands === 1 ? "" : "s"}`);
  if (status.pendingApprovals) items.push(`${status.pendingApprovals} approval${status.pendingApprovals === 1 ? "" : "s"}`);
  if (status.activeVerifications) items.push(`${status.activeVerifications} verification${status.activeVerifications === 1 ? "" : "s"}`);
  if (status.hostedContinuations) items.push(`${status.hostedContinuations} hosted continuation${status.hostedContinuations === 1 ? "" : "s"}`);
  if (status.backgroundTasks) items.push(`${status.backgroundTasks} background task${status.backgroundTasks === 1 ? "" : "s"}`);
  return items.join(" · ") || "Background state is being saved.";
}

/**
 * Compact count for the tray tooltip / header badge — running work only, deliberately excluding
 * `pendingApprovals` (something waiting ON the user isn't "running", it's paused) so "N tasks
 * running" never overstates what's actually executing right now.
 */
export function countRunningWork(status: ActiveWorkCounts): number {
  return (
    status.activeWorkflows +
    status.activeAgentTurns +
    status.activeCommands +
    status.activeVerifications +
    status.hostedContinuations +
    status.backgroundTasks
  );
}

/**
 * Compact label for the persistent header activity indicator (R2 GAP-6). The header stays mounted
 * while Settings is open, so this indicator keeps a live agent run visible even though the workspace
 * SSE view is unmounted underneath Settings — the user always knows work is still executing and has
 * an affordance to return to it. Running work and pending approvals are surfaced separately because
 * an approval is waiting ON the user, not executing. Returns null when there is nothing to show, so
 * the header stays clean (no permanent telemetry) whenever the runtime is idle.
 */
export function describeHeaderActivity(status: ActiveWorkCounts): string | null {
  const running = countRunningTasks(status);
  const approvals = status.pendingApprovals;
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} task${running === 1 ? "" : "s"} running`);
  if (approvals > 0) parts.push(`${approvals} approval${approvals === 1 ? "" : "s"} pending`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Running work counted the way a user thinks about it — as tasks. A workflow OWNS the agent turn,
 * commands and verifications it dispatches, so one autonomous task must read as one task, not as
 * "3 running" (workflow + its turn + its command). Agent turns beyond the active workflows are
 * standalone chat turns and count on their own; hosted continuations and background tasks (repository
 * indexing) are separate lines of work.
 */
export function countRunningTasks(status: ActiveWorkCounts): number {
  const standaloneTurns = Math.max(0, status.activeAgentTurns - status.activeWorkflows);
  const ownedByTurns = status.activeWorkflows + standaloneTurns;
  // Commands/verifications without any owning turn or workflow (e.g. a verification the user
  // triggered directly) still count as work in progress.
  const orphanUnits = ownedByTurns === 0 ? Math.min(1, status.activeCommands + status.activeVerifications) : 0;
  return ownedByTurns + orphanUnits + status.hostedContinuations + status.backgroundTasks;
}
