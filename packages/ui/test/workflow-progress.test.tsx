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

  it("renders `blocked` as a terminal state, not as still-running work", () => {
    const state = makeState({
      isRunning: false,
      activeTaskId: "task-blocked",
      activePhase: "blocked",
    });
    const html = markupFor(state);
    expect(html).toContain("Blocked · not verified");
    expect(html).not.toContain("Working ·");
    expect(phaseIndex("blocked")).toBeGreaterThanOrEqual(0);
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

  it("renders an Agent start failure with its code and no phantom execution evidence", () => {
    const state = makeState({
      activeTaskId: null,
      activePhase: "failed_to_start",
      isRunning: false,
      workflowError: "Agent could not start\nWorkspace lease conflict",
      events: [{
        type: "execution.start_failed", sessionId: "session", seq: 1, timestamp: "2026-09-04T00:00:00.000Z",
        payload: { requestId: "request", executionMode: "agent", code: "WORKSPACE_LEASE_CONFLICT", message: "Workspace lease conflict" },
      }] as WorkspaceState["events"],
    });
    const html = markupFor(state, true);
    expect(html).toContain("Agent could not start");
    expect(html).toContain("WORKSPACE_LEASE_CONFLICT");
    expect(html).toContain("No files changed · No tools executed · No verification ran");
    expect(html).not.toContain("Implementing");
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

  it("renders live parallel workstream state from the durable dispatch record", () => {
    const state = makeState({
      isRunning: false,
      activeTaskId: null,
      workItems: [{
        kind: "parallel_run", id: "parallel-1", sessionId: "s1", workspaceId: "ws", goal: "parallel goal",
        status: "executing", baseRevision: "base",
        planJson: JSON.stringify({ workstreams: [
          { id: "alpha", title: "Alpha", dependencies: [] },
          { id: "beta", title: "Beta", dependencies: [] },
          { id: "gamma", title: "Gamma", dependencies: ["alpha"] },
        ] }),
        workstreamsJson: JSON.stringify({
          results: [{ workstreamId: "beta", status: "completed" }],
          dispatches: [{ workstreamId: "alpha", state: "active" }, { workstreamId: "beta", state: "completed" }],
        }),
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      }] as WorkspaceState["workItems"],
    });
    const html = markupFor(state, true);
    expect(html).toContain("Parallel engineering · 1/3 workstreams · executing");
    expect(html).toContain("Alpha · running");
    expect(html).toContain("Beta · completed");
    expect(html).toContain("Gamma · waiting · waiting on alpha");
  });

  it("surfaces a cancelled parallel run without losing its workstream detail", () => {
    const state = makeState({
      isRunning: false,
      activeTaskId: null,
      workItems: [{
        kind: "parallel_run", id: "parallel-2", sessionId: "s1", workspaceId: "ws", goal: "parallel goal",
        status: "cancelled", baseRevision: "base", error: "PARALLEL_RUN_CANCELLED",
        planJson: JSON.stringify({ workstreams: [{ id: "alpha", title: "Alpha", dependencies: [] }] }),
        workstreamsJson: JSON.stringify({ results: [], dispatches: [{ workstreamId: "alpha", state: "cancelled" }] }),
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      }] as WorkspaceState["workItems"],
    });
    const html = markupFor(state, true);
    expect(html).toContain("Parallel engineering · 0/1 workstreams · cancelled");
    expect(html).toContain("Alpha · cancelled");
    expect(html).toContain("Synthesis · cancelled · PARALLEL_RUN_CANCELLED");
  });

  it("renders long-horizon mission progress with plan version and replan reason", () => {
    const state = makeState({
      isRunning: false,
      activeTaskId: null,
      workItems: [{
        kind: "mission", id: "mission-1", sessionId: "s1", workspaceId: "ws",
        goal: "Implement repository-wide feature flags",
        status: "executing", baseRevision: "base", currentPlanVersion: 2, currentWave: 3,
        missionJson: JSON.stringify({
          milestones: [
            { id: "m-model", title: "Shared model", status: "completed", dependencies: [] },
            { id: "m-server", title: "Server runtime", status: "completed", dependencies: ["m-model"] },
            { id: "m-ui-2", title: "Desktop UI", status: "executing", dependencies: ["m-server"] },
            { id: "m-certify", title: "Final certification", status: "pending", dependencies: ["m-ui-2"] },
          ],
          planVersions: [
            { version: 1 },
            { version: 2, parentVersion: 1, reason: { type: "verification_failure" }, diff: { preservedMilestones: ["m-model", "m-server"], invalidatedMilestones: ["m-certify"], addedMilestones: ["m-ui-2"] } },
          ],
          usage: { waves: 3, replans: 1, workstreams: 5 },
        }),
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      }] as WorkspaceState["workItems"],
    });
    const html = markupFor(state, true);
    expect(html).toContain("Mission");
    expect(html).toContain("2/4 milestones");
    expect(html).toContain("Implement repository-wide feature flags");
    expect(html).toContain("Shared model");
    expect(html).toContain("Final certification");
    expect(html).toContain("Wave 3");
    expect(html).toContain("Plan v2");
    expect(html).toContain("1 replan");
    // Replan visibility: what changed and what survived, never raw model reasoning.
    expect(html).toContain("verification_failure");
    expect(html).toContain("preserved m-model, m-server");
    expect(html).toContain("replanned m-certify, m-ui-2");
  });

  it("surfaces paused mission state and the latest trusted steering", () => {
    const state = makeState({
      isRunning: false,
      activeTaskId: null,
      workItems: [{
        kind: "mission", id: "mission-2", sessionId: "s1", workspaceId: "ws",
        goal: "Implement repository-wide feature flags",
        status: "paused", baseRevision: "base", currentPlanVersion: 1, currentWave: 1,
        error: "MISSION_PAUSED",
        missionJson: JSON.stringify({
          milestones: [{ id: "m-model", title: "Shared model", status: "completed", dependencies: [] }],
          planVersions: [{ version: 1 }],
          usage: { waves: 1, replans: 0 },
          steering: [{ type: "clarification", message: "use the existing SettingsService" }],
          pauseRequested: false,
        }),
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      }] as WorkspaceState["workItems"],
    });
    const html = markupFor(state, true);
    expect(html).toContain("1/1 milestones");
    expect(html).toContain("paused");
    expect(html).toContain("Steering");
    expect(html).toContain("use the existing SettingsService");
    expect(html).toContain("MISSION_PAUSED");
    expect(html).toContain("0 replans");
  });

  it("renders delivery analysis, packaging, review, blocked, and PR-ready states without exposing private context", () => {
    const state = makeState({
      isRunning: false, activeTaskId: null,
      workItems: [{
        kind: "change_delivery", id: "delivery-1", sessionId: "s1", missionId: "mission-1", workspaceId: "ws",
        status: "ready", sourceRevision: "0123456789abcdef", targetRevision: "0123456789abcdef",
        deliveryJson: JSON.stringify({ deliveryBranch: "codeforge/delivery/mission-1-a1b2c3d4", commits: [{ title: "feat: add retry limit", sha: "a1b2c3d4e5f6" }], reviewPackage: { verdict: "pass", summary: "PR-ready without remote creation" } }),
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      }] as WorkspaceState["workItems"],
    });
    const html = markupFor(state, true);
    expect(html).toContain("Delivery · ready · PR-ready");
    expect(html).toContain("Certified source · 0123456789ab");
    expect(html).toContain("feat: add retry limit");
    expect(html).toContain("Review · pass");
    expect(html).not.toContain("private marker");
  });

  const deliveryItem = {
    kind: "change_delivery", id: "delivery-1", sessionId: "s1", missionId: "mission-1", workspaceId: "ws", status: "ready", sourceRevision: "0123456789abcdef", targetRevision: "0123456789abcdef", deliveryJson: JSON.stringify({ commits: [], reviewPackage: { verdict: "pass" } }), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const cloudPublication = (status: string, detail: Record<string, unknown> = {}, error?: string) => ({
    kind: "cloud_publication", id: "cloud-publication-1", sessionId: "s1", deliveryId: "delivery-1", workspaceId: "ws", status,
    cloudPublicationId: "11111111-1111-4111-8111-111111111111", publicationJson: JSON.stringify(detail), ...(error ? { error } : {}),
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  });

  it("shows the Cloud-authoritative completed publication with its PR", () => {
    const state = makeState({
      isRunning: false, activeTaskId: null,
      workItems: [deliveryItem, cloudPublication("completed", {
        state: "completed", targetBranch: "main", pushRef: "refs/heads/codeforge/publication/11111111-1111-4111-8111-111111111111",
        pullRequestNumber: 42, pullRequestUrl: "https://example.test/pull/42",
        receipt: { repositoryFullName: "acme/widget", publishedCommit: "0123456789abcdef0123456789abcdef01234567", publicationRef: "refs/heads/codeforge/publication/11111111-1111-4111-8111-111111111111" },
      })] as unknown as WorkspaceState["workItems"],
    });
    const html = markupFor(state, true);
    expect(html).toContain("Cloud publication · Published");
    expect(html).toContain("acme/widget / main");
    expect(html).toContain("Pull request · #42");
  });

  it("never shows a pull request while Cloud is still publishing", () => {
    const state = makeState({
      isRunning: false, activeTaskId: null,
      workItems: [deliveryItem, cloudPublication("pushing", { state: "pushing", targetBranch: "main", pullRequestNumber: 42, pullRequestUrl: "https://example.test/pull/42" })] as unknown as WorkspaceState["workItems"],
    });
    const html = markupFor(state, true);
    expect(html).toContain("Cloud publication · Cloud publishing branch");
    expect(html).toContain("authoritative only when Cloud reports completion");
    expect(html).not.toContain("Pull request · #42");
  });

  it("surfaces the Cloud authorization, revocation, and divergence states", () => {
    const authorization = markupFor(makeState({
      isRunning: false, activeTaskId: null,
      workItems: [deliveryItem, cloudPublication("authorization_required", {}, "REPOSITORY_AUTHORIZATION_REQUIRED")] as unknown as WorkspaceState["workItems"],
    }), true);
    expect(authorization).toContain("GitHub App repository authorization required");
    expect(authorization).toContain("Authorize repository");

    const revoked = markupFor(makeState({
      isRunning: false, activeTaskId: null,
      workItems: [deliveryItem, cloudPublication("authorization_revoked", {}, "INSTALLATION_REVOKED")] as unknown as WorkspaceState["workItems"],
    }), true);
    expect(revoked).toContain("Repository authorization revoked");

    const diverged = markupFor(makeState({
      isRunning: false, activeTaskId: null,
      workItems: [deliveryItem, cloudPublication("target_diverged", { canRetry: true }, "PROMOTION_TARGET_DIVERGED")] as unknown as WorkspaceState["workItems"],
    }), true);
    expect(diverged).toContain("Target branch moved since certification");
    expect(diverged).toContain("Retry publication");

    const identity = markupFor(makeState({
      isRunning: false, activeTaskId: null,
      workItems: [deliveryItem, cloudPublication("identity_required", {}, "CLOUD_IDENTITY_REQUIRED")] as unknown as WorkspaceState["workItems"],
    }), true);
    expect(identity).toContain("Sign in to CodeForge Cloud");
  });

  it("requires an explicit publish action for a local-ready delivery", () => {
    const state = makeState({
      workItems: [{ kind: "change_delivery", id: "delivery-ready", sessionId: "s1", missionId: "mission-1", workspaceId: "ws", status: "ready", sourceRevision: "0123456789abcdef", targetRevision: "0123456789abcdef", deliveryJson: JSON.stringify({ commits: [], reviewPackage: { verdict: "pass" } }), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }] as WorkspaceState["workItems"],
    });
    expect(markupFor(state, true)).toContain("Publish to GitHub via CodeForge Cloud");
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
