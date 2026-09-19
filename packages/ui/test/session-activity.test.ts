import { describe, it, expect } from "vitest";
import type { WorkspaceEvent } from "@codeforge/protocol";
import type { WorkItem } from "@codeforge/sessions";
import { projectSessionChanges, projectSessionCommands, projectSessionVerification } from "../src/session-activity.js";

let seq = 0;
function ev(type: string, payload: unknown, sessionId = "s1"): WorkspaceEvent {
  return { type, payload, seq: ++seq, sessionId, timestamp: new Date().toISOString() } as unknown as WorkspaceEvent;
}
function reset() {
  seq = 0;
}

/**
 * The Inspector's Changes/Commands tabs used to read only `file_change`/`command` work items —
 * which real agent runs never produce — so a task that demonstrably edited files and ran commands
 * inspected as "No changes yet. No commands run yet." These tests pin the event-driven projection
 * that makes real runs visible.
 */
describe("projectSessionChanges", () => {
  it("surfaces a real agent edit reported only as file.written", () => {
    reset();
    const changes = projectSessionChanges([ev("file.written", { fileCallId: "w1", path: "src/inventory.js", bytesOrChars: 802 })], []);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.path).toBe("src/inventory.js");
  });

  it("prefers the rich change_proposed record for a path over the file.written fallback", () => {
    reset();
    const changes = projectSessionChanges([
      ev("file.written", { fileCallId: "w1", path: "src/a.ts", bytesOrChars: 50 }),
      ev("file.change_proposed", { changeId: "c1", path: "src/a.ts", changeType: "modified", additions: 3, deletions: 1, diff: "-x\n+y" }),
      ev("file.change_applied", { changeId: "c1", path: "src/a.ts" }),
    ], []);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ path: "src/a.ts", additions: 3, deletions: 1, diff: "-x\n+y" });
  });

  it("drops a reverted change entirely — a reverted change is not a change", () => {
    reset();
    const changes = projectSessionChanges([
      ev("file.change_proposed", { changeId: "c1", path: "src/a.ts", changeType: "modified", additions: 2, deletions: 0 }),
      ev("file.change_reverted", { changeId: "c1", path: "src/a.ts" }),
      ev("file.written", { fileCallId: "w1", path: "src/b.ts", bytesOrChars: 12 }),
    ], []);
    expect(changes.map((c) => c.path)).toEqual(["src/b.ts"]);
  });

  it("merges demo-style file_change work items with event-sourced changes by path", () => {
    reset();
    const workItem = {
      kind: "file_change", id: "wi1", sessionId: "s1", path: "src/demo.ts",
      changeType: "modified", additions: 10, deletions: 2,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as unknown as WorkItem;
    const changes = projectSessionChanges(
      [ev("file.written", { fileCallId: "w1", path: "src/real.ts", bytesOrChars: 5 })],
      [workItem],
    );
    expect(changes.map((c) => c.path).sort()).toEqual(["src/demo.ts", "src/real.ts"]);
  });
});

describe("projectSessionCommands", () => {
  it("surfaces a real run_command execution reported as command.executed", () => {
    reset();
    const commands = projectSessionCommands(
      [ev("command.executed", { commandId: "x1", command: "npm test", output: "4 passed", exitCode: 0 })],
      [],
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ command: "npm test", status: "completed", exitCode: 0, output: "4 passed" });
  });

  it("joins command.started/completed by commandId and fails a nonzero exit", () => {
    reset();
    const commands = projectSessionCommands([
      ev("command.started", { commandId: "t1", command: "npm run build", workingDirectory: "/repo" }),
      ev("command.output", { commandId: "t1", output: "compiling…\n" }),
      ev("command.output", { commandId: "t1", output: "failed\n" }),
      ev("command.completed", { commandId: "t1", exitCode: 2, durationMs: 1234 }),
    ], []);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ status: "failed", exitCode: 2, durationMs: 1234, output: "compiling…\nfailed\n" });
  });

  it("adopts the still-running row when a completion carries an unmatched id (older producers)", () => {
    reset();
    const commands = projectSessionCommands([
      ev("command.started", { commandId: "t1", command: "dotnet test" }),
      ev("command.completed", { commandId: "different-id", exitCode: 0, durationMs: 45200 }),
    ], []);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ command: "dotnet test", status: "completed", exitCode: 0 });
  });

  it("marks an unfinished command as interrupted once the session's run is terminal", () => {
    reset();
    const live = projectSessionCommands([ev("command.started", { commandId: "t1", command: "npm test" })], [], false);
    expect(live[0]!.status).toBe("running");
    const settled = projectSessionCommands([ev("command.started", { commandId: "t1", command: "npm test" })], [], true);
    expect(settled[0]!.status).toBe("interrupted");
  });

  it("keeps command work items from producers that do not emit events", () => {
    reset();
    const workItem = {
      kind: "command", id: "wi-cmd", sessionId: "s1", command: "npm test",
      status: "completed", exitCode: 0, durationMs: 900, startedAt: new Date().toISOString(),
    } as unknown as WorkItem;
    const commands = projectSessionCommands([], [workItem]);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ command: "npm test", status: "completed", exitCode: 0 });
  });
});

describe("projectSessionVerification", () => {
  it("reports the latest workflow verification attempt", () => {
    reset();
    const result = projectSessionVerification([
      ev("workflow.verification_completed", { attempt: 1, notConfigured: false, passed: 1, failed: 3, skipped: 0, durationMs: 100, verifiers: [] }),
      ev("workflow.verification_completed", { attempt: 2, notConfigured: false, passed: 4, failed: 0, skipped: 0, durationMs: 90, verifiers: [] }),
    ], []);
    expect(result).toEqual({ passed: 4, failed: 0, skipped: 0 });
  });

  it("falls back to test_run work items when no workflow verification ran", () => {
    reset();
    const workItem = {
      kind: "test_run", id: "tr1", sessionId: "s1", suite: "unit", status: "completed",
      passed: 7, failed: 1, durationMs: 50, startedAt: new Date().toISOString(),
    } as unknown as WorkItem;
    expect(projectSessionVerification([], [workItem])).toEqual({ passed: 7, failed: 1, skipped: 0 });
  });

  it("returns null when nothing verified", () => {
    expect(projectSessionVerification([], [])).toBeNull();
  });
});
