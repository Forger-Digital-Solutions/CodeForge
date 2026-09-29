import fs from "node:fs";
import path from "node:path";
import { R20ScaleHarness } from "../../packages/benchmark/dist/r20-scale.js";

const root = path.resolve(import.meta.dirname, "../..");
const out = path.join(root, "docs/evidence/r57-autonomous-endurance-learning/scale-campaign.json");
const route = (id, providerId, faultWindows = []) => ({
  routeId: id, providerId, modelId: `${id}-model`, costClass: "PUBLIC_MANAGED_FREE",
  roles: ["coder", "explorer", "reviewer"], concurrency: 3, latencyMs: 80,
  tokensPerSecond: 12_000, quality: 0.9, faultWindows, cooldownThreshold: 2, cooldownMs: 500,
});
const mix = [
  { taskType: "bug_fix", inputTokens: 2500, outputTokens: 900, turns: 2, topology: "T0", role: "coder", weight: 4 },
  { taskType: "feature", inputTokens: 5000, outputTokens: 1500, turns: 3, topology: "T1", role: "coder", weight: 2 },
  { taskType: "refactor", inputTokens: 4000, outputTokens: 1100, turns: 3, topology: "T1", role: "coder", weight: 1 },
];
const scenarios = [1, 2, 5, 10, 25].map((users) => ({
  scenarioId: `R57-${users}-USERS`, evidenceClass: "simulated", users,
  concurrentActiveUsers: users, tasksPerUser: 2, thinkTimeMs: 25, burst: true,
  maxRetries: 2, backoffBaseMs: 100, jitterRatio: 0.2, maxQueueWaitMs: 120_000,
  userConcurrency: 1, taskMix: mix, routes: [route("free-a", "synthetic-a"), route("free-b", "synthetic-b")], seed: 57,
}));
scenarios.push({ ...scenarios[4], scenarioId: "R57-HEAVY-USER", tasksPerUser: 1, tasksByUser: { "user-0001": 50 } });
scenarios.push({ ...scenarios[4], scenarioId: "R57-429-FAILOVER", routes: [
  route("limited", "synthetic-a", [{ startMs: 0, endMs: 5_000, kind: "rate_limit", retryAfterMs: 500 }]),
  route("healthy", "synthetic-b"),
] });
const harness = new R20ScaleHarness();
const started = Date.now();
const results = scenarios.map((scenario) => {
  const { events, ...result } = harness.run(scenario);
  return { ...result, eventCount: events.length, starvingUsers: result.userMetrics.filter((user) => user.attemptedTasks > 0 && user.completedTasks === 0).length };
});
const evidence = { schemaVersion: "r57-scale/v1", evidenceClass: "deterministic_simulation", wallTimeMs: Date.now() - started, results };
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(results.map(({ scenario, users, tasks, fairness, queueWaitMs, starvingUsers, routeFailovers }) => ({ scenario, users, tasks, fairness, queueWaitMs, starvingUsers, routeFailovers })), null, 2));
