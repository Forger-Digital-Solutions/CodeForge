import { describe, expect, it } from "vitest";
import { ForgeEvalHarness } from "../src/index.js";

const capsule = {
  schemaVersion: 1 as const,
  assignment: "evaluation task",
  goal: "Implement the fixture change",
  relevantFiles: ["src/fixture.ts"],
  knownEvidence: ["test:fixture.test.ts"],
  constraints: ["Use the fixture workspace only"],
  requiredOutput: ["changed files", "verification"],
};

describe("ForgeEval matched experiments", () => {
  it("grades both strategies through an independent oracle and preserves measurements", async () => {
    const harness = new ForgeEvalHarness();
    const result = await harness.runMatchedExperiment({
      experimentId: "exp-1",
      sessionId: "session-1",
      taskId: "task-1",
      taskType: "small-fix",
      capsule,
      startingStateDigest: "state-a",
      control: {
        topology: "single_agent",
        execute: async () => ({ status: "completed", summary: "single result", modelId: "model-a", elapsedMs: 10, retryCount: 0, tokenCount: 100, toolCalls: 2, workerCount: 1 }),
      },
      treatment: {
        topology: "fixed_team",
        execute: async () => ({ status: "completed", summary: "team result", modelId: "model-b", elapsedMs: 8, retryCount: 1, tokenCount: 160, toolCalls: 5, workerCount: 3 }),
      },
      oracle: {
        id: "fixture-oracle",
        tier: "deterministic",
        grade: async ({ candidate }) => ({
          status: candidate.summary.includes("result") ? "pass" : "unknown",
          verified: candidate.summary.includes("result"),
          score: candidate.summary.includes("result") ? 1 : 0,
          reason: "fixture oracle inspected the candidate result",
        }),
      },
      environmentalDifferences: ["same frozen fixture workspace"],
    });

    expect(result.status).toBe("graded");
    expect(result.control.verified).toBe(true);
    expect(result.treatment.verified).toBe(true);
    expect(result.environmentalDifferences).toEqual(["same frozen fixture workspace"]);
    expect(result.experiment).toMatchObject({ kind: "forgeeval_experiment", id: "exp-1", sessionId: "session-1", status: "graded" });
    expect(harness.benchmarkStore.list()).toHaveLength(2);
    expect(harness.benchmarkStore.listExperiments()).toHaveLength(1);
    expect(harness.benchmarkStore.scoreFor("model-b", "small-fix")).toBe(1);
  });

  it("does not equate a completed execution with a passing grade", async () => {
    const harness = new ForgeEvalHarness();
    const result = await harness.runMatchedExperiment({
      experimentId: "exp-2",
      taskId: "task-2",
      taskType: "review-disagreement",
      capsule,
      startingStateDigest: "state-b",
      control: { topology: "single_agent", execute: async () => ({ status: "completed", summary: "done", elapsedMs: 1, retryCount: 0 }) },
      treatment: { topology: "fixed_team", execute: async () => ({ status: "completed", summary: "done", elapsedMs: 1, retryCount: 0 }) },
      oracle: {
        id: "rejecting-oracle",
        tier: "structured",
        grade: async () => ({ status: "fail", verified: false, score: 0, reason: "contract assertion failed" }),
      },
    });

    expect(result.control.status).toBe("fail");
    expect(result.control.verified).toBe(false);
    expect(harness.benchmarkStore.scoreFor("unknown", "review-disagreement")).toBe(0);
  });
});
