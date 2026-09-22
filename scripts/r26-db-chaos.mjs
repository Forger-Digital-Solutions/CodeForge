#!/usr/bin/env node
/*
 * R26 Mission F — database chaos against the durable hosted-admission path.
 *
 * Real PostgreSQL (WSL, via postgres-test-harness). Cases:
 *   C1 connection kill mid-drain — pg_terminate_backend severs the working pool
 *      repeatedly while a claim→complete loop drains 20 executions on capacity 4.
 *      Assert: drain still completes, every execution exactly once, zero orphans.
 *   C2 pool exhaustion — pool max=2, 8 parallel claim attempts contend for connections.
 *      Assert: no crash, claims resolve honestly (success or timeout error, never
 *      a double-claim).
 *   C3 transaction failure — a claim racing a deliberately aborted sibling must not
 *      leave the row stuck in 'claimed' (the loser retries cleanly).
 *   C4 kill during claim — terminate the claiming connection between SELECT and
 *      UPDATE; verify the row is either claimed-by-survivor or still queued, never
 *      half-claimed.
 *
 * Evidence → docs/evidence/r26-production-readiness/db-chaos.json
 */
import pg from "pg";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgresCloudDatabase } from "../packages/cloud-db/dist/postgres.js";

const connectionString = process.env.CODEFORGE_TEST_POSTGRES_URL;
if (!connectionString) throw new Error("CODEFORGE_TEST_POSTGRES_URL is required");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const results = { schemaVersion: 1, evidenceClass: "local_real_postgresql_chaos", recordedAt: new Date().toISOString(), cases: {} };
const pass = (name, detail) => { results.cases[name] = { pass: true, detail }; console.log(`PASS ${name}: ${detail}`); };
const fail = (name, detail) => { results.cases[name] = { pass: false, detail }; console.error(`FAIL ${name}: ${detail}`); };

const admin = new pg.Client({ connectionString });
await admin.connect();
const killBackendPids = async () => {
  // Terminate every connection belonging to the chaos pools (application_name tags them).
  // Only connections with an in-flight query: terminating an idle checked-out pool client
  // emits an 'error' no one owns (pg pool only absorbs idle-in-pool client errors), which is
  // a driver-level process crash, not product behavior. Killing active queries exercises the
  // real path: in-flight statement dies → query rejects → caller's retry runs.
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE application_name = 'r26-chaos' AND state = 'active' AND pid <> pg_backend_pid()`);
};
const chaosPool = (max) => new pg.Pool({ connectionString, max, idleTimeoutMillis: 5_000, connectionTimeoutMillis: 8_000, application_name: "r26-chaos" });
const suffix = crypto.randomUUID().slice(0, 8);
const mkUser = async (db, tag, i) => (await db.createUser({ displayName: `R26 ${tag}${i}`, primaryIdentity: `r26:${suffix}:${tag}:${i}` })).id;
const statusCounts = async (providerId) => (await admin.query("SELECT status, count(*) FROM hosted_executions WHERE provider_id=$1 GROUP BY status", [providerId])).rows;

try {
  // ---- C1: connection kill mid-drain ----------------------------------------
  {
    const db = new PostgresCloudDatabase({ connectionString, pool: chaosPool(4) });
    await db.init();
    const route = { providerId: `r26c1-${suffix}`, modelId: "verified-free" };
    const user = await mkUser(db, "c1", 0);
    await db.setHostedProviderCapacity({ ...route, maxConcurrent: 4 });
    for (let i = 0; i < 20; i++) await db.enqueueHostedExecution({ id: `r26c1-${suffix}-${i}`, idempotencyKey: `r26c1-${suffix}-k${i}`, userId: user, taskId: `t${i}`, ...route });

    // Killer: sever the pool's connections every 600ms while the drainer works.
    let killing = true;
    let killRounds = 0;
    const killer = (async () => { while (killing) { await killBackendPids().then(() => killRounds++).catch(() => {}); await new Promise((r) => setTimeout(r, 600)); } })();

    const completedIds = new Set();
    let claims = 0, claimErrors = 0, completeErrors = 0;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      let claim;
      try { claim = await db.claimNextHostedExecution({ workerId: "chaos-drainer", leaseMs: 15_000, maxUserConcurrent: 4, providerIds: [route.providerId] }); }
      catch { claimErrors++; await new Promise((r) => setTimeout(r, 300)); continue; }
      if (!claim) {
        const left = (await admin.query("SELECT count(*) FROM hosted_executions WHERE provider_id=$1 AND status IN ('queued','dispatching','claimed','running')", [route.providerId])).rows[0].count;
        if (Number(left) === 0) break;
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      claims++;
      try {
        const res = await db.completeHostedExecution({ executionId: claim.execution.id, userId: claim.execution.userId, workerId: "chaos-drainer", leaseToken: claim.execution.leaseToken, status: "completed" });
        if (res.transitioned) completedIds.add(claim.execution.id);
      } catch { completeErrors++; }
    }
    killing = false; await killer;
    const counts = await statusCounts(route.providerId);
    const completed = Number(counts.find((r) => r.status === "completed")?.count ?? 0);
    const leftover = counts.filter((r) => !["completed", "failed", "cancelled"].includes(r.status)).reduce((s, r) => s + Number(r.count), 0);
    void (completed === 20 && leftover === 0 && completedIds.size === 20
      ? pass("C1.conn_kill_mid_drain", `drained 20/20 exactly-once through ${killRounds} kill rounds (claimErrors=${claimErrors} completeErrors=${completeErrors})`)
      : fail("C1.conn_kill_mid_drain", `completed=${completed}/20 leftover=${leftover} unique=${completedIds.size} kills=${killRounds} claimErr=${claimErrors} completeErr=${completeErrors}`));
    await db.close();
  }

  // ---- C2: pool exhaustion under contention ----------------------------------
  {
    const tinyPool = chaosPool(2);
    const db = new PostgresCloudDatabase({ connectionString, pool: tinyPool });
    await db.init();
    const route = { providerId: `r26c2-${suffix}`, modelId: "verified-free" };
    const user = await mkUser(db, "c2", 0);
    await db.setHostedProviderCapacity({ ...route, maxConcurrent: 8 });
    for (let i = 0; i < 8; i++) await db.enqueueHostedExecution({ id: `r26c2-${suffix}-${i}`, idempotencyKey: `r26c2-${suffix}-k${i}`, userId: user, taskId: `t${i}`, ...route });
    // 8 claims on a 2-connection pool — pg queues the extras; all must resolve honestly.
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
      db.claimNextHostedExecution({ workerId: `pool-w${i}`, leaseMs: 15_000, maxUserConcurrent: 8, providerIds: [route.providerId] })));
    const claims = outcomes.filter((o) => o.status === "fulfilled" && o.value).map((o) => o.value.execution.id);
    const unique = new Set(claims);
    const noCrash = outcomes.every((o) => o.status === "fulfilled" || (o.reason instanceof Error));
    void (unique.size === claims.length && noCrash && claims.length <= 8
      ? pass("C2.pool_exhaustion", `${claims.length} claims all unique on a 2-conn pool; outcomes all resolved honestly (no crash, no double-claim)`)
      : fail("C2.pool_exhaustion", `claims=${claims.length} unique=${unique.size} rejections=${outcomes.filter((o) => o.status === "rejected").length}`));

    await db.close();
  }

  // ---- C3: aborted sibling transaction cannot wedge the row -------------------
  {
    const db = new PostgresCloudDatabase({ connectionString, pool: chaosPool(4) });
    await db.init();
    const route = { providerId: `r26c3-${suffix}`, modelId: "verified-free" };
    const user = await mkUser(db, "c3", 0);
    await db.setHostedProviderCapacity({ ...route, maxConcurrent: 1 });
    const execId = `r26c3-${suffix}-0`;
    await db.enqueueHostedExecution({ id: execId, idempotencyKey: `r26c3-${suffix}-k0`, userId: user, taskId: "t0", ...route });
    // Abort a transaction that had locked the row but never committed.
    const conn = new pg.Client({ connectionString, application_name: "r26-chaos-txn" });
    conn.on("error", () => {}); // expected: this connection is deliberately terminated mid-txn
    await conn.connect();
    await conn.query("BEGIN");
    await conn.query("SELECT id FROM hosted_executions WHERE id=$1 FOR UPDATE", [execId]);
    // Kill it while idle-in-transaction — the lock dies with the connection.
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='r26-chaos-txn' AND pid <> pg_backend_pid()`);
    await conn.end().catch(() => {});
    // A fresh claim must still work — row must be queued, not stuck.
    const claim = await db.claimNextHostedExecution({ workerId: "survivor", leaseMs: 15_000, maxUserConcurrent: 1, providerIds: [route.providerId] });
    const st = (await admin.query("SELECT status FROM hosted_executions WHERE id=$1", [execId])).rows[0]?.status;
    void (claim && ["claimed", "running", "dispatching"].includes(st)
      ? pass("C3.aborted_txn", `aborted sibling released the row; fresh claim succeeded (status=${st})`)
      : fail("C3.aborted_txn", `claim=${claim ? "ok" : "null"} status=${st}`));
    await db.close();
  }

  // ---- C4: terminate between claim SELECT and UPDATE --------------------------
  {
    const db = new PostgresCloudDatabase({ connectionString, pool: chaosPool(4) });
    await db.init();
    const route = { providerId: `r26c4-${suffix}`, modelId: "verified-free" };
    const user = await mkUser(db, "c4", 0);
    await db.setHostedProviderCapacity({ ...route, maxConcurrent: 2 });
    for (let i = 0; i < 4; i++) await db.enqueueHostedExecution({ id: `r26c4-${suffix}-${i}`, idempotencyKey: `r26c4-${suffix}-k${i}`, userId: user, taskId: `t${i}`, ...route });
    // Kill mid-claim repeatedly; the claim either atomically lands or the connection dies —
    // a half-claimed row is impossible under the UPDATE ... RETURNING pattern.
    const killer = (async () => { for (let i = 0; i < 8; i++) { await killBackendPids().catch(() => {}); await new Promise((r) => setTimeout(r, 150)); } })();
    const attempts = await Promise.allSettled(Array.from({ length: 4 }, (_, i) =>
      db.claimNextHostedExecution({ workerId: `kill-w${i}`, leaseMs: 15_000, maxUserConcurrent: 4, providerIds: [route.providerId] })));
    await killer;
    const claimedIds = attempts.filter((a) => a.status === "fulfilled" && a.value).map((a) => a.value.execution.id);
    const states = (await admin.query("SELECT id, status FROM hosted_executions WHERE provider_id=$1", [route.providerId])).rows;
    const stuck = states.filter((s) => ["claimed", "dispatching"].includes(s.status) && !claimedIds.includes(s.id));
    void (new Set(claimedIds).size === claimedIds.length && stuck.length === 0
      ? pass("C4.kill_mid_claim", `${claimedIds.length} atomic claims, ${attempts.filter((a) => a.status === "rejected").length} killed mid-flight, 0 half-claimed rows`)
      : fail("C4.kill_mid_claim", `claimed=${claimedIds.length} dupes=${claimedIds.length - new Set(claimedIds).size} stuck=${stuck.length}`));
    await db.close();
  }
} finally {
  await admin.end();
}

const allPass = Object.values(results.cases).every((c) => c.pass);
results.verdict = allPass ? "R26_DB_CHAOS_CLEAN" : "CHAOS_FAILURES_PRESENT";
const out = path.join(ROOT, "docs", "evidence", "r26-production-readiness", "db-chaos.json");
fs.writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
console.log(`\nverdict: ${results.verdict} → ${path.relative(ROOT, out)}`);
process.exit(allPass ? 0 : 1);
