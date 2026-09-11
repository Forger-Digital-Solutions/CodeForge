import { describe, expect, it } from "vitest";
import { createDuplicateActionSupervisor, MUTATING_TOOLS, READ_ONLY_SUPPRESSIBLE, type DuplicateActionIdentity } from "../src/duplicate-suppression.js";

/**
 * FG-9 §30 items 11-14: writes/deletes/installs/deployment-shaped tools must never be cached or
 * suppressed. This proves the invariant against the REAL, already-certified FG-1C
 * `DuplicateActionSupervisor` (no reimplementation) — FG-9's `buildDuplicateToolReuseDecision`
 * (packages/forge-green/src/optimization-candidate-a.ts) only ever wraps events this supervisor
 * already classified as "suppress", so proving the supervisor itself never suppresses a mutating
 * tool call is sufficient to prove FG-9 can never suppress one either.
 */
describe("FG-9 unsafe-mutating-operations proof (§30 items 11-14)", () => {
  it("[11] a write operation is never suppressed even when called with identical arguments twice in a row", () => {
    const supervisor = createDuplicateActionSupervisor();
    const identity: DuplicateActionIdentity = { tool: "write_file", canonicalArguments: { path: "a.ts", content: "x" } };
    expect(supervisor.classify(identity).action).toBe("execute");
    supervisor.recordMutationExecution(identity, true);
    // A second identical write is STILL never suppressible — write_file is not in
    // READ_ONLY_SUPPRESSIBLE, so classify() short-circuits to "execute" unconditionally.
    expect(supervisor.classify(identity).action).toBe("execute");
    expect(supervisor.metrics.duplicateActionsSuppressed).toBe(0);
  });

  it("[12] a delete-shaped edit (empty content) is never suppressed", () => {
    const supervisor = createDuplicateActionSupervisor();
    const identity: DuplicateActionIdentity = { tool: "edit_file", canonicalArguments: { path: "a.ts", operation: "delete" } };
    supervisor.recordMutationExecution(identity, true);
    expect(supervisor.classify(identity).action).toBe("execute");
    expect(supervisor.metrics.duplicateActionsSuppressed).toBe(0);
  });

  it("[13] an install-shaped command (executed via run_command, the shell mutation tool) is never suppressed", () => {
    const supervisor = createDuplicateActionSupervisor();
    const identity: DuplicateActionIdentity = { tool: "run_command", canonicalArguments: { command: "npm install" } };
    supervisor.recordMutationExecution(identity, true);
    expect(supervisor.classify(identity).action).toBe("execute");
    expect(supervisor.metrics.duplicateActionsSuppressed).toBe(0);
  });

  it("[14] a deployment/external-side-effect-shaped command is never suppressed", () => {
    const supervisor = createDuplicateActionSupervisor();
    const identity: DuplicateActionIdentity = { tool: "run_command", canonicalArguments: { command: "npm run deploy" } };
    supervisor.recordMutationExecution(identity, true);
    expect(supervisor.classify(identity).action).toBe("execute");
    expect(supervisor.metrics.duplicateActionsSuppressed).toBe(0);
  });

  it("READ_ONLY_SUPPRESSIBLE and MUTATING_TOOLS are disjoint — no tool name can ever be both cacheable and mutating", () => {
    for (const tool of MUTATING_TOOLS) {
      expect(READ_ONLY_SUPPRESSIBLE.has(tool)).toBe(false);
    }
  });

  it("classify() NEVER returns 'suppress' for any tool outside READ_ONLY_SUPPRESSIBLE, regardless of repeated identical calls", () => {
    const supervisor = createDuplicateActionSupervisor();
    for (const tool of MUTATING_TOOLS) {
      const identity: DuplicateActionIdentity = { tool, canonicalArguments: { same: "args" } };
      for (let i = 0; i < 3; i++) {
        const decision = supervisor.classify(identity);
        expect(decision.action).not.toBe("suppress");
        supervisor.recordMutationExecution(identity, true);
      }
    }
    expect(supervisor.metrics.duplicateActionsSuppressed).toBe(0);
  });
});
