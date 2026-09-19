import { describe, it, expect } from "vitest";
import type { WorkspaceEvent } from "@codeforge/protocol";
import type { SessionRecord, TurnRecord } from "@codeforge/sessions";
import { buildTimeline } from "../src/timeline.js";
import { deriveRestoredRunState } from "../src/workspace-sse.js";
import { sessionsForWorkspace } from "../src/WorkspaceApp.js";

let seq = 0;
function ev(type: string, payload: unknown, sessionId = "s1"): WorkspaceEvent {
  return { type, payload, seq: ++seq, sessionId, timestamp: new Date().toISOString() } as unknown as WorkspaceEvent;
}

/**
 * R16: a relaunched conversation must tell the truth about how it ended. The live failure banner
 * does not survive a restart, and the persisted-event replay races the snapshot fetch, so both the
 * timeline and the restored run state have to carry the terminal outcome on their own.
 */
describe("restored conversation truth (R16)", () => {
  it("renders a failed plain turn as a visible Failed outcome with human wording", () => {
    seq = 0;
    const tl = buildTimeline([
      ev("turn.started", { turnId: "t1", userMessage: "Explain the architecture of this repository." }),
      ev("turn.failed", { turnId: "t1", error: 'Opencode error (401): {"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}' }),
    ]);
    expect(tl.map((i) => i.kind)).toEqual(["user", "phase"]);
    const outcome = tl[1] as Extract<(typeof tl)[number], { kind: "phase" }>;
    expect(outcome.phase).toBe("outcome");
    expect(outcome.text).toBe("Failed");
    expect(outcome.detail).toMatch(/authentication failed/i);
    expect(outcome.detail).not.toMatch(/AuthError|\{/);
  });

  it("renders a user stop as a neutral Stopped outcome, not an error", () => {
    seq = 0;
    const tl = buildTimeline([
      ev("turn.started", { turnId: "t1", userMessage: "Refactor the helper" }),
      ev("turn.cancelled", { turnId: "t1", reason: "User stopped the run" }),
    ]);
    const outcome = tl.at(-1) as Extract<(typeof tl)[number], { kind: "phase" }>;
    expect(outcome.text).toBe("Stopped");
    expect(outcome.detail).toBe("Stopped by you");
  });

  it("does not duplicate a workflow's own outcome row with the raw turn terminal event", () => {
    seq = 0;
    const tl = buildTimeline([
      ev("turn.started", { turnId: "t1", userMessage: "Fix the failing test" }),
      ev("workflow.completion_decided", { outcome: "failed", rationale: "2 tests still fail" }),
      ev("turn.failed", { turnId: "t1", error: "verification failed" }),
    ]);
    expect(tl.filter((i) => i.kind === "phase")).toHaveLength(1);
    expect((tl[1] as { detail?: string }).detail).toBe("2 tests still fail");
  });

  it("keeps workflow-internal implement/repair turn failures out of the transcript", () => {
    seq = 0;
    const tl = buildTimeline([
      ev("turn.started", { turnId: "user-1", userMessage: "Add a feature" }),
      ev("turn.started", { turnId: "wf-1", userMessage: "implement step", origin: "workflow" }),
      ev("turn.failed", { turnId: "wf-1", error: "provider hiccup" }),
      ev("workflow.completion_decided", { outcome: "completed", rationale: "14 tests passed" }),
    ]);
    expect(tl.map((i) => i.kind)).toEqual(["user", "phase"]);
    expect((tl[1] as { text: string }).text).toBe("Done");
  });

  it("renders a refused start (no workspace / wrong workspace) as a Failed outcome", () => {
    seq = 0;
    const tl = buildTimeline([
      ev("execution.start_failed", { requestId: "r1", executionMode: "agent", code: "WORKSPACE_MISMATCH", message: 'This conversation belongs to the "api" project. Open that project to continue it.' }),
    ]);
    expect(tl).toHaveLength(1);
    expect((tl[0] as { detail?: string }).detail).toMatch(/belongs to the "api" project/);
  });

  it("derives Failed + the last turn's error for a persisted failed session", () => {
    const session = { id: "default", status: "failed", title: "x", createdAt: "", updatedAt: "" } as unknown as SessionRecord;
    const turns = [
      { id: "t0", sessionId: "default", seq: 1, userMessage: "a", status: "failed", startedAt: "2026-08-29T01:00:00.000Z", error: "Provider codeforge not found in catalog" },
      { id: "t1", sessionId: "default", seq: 2, userMessage: "b", status: "failed", startedAt: "2026-08-29T20:46:04.554Z", error: "Opencode error (401): Invalid API key." },
    ] as unknown as TurnRecord[];
    const restored = deriveRestoredRunState(session, turns);
    expect(restored).toMatchObject({ agentStatus: "failed", activePhase: "failed", isRunning: false });
    expect(restored?.workflowError).toMatch(/authentication failed/i);
  });

  it("never overrides a session that still has an in-flight turn", () => {
    const session = { id: "s", status: "failed", title: "x", createdAt: "", updatedAt: "" } as unknown as SessionRecord;
    const turns = [{ id: "t1", sessionId: "s", seq: 1, userMessage: "b", status: "running", startedAt: "2026-09-01T00:00:00.000Z" }] as unknown as TurnRecord[];
    expect(deriveRestoredRunState(session, turns)).toBeNull();
  });

  it("derives Completed and Stopped for those persisted outcomes", () => {
    const base = { id: "s", title: "x", createdAt: "", updatedAt: "" };
    expect(deriveRestoredRunState({ ...base, status: "completed" } as unknown as SessionRecord, [])).toMatchObject({ agentStatus: "completed", activePhase: "complete" });
    expect(deriveRestoredRunState({ ...base, status: "cancelled" } as unknown as SessionRecord, [])).toMatchObject({ agentStatus: "cancelled", activePhase: "cancelled" });
    expect(deriveRestoredRunState({ ...base, status: "running" } as unknown as SessionRecord, [])).toBeNull();
  });
});

describe("task list is scoped to the open repository (R16)", () => {
  const sessions = [
    { id: "a", workspacePath: "G:\\dogfood\\sandbox-repo" },
    { id: "b", workspacePath: "G:\\dogfood\\codeforge-dogfood" },
    { id: "legacy" },
    { id: "c", workspacePath: "g:/dogfood/sandbox-repo/" },
  ];

  it("shows only this repository's conversations plus unbound legacy ones", () => {
    expect(sessionsForWorkspace(sessions, "G:\\dogfood\\sandbox-repo").map((s) => s.id)).toEqual(["a", "legacy", "c"]);
  });

  it("shows everything when no repository is open", () => {
    expect(sessionsForWorkspace(sessions, undefined)).toHaveLength(4);
  });
});
