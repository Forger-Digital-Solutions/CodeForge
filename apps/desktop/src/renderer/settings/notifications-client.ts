import type { AppSettings } from "../../app-settings.js";
import type { DesktopRuntimeStatus } from "./settings-context.js";

/**
 * Pure notification policy for OS notifications about agent work. The renderer polls the
 * authoritative runtime status (the same source the close-safety dialog uses) and runs it through
 * `computeWorkNotifications`; anything returned is shown via the `notifications:show` bridge.
 * Approval/failure signals always remain visible inside the app regardless of these preferences —
 * these are an extra signal, never the only one.
 */

export type NotificationPrefs = Pick<
  AppSettings["notifications"],
  "enabled" | "onApprovalNeeded" | "onAgentCompleted" | "onlyWhenInBackground"
>;

export type WorkNotificationKind = "approval_needed" | "agent_completed";

export interface WorkNotification {
  kind: WorkNotificationKind;
  title: string;
  body: string;
}

export type RunningCounters = Pick<
  DesktopRuntimeStatus,
  "activeWorkflows" | "activeAgentTurns" | "activeCommands" | "activeVerifications" | "hostedContinuations" | "backgroundTasks" | "pendingApprovals"
>;

export function countRunningWork(status: RunningCounters): number {
  return (
    status.activeWorkflows +
    status.activeAgentTurns +
    status.activeCommands +
    status.activeVerifications +
    status.hostedContinuations +
    status.backgroundTasks
  );
}

export function computeWorkNotifications(
  previous: RunningCounters | null,
  next: RunningCounters,
  prefs: NotificationPrefs,
  windowFocused: boolean,
): WorkNotification[] {
  if (!prefs.enabled) return [];
  // Notifications are a background signal. While the user is looking at CodeForge the app's own
  // approval bars and banners are the right surface, so "only when in background" (the default)
  // suppresses redundant OS toasts.
  if (prefs.onlyWhenInBackground && windowFocused) return [];

  const notifications: WorkNotification[] = [];
  const runningNow = countRunningWork(next);

  if (prefs.onApprovalNeeded && next.pendingApprovals > (previous?.pendingApprovals ?? 0)) {
    const count = next.pendingApprovals;
    notifications.push({
      kind: "approval_needed",
      title: "Agent needs your approval",
      body: `${count} approval request${count === 1 ? "" : "s"} waiting in CodeForge.`,
    });
  }

  const wasRunning = previous ? countRunningWork(previous) > 0 : false;
  if (prefs.onAgentCompleted && wasRunning && runningNow === 0 && next.pendingApprovals === 0) {
    notifications.push({
      kind: "agent_completed",
      title: "CodeForge work finished",
      body: "Agent work is no longer running. Open CodeForge to review the results.",
    });
  }

  return notifications;
}
