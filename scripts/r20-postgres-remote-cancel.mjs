import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { PostgresCloudDatabase } from "../packages/cloud-db/dist/postgres.js";
import { HostedAdmissionAuthority } from "../packages/cloud-gateway/dist/hosted-admission.js";
import { HostedQueueWorker } from "../packages/cloud-gateway/dist/hosted-queue-worker.js";

const connectionString = process.env.CODEFORGE_TEST_POSTGRES_URL;
if (!connectionString) throw new Error("CODEFORGE_TEST_POSTGRES_URL is required");

const mode = process.argv[2];
const providerId = process.argv[3];

if (mode === "worker") {
  // Independent process: owns the execution lease and the in-flight provider call. mode=poll
  // never subscribes — the ONLY delivery path for a remote cancellation is the durable poll.
  const subscribe = process.argv[4] !== "poll";
  const db = new PostgresCloudDatabase({ connectionString });
  await db.init();
  const authority = new HostedAdmissionAuthority({ db, workerId: `remote-worker-${randomUUID()}`, leaseMs: 30_000, maxUserConcurrent: 4, claimableProviderIds: () => [providerId] });
  let abortAtMs;
  const worker = new HostedQueueWorker({
    authority,
    heartbeatMs: 5_000,
    idleWaitMs: 50,
    cancelObserveMs: 400,
    execute: async (_execution, signal) => {
      process.stdout.write(`${JSON.stringify({ state: "dispatching" })}\n`);
      await new Promise((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => { abortAtMs = Date.now(); resolve(); }, { once: true });
      });
      process.stdout.write(`${JSON.stringify({ state: "done", aborted: abortAtMs !== undefined, abortAtMs: abortAtMs ?? null })}\n`);
      worker.stop();
      return { status: "failed", resultError: "aborted" };
    },
  });
  if (subscribe) {
    await db.subscribeHostedExecutionEvents((event) => {
      void worker.observeCancellations(event.executionIds === "*" ? "*" : event.executionIds);
    });
  }
  // run() (not runOnce) so the worker's own cancelObserveMs poll is armed — in poll mode that
  // timer is the only thing that can deliver the remote cancellation.
  await worker.run();
  await db.close();
  process.exit(0);
}

// Controller process: enqueues the work on one connection, cancels it on the same connection
// while a SEPARATE process owns the execution — the cancellation must cross process boundaries.
const db = new PostgresCloudDatabase({ connectionString });
await db.init();
const suffix = randomUUID();
const route = { providerId: `r20-remote-${suffix}`, modelId: "verified-free" };
const userId = (await db.createUser({ displayName: "Remote Cancel User", primaryIdentity: `r20-remote:${suffix}` })).id;
await db.setHostedProviderCapacity({ ...route, maxConcurrent: 4 });

const runScenario = async (workerMode, enqueueParams, options = {}) => {
  const claimProviderId = options.claimProviderId ?? route.providerId;
  const cancelTargetId = options.cancelTargetId ?? enqueueParams.id;
  const execution = await db.enqueueHostedExecution(enqueueParams);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "worker", claimProviderId, workerMode], { env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  let stderr = "";
  let resolveDispatching;
  const dispatching = new Promise((resolve) => { resolveDispatching = resolve; });
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  child.stdout.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line);
      lines.push(parsed);
      if (parsed.state === "dispatching") resolveDispatching();
      if (parsed.state === "done") resolveDone(parsed);
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(stderr || `worker exited ${code}`))));
  });
  const timeout = setTimeout(() => { child.kill("SIGKILL"); }, 30_000);
  await Promise.race([dispatching, exit.then(() => Promise.reject(new Error("worker exited before dispatching")))]);
  const cancelSentAt = Date.now();
  const cancelled = await db.cancelHostedExecution({ executionId: cancelTargetId, userId });
  const cancelCommitAt = Date.now();
  const result = await Promise.race([done, exit.then(() => Promise.reject(new Error("worker exited without reporting")))]);
  await exit;
  clearTimeout(timeout);
  const status = (await db.getHostedExecution(execution.execution.id, userId))?.status;
  return {
    mode: workerMode,
    transitioned: cancelled.transitioned,
    aborted: result.aborted === true,
    cancelCommitToAbortMs: result.abortAtMs != null ? result.abortAtMs - cancelCommitAt : null,
    cancelSentToAbortMs: result.abortAtMs != null ? result.abortAtMs - cancelSentAt : null,
    durableStatus: status,
    pass: result.aborted === true && status === "cancelled",
  };
};

const listenResult = await runScenario("listen", { id: `remote-listen-${suffix}`, idempotencyKey: `remote-listen-key-${suffix}`, userId, taskId: "remote-listen", ...route });
const pollResult = await runScenario("poll", { id: `remote-poll-${suffix}`, idempotencyKey: `remote-poll-key-${suffix}`, userId, taskId: "remote-poll", ...route });

// Cascade scenario: a child execution owned by a remote worker must abort when its PARENT is
// cancelled — even though the child lives on a different provider route so only it is claimable.
const childRoute = { providerId: `r20-remote-child-${suffix}`, modelId: "verified-free" };
await db.setHostedProviderCapacity({ ...childRoute, maxConcurrent: 4 });
const parentExec = await db.enqueueHostedExecution({ id: `remote-parent-${suffix}`, idempotencyKey: `remote-parent-key-${suffix}`, userId, taskId: "remote-parent", ...route });
const cascadeResult = await runScenario(
  "cascade",
  { id: `remote-child-${suffix}`, idempotencyKey: `remote-child-key-${suffix}`, userId, taskId: "remote-child", ...childRoute, parentExecutionId: parentExec.execution.id, rootExecutionId: parentExec.execution.id },
  { claimProviderId: childRoute.providerId, cancelTargetId: parentExec.execution.id },
);
cascadeResult.cancelledParent = parentExec.execution.id;
cascadeResult.parentStatus = (await db.getHostedExecution(parentExec.execution.id, userId))?.status;
cascadeResult.pass = cascadeResult.pass && cascadeResult.parentStatus === "cancelled";

const evidence = {
  schemaVersion: 1,
  evidenceClass: "local_real_postgresql_two_processes",
  mechanism: "postgresql LISTEN/NOTIFY wake-up + bounded durable terminal-state poll fallback",
  scenarios: [listenResult, pollResult, cascadeResult],
  pass: listenResult.pass && pollResult.pass && cascadeResult.pass,
};
console.log(JSON.stringify(evidence, null, 2));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.writeFileSync(path.join(root, "docs", "evidence", "r20-platform-intelligence-scale", "03-managed-free", "results", "postgres-remote-cancel.json"), `${JSON.stringify({ ...evidence, timestamp: new Date().toISOString() }, null, 2)}\n`);
await db.close();
if (!evidence.pass) process.exitCode = 1;
