import { describe, expect, it } from "vitest";
import { simulateR33ControlPlane, type R33ControlPlaneScenario } from "../src/r33-control-plane-scale.js";

const scenario = (users: number): R33ControlPlaneScenario => ({
  users,
  tasksPerUser: 2,
  maxTicks: 10_000,
  routes: [
    { id: "synthetic-a", concurrency: 64, quotaPerWindow: 200, windowTicks: 5, failedCallsConsumeQuota: false, fault: { fromTick: 2, throughTick: 3, kind: "429" } },
    { id: "synthetic-b", concurrency: 64, quotaPerWindow: 200, windowTicks: 5, failedCallsConsumeQuota: true },
  ],
});

describe("R33 synthetic control plane scale", () => {
  it.each([1_000, 10_000, 100_000])("accounts for every lease and user at %i users", (users) => {
    const result = simulateR33ControlPlane(scenario(users));
    expect(result.complete).toBe(true);
    expect(result.completedTasks).toBe(users * 2);
    expect(result.duplicateAdmissions).toBe(0);
    expect(result.inFlightReplayRejections).toBe(result.attemptedAdmissions);
    expect(result.idempotentReplays).toBe(users * 2);
    expect(result.leakedLeases).toBe(0);
    expect(result.capacityAccountingErrors).toBe(0);
    expect(result.starvedUsers).toBe(0);
    expect(result.fairFirstAdmissions).toBe(true);
    expect(result.maximumConcurrentLeases).toBeLessThanOrEqual(128);
    expect(result.routes.reduce((sum, route) => sum + route.completed, 0)).toBe(users * 2);
  });

  it("checkpoints 429s, migrates retried work, and resets quota", () => {
    const result = simulateR33ControlPlane(scenario(10_000));
    expect(result.rateLimits).toBeGreaterThan(0);
    expect(result.checkpointedTasks).toBe(result.rateLimits);
    expect(result.recoveredTasks).toBeGreaterThan(0);
    expect(result.migratedTasks).toBeGreaterThan(0);
    expect(result.quotaResets).toBeGreaterThan(0);
    expect(result.quotaDeniedSlots).toBeGreaterThan(0);
  });

  it("reports starvation when the only route never recovers", () => {
    const input = scenario(1_000);
    input.routes = [{ id: "broken", concurrency: 64, quotaPerWindow: 64, windowTicks: 1, failedCallsConsumeQuota: false, fault: { fromTick: 0, throughTick: 50, kind: "403" } }];
    input.maxTicks = 10;
    const result = simulateR33ControlPlane(input);
    expect(result.complete).toBe(false);
    expect(result.starvedUsers).toBeGreaterThan(0);
    expect(result.forbiddenResponses).toBeGreaterThan(0);
    expect(result.leakedLeases).toBe(0);
  });
});
