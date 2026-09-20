import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresCloudDatabase } from "../packages/cloud-db/dist/postgres.js";

const connectionString = process.env.CODEFORGE_TEST_POSTGRES_URL;
if (!connectionString) throw new Error("CODEFORGE_TEST_POSTGRES_URL is required");
const db = new PostgresCloudDatabase({ connectionString });
await db.init();
const suffix = randomUUID();
const route = { providerId: `r20-benchmark-${suffix}`, modelId: "verified-free" };
const users = await Promise.all(Array.from({ length: 100 }, async (_, index) => (await db.createUser({ displayName: `Benchmark User ${index}`, primaryIdentity: `r20-benchmark:${suffix}:${index}` })).id));
await db.setHostedProviderCapacity({ ...route, maxConcurrent: 4 });
const client = new pg.Client({ connectionString });
await client.connect();
const plans = {};
const samples = [];
for (const queueSize of [10, 100, 1_000, 10_000]) {
  const ids = [];
  const enqueueStart = performance.now();
  for (let index = 0; index < queueSize; index++) {
    const id = `benchmark-${queueSize}-${suffix}-${index}`;
    ids.push({ id, userId: users[index % users.length] });
    await db.enqueueHostedExecution({ id, idempotencyKey: `benchmark-key-${queueSize}-${suffix}-${index}`, userId: users[index % users.length], taskId: `task-${index}`, ...route });
  }
  const enqueueMs = performance.now() - enqueueStart;
  if (queueSize === 10_000) {
    const fairPlan = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      WITH user_heads AS (
        SELECT DISTINCT ON (user_id) id
        FROM hosted_executions
        WHERE status = 'queued' AND eligible_at <= NOW()
          AND provider_id = ANY(ARRAY['${route.providerId}']::text[])
        ORDER BY user_id, priority DESC, created_at ASC
      )
      SELECT e.* FROM user_heads head
      JOIN hosted_executions e ON e.id = head.id
      LEFT JOIN hosted_user_admission_state uas ON uas.user_id = e.user_id
      JOIN hosted_provider_capacity pc ON pc.provider_id = e.provider_id AND pc.model_id = e.model_id
      WHERE (SELECT COUNT(*) FROM hosted_capacity_leases ul WHERE ul.user_id = e.user_id AND ul.state = 'active' AND ul.lease_expires_at > NOW()) < 1
        AND (SELECT COUNT(*) FROM hosted_capacity_leases rl WHERE rl.provider_id = e.provider_id AND rl.model_id = e.model_id AND rl.state = 'active' AND rl.lease_expires_at > NOW()) < pc.max_concurrent
      ORDER BY CASE WHEN uas.last_admitted_at IS NULL THEN 0 ELSE 1 END, uas.last_admitted_at ASC NULLS FIRST, e.priority DESC, e.created_at ASC
      LIMIT 1`);
    plans.fair_claim = fairPlan.rows[0]["QUERY PLAN"][0];
  }
  const latencies = [];
  const claimCount = Math.min(queueSize, 100);
  for (let index = 0; index < claimCount; index++) {
    const started = performance.now();
    const claim = await db.claimNextHostedExecution({ workerId: `benchmark-worker-${index}`, leaseMs: 60_000, maxUserConcurrent: 1, providerIds: [route.providerId] });
    latencies.push(performance.now() - started);
    if (!claim) throw new Error(`claim missing at ${index}/${claimCount}`);
    await db.completeHostedExecution({ executionId: claim.execution.id, userId: claim.execution.userId, workerId: `benchmark-worker-${index}`, leaseToken: claim.lease.id, status: "completed" });
  }
  const completed = new Set((await Promise.all(users.map((userId) => db.listHostedExecutions(userId, queueSize)))).flat().filter((execution) => execution.status === "completed").map((execution) => execution.id));
  for (const item of ids) if (!completed.has(item.id)) await db.cancelHostedExecution({ executionId: item.id, userId: item.userId });
  latencies.sort((a, b) => a - b);
  const percentile = (fraction) => latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * fraction) - 1)];
  samples.push({ queueSize, enqueueMs, claimsMeasured: claimCount, claimLatencyMs: { median: percentile(0.5), p90: percentile(0.9), p95: percentile(0.95), max: latencies.at(-1) } });
}

for (const [name, query, values] of [
  ["idempotency_lookup", "SELECT * FROM hosted_executions WHERE idempotency_key = $1", [`benchmark-key-10000-${suffix}-9999`]],
  ["stale_lease_scan", "SELECT execution_id FROM hosted_capacity_leases WHERE state='active' AND lease_expires_at <= NOW()", []],
  ["receipt_lookup", "SELECT * FROM hosted_admission_receipts WHERE execution_id=$1 ORDER BY created_at ASC", [`benchmark-10000-${suffix}-0`]],
  ["active_route_count", "SELECT COUNT(*) FROM hosted_capacity_leases WHERE provider_id=$1 AND model_id=$2 AND state='active' AND lease_expires_at > NOW()", [route.providerId, route.modelId]],
]) {
  const result = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`, values);
  plans[name] = result.rows[0]["QUERY PLAN"][0];
}
await client.end();
await db.close();
const result = { schemaVersion: 1, evidenceClass: "local_real_postgresql", timestamp: new Date().toISOString(), samples, plans };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.writeFileSync(path.join(root, "docs", "evidence", "r20-platform-intelligence-scale", "03-managed-free", "results", "postgres-admission-benchmark.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ ...result, plans: Object.fromEntries(Object.entries(plans).map(([name, plan]) => [name, { planningTime: plan["Planning Time"], executionTime: plan["Execution Time"] }])) }, null, 2));
