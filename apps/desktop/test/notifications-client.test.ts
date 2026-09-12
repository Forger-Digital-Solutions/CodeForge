import { describe, expect, it } from "vitest";
import { computeWorkNotifications, countRunningWork, type RunningCounters } from "../src/renderer/settings/notifications-client.js";
import { FIXTURE_SETTINGS } from "./settings-test-harness.js";

const PREFERENCES = FIXTURE_SETTINGS.notifications;

const IDLE: RunningCounters = {
  activeWorkflows: 0, activeAgentTurns: 0, activeCommands: 0,
  pendingApprovals: 0, activeVerifications: 0, hostedContinuations: 0, backgroundTasks: 0,
};

const BUSY: RunningCounters = {
  activeWorkflows: 1, activeAgentTurns: 1, activeCommands: 0,
  pendingApprovals: 0, activeVerifications: 0, hostedContinuations: 0, backgroundTasks: 0,
};

const AWAITING_APPROVAL: RunningCounters = { ...BUSY, pendingApprovals: 1 };

describe("notification counting", () => {
  it("counts running work but excludes approvals waiting on the user", () => {
    expect(countRunningWork(BUSY)).toBe(2);
    expect(countRunningWork(AWAITING_APPROVAL)).toBe(2);
    expect(countRunningWork(IDLE)).toBe(0);
  });
});

describe("computeWorkNotifications", () => {
  it("notifies when a new approval request appears while the window is in the background", () => {
    const notifications = computeWorkNotifications(BUSY, AWAITING_APPROVAL, PREFERENCES, false);
    expect(notifications.map((n) => n.kind)).toEqual(["approval_needed"]);
    expect(notifications[0]!.body).toContain("1 approval request");
  });

  it("does not re-notify for unchanged approval counts", () => {
    expect(computeWorkNotifications(AWAITING_APPROVAL, AWAITING_APPROVAL, PREFERENCES, false)).toEqual([]);
  });

  it("notifies when work finishes and nothing is left running or waiting", () => {
    const notifications = computeWorkNotifications(BUSY, IDLE, PREFERENCES, false);
    expect(notifications.map((n) => n.kind)).toEqual(["agent_completed"]);
  });

  it("stays silent when work finishes but an approval is still pending", () => {
    const notifications = computeWorkNotifications(BUSY, { ...IDLE, pendingApprovals: 1 }, PREFERENCES, false);
    // The approval-needed signal covers it; a "finished" toast would be wrong.
    expect(notifications.map((n) => n.kind)).toEqual(["approval_needed"]);
  });

  it("suppresses everything while the window is focused under the default background-only policy", () => {
    expect(computeWorkNotifications(BUSY, AWAITING_APPROVAL, PREFERENCES, true)).toEqual([]);
    expect(computeWorkNotifications(BUSY, IDLE, PREFERENCES, true)).toEqual([]);
  });

  it("notifies while focused when the user opted out of background-only", () => {
    const prefs = { ...PREFERENCES, onlyWhenInBackground: false };
    expect(computeWorkNotifications(BUSY, AWAITING_APPROVAL, prefs, true).map((n) => n.kind)).toEqual(["approval_needed"]);
  });

  it("respects the master switch and per-class toggles", () => {
    expect(computeWorkNotifications(BUSY, AWAITING_APPROVAL, { ...PREFERENCES, enabled: false }, false)).toEqual([]);
    expect(
      computeWorkNotifications(BUSY, AWAITING_APPROVAL, { ...PREFERENCES, onApprovalNeeded: false }, false),
      // approval notifications off + nothing finished -> silent
    ).toEqual([]);
    expect(
      computeWorkNotifications(BUSY, IDLE, { ...PREFERENCES, onAgentCompleted: false }, false),
    ).toEqual([]);
  });

  it("treats a first observation with no previous state as no completion", () => {
    expect(computeWorkNotifications(null, IDLE, PREFERENCES, false)).toEqual([]);
  });
});
