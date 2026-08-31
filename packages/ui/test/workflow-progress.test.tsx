import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import WorkflowProgress, { PHASES, phaseIndex } from "../src/WorkflowProgress.js";
import type { WorkspaceState } from "../src/workspace-sse.js";
import { initialWorkspaceState } from "../src/workspace-sse.js";

function makeState(overrides: Partial<WorkspaceState>): WorkspaceState {
  return { ...initialWorkspaceState, ...overrides } as WorkspaceState;
}

function markupFor(state: WorkspaceState, expanded = false): string {
  return renderToStaticMarkup(
    React.createElement(WorkflowProgress, { state, onCancel: () => {}, onApprove: () => {}, expanded }),
  );
}

describe("WorkflowProgress — compact workflow stages", () => {
  it("renders nothing when no workflow active and no errors", () => {
    const state = makeState({
      isRunning: false,
      activeTaskId: null,
      workflowError: null,
      lastWorkflowResult: null,
      pendingApproval: null,
      workflowActionError: null,
    });
    const html = markupFor(state);
    expect(html).toBe("");
  });

  it("renders compact working status when active", () => {
    const state = makeState({
      isRunning: true,
      activeTaskId: "task-123",
      activePhase: "implementing",
      workflowProgress: 55,
    });
    const html = markupFor(state);
    expect(html).toContain("Working · implementing");
    expect(html).toContain("Cancel");
  });

  it("renders all stages when expanded", () => {
    const state = makeState({
      isRunning: true,
      activeTaskId: "task-123",
      activePhase: "implementing",
      workflowProgress: 55,
    });
    const html = markupFor(state, true);
    expect(html).toContain("workflow-stages-list");
    expect(html).toContain("Received");
    expect(html).toContain("Reconnaissance");
    expect(html).toContain("Planning");
    expect(html).toContain("Implementing");
    expect(html).toContain("Verifying");
    expect(html).toContain("Completed");
  });

  /**
   * This panel reports that the workflow is parked on a decision; it must NOT offer a second set of
   * approval buttons. Rendering the same approval as several independent cards — this panel, the
   * approval bar, and the transcript — made one decision look like three, and left the user unsure
   * which one the agent was actually waiting on. The decision lives in ApprovalBar alone.
   */
  it("reports that it is awaiting a decision without duplicating the approval control", () => {
    const state = makeState({
      isRunning: true,
      activeTaskId: "task-abc",
      activePhase: "user_input_required",
      pendingApproval: {
        kind: "approval",
        id: "appr-1",
        sessionId: "sess-1",
        tool: "workflow",
        action: "execute_plan",
        description: "Execute plan plan-123: Implement multi-file feature",
        risk: "high",
        scope: "/workspace/my-project",
        createdAt: new Date().toISOString(),
      },
    });
    const html = markupFor(state);
    // It says what is being waited on...
    expect(html).toContain("execute_plan");
    expect(html).toContain("Waiting for your decision");
    // ...and offers no competing way to decide it.
    expect(html).not.toContain("Approve Plan");
    expect(html).not.toContain("Allow Session");
    expect(html).not.toContain("Deny");
  });

  it("renders terminal completed status correctly", () => {
    const state = makeState({
      activeTaskId: "task-done",
      activePhase: "complete",
      isRunning: false,
      lastWorkflowResult: "Done",
    });
    const html = markupFor(state);
    expect(html).toContain(`Completed · ${PHASES.length}/${PHASES.length} stages`);
  });

  it("renders failed safely status", () => {
    const state = makeState({
      activeTaskId: "task-err",
      activePhase: "failed_safely",
      isRunning: false,
      workflowError: "Workflow timed out after 10 minutes",
    });
    const html = markupFor(state);
    expect(html).toContain("Failed safely");
  });

  it("phaseIndex correctly maps standard and legacy phases", () => {
    expect(phaseIndex("received")).toBe(0);
    expect(phaseIndex("planning")).toBe(2);
    expect(phaseIndex("implementing")).toBe(4);
    expect(phaseIndex("testing")).toBe(5);
    expect(phaseIndex("verifying")).toBe(5);
    expect(phaseIndex("complete")).toBe(10);
    expect(phaseIndex("completed")).toBe(10);
    expect(phaseIndex("unknown_phase")).toBe(-1);
  });

  it("initialWorkspaceState has workflow fields", () => {
    expect(initialWorkspaceState.workflowTasks).toEqual([]);
    expect(initialWorkspaceState.activeTaskId).toBeNull();
    expect(initialWorkspaceState.activePhase).toBe("idle");
    expect(initialWorkspaceState.workflowProgress).toBe(0);
    expect(initialWorkspaceState.workflowError).toBeNull();
    expect(initialWorkspaceState.workflowActionPending).toBe("none");
    expect(initialWorkspaceState.lastWorkflowResult).toBeNull();
  });
});
