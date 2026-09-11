import { describe, expect, it } from "vitest";
import { observeCandidateA } from "../src/candidate-a-observer.js";

const identity = { certifiedSourceStateId: "test-state", campaignHarnessId: "test-harness" };

describe("FG-11 Candidate A positive-control regression — unaffected by this work", () => {
  it("a real duplicate read-only call against unchanged state is suppressed and reports ACTUAL avoided work", () => {
    const steps = [
      { tool: "read_file", args: { path: "a.ts" }, simulatedBytes: 100, simulatedMs: 5 },
      { tool: "read_file", args: { path: "a.ts" }, simulatedBytes: 100, simulatedMs: 5 },
    ];
    const observations = observeCandidateA({ runId: "a-reg-1", taskId: "control", ...identity, steps });
    const suppressed = observations.find((o) => o.classification === "VALIDATED");
    expect(suppressed).toBeDefined();
    expect(suppressed!.actual).toEqual({ toolExecutionsPrevented: 1, bytesReplayed: 100, msSaved: 5 });
    expect(suppressed!.projected).toBeUndefined();
  });

  it("a mutating tool call is never suppressed — the invariant holds under a real interleaved sequence", () => {
    const steps = [
      { tool: "write_file", args: { path: "a.ts" }, simulatedBytes: 100, simulatedMs: 5 },
      { tool: "write_file", args: { path: "a.ts" }, simulatedBytes: 100, simulatedMs: 5 },
    ];
    const observations = observeCandidateA({ runId: "a-reg-2", taskId: "control", ...identity, steps });
    expect(observations.every((o) => o.classification !== "VALIDATED")).toBe(true);
    expect(observations.every((o) => o.unsafeFalsePositive === false)).toBe(true);
  });

  it("a real mutation between two identical reads invalidates the would-be duplicate", () => {
    const steps = [
      { tool: "read_file", args: { path: "a.ts" }, simulatedBytes: 100, simulatedMs: 5 },
      { tool: "read_file", args: { path: "a.ts" }, simulatedBytes: 100, simulatedMs: 5, mutationBefore: true },
    ];
    const observations = observeCandidateA({ runId: "a-reg-3", taskId: "control", ...identity, steps });
    expect(observations[1]!.classification).not.toBe("VALIDATED");
  });

  it("a third identical read against unchanged state escalates as a no-progress loop, never a silent third suppression", () => {
    const steps = [
      { tool: "read_file", args: { path: "a.ts" }, simulatedBytes: 100, simulatedMs: 5 },
      { tool: "read_file", args: { path: "a.ts" }, simulatedBytes: 100, simulatedMs: 5 },
      { tool: "read_file", args: { path: "a.ts" }, simulatedBytes: 100, simulatedMs: 5 },
    ];
    const observations = observeCandidateA({ runId: "a-reg-4", taskId: "control", ...identity, steps });
    expect(observations[2]!.classification).toBe("INCOMPLETE");
  });
});
