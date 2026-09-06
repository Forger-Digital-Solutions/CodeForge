import { describe, it, expect } from "vitest";
import { createDuplicateActionSupervisor } from "../src/duplicate-suppression.js";

const identity = (tool = "read_file", args: unknown = { path: "src/a.ts" }) => ({ tool, canonicalArguments: args });

describe("FG-1C duplicate / no-progress suppression", () => {
  it("executes the first occurrence of an action", () => {
    const supervisor = createDuplicateActionSupervisor();
    expect(supervisor.classify(identity())).toEqual({ action: "execute" });
  });

  it("suppresses an identical read against unchanged state and replays the prior result", () => {
    const supervisor = createDuplicateActionSupervisor();
    supervisor.classify(identity());
    supervisor.recordReadResult(identity(), "file contents", true, "exec-1");
    const decision = supervisor.classify(identity());
    expect(decision.action).toBe("suppress");
    if (decision.action === "suppress") {
      expect(decision.priorOutput).toBe("file contents");
      expect(decision.priorExecutionId).toBe("exec-1");
    }
    expect(supervisor.metrics.duplicateActionsSuppressed).toBe(1);
  });

  it("escalates instead of looping forever after a suppression is ignored", () => {
    const supervisor = createDuplicateActionSupervisor();
    supervisor.classify(identity());
    supervisor.recordReadResult(identity(), "file contents", true, "exec-1");
    expect(supervisor.classify(identity()).action).toBe("suppress");
    expect(supervisor.classify(identity()).action).toBe("escalate");
    expect(supervisor.metrics.noProgressEscalations).toBe(1);
  });

  it("never mistakes a rerun after a file change for duplicate work", () => {
    const supervisor = createDuplicateActionSupervisor();
    supervisor.classify(identity());
    supervisor.recordReadResult(identity(), "old contents", true, "exec-1");
    supervisor.recordMutationExecution({ tool: "edit_file", canonicalArguments: { path: "src/a.ts" } }, true);
    expect(supervisor.classify(identity()).action).toBe("execute");
  });

  it("never suppresses work after a steer changes the plan (CF-17 revision semantics)", () => {
    const supervisor = createDuplicateActionSupervisor();
    supervisor.classify(identity());
    supervisor.recordReadResult(identity(), "old contents", true, "exec-1");
    supervisor.noteSteerConsumed();
    expect(supervisor.classify(identity()).action).toBe("execute");
  });

  it("treats different workstream scopes as distinct identities (alpha never suppresses beta)", () => {
    const alpha = createDuplicateActionSupervisor({ workstreamScope: "alpha" });
    const beta = createDuplicateActionSupervisor({ workstreamScope: "beta" });
    const readIdentity = identity("repo_search", { query: "router" });
    alpha.classify(readIdentity);
    alpha.recordReadResult(readIdentity, "alpha results", true, "exec-alpha");
    expect(alpha.classify(readIdentity).action).toBe("suppress");
    // A different supervisor for the beta workstream starts empty: beta work is never suppressed
    // by alpha history, and the beta identity key itself differs from alpha's.
    expect(beta.classify(readIdentity).action).toBe("execute");
    expect(alpha.identityKey(readIdentity)).not.toBe(beta.identityKey(readIdentity));
  });

  it("allows exactly one retry of a failed read, then escalates (terminal impossible state surfaced)", () => {
    const supervisor = createDuplicateActionSupervisor();
    supervisor.classify(identity());
    supervisor.recordReadResult(identity(), "Error: file not found", false, "exec-f1");
    expect(supervisor.classify(identity()).action).toBe("execute_retry_failed");
    supervisor.recordReadResult(identity(), "Error: file not found", false, "exec-f2");
    expect(supervisor.classify(identity()).action).toBe("escalate");
  });

  it("never suppresses mutating actions", () => {
    const supervisor = createDuplicateActionSupervisor();
    const write = { tool: "write_file", canonicalArguments: { path: "src/a.ts", content: "x" } };
    const command = { tool: "run_command", canonicalArguments: { command: "npm test" } };
    supervisor.recordMutationExecution(write, true);
    supervisor.recordMutationExecution(command, true);
    expect(supervisor.classify(write).action).toBe("execute");
    expect(supervisor.classify(command).action).toBe("execute");
  });

  it("distinguishes identical tool text by canonical arguments", () => {
    const supervisor = createDuplicateActionSupervisor();
    supervisor.classify(identity("read_file", { path: "src/a.ts" }));
    supervisor.recordReadResult(identity("read_file", { path: "src/a.ts" }), "a", true, "exec-1");
    expect(supervisor.classify(identity("read_file", { path: "src/b.ts" })).action).toBe("execute");
  });
});
