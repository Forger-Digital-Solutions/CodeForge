import { describe, expect, it } from "vitest";
import { R20FairScheduler, R20ScaleHarness, modelR20Dau, type R20ScaleScenario } from "../src/r20-scale.js";

const route = (overrides: Partial<R20ScaleScenario["routes"][number]> = {}): R20ScaleScenario["routes"][number] => ({
  routeId: "free-a",
  providerId: "synthetic-a",
  modelId: "model-a",
  costClass: "PUBLIC_MANAGED_FREE",
  roles: ["coder"],
  concurrency: 2,
  latencyMs: 20,
  tokensPerSecond: 10_000,
  quality: 0.9,
  ...overrides,
});

const scenario = (overrides: Partial<R20ScaleScenario> = {}): R20ScaleScenario => ({
  scenarioId: "test",
  evidenceClass: "simulated",
  users: 10,
  concurrentActiveUsers: 10,
  tasksPerUser: 2,
  thinkTimeMs: 1,
  burst: true,
  maxRetries: 2,
  backoffBaseMs: 10,
  jitterRatio: 0,
  maxQueueWaitMs: 10_000,
  userConcurrency: 1,
  taskMix: [{ taskType: "bug_fix", inputTokens: 200, outputTokens: 100, turns: 1, topology: "T0", role: "coder" }],
  routes: [route()],
  seed: 20,
  startedAt: "2026-09-19T00:00:00.000Z",
  commit: "test",
  ...overrides,
});

describe("R20 scale harness", () => {
  it("serves stable virtual-user identities fairly without starvation", () => {
    const result = new R20ScaleHarness().run(scenario());
    expect(result.tasks).toEqual({ attempted: 20, completed: 20, blocked: 0, failed: 0, cancelled: 0 });
    expect(result.userMetrics).toHaveLength(10);
    expect(new Set(result.events.map((event) => event.userId)).size).toBe(10);
    expect(result.fairness.starvationEvents).toBe(0);
    expect(result.fairness.jainIndex).toBe(1);
    expect(result.queueWaitMs.p95).toBeGreaterThan(0);
    expect(result.evidenceClass).toBe("simulated");
  });

  it("bounds a normal user's wait when one user queues fifty tasks", () => {
    const result = new R20ScaleHarness().run(scenario({ users: 10, concurrentActiveUsers: 10, tasksPerUser: 1, tasksByUser: { "user-0001": 50 }, routes: [route({ concurrency: 1 })] }));
    expect(result.userMetrics[1]?.completedTasks).toBe(1);
    expect(result.userMetrics[1]?.maxWaitMs).toBeLessThan(result.userMetrics[0]!.maxWaitMs);
    expect(result.fairness.starvationEvents).toBe(0);
    expect(result.fairness.jainIndex).toBeGreaterThan(0.15);
  });

  it("accounts for subagent fan-out as provider executions", () => {
    const result = new R20ScaleHarness().run(scenario({ users: 1, concurrentActiveUsers: 1, tasksPerUser: 1, taskMix: [{ taskType: "subagent", inputTokens: 200, outputTokens: 100, turns: 4, topology: "T4", role: "coder" }] }));
    expect(result.requests).toBe(4);
    expect(result.tasks.completed).toBe(1);
    expect(result.tokensProcessed).toBe(1_200);
  });

  it("fails over with bounded retries and route cooldown", () => {
    const result = new R20ScaleHarness().run(scenario({
      users: 2,
      concurrentActiveUsers: 2,
      tasksPerUser: 1,
      routes: [
        route({ routeId: "bad", providerId: "bad-provider", concurrency: 1, faultWindows: [{ startMs: 0, endMs: 10_000, kind: "rate_limit", retryAfterMs: 100 }], cooldownThreshold: 1, cooldownMs: 100 }),
        route({ routeId: "good", providerId: "good-provider", concurrency: 1 }),
      ],
    }));
    expect(result.rateLimits).toBeGreaterThan(0);
    expect(result.retries).toBeGreaterThan(0);
    expect(result.routeFailovers).toBeGreaterThan(0);
    expect(result.tasks.failed).toBe(0);
    expect(result.providerMetrics.find((item) => item.routeId === "bad")?.cooldowns).toBeGreaterThan(0);
  });

  it("keeps unknown and paid routes out of simulated Free dispatch", () => {
    expect(() => new R20ScaleHarness().run(scenario({ users: 1, concurrentActiveUsers: 1, tasksPerUser: 1, maxQueueWaitMs: 5, routes: [route({ costClass: "UNKNOWN" }), route({ routeId: "paid", costClass: "PAID" })] }))).not.toThrow();
    const result = new R20ScaleHarness().run(scenario({ users: 1, concurrentActiveUsers: 1, tasksPerUser: 1, maxQueueWaitMs: 5, routes: [route({ costClass: "UNKNOWN" })] }));
    expect(result.successes).toBe(0);
    expect(result.routeExhaustions).toBe(1);
    expect(result.tasks.failed).toBe(1);
  });

  it("rejects synthetic output mislabeled as live evidence", () => {
    expect(() => new R20ScaleHarness().run(scenario({ evidenceClass: "production" }))).toThrow(/Synthetic harness/);
  });

  it("releases reservations on completion and recovers expired leases", () => {
    const scheduler = new R20FairScheduler(1);
    const execution = { userId: "u", sessionId: "s", taskId: "t", executionId: "e", profile: scenario().taskMix[0]!, availableAt: 0, queuedAt: 0, attempt: 0, routeIndex: 0, state: "queued" as const };
    scheduler.reserve(execution, "r", 0, 10);
    expect(scheduler.reservationCount()).toBe(1);
    expect(scheduler.recoverExpired(11)).toBe(1);
    expect(scheduler.reservationCount()).toBe(0);
  });

  it("models DAU separately from concurrency", () => {
    const model = modelR20Dau({ dau: 373, peakHourActivePercent: 0.15, tasksPerUserDay: 2, turnsPerTask: 4, averageTaskMinutes: 10, subagentPercent: 0.1, browserPercent: 0.05, averageTokensPerTurn: 2_000, burstFactor: 1.5 });
    expect(model.peakActiveUsers).toBe(56);
    expect(model.peakConcurrentTasks).toBe(14);
    expect(model.dailyTasks).toBe(746);
    expect(model.dailyTokens).toBe(5_968_000);
    expect(model.peakRequestMultiplier).toBeCloseTo(1.35);
  });
});
