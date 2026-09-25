import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStatusSchema, TaskStatusSchema } from "@codeforge/protocol";
import {
  TURN_TRANSITIONS,
  TERMINAL_TURN_STATUSES,
  WAITING_TURN_STATUSES,
  RESTORABLE_TURN_STATUSES,
  WORKFLOW_PHASE_TO_TASK_STATUS,
  WORKFLOW_PHASE_TO_SESSION_STATUS,
  taskStatusForPhase,
  sessionStatusForPhase,
  isLegalTurnTransition,
  type CanonicalTurnStatus,
} from "../src/turn-state-machine.js";

const serverSrc = path.resolve(__dirname, "..", "src");

function readSource(rel: string): string {
  return fs.readFileSync(path.join(serverSrc, rel), "utf8");
}

/** Literal `emitStatusChanged("from", "to")` call sites across the runtime. Dynamic
 * call sites (variable arguments) are checked separately below. */
function emittedLiteralTransitions(): Array<{ file: string; from: string; to: string }> {
  const results: Array<{ file: string; from: string; to: string }> = [];
  for (const file of ["agent-runtime.ts", "workflow-service.ts", "autonomous-orchestrator.ts", "demo-runtime.ts"]) {
    const src = readSource(file);
    for (const match of src.matchAll(/emitStatusChanged\(\s*"([^"]+)"\s*,\s*"([^"]+)"/g)) {
      results.push({ file, from: match[1]!, to: match[2]! });
    }
  }
  return results;
}

describe("R35 Mission B — canonical turn/task state machine", () => {
  it("the transition graph is closed over the canonical status set", () => {
    const declared = new Set(Object.keys(TURN_TRANSITIONS));
    for (const [from, tos] of Object.entries(TURN_TRANSITIONS)) {
      for (const to of tos) {
        expect(declared.has(to), `${from} -> ${to} targets an undeclared state`).toBe(true);
      }
    }
  });

  it("terminal states are terminal: no outgoing transitions", () => {
    for (const terminal of TERMINAL_TURN_STATUSES) {
      expect(TURN_TRANSITIONS[terminal]).toEqual([]);
    }
  });

  it("cancel is reachable from every non-terminal state — user stop always works", () => {
    for (const [from, tos] of Object.entries(TURN_TRANSITIONS) as [CanonicalTurnStatus, CanonicalTurnStatus[]][]) {
      if (TERMINAL_TURN_STATUSES.has(from)) continue;
      if (from === "idle") continue;
      expect(tos, `${from} cannot be cancelled`).toContain("cancelled");
    }
  });

  it("every literal status transition emitted by the runtime is legal", () => {
    const emissions = emittedLiteralTransitions();
    expect(emissions.length).toBeGreaterThan(10);
    for (const { file, from, to } of emissions) {
      expect(
        isLegalTurnTransition(from as CanonicalTurnStatus, to as CanonicalTurnStatus),
        `${file}: emitStatusChanged("${from}", "${to}") is not a legal transition`,
      ).toBe(true);
    }
  });

  it("the WorkflowPhase → TaskStatus map is total over engine phases", () => {
    const phases = fs
      .readFileSync(path.resolve(serverSrc, "../../workflow/src/types.ts"), "utf8")
      .match(/WorkflowPhase\s*=\s*([\s\S]*?);/)![1]!
      .match(/"[^"]+"/g)!
      .map((s) => s.slice(1, -1));
    for (const phase of phases) {
      expect(WORKFLOW_PHASE_TO_TASK_STATUS[phase], `phase '${phase}' unmapped`).toBeDefined();
      expect(TaskStatusSchema.safeParse(taskStatusForPhase(phase)).success).toBe(true);
    }
    expect(taskStatusForPhase("completed")).toBe("complete");
    expect(taskStatusForPhase("failed")).toBe("failed_safely");
    expect(() => taskStatusForPhase("not_a_phase")).toThrow();
  });

  it("the WorkflowPhase → SessionStatus map is total and never leaks TaskStatus values", () => {
    const phases = fs
      .readFileSync(path.resolve(serverSrc, "../../workflow/src/types.ts"), "utf8")
      .match(/WorkflowPhase\s*=\s*([\s\S]*?);/)![1]!
      .match(/"[^"]+"/g)!
      .map((s) => s.slice(1, -1));
    for (const phase of phases) {
      expect(WORKFLOW_PHASE_TO_SESSION_STATUS[phase], `phase '${phase}' unmapped`).toBeDefined();
      expect(SessionStatusSchema.safeParse(sessionStatusForPhase(phase)).success).toBe(true);
    }
  });

  it("workflow-service never emits raw phases into status channels", () => {
    const src = readSource("workflow-service.ts");
    // The old `statusMap[phase] ?? phase` fall-through emitted unchecked phase
    // names as TaskStatus; session persistence must use the canonical maps.
    expect(src).not.toMatch(/statusMap\[phase\]\s*\?\?\s*phase/);
    expect(src).not.toMatch(/emitStatusChanged\(task\.phase/);
    expect(src).toContain("taskStatusForPhase(phase)");
    expect(src).toContain("sessionStatusForPhase(phase)");
  });

  it("restorable statuses are exactly the in-flight set used by restart recovery", () => {
    const runtimeSrc = readSource("agent-runtime.ts");
    const normalized = runtimeSrc.match(
      /normalizedOriginalStatus[\s\S]*?as\s+"([^"]+)"[^)]*\|\s*"([^"]+)"[^)]*\|\s*"([^"]+)"[^)]*\|\s*"([^"]+)"[^)]*\|\s*"([^"]+)"[^)]*\|\s*"([^"]+)"/,
    );
    expect(normalized).not.toBeNull();
    const declaredInRuntime = new Set(normalized!.slice(1));
    for (const s of declaredInRuntime) {
      expect(RESTORABLE_TURN_STATUSES.has(s as CanonicalTurnStatus)).toBe(true);
    }
  });

  it("waiting statuses are the only states a turn can park in without dying", () => {
    for (const waiting of WAITING_TURN_STATUSES) {
      expect(RESTORABLE_TURN_STATUSES.has(waiting), `${waiting} must survive restart`).toBe(true);
    }
  });
});
