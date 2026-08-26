import { describe, expect, it } from "vitest";
import { EventStore } from "@codeforge/sessions";
import type { WorkspaceEvent } from "@codeforge/protocol";

function makeEvent(overrides: Partial<WorkspaceEvent>): WorkspaceEvent {
  return {
    type: "turn.started",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId: "default",
    payload: { turnId: "turn-1", userMessage: "Hello" },
    ...overrides,
  } as WorkspaceEvent;
}

function buildDemoSequence(sessionId = "default", turnId = "turn-1"): WorkspaceEvent[] {
  const base = (type: string, payload: Record<string, unknown>) =>
    makeEvent({ type, sessionId, payload: { ...payload, turnId } });

  return [
    base("turn.started", { turnId, userMessage: "Implement routing" }),
    base("status.changed", { from: "idle", to: "running" }),
    base("agent.started", { agentId: "lead", role: "Lead Agent", taskId: turnId }),
    base("subagent.started", { agentId: "explorer", role: "Repository Explorer", parentAgentId: "lead", task: "Scan repo" }),
    base("subagent.progress", { agentId: "explorer", message: "Scanning...", percent: 30 }),
    base("file.read", { fileCallId: "fc1", path: "src/ForgeRouter.cs", lines: 245 }),
    base("subagent.completed", { agentId: "explorer", result: "Found files" }),
    base("subagent.started", { agentId: "architect", role: "Architect", parentAgentId: "lead", task: "Design routing" }),
    base("plan.started", { planId: "plan-1", turnId, title: "Implement routing" }),
    base("plan.updated", { planId: "plan-1", steps: [
      { id: "s1", description: "Extend descriptor", status: "completed" },
      { id: "s2", description: "Update catalog", status: "completed" },
      { id: "s3", description: "Modify router", status: "active" },
    ] }),
    base("plan.status_changed", { planId: "plan-1", status: "review" }),
    base("file.change_proposed", { changeId: "ch1", path: "src/ProviderDescriptor.cs", changeType: "modified", additions: 23, deletions: 4, description: "Add scoring" }),
    base("file.change_applied", { changeId: "ch1", path: "src/ProviderDescriptor.cs" }),
    base("file.change_proposed", { changeId: "ch2", path: "src/ForgeRouter.cs", changeType: "modified", additions: 41, deletions: 8, description: "Integrate scoring" }),
    base("file.change_applied", { changeId: "ch2", path: "src/ForgeRouter.cs" }),
    base("command.started", { commandId: "cmd1", command: "dotnet test", workingDirectory: "E:\\CodeForge" }),
    base("command.output", { commandId: "cmd1", output: "Passed", stream: "stdout" }),
    base("command.completed", { commandId: "cmd1", exitCode: 0, durationMs: 45200 }),
    base("validation.started", { validationId: "v1", type: "unit_tests" }),
    base("test.started", { taskId: turnId }),
    base("test.completed", { taskId: turnId, passed: 411, failed: 0, skipped: 0 }),
    base("validation.completed", { validationId: "v1", passed: 411, failed: 0, skipped: 0 }),
    base("subagent.completed", { agentId: "architect", result: "Routing complete" }),
    base("artifact.created", { artifactId: "art1", type: "verification", title: "Verification Report", sessionId, turnId }),
    base("checkpoint.created", { checkpointId: "ck1", label: "Routing complete", branch: "feature/provider-routing", fileCount: 3, testStatus: "411 passed" }),
    base("evidence.created", { evidenceId: "ev1", conclusion: "ProviderCatalogService supports scoring.", references: [
      { kind: "file", ref: "src/ProviderDescriptor.cs:45" },
      { kind: "test", ref: "tests/RouterTests.cs:78" },
    ] }),
    base("turn.completed", { turnId, result: "Provider routing implemented" }),
    base("status.changed", { from: "running", to: "completed" }),
    base("agent.completed", { agentId: "lead", taskId: turnId }),
  ];
}

describe("Event → state transitions", () => {
  it("full demo sequence produces coherent state", () => {
    const store = new EventStore();
    const events = buildDemoSequence();
    for (const event of events) {
      store.append(event);
    }

    const all = store.getAll();
    expect(all).toHaveLength(events.length);

    const types = all.map((e) => e.type);
    expect(types[0]).toBe("turn.started");
    expect(types[types.length - 1]).toBe("agent.completed");

    const turnStarted = all.find((e) => e.type === "turn.started");
    expect(turnStarted).toBeDefined();
    expect(turnStarted!.payload.turnId).toBe("turn-1");

    const planUpdated = all.find((e) => e.type === "plan.updated");
    expect(planUpdated).toBeDefined();
    expect(planUpdated!.payload.steps).toHaveLength(3);

    const testCompleted = all.find((e) => e.type === "test.completed");
    expect(testCompleted).toBeDefined();
    expect(testCompleted!.payload.passed).toBe(411);

    const statusChanged = all.filter((e) => e.type === "status.changed");
    expect(statusChanged[0]!.payload.to).toBe("running");
    expect(statusChanged[statusChanged.length - 1]!.payload.to).toBe("completed");
  });

  it("approval flow events are coherent", () => {
    const store = new EventStore();
    const sessionId = "approval-sess";
    const turnId = "turn-approval";

    store.append(makeEvent({ type: "turn.started", sessionId, payload: { turnId, userMessage: "Deploy" } }));
    store.append(makeEvent({ type: "status.changed", sessionId, payload: { from: "idle", to: "running" } }));
    store.append(makeEvent({ type: "approval.requested", sessionId, payload: {
      approvalId: "appr-1", tool: "deploy", action: "Deploy to prod", description: "Deploy application", risk: "high", scope: "global",
    } }));
    store.append(makeEvent({ type: "approval.resolved", sessionId, payload: { approvalId: "appr-1", decision: "allow_once" } }));
    store.append(makeEvent({ type: "turn.completed", sessionId, payload: { turnId, result: "Deployed" } }));
    store.append(makeEvent({ type: "status.changed", sessionId, payload: { from: "running", to: "completed" } }));

    const all = store.getAll();
    expect(all).toHaveLength(6);
    expect(all[2]!.type).toBe("approval.requested");
    expect(all[3]!.type).toBe("approval.resolved");
    expect(all[3]!.payload.decision).toBe("allow_once");
  });

  it("question flow events are coherent", () => {
    const store = new EventStore();
    const sessionId = "question-sess";
    const turnId = "turn-question";

    store.append(makeEvent({ type: "turn.started", sessionId, payload: { turnId, userMessage: "Fix bug" } }));
    store.append(makeEvent({ type: "status.changed", sessionId, payload: { from: "idle", to: "running" } }));
    store.append(makeEvent({ type: "question.requested", sessionId, payload: {
      questionId: "q1", prompt: "Which branch?", options: ["main", "develop"],
    } }));
    store.append(makeEvent({ type: "question.resolved", sessionId, payload: { questionId: "q1", answer: "main" } }));
    store.append(makeEvent({ type: "turn.completed", sessionId, payload: { turnId, result: "Fixed on main" } }));

    const all = store.getAll();
    expect(all).toHaveLength(5);
    expect(all[2]!.type).toBe("question.requested");
    expect(all[3]!.type).toBe("question.resolved");
    expect(all[3]!.payload.answer).toBe("main");
  });

  it("failure path is coherent", () => {
    const store = new EventStore();
    const sessionId = "fail-sess";

    store.append(makeEvent({ type: "turn.started", sessionId, payload: { turnId: "t1", userMessage: "Run tests" } }));
    store.append(makeEvent({ type: "status.changed", sessionId, payload: { from: "idle", to: "running" } }));
    store.append(makeEvent({ type: "command.started", sessionId, payload: { commandId: "c1", command: "dotnet test" } }));
    store.append(makeEvent({ type: "command.completed", sessionId, payload: { commandId: "c1", exitCode: 1, durationMs: 1000 } }));
    store.append(makeEvent({ type: "turn.failed", sessionId, payload: { turnId: "t1", error: "Tests failed" } }));
    store.append(makeEvent({ type: "status.changed", sessionId, payload: { from: "running", to: "failed" } }));

    const all = store.getAll();
    expect(all).toHaveLength(6);
    expect(all[4]!.type).toBe("turn.failed");
    const statuses = all.filter((e) => e.type === "status.changed").map((e) => e.payload.to);
    expect(statuses).toEqual(["running", "failed"]);
  });

  it("cancellation path is coherent", () => {
    const store = new EventStore();
    const sessionId = "cancel-sess";

    store.append(makeEvent({ type: "turn.started", sessionId, payload: { turnId: "t1", userMessage: "Run" } }));
    store.append(makeEvent({ type: "status.changed", sessionId, payload: { from: "idle", to: "running" } }));
    store.append(makeEvent({ type: "turn.cancelled", sessionId, payload: { turnId: "t1", reason: "User stopped" } }));
    store.append(makeEvent({ type: "status.changed", sessionId, payload: { from: "running", to: "cancelled" } }));

    const all = store.getAll();
    expect(all).toHaveLength(4);
    expect(all[2]!.type).toBe("turn.cancelled");
  });

  it("pause/resume path is coherent", () => {
    const store = new EventStore();
    const sessionId = "pause-sess";

    store.append(makeEvent({ type: "turn.started", sessionId, payload: { turnId: "t1", userMessage: "Run" } }));
    store.append(makeEvent({ type: "turn.paused", sessionId, payload: {} }));
    store.append(makeEvent({ type: "turn.resumed", sessionId, payload: {} }));
    store.append(makeEvent({ type: "turn.completed", sessionId, payload: { turnId: "t1", result: "Done" } }));

    const types = store.getAll().map((e) => e.type);
    expect(types).toEqual(["turn.started", "turn.paused", "turn.resumed", "turn.completed"]);
  });
});
