import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { SQLiteCloudDatabase } from "../packages/cloud-db/dist/sqlite.js";

const root = path.resolve(import.meta.dirname, "..");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const samples = [];
for (const size of [10, 100, 1_000, 10_000]) {
  const db = new SQLiteCloudDatabase();
  const users = [];
  for (let index = 0; index < Math.min(size, 100); index++) users.push((await db.createUser({ displayName: `User ${index}`, primaryIdentity: `benchmark:${size}:${index}` })).id);
  await db.setHostedProviderCapacity({ providerId: "synthetic", modelId: "free", maxConcurrent: size });
  const enqueueStart = performance.now();
  for (let index = 0; index < size; index++) await db.enqueueHostedExecution({ id: `execution-${size}-${index}`, idempotencyKey: `key-${size}-${index}`, userId: users[index % users.length], taskId: `task-${index}`, providerId: "synthetic", modelId: "free" });
  const enqueueMs = performance.now() - enqueueStart;
  const selectionLatencies = [];
  const claimStart = performance.now();
  for (let index = 0; index < size; index++) {
    const started = performance.now();
    const claim = await db.claimNextHostedExecution({ workerId: `worker-${index}`, leaseMs: 60_000, maxUserConcurrent: size });
    selectionLatencies.push(performance.now() - started);
    if (!claim) throw new Error(`Admission stopped at ${index}/${size}`);
    await db.completeHostedExecution({ executionId: claim.execution.id, userId: claim.execution.userId, status: "completed" });
  }
  const claimMs = performance.now() - claimStart;
  selectionLatencies.sort((a, b) => a - b);
  const percentile = (fraction) => selectionLatencies[Math.min(selectionLatencies.length - 1, Math.ceil(selectionLatencies.length * fraction) - 1)];
  samples.push({ queueSize: size, enqueueMs, claimMs, throughputClaimsPerSecond: size / (claimMs / 1000), selectionLatencyMs: { median: percentile(0.5), p90: percentile(0.9), p95: percentile(0.95), max: selectionLatencies.at(-1) } });
  await db.close();
}
const result = { schemaVersion: 1, environment: "local SQLite in-memory", evidenceClass: "locally_emulated", timestamp: new Date().toISOString(), commit, samples };
const output = path.join(root, "docs", "evidence", "r20-platform-intelligence-scale", "04-per-user", "fairness", "hosted-admission-overhead.json");
fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
