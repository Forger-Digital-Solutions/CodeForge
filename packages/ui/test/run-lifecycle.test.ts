import { describe, expect, it } from "vitest";
import type { WorkspaceEvent } from "@codeforge/protocol";
import {
  deriveRunLifecycle,
  lifecycleFromSessionRecord,
  presentRun,
  presentSessionSummary,
  TERMINAL_RUN_STATES,
  type RunLifecycle,
  type RunState,
} from "../src/run-lifecycle.js";

/**
 * The reducer + projection are the ONLY authority on run state. These tests pin the contract the
 * real smoke session violated: contradictory surfaces (sidebar "Failed" + header "Running" +
 * composer "Agent working") are impossible because every surface reads one presentation.
 */

let seq = 0;
function ev(type: string, payload: Record<string, unknown> = {}, at = "2026-09-19T10:00:00.000Z"): WorkspaceEvent {
  return { type, seq: ++seq, timestamp: at, sessionId: "s1", payload } as WorkspaceEvent;
}
function at(minute: number): string {
  return `2026-09-19T10:${String(minute).padStart(2, "0")}:00.000Z`;
}

/** The invariants a terminal run must satisfy on every surface at once. */
function expectFullySettled(presentation: ReturnType<typeof presentRun>): void {
  expect(presentation.spinner).toBe(false);
  expect(presentation.timer).toBe(false);
  expect(presentation.inProgress).toBe(false);
  expect(presentation.controls.pause).toBe(false);
  expect(presentation.controls.stop).toBe(false);
  expect(presentation.composer).toBe("send");
}

describe("deriveRunLifecycle — transitions", () => {
  it("QUEUED → ROUTING → RUNNING → COMPLETED (agent run)", () => {
    seq = 0;
    const events = [
      ev("execution.requested", { requestId: "r1", executionMode: "agent", runtime: "workflow" }, at(0)),
      ev("task.created", { taskId: "t1", title: "Fix the bug", mode: "autonomous" }, at(0)),
      ev("task.started", { taskId: "t1" }, at(0)),
      ev("turn.started", { turnId: "root", userMessage: "Fix the bug", origin: "user" }, at(0)),
      ev("task.state_changed", { taskId: "t1", from: "received", to: "implementing" }, at(1)),
      ev("task.state_changed", { taskId: "t1", from: "implementing", to: "complete" }, at(2)),
      ev("run.outcome", {
        runId: "t1", executionMode: "agent", outcome: "completed", reasonCode: "completed",
        summary: "Done.", execution: "completed", verification: "passed", review: "passed", completion: "completed",
      }, at(2)),
    ];
    const lifecycle = deriveRunLifecycle(events);
    expect(lifecycle.state).toBe("COMPLETED");
    expect(lifecycle.terminal).toBe(true);
    expect(lifecycle.runId).toBe("t1");
    expectFullySettled(presentRun(lifecycle));
  });

  it("RUNNING → VERIFYING → REPAIRING → VERIFYING → COMPLETED", () => {
    seq = 0;
    const seen: RunState[] = [];
    const feed = (events: WorkspaceEvent[]): RunLifecycle => {
      const lifecycle = deriveRunLifecycle(events);
      seen.push(lifecycle.state);
      return lifecycle;
    };
    const events: WorkspaceEvent[] = [
      ev("task.created", { taskId: "t1", title: "x", mode: "autonomous" }, at(0)),
      ev("task.started", { taskId: "t1" }, at(0)),
      ev("turn.started", { turnId: "root", userMessage: "x", origin: "user" }, at(0)),
    ];
    feed(events);
    events.push(ev("task.state_changed", { taskId: "t1", from: "implementing", to: "testing" }, at(1)));
    expect(feed(events).state).toBe("VERIFYING");
    events.push(ev("task.state_changed", { taskId: "t1", from: "testing", to: "repairing" }, at(2)));
    expect(feed(events).state).toBe("REPAIRING");
    events.push(ev("task.state_changed", { taskId: "t1", from: "repairing", to: "testing" }, at(3)));
    expect(feed(events).state).toBe("VERIFYING");
    events.push(ev("run.outcome", {
      runId: "t1", executionMode: "agent", outcome: "completed", reasonCode: "completed",
      summary: "Done.", execution: "completed", verification: "passed", review: "passed", completion: "completed",
    }, at(4)));
    const lifecycle = feed(events);
    expect(lifecycle.state).toBe("COMPLETED");
    expectFullySettled(presentRun(lifecycle));
  });

  it("RUNNING → VERIFYING → REPAIRING → VERIFYING → FAILED", () => {
    seq = 0;
    const events = [
      ev("task.created", { taskId: "t1", title: "x", mode: "autonomous" }, at(0)),
      ev("turn.started", { turnId: "root", userMessage: "x", origin: "user" }, at(0)),
      ev("task.state_changed", { taskId: "t1", from: "received", to: "testing" }, at(1)),
      ev("task.state_changed", { taskId: "t1", from: "testing", to: "repairing" }, at(2)),
      ev("task.state_changed", { taskId: "t1", from: "repairing", to: "testing" }, at(3)),
      ev("run.outcome", {
        runId: "t1", executionMode: "agent", outcome: "failed", reasonCode: "verification_failed",
        summary: "Required verification failed.", execution: "completed", verification: "failed", review: "passed", completion: "failed",
        failure: { code: "verification_failed", ownership: "runtime", message: "Required verification failed." },
      }, at(4)),
    ];
    const lifecycle = deriveRunLifecycle(events);
    expect(lifecycle.state).toBe("FAILED");
    expect(lifecycle.reasonCode).toBe("verification_failed");
    const presentation = presentRun(lifecycle);
    expect(presentation.label).toBe("Failed");
    expect(presentation.detail).toBe("Required verification failed");
    expectFullySettled(presentation);
  });

  it("RUNNING → REROUTING → RUNNING (8-Bit rotation mid-run)", () => {
    seq = 0;
    const events = [
      ev("turn.started", { turnId: "root", userMessage: "x", origin: "user" }, at(0)),
      ev("router.selection", { providerId: "p1", modelId: "m1" }, at(0)),
      ev("eightbit.status", { event: "ROUTE_ROTATION_STARTED", role: "agent", reasonCodes: ["RATE_LIMITED"], accessibleText: "Switching route" }, at(1)),
      ev("eightbit.status", { event: "ROUTE_READY", role: "agent", reasonCodes: [], accessibleText: "On p2", selected: { providerId: "p2", modelId: "m2" } }, at(2)),
      ev("turn.completed", { turnId: "root" }, at(3)),
    ];
    const mid = deriveRunLifecycle(events.slice(0, 3));
    expect(mid.state).toBe("REROUTING");
    expect(presentRun(mid).label).toBe("Switching route");
    const lifecycle = deriveRunLifecycle(events);
    expect(lifecycle.state).toBe("COMPLETED");
    expect(lifecycle.reroutes).toBe(1);
    expect(lifecycle.route).toEqual({ providerId: "p2", modelId: "m2" });
  });

  it("RUNNING → REROUTING → ROUTE_EXHAUSTED (no eligible free route)", () => {
    seq = 0;
    const events = [
      ev("turn.started", { turnId: "root", userMessage: "x", origin: "user" }, at(0)),
      ev("eightbit.status", { event: "NO_ELIGIBLE_FREE_MODEL", role: "agent", reasonCodes: ["ALL_ROUTES_UNHEALTHY"], accessibleText: "No eligible free route" }, at(1)),
      ev("turn.failed", {
        turnId: "root", error: "no eligible free route",
        failure: { code: "route_exhausted", ownership: "managed_free", message: "No eligible verified-free route is currently available." },
      }, at(2)),
    ];
    const lifecycle = deriveRunLifecycle(events);
    expect(lifecycle.state).toBe("ROUTE_EXHAUSTED");
    const presentation = presentRun(lifecycle);
    expect(presentation.label).toBe("No free route available");
    expect(presentation.detail).toContain("no paid or unknown-cost route");
    expectFullySettled(presentation);
  });

  it("RUNNING → PAUSED → RUNNING", () => {
    seq = 0;
    const base = [
      ev("turn.started", { turnId: "root", userMessage: "x", origin: "user" }, at(0)),
    ];
    expect(deriveRunLifecycle(base).state).not.toBe("IDLE");
    const paused = deriveRunLifecycle([...base, ev("turn.paused", { turnId: "root" }, at(1))]);
    expect(paused.state).toBe("PAUSED");
    const p = presentRun(paused);
    expect(p.spinner).toBe(false);
    expect(p.timer).toBe(false);
    expect(p.controls.resume).toBe(true);
    const resumed = deriveRunLifecycle([...base, ev("turn.paused", { turnId: "root" }, at(1)), ev("turn.resumed", { turnId: "root" }, at(2))]);
    expect(resumed.state).toBe("RUNNING");
    expect(presentRun(resumed).spinner).toBe(true);
  });

  it("RUNNING → CANCELLED (user stop)", () => {
    seq = 0;
    const events = [
      ev("turn.started", { turnId: "root", userMessage: "x", origin: "user" }, at(0)),
      ev("turn.cancelled", { turnId: "root", reason: "User stopped" }, at(1)),
    ];
    const lifecycle = deriveRunLifecycle(events);
    expect(lifecycle.state).toBe("CANCELLED");
    const p = presentRun(lifecycle);
    expect(p.label).toBe("Stopped");
    expect(p.detail).toBe("Stopped by you");
    expectFullySettled(p);
  });

  it("RUNNING → BLOCKED (completion gate refuses)", () => {
    seq = 0;
    const events = [
      ev("task.created", { taskId: "t1", title: "x", mode: "autonomous" }, at(0)),
      ev("turn.started", { turnId: "root", userMessage: "x", origin: "user" }, at(0)),
      ev("run.outcome", {
        runId: "t1", executionMode: "agent", outcome: "blocked", reasonCode: "verification_not_run",
        summary: "Verification did not run.", execution: "completed", verification: "not_run", review: "not_run", completion: "blocked",
      }, at(2)),
    ];
    const lifecycle = deriveRunLifecycle(events);
    expect(lifecycle.state).toBe("BLOCKED");
    const p = presentRun(lifecycle);
    expect(p.label).toBe("Blocked");
    expect(p.detail).toBe("Verification did not run");
    expectFullySettled(p);
  });

  it("an approval wait suspends the active presentation without ending the run", () => {
    seq = 0;
    const events = [
      ev("turn.started", { turnId: "root", userMessage: "x", origin: "user" }, at(0)),
      ev("approval.requested", { approvalId: "a1", tool: "write", action: "edit", description: "d", risk: "moderate" }, at(1)),
    ];
    const lifecycle = deriveRunLifecycle(events);
    expect(lifecycle.state).toBe("WAITING_FOR_APPROVAL");
    const p = presentRun(lifecycle);
    expect(p.spinner).toBe(false);
    expect(p.inProgress).toBe(true);
    expect(p.composer).toBe("approve");
    expect(p.label).toBe("Needs your approval");
    const resolved = deriveRunLifecycle([...events, ev("approval.resolved", { approvalId: "a1", decision: "allow_once" }, at(2))]);
    expect(resolved.state).toBe("RUNNING");
  });
});

describe("deriveRunLifecycle — terminal latch", () => {
  it("no bookkeeping event revives a finished run; only a new request starts a new run", () => {
    seq = 0;
    const events = [
      ev("turn.started", { turnId: "root", userMessage: "x", origin: "user" }, at(0)),
      ev("turn.failed", { turnId: "root", error: "boom", failure: { code: "unknown", ownership: "runtime", message: "boom" } }, at(1)),
      // Late-arriving bookkeeping that used to flip surfaces back to "Running":
      ev("task.state_changed", { taskId: "t1", from: "x", to: "testing" }, at(2)),
      ev("turn.paused", { turnId: "root" }, at(2)),
      ev("eightbit.status", { event: "ROUTE_ROTATION_STARTED", role: "agent", reasonCodes: [], accessibleText: "" }, at(2)),
    ];
    const lifecycle = deriveRunLifecycle(events);
    expect(lifecycle.state).toBe("FAILED");
    expect(lifecycle.terminal).toBe(true);
    expectFullySettled(presentRun(lifecycle));
    // A NEW request starts a new run even inside the same session's event list.
    const next = deriveRunLifecycle([...events, ev("execution.requested", { requestId: "r2", executionMode: "agent", runtime: "workflow" }, at(3))]);
    expect(next.state).toBe("QUEUED");
    expect(next.terminal).toBe(false);
  });

  it("workflow internal turns never end the run; the workflow's own outcome does", () => {
    seq = 0;
    const events = [
      ev("task.created", { taskId: "t1", title: "x", mode: "autonomous" }, at(0)),
      ev("turn.started", { turnId: "root", userMessage: "x", origin: "user" }, at(0)),
      ev("turn.started", { turnId: "impl-1", userMessage: "internal", origin: "workflow" }, at(1)),
      // An implement turn failing is a STEP failing — the workflow decides what happens next.
      ev("turn.failed", { turnId: "impl-1", error: "provider 500" }, at(2)),
      ev("task.state_changed", { taskId: "t1", from: "implementing", to: "repairing" }, at(3)),
    ];
    const lifecycle = deriveRunLifecycle(events);
    expect(lifecycle.state).toBe("REPAIRING");
    expect(lifecycle.terminal).toBe(false);
    expect(lifecycle.attempt).toBe(1);
  });
});

describe("presentRun — contradiction invariants", () => {
  const allStates: RunState[] = [
    "IDLE", "QUEUED", "ROUTING", "RUNNING", "WAITING_FOR_APPROVAL", "WAITING_FOR_INPUT",
    "VERIFYING", "REPAIRING", "REVIEWING", "REROUTING", "PAUSED", "INTERRUPTED",
    "COMPLETED", "FAILED", "BLOCKED", "CANCELLED", "ROUTE_EXHAUSTED",
  ];

  it("terminal state ⇒ no spinner, no timer, no pause, no stop, composer ready", () => {
    for (const state of allStates) {
      const lifecycle = { state, terminal: TERMINAL_RUN_STATES.has(state), active: false, waitingOnUser: false, attempt: 1, reroutes: 0 } as RunLifecycle;
      const p = presentRun(lifecycle);
      if (lifecycle.terminal) {
        expect(p.spinner, `${state} spinner`).toBe(false);
        expect(p.timer, `${state} timer`).toBe(false);
        expect(p.controls.pause, `${state} pause`).toBe(false);
        expect(p.controls.stop, `${state} stop`).toBe(false);
        expect(p.inProgress, `${state} inProgress`).toBe(false);
        expect(p.composer, `${state} composer`).toBe("send");
      }
    }
  });

  it("non-terminal ⇒ label and sidebar status never claim a terminal word", () => {
    for (const state of allStates) {
      if (TERMINAL_RUN_STATES.has(state)) continue;
      const p = presentRun({ state, terminal: false, active: true, waitingOnUser: false, attempt: 1, reroutes: 0 } as RunLifecycle);
      expect(["Failed", "Completed", "Blocked", "Stopped", "No free route available"]).not.toContain(p.label);
    }
  });

  it("the earlier real-world contradiction cannot be represented: FAILED + working indicator", () => {
    const p = presentRun({ state: "FAILED", terminal: true, active: false, waitingOnUser: false, attempt: 1, reroutes: 0, reasonCode: "verification_failed" } as RunLifecycle);
    expect(p.label).toBe("Failed");
    expect(p.spinner).toBe(false);
    expect(p.sidebarStatus).toBe("Failed");
  });
});

describe("lifecycleFromSessionRecord — restored truth", () => {
  const record = (status: string, outcome?: string) => ({
    id: "s1", title: "T", createdAt: at(0), updatedAt: at(1), status: status as never, outcome,
  });

  it("a restored failed session presents FAILED, never working", () => {
    const lifecycle = lifecycleFromSessionRecord(record("failed", "verification_failed"), [
      { id: "t1", sessionId: "s1", seq: 1, userMessage: "x", status: "failed", error: "tests failed", startedAt: at(0), completedAt: at(1) },
    ])!;
    expect(lifecycle.state).toBe("FAILED");
    expect(lifecycle.restored).toBe(true);
    expectFullySettled(presentRun(lifecycle));
  });

  it("a restored route-exhausted session presents ROUTE_EXHAUSTED", () => {
    const lifecycle = lifecycleFromSessionRecord(record("failed", "route_exhausted"), [])!;
    expect(lifecycle.state).toBe("ROUTE_EXHAUSTED");
    expect(presentRun(lifecycle).label).toBe("No free route available");
  });

  it("a running record with no in-flight turn is INTERRUPTED, not running", () => {
    const lifecycle = lifecycleFromSessionRecord(record("running"), [])!;
    expect(lifecycle.state).toBe("INTERRUPTED");
    expect(presentRun(lifecycle).spinner).toBe(false);
  });
});

describe("presentSessionSummary — sidebar vocabulary", () => {
  it("distinguishes route exhaustion from generic failure", () => {
    expect(presentSessionSummary({ status: "failed", outcome: "route_exhausted" }).label).toBe("No free route");
    expect(presentSessionSummary({ status: "failed", outcome: "verification_failed" }).label).toBe("Failed");
    expect(presentSessionSummary({ status: "failed", outcome: "plan_steps_unfinished" }).label).toBe("Blocked");
    expect(presentSessionSummary({ status: "cancelled" }).label).toBe("Stopped");
    expect(presentSessionSummary({ status: "running" }).tone).toBe("active");
  });
});
