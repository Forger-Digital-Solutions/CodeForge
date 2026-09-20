import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { PostgresCloudDatabase } from "../packages/cloud-db/dist/postgres.js";

const connectionString = process.env.CODEFORGE_TEST_POSTGRES_URL;
if (!connectionString) throw new Error("CODEFORGE_TEST_POSTGRES_URL is required");

if (process.argv[2] === "worker") {
  const db = new PostgresCloudDatabase({ connectionString });
  await db.init();
  try {
    const claim = await db.claimNextHostedExecution({ workerId: process.argv[3], leaseMs: 60_000, maxUserConcurrent: 4 });
    process.stdout.write(`${JSON.stringify(claim ? { executionId: claim.execution.id, providerId: claim.execution.providerId, modelId: claim.execution.modelId, workerId: process.argv[3] } : null)}\n`);
  } finally {
    await db.close();
  }
  process.exit(0);
}

const db = new PostgresCloudDatabase({ connectionString });
await db.init();
const suffix = randomUUID();
const route = { providerId: `r20-process-${suffix}`, modelId: "verified-free" };
const users = await Promise.all(Array.from({ length: 20 }, async (_, index) => (await db.createUser({ displayName: `Process User ${index}`, primaryIdentity: `r20-process:${suffix}:${index}` })).id));
await db.setHostedProviderCapacity({ ...route, maxConcurrent: 4 });
for (let index = 0; index < 100; index++) await db.enqueueHostedExecution({ id: `process-execution-${suffix}-${index}`, idempotencyKey: `process-key-${suffix}-${index}`, userId: users[index % users.length], taskId: `process-task-${index}`, ...route });

const runWorker = (index) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "worker", `process-worker-${index}`], { env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("exit", (code) => {
    if (code !== 0) reject(new Error(stderr || `worker ${index} exited ${code}`));
    else resolve(stdout.trim() ? JSON.parse(stdout.trim().split(/\r?\n/).at(-1)) : null);
  });
});

const claims = await Promise.all(Array.from({ length: 20 }, (_, index) => runWorker(index)));
const routeClaims = claims.filter((claim) => claim?.providerId === route.providerId && claim.modelId === route.modelId);
const result = { schemaVersion: 1, evidenceClass: "local_real_postgresql", processes: 20, queued: 100, providerCapacity: 4, routeClaims: routeClaims.length, distinctExecutions: new Set(routeClaims.map((claim) => claim.executionId)).size, workerIds: routeClaims.map((claim) => claim.workerId), pass: routeClaims.length === 4 && new Set(routeClaims.map((claim) => claim.executionId)).size === 4 };
console.log(JSON.stringify(result, null, 2));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.writeFileSync(path.join(root, "docs", "evidence", "r20-platform-intelligence-scale", "03-managed-free", "results", "postgres-multiprocess-admission.json"), `${JSON.stringify({ ...result, timestamp: new Date().toISOString() }, null, 2)}\n`);
await db.close();
if (!result.pass) process.exitCode = 1;
