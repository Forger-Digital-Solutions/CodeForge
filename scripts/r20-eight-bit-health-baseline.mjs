import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EightBitMeasuredHealthTracker } from "../packages/eight-bit/dist/measured-health.js";

const root = path.resolve(import.meta.dirname, "..");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const base = { providerId: "synthetic", modelId: "model", observedAt: new Date().toISOString(), sampleSize: 20, successes: 20, failures: 0, rateLimits: 0, timeouts: 0, latencyP50Ms: 500, latencyP95Ms: 1_000, capacityUtilization: 0.25, availableCapacity: 3, qualityScore: 0.9, toolCallScore: 0.95, policyCertainty: "verified", costCertainty: "verified_free" };
const cases = [
  { id: "healthy", expected: "HEALTHY", input: {} },
  { id: "degraded", expected: "DEGRADED", input: { successes: 16, failures: 4 } },
  { id: "rate_limited", expected: "UNAVAILABLE", input: { successes: 10, failures: 10, rateLimits: 9 } },
  { id: "offline", expected: "UNAVAILABLE", input: { successes: 0, failures: 20 } },
  { id: "healthy_but_full", expected: "HEALTHY", input: { capacityUtilization: 1, availableCapacity: 0 } },
  { id: "cost_unknown", expected: "QUARANTINED", input: { costCertainty: "unknown" } },
  { id: "policy_unknown", expected: "QUARANTINED", input: { policyCertainty: "unknown" } },
  { id: "quality_bad", expected: "QUARANTINED", input: { qualityScore: 0.4 } },
].map((testCase) => {
  const actual = new EightBitMeasuredHealthTracker().ingest({ ...base, ...testCase.input, modelId: testCase.id }).state;
  return { ...testCase, actual, pass: actual === testCase.expected };
});
const unsafeCases = cases.filter((item) => ["cost_unknown", "policy_unknown", "quality_bad"].includes(item.id));
const truePositive = cases.filter((item) => item.expected !== "HEALTHY" && item.actual === item.expected).length;
const predictedPositive = cases.filter((item) => item.actual !== "HEALTHY").length;
const actualPositive = cases.filter((item) => item.expected !== "HEALTHY").length;
const result = { schemaVersion: 1, evidenceClass: "simulated", timestamp: new Date().toISOString(), commit, cases, metrics: { accuracy: cases.filter((item) => item.pass).length / cases.length, demotionPrecision: predictedPositive === 0 ? 1 : truePositive / predictedPositive, demotionRecall: actualPositive === 0 ? 1 : truePositive / actualPositive, unsafeAcceptanceRate: unsafeCases.filter((item) => item.actual !== "QUARANTINED").length / unsafeCases.length }, trainingDecision: cases.every((item) => item.pass) ? "DO_NOT_TRAIN_RULE_BASELINE_PERFECT_ON_CURRENT_LABELED_SET" : "EVALUATE_TRAINING_CANDIDATE" };
const output = path.join(root, "docs", "evidence", "r20-platform-intelligence-scale", "05-eight-bit", "health", "rule-baseline.json");
fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
