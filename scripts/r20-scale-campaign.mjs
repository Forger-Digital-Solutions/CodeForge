import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { R20ScaleHarness, modelR20Dau } from "../packages/benchmark/dist/r20-scale.js";

const root = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(root, "docs", "evidence", "r20-platform-intelligence-scale", "09-scale", "scenarios");
fs.mkdirSync(outputDir, { recursive: true });
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const timestamp = new Date().toISOString();

const normalRoute = (routeId, providerId, overrides = {}) => ({ routeId, providerId, modelId: `${routeId}-model`, costClass: "PUBLIC_MANAGED_FREE", roles: ["coder", "explorer", "reviewer"], concurrency: 4, latencyMs: 80, tokensPerSecond: 12_000, quality: 0.9, ...overrides });
const mix = [
  { taskType: "explain", inputTokens: 800, outputTokens: 300, turns: 1, topology: "T0", role: "coder", weight: 5 },
  { taskType: "bug_fix", inputTokens: 2_500, outputTokens: 900, turns: 2, topology: "T0", role: "coder", weight: 4 },
  { taskType: "feature", inputTokens: 5_000, outputTokens: 1_500, turns: 3, topology: "T1", role: "coder", weight: 2 },
  { taskType: "subagent", inputTokens: 8_000, outputTokens: 2_000, turns: 5, topology: "T4", role: "coder", weight: 1 },
];
const base = { evidenceClass: "simulated", tasksPerUser: 2, thinkTimeMs: 25, burst: false, maxRetries: 2, backoffBaseMs: 100, jitterRatio: 0.2, maxQueueWaitMs: 120_000, userConcurrency: 1, taskMix: mix, routes: [normalRoute("free-a", "synthetic-a"), normalRoute("free-b", "synthetic-b")], seed: 20, startedAt: timestamp, commit };
const scenarios = [
  { ...base, scenarioId: "R20-S1-BASELINE", users: 1, concurrentActiveUsers: 1 },
  { ...base, scenarioId: "R20-S2-10-USERS", users: 10, concurrentActiveUsers: 5 },
  { ...base, scenarioId: "R20-S3-50-USERS", users: 50, concurrentActiveUsers: 20 },
  { ...base, scenarioId: "R20-S4-100-BURST", users: 100, concurrentActiveUsers: 50, burst: true },
  { ...base, scenarioId: "R20-S5-373-DAU-EXPECTED", users: 56, concurrentActiveUsers: 14 },
  { ...base, scenarioId: "R20-S6-HEAVY-USER", users: 20, concurrentActiveUsers: 20, tasksPerUser: 1, tasksByUser: { "user-0001": 50 }, taskMix: mix, burst: true },
  { ...base, scenarioId: "R20-S7-RATE-LIMIT", users: 50, concurrentActiveUsers: 25, routes: [normalRoute("limited", "synthetic-limited", { faultWindows: [{ startMs: 0, endMs: 5_000, kind: "rate_limit", retryAfterMs: 500 }], cooldownThreshold: 2, cooldownMs: 500 }), normalRoute("healthy", "synthetic-healthy")] },
  { ...base, scenarioId: "R20-S8-OUTAGE", users: 50, concurrentActiveUsers: 25, routes: [normalRoute("offline", "synthetic-offline", { faultWindows: [{ startMs: 0, endMs: 5_000, kind: "offline" }], cooldownThreshold: 1, cooldownMs: 500 }), normalRoute("healthy", "synthetic-healthy")] },
  { ...base, scenarioId: "R20-S9-RECOVERY", users: 50, concurrentActiveUsers: 25, routes: [normalRoute("recovering", "synthetic-recovering", { faultWindows: [{ startMs: 0, endMs: 1_000, kind: "server_error" }], cooldownThreshold: 2, cooldownMs: 250, recoveryProbeSuccesses: 2 }), normalRoute("healthy", "synthetic-healthy")] },
  { ...base, scenarioId: "R20-S10-SUBAGENT-HEAVY", users: 25, concurrentActiveUsers: 15, taskMix: [{ taskType: "subagent", inputTokens: 8_000, outputTokens: 2_000, turns: 5, topology: "T5", role: "coder", weight: 1 }] },
];

const harness = new R20ScaleHarness();
const results = scenarios.map((scenario) => harness.run(scenario));
for (const result of results) {
  const { events, ...summary } = result;
  const eventSummary = Object.fromEntries([...new Set(events.map((event) => event.state))].map((state) => [state, events.filter((event) => event.state === state).length]));
  fs.writeFileSync(path.join(outputDir, `${result.scenario}.json`), `${JSON.stringify({ ...summary, eventSummary }, null, 2)}\n`);
}
const dau = {
  low: modelR20Dau({ dau: 373, peakHourActivePercent: 0.08, tasksPerUserDay: 1, turnsPerTask: 3, averageTaskMinutes: 6, subagentPercent: 0.05, browserPercent: 0.03, averageTokensPerTurn: 1_500, burstFactor: 1.2 }),
  expected: modelR20Dau({ dau: 373, peakHourActivePercent: 0.15, tasksPerUserDay: 2, turnsPerTask: 4, averageTaskMinutes: 10, subagentPercent: 0.1, browserPercent: 0.05, averageTokensPerTurn: 2_000, burstFactor: 1.5 }),
  high: modelR20Dau({ dau: 373, peakHourActivePercent: 0.25, tasksPerUserDay: 3, turnsPerTask: 5, averageTaskMinutes: 15, subagentPercent: 0.2, browserPercent: 0.1, averageTokensPerTurn: 3_000, burstFactor: 1.75 }),
  stress: modelR20Dau({ dau: 373, peakHourActivePercent: 0.4, tasksPerUserDay: 5, turnsPerTask: 6, averageTaskMinutes: 20, subagentPercent: 0.3, browserPercent: 0.15, averageTokensPerTurn: 4_000, burstFactor: 2 }),
};
fs.writeFileSync(path.join(outputDir, "R20-373-DAU-MODEL.json"), `${JSON.stringify({ schemaVersion: 1, evidenceClass: "simulated", timestamp, commit, scenarios: dau }, null, 2)}\n`);
console.log(JSON.stringify(results.map(({ scenario, users, concurrency, tasks, queueWaitMs, fairness, requests, successes, failures, retries, rateLimits, durationMs, result }) => ({ scenario, users, concurrency, tasks, queueWaitMs, fairness, requests, successes, failures, retries, rateLimits, durationMs, result })), null, 2));
