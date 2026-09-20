import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { PostgresCloudDatabase } from "../packages/cloud-db/dist/postgres.js";
import { HostedAdmissionAuthority } from "../packages/cloud-gateway/dist/hosted-admission.js";
import { HostedQueueWorker } from "../packages/cloud-gateway/dist/hosted-queue-worker.js";

const connectionString = process.env.CODEFORGE_TEST_POSTGRES_URL;
if (!connectionString) throw new Error("CODEFORGE_TEST_POSTGRES_URL is required");

const mode = process.argv[2];

if (mode === "drain-worker" || mode === "hang-worker") {
  // Independent worker process. drain-worker claims, holds a lease briefly, and completes —
  // proving global capacity/fairness under concurrent claimants. hang-worker claims then
  // stalls inside "provider execution" so the controller can SIGKILL it post-dispatch.
  const providerId = process.argv[3];
  const tag = process.argv[4];
  const leaseMs = Number(process.argv[5] ?? 30_000);
  const db = new PostgresCloudDatabase({ connectionString });
  await db.init();
  const authority = new HostedAdmissionAuthority({ db, workerId: `mi-worker-${tag}`, leaseMs, maxUserConcurrent: 1, claimableProviderIds: () => [providerId] });
  const worker = new HostedQueueWorker({
    authority,
    heartbeatMs: 200,
    idleWaitMs: 40,
    cancelObserveMs: 500,
    execute: async (execution, signal) => {
      process.stdout.write(`${JSON.stringify({ type: "claim", worker: tag, executionId: execution.id, userId: execution.userId, atMs: Date.now() })}\n`);
      if (mode === "hang-worker") {
        process.stdout.write(`${JSON.stringify({ type: "dispatch", worker: tag, executionId: execution.id, atMs: Date.now() })}\n`);
        await new Promise(() => {});
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (signal.aborted) return { status: "failed", resultError: "aborted" };
      process.stdout.write(`${JSON.stringify({ type: "complete", worker: tag, executionId: execution.id, atMs: Date.now() })}\n`);
      return { status: "completed" };
    },
  });
  await worker.run();
  await db.close();
  process.exit(0);
}

// Controller: enqueues work and measures behavior across real worker subprocesses.
const db = new PostgresCloudDatabase({ connectionString });
await db.init();
const suffix = randomUUID();
const route = { providerId: `r20-mi-${suffix}`, modelId: "verified-free" };
const userCount = 4;
const executionsPerUser = 3;
const routeCapacity = 4;
const users = [];
for (let i = 0; i < userCount; i += 1) {
  users.push((await db.createUser({ displayName: `MI User ${i}`, primaryIdentity: `r20-mi-${suffix}:${i}` })).id);
}
await db.setHostedProviderCapacity({ ...route, maxConcurrent: routeCapacity });

const spawnWorker = (workerMode, tag, extraArgs = [], claimProviderId = route.providerId) => {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), workerMode, claimProviderId, tag, ...extraArgs], { env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const events = [];
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      events.push(JSON.parse(line));
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return { child, events, stderr: () => stderr };
};

// Phase A — three independent drain workers race for 12 executions (4 users × 3) on one
// route capped at 4. Proves: global capacity bound, claim-once (attempt=1), fair rotation.
for (const [index, userId] of users.entries()) {
  for (let j = 0; j < executionsPerUser; j += 1) {
    await db.enqueueHostedExecution({ id: `mi-${suffix}-u${index}-e${j}`, idempotencyKey: `mi-key-${suffix}-u${index}-e${j}`, userId, taskId: `mi-task-u${index}-e${j}`, ...route });
  }
}
const raw = new pg.Client(connectionString);
await raw.connect();
// Four workers against capacity four — enough claimants to saturate the bound if it fails.
const workers = [spawnWorker("drain-worker", "a"), spawnWorker("drain-worker", "b"), spawnWorker("drain-worker", "c"), spawnWorker("drain-worker", "d")];
const totalExpected = userCount * executionsPerUser;
const deadline = Date.now() + 90_000;
let terminalCount = 0;
do {
  await new Promise((resolve) => setTimeout(resolve, 250));
  const res = await raw.query("SELECT COUNT(*)::int AS c FROM hosted_executions WHERE id LIKE $1 AND status IN ('completed','failed','cancelled')", [`mi-${suffix}-u%`]);
  terminalCount = res.rows[0]?.c ?? 0;
} while (terminalCount < totalExpected && Date.now() < deadline);
for (const worker of workers) worker.child.kill("SIGKILL");
await new Promise((resolve) => setTimeout(resolve, 300));

// Durable occupancy proof: rebuild concurrency from lease intervals instead of sampling —
// a poller can miss a peak; committed created_at/released_at intervals cannot.
const leaseRows = (await raw.query("SELECT created_at, released_at, lease_expires_at, state FROM hosted_capacity_leases WHERE provider_id = $1", [route.providerId])).rows;
const edges = [];
for (const lease of leaseRows) {
  const start = new Date(lease.created_at).getTime();
  const end = new Date(lease.released_at ?? lease.lease_expires_at).getTime();
  edges.push({ t: start, d: 1 }, { t: end, d: -1 });
}
edges.sort((a, b) => a.t - b.t || a.d - b.d);
let maxActive = 0;
let running = 0;
for (const edge of edges) { running += edge.d; if (running > maxActive) maxActive = running; }

const claimEvents = workers.flatMap((worker) => worker.events.filter((event) => event.type === "claim")).sort((a, b) => a.atMs - b.atMs);
const claimedIds = new Set(claimEvents.map((event) => event.executionId));
const claimedRows = (await raw.query("SELECT id, status, attempt, user_id FROM hosted_executions WHERE id LIKE $1", [`mi-${suffix}-u%`])).rows;
const allCompleted = claimedRows.length === totalExpected && claimedRows.every((row) => row.status === "completed");
const claimOnce = claimedRows.every((row) => row.attempt === 1) && claimedIds.size === claimEvents.length && claimEvents.length === totalExpected;
const firstWindow = claimEvents.slice(0, routeCapacity).map((event) => event.userId);
const fairFirstWindow = new Set(firstWindow).size === Math.min(userCount, routeCapacity);
const perUserClaims = new Map();
for (const event of claimEvents) perUserClaims.set(event.userId, (perUserClaims.get(event.userId) ?? 0) + 1);
const noStarvation = users.every((userId) => perUserClaims.get(userId) === executionsPerUser);
// Safety is "never exceeded capacity"; saturation is "all four claimants overlapped once".
const capacityBound = maxActive <= routeCapacity && maxActive >= Math.min(routeCapacity, workers.length);

// Idempotent enqueue: the same idempotency_key submitted concurrently must yield one row.
const dupUser = users[0];
const dupKey = `mi-dup-key-${suffix}`;
const [dupA, dupB] = await Promise.all([
  db.enqueueHostedExecution({ id: `mi-dup-a-${suffix}`, idempotencyKey: dupKey, userId: dupUser, taskId: "mi-dup", ...route }),
  db.enqueueHostedExecution({ id: `mi-dup-b-${suffix}`, idempotencyKey: dupKey, userId: dupUser, taskId: "mi-dup", ...route }),
]);
const dupRows = (await raw.query("SELECT id FROM hosted_executions WHERE idempotency_key = $1", [dupKey])).rows;
const idempotentEnqueue = dupRows.length === 1 && dupA.execution.id === dupB.execution.id;

// Phase B — server death: a worker SIGKILLed post-dispatch must not strand the execution;
// lease expiry + recovery moves it to recovery_pending (ambiguous), resolved fail-closed.
// A dedicated route guarantees the hang-worker can only claim THIS execution.
const deathRoute = { providerId: `r20-mi-death-${suffix}`, modelId: "verified-free" };
await db.setHostedProviderCapacity({ ...deathRoute, maxConcurrent: 4 });
const deathLeaseMs = 1_500;
const deathUser = users[1];
await db.enqueueHostedExecution({ id: `mi-death-${suffix}`, idempotencyKey: `mi-death-key-${suffix}`, userId: deathUser, taskId: "mi-death", ...deathRoute });
const hangWorker = spawnWorker("hang-worker", "hang", [String(deathLeaseMs)], deathRoute.providerId);
const dispatched = new Promise((resolve) => {
  const check = setInterval(() => {
    if (hangWorker.events.some((event) => event.type === "dispatch")) { clearInterval(check); resolve(); }
  }, 25);
});
await Promise.race([dispatched, new Promise((_, reject) => setTimeout(() => reject(new Error("hang worker never dispatched")), 30_000))]);
hangWorker.child.kill("SIGKILL");
await new Promise((resolve) => setTimeout(resolve, deathLeaseMs + 700));
await db.recoverExpiredHostedLeases();
const deathRow = await db.getHostedExecution(`mi-death-${suffix}`, deathUser);
const recoveredPending = deathRow?.status === "recovery_pending" && deathRow.dispatchedAt != null;
const deathResolution = await db.resolveHostedRecoveryPending({ executionId: `mi-death-${suffix}`, workerId: "mi-controller", resolution: "failed", reason: "worker died post-dispatch; provider outcome ambiguous" });
const deathFinal = await db.getHostedExecution(`mi-death-${suffix}`, deathUser);
const deathResolved = deathResolution.transitioned === true && deathFinal?.status === "failed";
await raw.end();

const evidence = {
  schemaVersion: 1,
  evidenceClass: "local_real_postgresql_multi_subprocess",
  phaseA: {
    workers: workers.length,
    executions: totalExpected,
    users: userCount,
    routeCapacity,
    claimsObserved: claimEvents.length,
    peakActiveLeases: maxActive,
    occupancySource: "hosted_capacity_leases.created_at..released_at interval sweep",
    allCompleted,
    claimOnce,
    fairFirstWindow,
    firstClaimUsers: firstWindow,
    perUserClaims: Object.fromEntries(perUserClaims),
    noStarvation,
    capacityBound,
    idempotentEnqueue,
    pass: allCompleted && claimOnce && fairFirstWindow && noStarvation && capacityBound && idempotentEnqueue,
  },
  phaseB: {
    executionId: `mi-death-${suffix}`,
    leaseMs: deathLeaseMs,
    recoveredPending,
    deathResolved,
    pass: recoveredPending && deathResolved,
  },
};
evidence.pass = evidence.phaseA.pass && evidence.phaseB.pass;
console.log(JSON.stringify(evidence, null, 2));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.writeFileSync(path.join(root, "docs", "evidence", "r20-platform-intelligence-scale", "03-managed-free", "results", "postgres-multi-instance.json"), `${JSON.stringify({ ...evidence, timestamp: new Date().toISOString() }, null, 2)}\n`);
await db.close();
if (!evidence.pass) process.exitCode = 1;
