import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import WorkflowProgress from "../src/WorkflowProgress.js";
import type { WorkspaceState } from "../src/workspace-sse.js";
import { initialWorkspaceState } from "../src/workspace-sse.js";

function makeState(overrides: Partial<WorkspaceState>): WorkspaceState {
  return { ...initialWorkspaceState, ...overrides } as WorkspaceState;
}

function markupFor(state: WorkspaceState): string {
  return renderToStaticMarkup(React.createElement(WorkflowProgress, { state, onCancel: () => {}, onApprove: () => {} }));
}

describe("WorkflowProgress — production UX trust signals", () => {
  it("renders nothing when no workflow active and no errors", () => {
    const state = makeState({ isRunning: false, activeTaskId: null, workflowError: null, lastWorkflowResult: null, pendingApproval: null, workflowActionError: null });
    const html = markupFor(state);
    expect(html).toBe("");
  });

  it("renders autonomous header and phase when workflow active", () => {
    const state = makeState({
      isRunning: true,
      activeTaskId: "task-12345678-90ab-cdef",
      activePhase: "implementing",
      workflowProgress: 55,
      workflowTasks: [{ taskId: "task-12345678-90ab-cdef", title: "Fix add function to return a + b", status: "implementing", phase: "implementing", progress: 55, createdAt: new Date().toISOString() }],
      pendingApproval: null,
    });
    const html = markupFor(state);
    expect(html).toContain("Autonomous Workflow");
    expect(html).toContain("Fix add function");
    expect(html).toContain("implementing");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("Workspace Isolated");
    expect(html).toContain("ForgeZero Verified Free");
    expect(html).toContain("Secrets Redacted");
  });

  it("shows approval panel when workflow approval is pending", () => {
    const state = makeState({
      isRunning: true,
      activeTaskId: "task-abc",
      activePhase: "user_input_required",
      workflowProgress: 38,
      workflowTasks: [{ taskId: "task-abc", title: "Implement feature", status: "user_input_required", phase: "user_input_required", progress: 38, createdAt: new Date().toISOString() }],
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
    expect(html).toContain("Plan Approval Required");
    expect(html).toContain("high");
    expect(html).toContain("Approve Plan");
    expect(html).toContain("Allow Session");
    expect(html).toContain("Deny");
  });

  it("shows error banner when workflowError present", () => {
    const state = makeState({
      activeTaskId: "task-err",
      workflowTasks: [{ taskId: "task-err", title: "Fix bug", status: "failed_safely", phase: "failed_safely", progress: 100, createdAt: new Date().toISOString() }],
      activePhase: "failed_safely",
      workflowProgress: 100,
      isRunning: false,
      workflowError: "Workflow timed out after 10 minutes",
    });
    const html = markupFor(state);
    expect(html).toContain("Workflow Notice");
    expect(html).toContain("timed out");
  });

  it("shows completed evidence/checkpoint trust footer", () => {
    const state = makeState({
      activeTaskId: "task-done",
      workflowTasks: [{ taskId: "task-done", title: "Completed task", status: "completed", phase: "completed", progress: 100, createdAt: new Date().toISOString() }],
      activePhase: "complete",
      workflowProgress: 100,
      isRunning: false,
      lastWorkflowResult: "# Workflow Summary for &quot;Completed task&quot;\nOutcome: Completed successfully",
      lastEvidenceId: "evidence-123",
      lastCheckpointId: "checkpoint-456",
    });
    const html = markupFor(state);
    expect(html).toContain("Verified");
    expect(html).toContain("Evidence evidence");
    expect(html).toContain("Checkpoint checkpo");
  });

  it("initialWorkspaceState has new workflow fields", () => {
    expect(initialWorkspaceState.workflowTasks).toEqual([]);
    expect(initialWorkspaceState.activeTaskId).toBeNull();
    expect(initialWorkspaceState.activePhase).toBe("idle");
    expect(initialWorkspaceState.workflowProgress).toBe(0);
    expect(initialWorkspaceState.workflowError).toBeNull();
    expect(initialWorkspaceState.workflowActionPending).toBe("none");
    expect(initialWorkspaceState.lastWorkflowResult).toBeNull();
  });

  it("shows concurrency hint when error mentions already running", () => {
    const state = makeState({
      activeTaskId: "task-1",
      workflowTasks: [{ taskId: "task-1", title: "First", status: "implementing", phase: "implementing", progress: 55, createdAt: new Date().toISOString() }],
      activePhase: "implementing",
      workflowProgress: 55,
      workflowActionError: "A workflow is already running for this session. Cancel or wait for it to complete.",
    });
    const html = markupFor(state);
    expect(html).toContain("Only one workflow may run per session");
  });

  it("trust footer lists invariants", () => {
    const state = makeState({
      isRunning: true,
      activeTaskId: "task-123",
      activePhase: "implementing",
      workflowProgress: 55,
      workflowTasks: [{ taskId: "task-123", title: "Task", status: "implementing", phase: "implementing", progress: 55, createdAt: new Date().toISOString() }],
    });
    const html = markupFor(state);
    expect(html).toContain("No paid inference");
    expect(html).toContain("Workspace-bound edits only");
    expect(html).toContain("Secret redaction throughout");
  });
});
