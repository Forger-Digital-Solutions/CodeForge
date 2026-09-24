import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { simulateR33ControlPlane } from "../packages/benchmark/dist/r33-control-plane-scale.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "docs/evidence/r33-free-capacity-fabric/load-simulation/results.json");
const sizes = [100, 1_000, 10_000, 100_000, 1_000_000];
const results = [];

for (const users of sizes) {
  const before = process.memoryUsage();
  const started = performance.now();
  const result = simulateR33ControlPlane({
    users,
    tasksPerUser: 2,
    maxTicks: 10_000,
    routes: [
      { id: "synthetic-free-a", concurrency: 2_048, quotaPerWindow: 20_000, windowTicks: 20, failedCallsConsumeQuota: false, fault: { fromTick: 2, throughTick: 3, kind: "429" } },
      { id: "synthetic-free-b", concurrency: 2_048, quotaPerWindow: 20_000, windowTicks: 20, failedCallsConsumeQuota: true },
    ],
  });
  const after = process.memoryUsage();
  const measured = { ...result, wallMs: Math.round(performance.now() - started), heapDeltaMiB: Math.round((after.heapUsed - before.heapUsed) / 1048576), postRunRssMiB: Math.round(after.rss / 1048576) };
  results.push(measured);
  const valid = result.complete && result.duplicateAdmissions === 0 && result.inFlightReplayRejections === result.attemptedAdmissions && result.leakedLeases === 0 && result.capacityAccountingErrors === 0 && result.starvedUsers === 0 && result.fairFirstAdmissions && result.idempotentReplays === result.simulatedTasks;
  if (!valid) throw new Error(`Synthetic scale invariant failed at ${users} users: ${JSON.stringify(result)}`);
  console.log(`${users.toLocaleString()} virtual users: ${measured.wallMs} ms, post-run RSS ${measured.postRunRssMiB} MiB, ${result.ticks} ticks, ${result.completedTasks.toLocaleString()} tasks`);
}

const evidence = {
  schemaVersion: 1,
  evidenceClass: "synthetic_control_plane",
  generatedAt: new Date().toISOString(),
  nodeVersion: process.version,
  platform: `${process.platform}-${process.arch}`,
  sourceSha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "packages/benchmark/src/r33-control-plane-scale.ts"))).digest("hex"),
  caveat: "Virtual users and synthetic provider quotas executed in-process. Every admission, lease, and release passes through the production CapacityReservationLedger (same-id replace, per-user concurrency caps, pool demand accounting, lease expiry), cross-validated per tick against the independent synthetic model — but no network traffic, database transactions, or live inference run here, so this does not certify one million production users or any real provider capacity.",
  results,
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(path.relative(root, output));
