#!/usr/bin/env node
// Synthetic control-plane scale proof over the production CapacityReservationLedger.
import path from "node:path";
import { writeFileSync } from "node:fs";
import { simulateR33ControlPlane } from "../packages/benchmark/dist/r33-control-plane-scale.js";

const scenarios = {
  singleUser: {
    users: 1,
    tasksPerUser: 8,
    routes: [
      { id: "groq-model-a", concurrency: 2, quotaPerWindow: 4, windowTicks: 5, failedCallsConsumeQuota: true },
    ],
    maxTicks: 30,
  },
  modestConcurrent: {
    users: 32,
    tasksPerUser: 4,
    routes: [
      { id: "openrouter-account", concurrency: 8, quotaPerWindow: 40, windowTicks: 20, failedCallsConsumeQuota: true, fault: { fromTick: 2, throughTick: 8, kind: "429" } },
      { id: "groq-model-a", concurrency: 8, quotaPerWindow: 40, windowTicks: 10, failedCallsConsumeQuota: true },
      { id: "cloudflare-account", concurrency: 4, quotaPerWindow: 20, windowTicks: 15, failedCallsConsumeQuota: true, fault: { fromTick: 5, throughTick: 7, kind: "5xx" } },
    ],
    maxTicks: 120,
  },
  largeConcurrent: {
    users: 1000,
    tasksPerUser: 2,
    routes: [
      { id: "openrouter-account", concurrency: 64, quotaPerWindow: 600, windowTicks: 50, failedCallsConsumeQuota: true, fault: { fromTick: 5, throughTick: 15, kind: "429" } },
      { id: "groq-model-a", concurrency: 64, quotaPerWindow: 800, windowTicks: 40, failedCallsConsumeQuota: true },
      { id: "cloudflare-permanently-exhausted", concurrency: 32, quotaPerWindow: 200, windowTicks: 1000, failedCallsConsumeQuota: true, fault: { fromTick: 0, throughTick: 300, kind: "403" } },
    ],
    maxTicks: 300,
  },
  onePoolComparison: {
    users: 200,
    tasksPerUser: 3,
    routes: [
      { id: "pool-a", concurrency: 20, quotaPerWindow: 200, windowTicks: 20, failedCallsConsumeQuota: true },
    ],
    maxTicks: 20,
  },
  threePoolComparison: {
    users: 200,
    tasksPerUser: 3,
    routes: [
      { id: "pool-a", concurrency: 20, quotaPerWindow: 200, windowTicks: 20, failedCallsConsumeQuota: true },
      { id: "pool-b", concurrency: 20, quotaPerWindow: 200, windowTicks: 20, failedCallsConsumeQuota: true },
      { id: "pool-c", concurrency: 20, quotaPerWindow: 200, windowTicks: 20, failedCallsConsumeQuota: true },
    ],
    maxTicks: 20,
  },
};

const results = Object.fromEntries(Object.entries(scenarios).map(([name, scenario]) => [
  name,
  simulateR33ControlPlane(scenario),
]));
const fraction = (result) => result.completedTasks / result.simulatedTasks;
const assertions = {
  noDuplicateAdmissions: Object.values(results).every((result) => result.duplicateAdmissions === 0),
  noLeakedLeases: Object.values(results).every((result) => result.leakedLeases === 0),
  noAccountingErrors: Object.values(results).every((result) => result.capacityAccountingErrors === 0 && result.ledgerAccountingDivergences === 0),
  fairFirstAdmissions: Object.values(results).every((result) => result.fairFirstAdmissions),
  noStarvedUsersWhenScenarioCompletes: Object.values(results).filter((result) => result.complete).every((result) => result.starvedUsers === 0),
  recoveringProviderObserved: results.modestConcurrent.rateLimits > 0 && results.modestConcurrent.recoveredTasks > 0,
  permanentFailureDidNotBlockIndependentSupply: results.largeConcurrent.forbiddenResponses > 0 && results.largeConcurrent.completedTasks > 0,
  independentSupplyIncreasesSuccessFraction: fraction(results.threePoolComparison) > fraction(results.onePoolComparison),
  independentSupplyUsesMoreThanOneRoute: results.threePoolComparison.routes.filter((route) => route.dispatched > 0).length === 3,
};

const evidence = {
  schemaVersion: 1,
  round: "R49",
  generatedAt: new Date().toISOString(),
  provenance: "simulated; production CapacityReservationLedger cross-validated against independent synthetic counters",
  paidSpendUsd: 0,
  scenarios,
  results,
  comparison: {
    onePoolSuccessFraction: fraction(results.onePoolComparison),
    threePoolSuccessFraction: fraction(results.threePoolComparison),
    onePoolCompleted: results.onePoolComparison.completedTasks,
    threePoolCompleted: results.threePoolComparison.completedTasks,
    simulatedTasks: results.onePoolComparison.simulatedTasks,
  },
  assertions,
  passed: Object.values(assertions).every(Boolean),
};
writeFileSync(path.resolve("docs/evidence/r49-free-supply/R49-MULTIUSER-SIMULATION.json"), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`[r49-multiuser] single=${results.singleUser.completedTasks}/${results.singleUser.simulatedTasks} modest=${results.modestConcurrent.completedTasks}/${results.modestConcurrent.simulatedTasks} large=${results.largeConcurrent.completedTasks}/${results.largeConcurrent.simulatedTasks}`);
console.log(`[r49-multiuser] onePool=${evidence.comparison.onePoolSuccessFraction.toFixed(3)} threePool=${evidence.comparison.threePoolSuccessFraction.toFixed(3)} passed=${evidence.passed}`);
if (!evidence.passed) process.exitCode = 1;
