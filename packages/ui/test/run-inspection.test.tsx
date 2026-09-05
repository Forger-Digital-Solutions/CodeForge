import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceEvent } from "@codeforge/protocol";
import type { WorkItem } from "@codeforge/sessions";
import RunInspection from "../src/RunInspection.js";
import { parseDiff } from "../src/DiffViewer.js";
import { dedupeRunEvents, projectRunInspection, selectInspectableRunId } from "../src/run-inspection.js";

const timestamp = "2026-09-04T12:00:00.000Z";

function event(type: WorkspaceEvent["type"], seq: number, payload: unknown, runId = "run-a"): WorkspaceEvent {
  return { type, seq, sessionId: "session-a", runId, timestamp, payload } as WorkspaceEvent;
}

describe("run inspection projection", () => {
  it("projects ForgeVerify evidence by server event identity rather than pass-shaped output", () => {
    const events = [
      event("forgeverify.plan_created", 1, { taskId: "run-a", planId: "plan-1", policyVersion: "policy-1", requiredVerifierIds: ["tests.unit", "workspace.build"] }),
      event("forgeverify.evidence_created", 2, { taskId: "run-a", planId: "plan-1", attemptId: "attempt-1", evidenceId: "evidence-1", verifierId: "tests.unit", status: "passed", durationMs: 12, outputTruncated: false }),
      event("forgeverify.evidence_created", 3, { taskId: "run-a", planId: "plan-1", attemptId: "attempt-2", evidenceId: "evidence-2", verifierId: "workspace.build", status: "failed", durationMs: 8, outputTruncated: true }),
    ];
    const result = projectRunInspection(events, [], "run-a");
    expect(result.forgeVerify).toMatchObject({ planId: "plan-1", requiredCount: 2, satisfiedCount: 1, missingCount: 1, verificationComplete: false });
    expect(result.forgeVerify?.evidence).toHaveLength(2);
    const html = renderToStaticMarkup(React.createElement(RunInspection, { events, workItems: [], preferredRunId: "run-a" }));
    expect(html).toContain("workspace.build");
    expect(html).not.toContain("verification:passed");
  });

  it("renders a concurrent hierarchy without duplicating replayed events", () => {
    const events: WorkspaceEvent[] = [
      event("task.created", 1, { taskId: "run-a", title: "Implement transparency", mode: "autonomous" }),
      event("task.started", 2, { taskId: "run-a" }),
      event("agent.started", 3, { agentId: "root", role: "Root Agent", taskId: "run-a" }),
      event("subagent.started", 4, { agentId: "coder-a", role: "Coder A", parentAgentId: "root", task: "Server evidence" }),
      event("subagent.started", 5, { agentId: "coder-b", role: "Coder B", parentAgentId: "root", task: "UI evidence" }),
      event("subagent.started", 6, { agentId: "reviewer", role: "Reviewer", parentAgentId: "root", task: "Review" }),
      event("subagent.completed", 7, { agentId: "coder-a", result: "done" }),
      event("subagent.failed", 8, { agentId: "coder-b", error: "safe failure" }),
      event("tool.call_started", 9, { turnId: "turn", toolCallId: "tool-1", toolName: "edit_file", agentId: "coder-a" }),
      event("tool.execution_completed", 10, { turnId: "turn", toolCallId: "tool-1", toolName: "edit_file", result: "hidden output" }),
      event("file.change_proposed", 11, { changeId: "change-1", path: "packages/ui/src/RunInspection.tsx", changeType: "created", additions: 100, deletions: 0, diff: "+safe" }),
    ];
    const replayed = [...events, events[4]!];
    const result = projectRunInspection(replayed, [], "run-a");

    expect(dedupeRunEvents(replayed, "run-a")).toHaveLength(events.length);
    expect(result.agents.map((agent) => [agent.id, agent.status])).toEqual([
      ["root", "running"],
      ["coder-a", "completed"],
      ["coder-b", "failed"],
      ["reviewer", "running"],
    ]);
    expect(result.tools).toEqual([expect.objectContaining({ id: "tool-1", status: "completed", agentId: "coder-a" })]);
    expect(result.changes).toEqual([expect.objectContaining({ path: "packages/ui/src/RunInspection.tsx" })]);

    const html = renderToStaticMarkup(React.createElement(RunInspection, { events: replayed, workItems: [], preferredRunId: "run-a" }));
    expect(html).toContain("Root Agent");
    expect(html).toContain("Coder A");
    expect(html).toContain("Coder B");
    expect(html).toContain("Reviewer");
    expect(html).toContain("Cost");
    expect(html).toContain("Unavailable");
  });

  it("keeps Run A evidence out of Run B even when agent IDs collide", () => {
    const events = [
      event("task.created", 1, { taskId: "run-a", title: "A", mode: "autonomous" }, "run-a"),
      event("agent.started", 2, { agentId: "agent-1", role: "Coder A", taskId: "run-a" }, "run-a"),
      event("task.created", 3, { taskId: "run-b", title: "B", mode: "autonomous" }, "run-b"),
      event("agent.started", 4, { agentId: "agent-1", role: "Coder B", taskId: "run-b" }, "run-b"),
      event("file.change_proposed", 5, { changeId: "b-change", path: "run-b.ts", changeType: "created", additions: 1, deletions: 0 }, "run-b"),
    ];

    const runA = projectRunInspection(events, [], "run-a");
    const runB = projectRunInspection(events, [], "run-b");
    expect(runA.agents).toEqual([expect.objectContaining({ id: "agent-1", role: "Coder A" })]);
    expect(runA.changes).toEqual([]);
    expect(runB.agents).toEqual([expect.objectContaining({ id: "agent-1", role: "Coder B" })]);
    expect(runB.changes).toEqual([expect.objectContaining({ path: "run-b.ts" })]);
  });

  it("preserves a failed verification attempt before repair passes and only certifies through the gate", () => {
    const events = [
      event("workflow.verification_completed", 1, {
        taskId: "run-a", attempt: 1, notConfigured: false, passed: 0, failed: 1, skipped: 0, durationMs: 20,
        verifiers: [{ id: "test", kind: "test", command: "npm test", required: true, status: "failed", passed: 0, failed: 1, skipped: 0, exitCode: 1, durationMs: 20, failureSummary: "fixture failed" }],
      }),
      event("workflow.repair_attempted", 2, { taskId: "run-a", attempt: 1, summary: "Repair fixture" }),
      event("workflow.verification_completed", 3, {
        taskId: "run-a", attempt: 2, notConfigured: false, passed: 1, failed: 0, skipped: 0, durationMs: 21,
        verifiers: [{ id: "test", kind: "test", command: "npm test", required: true, status: "passed", passed: 1, failed: 0, skipped: 0, exitCode: 0, durationMs: 21 }],
      }),
      event("workflow.completion_decided", 4, { taskId: "run-a", outcome: "completed", rationale: "Structured verification passed", blockers: [] }),
    ];

    const result = projectRunInspection(events, [], "run-a");
    expect(result.verification.map((attempt) => attempt.failed)).toEqual([1, 0]);
    expect(result.repairs).toEqual([{ attempt: 1, summary: "Repair fixture" }]);
    expect(result.completion?.outcome).toBe("completed");
  });

  it("uses a durable final snapshot rather than later mutable events for a historical diff", () => {
    const snapshot: WorkItem = {
      kind: "run_inspection", id: "run-a", runId: "run-a", sessionId: "session-a", turnId: "turn-a", executionMode: "agent",
      taskTitle: "Historical", status: "completed", phase: "completed", workspace: { id: "workspace-a", kind: "local" },
      diffs: [{ path: "agent-change.ts", changeType: "modified", additions: 2, deletions: 1, diff: "-old\n+new" }],
      verificationAttempts: [],
      repairs: [],
      completion: { outcome: "completed", rationale: "gate", blockers: [] },
      startedAt: timestamp, completedAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
    };
    const laterEvent = event("file.change_proposed", 9, { changeId: "mutable", path: "unrelated-user-change.ts", changeType: "modified", additions: 99, deletions: 0, diff: "+unrelated" });
    const result = projectRunInspection([laterEvent], [snapshot], "run-a");

    expect(result.changes).toEqual([expect.objectContaining({ path: "agent-change.ts", diff: "-old\n+new" })]);
    expect(result.changes.some((change) => change.path === "unrelated-user-change.ts")).toBe(false);
  });

  it("selects no autonomous evidence for ordinary Chat events", () => {
    const chat = [{ type: "turn.started", sessionId: "session-a", seq: 1, timestamp, payload: { turnId: "chat", userMessage: "hello" } } as WorkspaceEvent];
    expect(selectInspectableRunId(chat, [])).toBeUndefined();
  });

  it("projects a realistic large replay in bounded time without double-counting usage", () => {
    const events: WorkspaceEvent[] = [event("task.created", 1, { taskId: "run-a", title: "Large", mode: "autonomous" })];
    for (let index = 0; index < 1_000; index++) {
      events.push(event("tool.started", index + 2, { toolCallId: `tool-${index}`, tool: "read_file", taskId: "run-a" }));
    }
    for (let index = 0; index < 500; index++) {
      events.push(event("file.change_proposed", index + 1_002, { changeId: `change-${index}`, path: `src/file-${index}.ts`, changeType: "modified", additions: 1, deletions: 0 }));
    }
    for (let index = 0; index < 200; index++) {
      events.push(event("token.usage", index + 1_502, { turnId: "turn", inputTokens: 1, outputTokens: 2 }));
    }
    const started = performance.now();
    const result = projectRunInspection([...events, ...events], [], "run-a");
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(1_000);
    expect(result.tools).toHaveLength(1_000);
    expect(result.changes).toHaveLength(500);
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 400, totalTokens: 600 });
  });

  it("bounds a very large text patch before it can create an unbounded review DOM", () => {
    const diff = Array.from({ length: 100_500 }, (_, index) => `+line ${index}`).join("\n");
    const parsed = parseDiff(diff, "large.ts");
    expect(parsed.truncated).toBe(true);
    expect(parsed.lines.length).toBeLessThanOrEqual(2_000);
  });
});
