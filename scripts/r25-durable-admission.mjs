#!/usr/bin/env node
/*
 * R25 durable distributed admission proof — real PostgreSQL, spawned worker processes.
 *
 * Cases:
 *   A multi-process atomic admission   — N queued, K capacity, P spawned workers race one claim each
 *   B lease expiry + fencing           — claimed worker "dies"; lease expires; row requeues;
 *                                        the stale fencing token can no longer complete it
 *   C idempotent enqueue               — same idempotency key twice → one execution row
 *   D dispatching crash → recovery     — dispatching + expired lease → recovery_pending;
 *                                        requeue refused without provider dispatch identity
 *                                        (fail closed), allowed with it
 *   E per-user fairness                — maxUserConcurrent spreads claims across users
 *   F queue drain                      — claim→complete loop drains the queue with zero duplicates
 *
 * Requires CODEFORGE_TEST_POSTGRES_URL (scripts/setup-local-pg.mjs provisions WSL Postgres 16).
 * Evidence → docs/evidence/r25-live-reality/durable-admission.json
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { PostgresCloudDatabase } from "../packages/cloud-db/dist/postgres.js";

const connectionString = process.env.CODEFORGE_TEST_POSTGRES_URL;
if (!connectionString) throw new Error("CODEFORGE_TEST_POSTGRES_URL is required");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SMALL_POOL = { max: 4, idleTimeoutMillis: 10_000 };

if (process.argv[2] === "worker") {
  const db = new PostgresCloudDatabase({ connectionString, pool: new pg.Pool({ connectionString, ...SMALL_POOL }) });
  await db.init();
  try {
    let claim;
    for (let attempt = 0; attempt < 5 && !claim; attempt++) {
      claim = await db.claimNextHostedExecution({ workerId: process.argv[3], leaseMs: 30_000, maxUserConcurrent: Number(process.argv[4] ?? 4), providerIds: process.argv[5] ? [process.argv[5]] : undefined });
      if (!claim) await new Promise((r) => setTimeout(r, 120));
    }
    process.stdout.write(`${JSON.stringify(claim ? { executionId: claim.execution.id, userId: claim.execution.userId, providerId: claim.execution.providerId, modelId: claim.execution.modelId, workerId: process.argv[3], leaseToken: claim.execution.leaseToken } : null)}\n`);
  } finally {
    await db.close();
  }
  process.exit(0);
}

const db = new PostgresCloudDatabase({ connectionString, pool: new pg.Pool({ connectionString, ...SMALL_POOL }) });
await db.init();
const raw = new pg.Client({ connectionString });
await raw.connect();

const suffix = randomUUID().slice(0, 8);
const results = { schemaVersion: 1, evidenceClass: "local_real_postgresql", recordedAt: new Date().toISOString(), cases: {} };
const fail = (name, detail) => { results.cases[name] = { pass: false, detail }; console.error(`FAIL ${name}: ${detail}`); };
const pass = (name, detail) => { results.cases[name] = { pass: true, detail }; console.log(`PASS ${name}: ${detail}`); };

const runWorker = (index, { maxUserConcurrent = 4, providerId } = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "worker", `w${index}`, String(maxUserConcurrent), providerId ?? ""], { env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.on("data", (c) => { stderr += c; });
  child.once("error", reject);
  child.once("exit", (code) => {
    if (code !== 0) reject(new Error(stderr || `worker ${index} exited ${code}`));
    else resolve(stdout.trim() ? JSON.parse(stdout.trim().split(/\r?\n/).at(-1)) : null);
  });
});

const statusOf = async (id) => (await raw.query("SELECT status, attempt, lease_owner, lease_token FROM hosted_executions WHERE id=$1", [id])).rows[0];
const receiptsFor = async (id) => (await raw.query("SELECT event_type, details FROM hosted_admission_receipts WHERE execution_id=$1 ORDER BY created_at", [id])).rows.map((r) => r.event_type);

try {
  // ---- Case A: multi-process atomic admission ----------------------------------------------
  {
    const route = { providerId: `r25-a-${suffix}`, modelId: "verified-free" };
    const users = await Promise.all(Array.from({ length: 8 }, async (_, i) => (await db.createUser({ displayName: `R25 A${i}`, primaryIdentity: `r25:${suffix}:a:${i}` })).id));
    await db.setHostedProviderCapacity({ ...route, maxConcurrent: 3 });
    for (let i = 0; i < 30; i++) await db.enqueueHostedExecution({ id: `r25a-${suffix}-${i}`, idempotencyKey: `r25a-key-${suffix}-${i}`, userId: users[i % users.length], taskId: `task-${i}`, ...route });
    const claims = (await Promise.all(Array.from({ length: 8 }, (_, i) => runWorker(i, { providerId: route.providerId })))).filter((c) => c?.providerId === route.providerId);
    const distinctExec = new Set(claims.map((c) => c.executionId));
    const distinctUsers = new Set(claims.map((c) => c.userId));
    claims.length === 3 && distinctExec.size === 3 && distinctUsers.size === 3
      ? pass("A.multi_process_admission", `8 processes raced 30 queued on capacity=3 → exactly 3 distinct claims across 3 users; no duplicates`)
      : fail("A.multi_process_admission", `claims=${claims.length} distinctExec=${distinctExec.size} distinctUsers=${distinctUsers.size}`);
  }

  // ---- Case B: lease expiry reclaim + fencing token ----------------------------------------
  {
    const route = { providerId: `r25-b-${suffix}`, modelId: "verified-free" };
    const user = (await db.createUser({ displayName: "R25 B", primaryIdentity: `r25:${suffix}:b` })).id;
    await db.setHostedProviderCapacity({ ...route, maxConcurrent: 1 });
    const execId = `r25b-${suffix}-0`;
    await db.enqueueHostedExecution({ id: execId, idempotencyKey: `r25b-key-${suffix}-0`, userId: user, taskId: "task-b", ...route });
    const claim = await db.claimNextHostedExecution({ workerId: "dying-worker", leaseMs: 800, maxUserConcurrent: 4, providerIds: [route.providerId] });
    if (!claim) throw new Error("case B: initial claim failed");
    await new Promise((r) => setTimeout(r, 1100));
    const recovered = await db.recoverExpiredHostedLeases();
    const afterRecovery = await statusOf(execId);
    let staleRejected = false;
    try {
      const res = await db.completeHostedExecution({ executionId: execId, userId: user, workerId: "dying-worker", leaseToken: claim.execution.leaseToken, status: "completed" });
      staleRejected = !res.transitioned;
    } catch { staleRejected = true; }
    const reclaim = await db.claimNextHostedExecution({ workerId: "recovery-worker", leaseMs: 30_000, maxUserConcurrent: 4, providerIds: [route.providerId] });
    const reclaimOk = reclaim?.execution.id === execId;
    const completed = reclaimOk ? await db.completeHostedExecution({ executionId: execId, userId: user, workerId: "recovery-worker", leaseToken: reclaim.execution.leaseToken, status: "completed" }) : { transitioned: false };
    const receipts = await receiptsFor(execId);
    const ok = recovered.executionIds.includes(execId) && afterRecovery.status === "queued" && staleRejected && reclaimOk && completed.transitioned === true && receipts.includes("LEASE_EXPIRED");
    ok ? pass("B.lease_expiry_fencing", `dead worker's lease expired → requeued → stale token rejected → new worker claimed+completed; receipts=${receipts.join(",")}`)
       : fail("B.lease_expiry_fencing", `recovered=${recovered.recovered} status=${afterRecovery.status} staleRejected=${staleRejected} reclaimOk=${reclaimOk} completed=${completed.transitioned} receipts=${receipts.join(",")}`);
  }

  // ---- Case C: idempotent enqueue -----------------------------------------------------------
  {
    const user = (await db.createUser({ displayName: "R25 C", primaryIdentity: `r25:${suffix}:c` })).id;
    const key = `r25c-key-${suffix}`;
    const route = { providerId: `r25-c-${suffix}`, modelId: "verified-free" };
    const first = await db.enqueueHostedExecution({ id: `r25c-${suffix}-0`, idempotencyKey: key, userId: user, taskId: "task-c", ...route });
    const second = await db.enqueueHostedExecution({ id: `r25c-${suffix}-dup`, idempotencyKey: key, userId: user, taskId: "task-c", ...route });
    const count = Number((await raw.query("SELECT COUNT(*)::int AS c FROM hosted_executions WHERE idempotency_key=$1", [key])).rows[0].c);
    first.created && !second.created && count === 1 && first.execution.id === second.execution.id
      ? pass("C.idempotent_enqueue", `duplicate idempotency key returned existing execution ${first.execution.id}; rows=${count}`)
      : fail("C.idempotent_enqueue", `created=${first.created}/${second.created} sameId=${first.execution.id === second.execution.id} rows=${count}`);
  }

  // ---- Case D: dispatching crash → recovery_pending → fail-closed resolve -------------------
  {
    const route = { providerId: `r25-d-${suffix}`, modelId: "verified-free" };
    const user = (await db.createUser({ displayName: "R25 D", primaryIdentity: `r25:${suffix}:d` })).id;
    await db.setHostedProviderCapacity({ ...route, maxConcurrent: 2 });
    // D1: dispatching WITHOUT a provider dispatch identity — outcome unknowable → must fail closed.
    const noDispatchId = `r25d-nodispatch-${suffix}`;
    await db.enqueueHostedExecution({ id: noDispatchId, idempotencyKey: `r25d-key-n-${suffix}`, userId: user, taskId: "task-d1", ...route });
    const claim1 = await db.claimNextHostedExecution({ workerId: "dispatch-crash-1", leaseMs: 800, maxUserConcurrent: 4, providerIds: [route.providerId] });
    if (claim1?.execution.id !== noDispatchId) throw new Error(`case D1: unexpected claim ${claim1?.execution.id}`);
    await db.markHostedExecutionDispatching({ executionId: claim1.execution.id, workerId: "dispatch-crash-1", leaseToken: claim1.execution.leaseToken });
    await new Promise((r) => setTimeout(r, 1100));
    await db.recoverExpiredHostedLeases();
    const pending = await statusOf(noDispatchId);
    let requeueRefused = false;
    try { await db.resolveHostedRecoveryPending({ executionId: noDispatchId, workerId: "recovery", resolution: "requeue" }); }
    catch (e) { requeueRefused = /provider dispatch identity/i.test(e.message); }
    const failed = await db.resolveHostedRecoveryPending({ executionId: noDispatchId, workerId: "recovery", resolution: "failed" });
    // D2: dispatching WITH a provider dispatch identity → safe requeue under a new fencing token.
    const withDispatchId = `r25d-dispatch-${suffix}`;
    await db.enqueueHostedExecution({ id: withDispatchId, idempotencyKey: `r25d-key-d-${suffix}`, userId: user, taskId: "task-d2", ...route });
    const claim2 = await db.claimNextHostedExecution({ workerId: "dispatch-crash-2", leaseMs: 800, maxUserConcurrent: 4, providerIds: [route.providerId] });
    if (claim2?.execution.id !== withDispatchId) throw new Error(`case D2: unexpected claim ${claim2?.execution.id}`);
    await db.markHostedExecutionDispatching({ executionId: claim2.execution.id, workerId: "dispatch-crash-2", leaseToken: claim2.execution.leaseToken, providerDispatchId: `dispatch-${suffix}` });
    await new Promise((r) => setTimeout(r, 1100));
    await db.recoverExpiredHostedLeases();
    const requeued = await db.resolveHostedRecoveryPending({ executionId: withDispatchId, workerId: "recovery", resolution: "requeue" });
    const reStatus = await statusOf(withDispatchId);
    const reclaim = await db.claimNextHostedExecution({ workerId: "worker-after-requeue", leaseMs: 30_000, maxUserConcurrent: 4, providerIds: [route.providerId] });
    const ok = pending.status === "recovery_pending" && requeueRefused && failed.transitioned && (await statusOf(noDispatchId)).status === "failed"
      && requeued.transitioned && reStatus.status === "queued" && reclaim?.execution.id === withDispatchId && reclaim.execution.attempt === 2;
    ok ? pass("D.dispatching_crash_recovery", `no dispatch-id: recovery_pending → requeue REFUSED → failed closed; with dispatch-id: requeued → reclaimed at attempt=2`)
       : fail("D.dispatching_crash_recovery", `pending=${pending.status} requeueRefused=${requeueRefused} failedTransition=${failed.transitioned} requeued=${requeued.transitioned} reStatus=${reStatus.status} reclaimAttempt=${reclaim?.execution.attempt}`);
  }

  // ---- Case E: per-user fairness under maxUserConcurrent ------------------------------------
  {
    const route = { providerId: `r25-e-${suffix}`, modelId: "verified-free" };
    const users = await Promise.all(Array.from({ length: 6 }, async (_, i) => (await db.createUser({ displayName: `R25 E${i}`, primaryIdentity: `r25:${suffix}:e:${i}` })).id));
    await db.setHostedProviderCapacity({ ...route, maxConcurrent: 6 });
    for (let i = 0; i < 24; i++) await db.enqueueHostedExecution({ id: `r25e-${suffix}-${i}`, idempotencyKey: `r25e-key-${suffix}-${i}`, userId: users[i % users.length], taskId: `task-e-${i}`, ...route });
    const claims = (await Promise.all(Array.from({ length: 6 }, (_, i) => runWorker(i, { maxUserConcurrent: 1, providerId: route.providerId })))).filter(Boolean);
    const distinctExec = new Set(claims.map((c) => c.executionId));
    const distinctUsers = new Set(claims.map((c) => c.userId));
    claims.length === 6 && distinctExec.size === claims.length && distinctUsers.size === claims.length
      ? pass("E.per_user_fairness", `capacity=6, maxUserConcurrent=1, 24 queued across 6 users → ${claims.length} claims on ${distinctUsers.size} distinct users (no single-user capture, no duplicate execution)`)
      : fail("E.per_user_fairness", `claims=${claims.length} distinctExec=${distinctExec.size} distinctUsers=${distinctUsers.size}`);
  }

  // ---- Case F: queue drain — every execution completes exactly once --------------------------
  {
    const route = { providerId: `r25-f-${suffix}`, modelId: "verified-free" };
    const users = await Promise.all(Array.from({ length: 4 }, async (_, i) => (await db.createUser({ displayName: `R25 F${i}`, primaryIdentity: `r25:${suffix}:f:${i}` })).id));
    await db.setHostedProviderCapacity({ ...route, maxConcurrent: 4 });
    for (let i = 0; i < 40; i++) await db.enqueueHostedExecution({ id: `r25f-${suffix}-${i}`, idempotencyKey: `r25f-key-${suffix}-${i}`, userId: users[i % users.length], taskId: `task-f-${i}`, ...route });
    const completedIds = new Set();
    let claims = 0;
    for (let round = 0; round < 40; round++) {
      const claim = await db.claimNextHostedExecution({ workerId: `drain-w${round % 4}`, leaseMs: 30_000, maxUserConcurrent: 4, providerIds: [route.providerId] });
      if (!claim) break;
      claims++;
      await db.completeHostedExecution({ executionId: claim.execution.id, userId: claim.execution.userId, workerId: `drain-w${round % 4}`, leaseToken: claim.execution.leaseToken, status: "completed" });
      completedIds.add(claim.execution.id);
    }
    const remaining = Number((await raw.query("SELECT COUNT(*)::int AS c FROM hosted_executions WHERE provider_id=$1 AND status='queued'", [route.providerId])).rows[0].c);
    const completed = Number((await raw.query("SELECT COUNT(*)::int AS c FROM hosted_executions WHERE provider_id=$1 AND status='completed'", [route.providerId])).rows[0].c);
    completedIds.size === 40 && remaining === 0 && completed === 40
      ? pass("F.queue_drain", `40 executions claimed+completed exactly once each; queue empty, ${claims} claims`)
      : fail("F.queue_drain", `completedUnique=${completedIds.size} remaining=${remaining} completed=${completed} claims=${claims}`);
  }
} finally {
  await db.close();
  await raw.end();
}

const allPass = Object.values(results.cases).every((c) => c.pass);
results.verdict = allPass ? "DURABLE_ADMISSION_PROVEN" : "FAILURES_PRESENT";
const out = path.join(ROOT, "docs", "evidence", "r25-live-reality", "durable-admission.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
console.log(`\nverdict: ${results.verdict} → ${path.relative(ROOT, out)}`);
process.exit(allPass ? 0 : 1);
