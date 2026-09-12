import { describe, it, expect } from "vitest";
import { resolveCloseAction, summarizeActiveWork, countRunningWork, describeHeaderActivity } from "../src/close-lifecycle.js";

const ZERO = {
  activeWorkflows: 0,
  activeAgentTurns: 0,
  activeCommands: 0,
  pendingApprovals: 0,
  activeVerifications: 0,
  hostedContinuations: 0,
  backgroundTasks: 0,
};

const NO_WORK = { activeWork: false, recoverable: true };
const RECOVERABLE_WORK = { activeWork: true, recoverable: true };
const UNRECOVERABLE_WORK = { activeWork: true, recoverable: false };

describe("resolveCloseAction", () => {
  it("quits normally when no work is active and preference is not tray", () => {
    expect(resolveCloseAction(NO_WORK, "ask")).toBe("quit");
    expect(resolveCloseAction(NO_WORK, "quit-safe")).toBe("quit");
  });

  it("minimizes to tray when no work is active but the user prefers tray", () => {
    expect(resolveCloseAction(NO_WORK, "tray")).toBe("tray");
  });

  it("silently minimizes to tray for recoverable active work when that is the remembered preference — no dialog", () => {
    expect(resolveCloseAction(RECOVERABLE_WORK, "tray")).toBe("tray");
  });

  it("silently quits safely for recoverable active work when that is the remembered preference — no dialog", () => {
    expect(resolveCloseAction(RECOVERABLE_WORK, "quit-safe")).toBe("quit");
  });

  it("asks (shows the safe-close dialog) for recoverable active work when preference is 'ask'", () => {
    expect(resolveCloseAction(RECOVERABLE_WORK, "ask")).toBe("ask");
  });

  it("NEVER silently quits or minimizes when work is unrecoverable — always asks, regardless of remembered preference", () => {
    // This is the critical safety property: a remembered "tray" or "quit-safe" preference must
    // never be allowed to silently discard work CodeForge cannot safely preserve.
    expect(resolveCloseAction(UNRECOVERABLE_WORK, "tray")).toBe("ask");
    expect(resolveCloseAction(UNRECOVERABLE_WORK, "quit-safe")).toBe("ask");
    expect(resolveCloseAction(UNRECOVERABLE_WORK, "ask")).toBe("ask");
  });
});

describe("summarizeActiveWork", () => {
  it("lists only the non-zero categories, correctly pluralized", () => {
    expect(
      summarizeActiveWork({
        activeWorkflows: 1,
        activeAgentTurns: 2,
        activeCommands: 0,
        pendingApprovals: 0,
        activeVerifications: 0,
        hostedContinuations: 0,
        backgroundTasks: 0,
      }),
    ).toBe("1 workflow · 2 agent turns");
  });

  it("falls back to a generic message when every counter is zero", () => {
    expect(
      summarizeActiveWork({
        activeWorkflows: 0,
        activeAgentTurns: 0,
        activeCommands: 0,
        pendingApprovals: 0,
        activeVerifications: 0,
        hostedContinuations: 0,
        backgroundTasks: 0,
      }),
    ).toBe("Background state is being saved.");
  });
});

describe("countRunningWork", () => {
  it("excludes pendingApprovals — something waiting on the user isn't 'running'", () => {
    const count = countRunningWork({
      activeWorkflows: 1,
      activeAgentTurns: 0,
      activeCommands: 0,
      pendingApprovals: 5,
      activeVerifications: 0,
      hostedContinuations: 0,
      backgroundTasks: 0,
    });
    expect(count).toBe(1);
  });

  it("sums every actually-running category", () => {
    const count = countRunningWork({
      activeWorkflows: 1,
      activeAgentTurns: 2,
      activeCommands: 3,
      pendingApprovals: 0,
      activeVerifications: 1,
      hostedContinuations: 1,
      backgroundTasks: 1,
    });
    expect(count).toBe(9);
  });
});

describe("describeHeaderActivity (R2 GAP-6 header indicator)", () => {
  it("returns null when the runtime is idle — header stays clean", () => {
    expect(describeHeaderActivity(ZERO)).toBeNull();
  });

  it("counts running work as tasks: a turn and the command it is running are one task", () => {
    expect(describeHeaderActivity({ ...ZERO, activeAgentTurns: 1, activeCommands: 1 })).toBe("1 task running");
  });

  it("folds a workflow's own agent turn, command and verification into one task", () => {
    // The live packaged run showed "2 running" for a single autonomous task: the workflow plus
    // the builder turn it dispatched. One task is one task.
    expect(describeHeaderActivity({ ...ZERO, activeWorkflows: 1, activeAgentTurns: 1, activeCommands: 1 })).toBe("1 task running");
    expect(describeHeaderActivity({ ...ZERO, activeWorkflows: 1, activeAgentTurns: 1, activeVerifications: 1 })).toBe("1 task running");
    // A standalone chat turn next to a workflow is a second task.
    expect(describeHeaderActivity({ ...ZERO, activeWorkflows: 1, activeAgentTurns: 2 })).toBe("2 tasks running");
    // Background indexing and hosted continuations are their own lines of work.
    expect(describeHeaderActivity({ ...ZERO, activeWorkflows: 1, activeAgentTurns: 1, backgroundTasks: 1 })).toBe("2 tasks running");
    expect(describeHeaderActivity({ ...ZERO, activeVerifications: 1 })).toBe("1 task running");
  });

  it("surfaces pending approvals separately from running work (an approval waits on the user)", () => {
    expect(describeHeaderActivity({ ...ZERO, activeWorkflows: 1, pendingApprovals: 1 })).toBe("1 task running · 1 approval pending");
    expect(describeHeaderActivity({ ...ZERO, pendingApprovals: 2 })).toBe("2 approvals pending");
  });
});
