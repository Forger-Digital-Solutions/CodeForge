import { describe, expect, it } from "vitest";
import { adviseFromExperience, buildExperienceReceipt, experienceLabel } from "../src/experience-learning.js";
import type { AutonomousRun } from "../src/autonomous-orchestrator.js";

const run = (overrides: Partial<AutonomousRun> = {}): AutonomousRun => ({
  id: "run-1",
  sessionId: "secret-owner-session",
  workspaceId: "private-workspace",
  workspacePath: "C:/private/acme/src/key.ts",
  goal: "Fix SECRET_API_KEY=super-secret in proprietary widget",
  status: "blocked",
  baseRevision: "base",
  reviewRounds: 0,
  taskGraph: { tasks: [] },
  counters: { childrenSpawned: 0, reviewRounds: 0, taskAttempts: 1, verificationAttempts: 0 },
  error: "VERIFICATION_FAILED",
  ...overrides,
});

describe("R57 experience learning boundary", () => {
  it("never gives an unverified completion positive credit", () => {
    const claimed = run({ status: "completed", error: undefined, result: {
      runId: "run-1", status: "completed", summary: "done", workspaceId: "private-workspace", baseRevision: "base",
      changedFiles: ["C:/private/acme/src/key.ts"], review: { passed: true, findings: [] }, verification: [],
      integration: { status: "integrated" }, evidence: [], counters: { childrenSpawned: 0, reviewRounds: 0, taskAttempts: 1, verificationAttempts: 0 },
    } });
    expect(experienceLabel(claimed)).toBe("UNKNOWN");
    expect(buildExperienceReceipt(claimed, []).generalized.verificationPassed).toBe(false);
  });

  it("keeps proprietary content out of generalized signals while retaining scoped operational identity", () => {
    const receipt = buildExperienceReceipt(run(), [{
      kind: "subagent_run", id: "worker-private", sessionId: "secret-owner-session", parentRunId: "run-1", role: "Autonomous Builder", status: "failed",
      model: { providerId: "user-secret-provider", modelId: "private-model" },
      telemetry: { modelRequests: 2, toolCalls: 3, inputTokens: 100, retryCount: 1 },
    }]);
    const generalized = JSON.stringify(receipt.generalized);
    for (const forbidden of ["SECRET_API_KEY", "super-secret", "acme", "key.ts", "private-model", "user-secret-provider", "secret-owner-session", "private-workspace", "worker-private"]) {
      expect(generalized).not.toContain(forbidden);
    }
    expect(receipt.generalized).toMatchObject({ label: "VERIFIED_FAILURE", modelRequests: 2, toolCalls: 3, retries: 1, verificationPassed: false, roles: ["coder"] });
    expect(receipt.local).toHaveProperty("runId", "run-1");
    expect(JSON.stringify(receipt.local)).not.toContain("super-secret");
    expect(JSON.stringify(receipt.local)).not.toContain("private-model");
  });

  it("counts only workers belonging to the run", () => {
    const receipt = buildExperienceReceipt(run(), [
      { kind: "subagent_run", id: "other", sessionId: "secret-owner-session", parentRunId: "run-2", role: "coder", status: "completed", telemetry: { modelRequests: 999 } },
      { kind: "subagent_run", id: "foreign", sessionId: "other-owner-session", parentRunId: "run-1", role: "coder", status: "completed", telemetry: { modelRequests: 999 } },
    ]);
    expect(receipt.generalized).toMatchObject({ workerCount: 0, modelRequests: 0 });
  });

  it("lets repeated prior outcomes change bounded recovery advice without a single poisoned outlier", () => {
    const exhausted = buildExperienceReceipt(run({ error: "STRATEGY_EXHAUSTED" }), []).generalized;
    expect(adviseFromExperience([exhausted], "unknown").action).toBe("STANDARD");
    const advice = adviseFromExperience([exhausted, exhausted], "unknown");
    expect(advice.action).toBe("INDEPENDENT_DIAGNOSIS");
    expect(advice.confidence).toBeLessThan(0.75);
    expect(adviseFromExperience([exhausted, exhausted], "complex").action).toBe("STANDARD");
  });
});
