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
const modelId = "verified-free";
const users = await Promise.all(Array.from({ length: 200 }, async (_, index) => (await db.createUser({ displayName: `Benchmark User ${index}`, primaryIdentity: `r20-benchmark:${suffix}:${index}` })).id));
const client = new pg.Client({ connectionString });
await client.connect();
const plans = {};
const samples = [];
// Each size gets its own provider route so the candidate set at measurement time is exactly the
// fixture for that size — earlier fixtures are terminal and never visible to the claim query.
for (const queueSize of [1_000, 10_000, 25_000, 50_000]) {
  const route = { providerId: `r20-benchmark-${queueSize}-${suffix}`, modelId };
  await db.setHostedProviderCapacity({ ...route, maxConcurrent: 4 });
  const ids = [];
  const enqueueStart = performance.now();
  for (let index = 0; index < queueSize; index++) {
    const id = `benchmark-${queueSize}-${suffix}-${index}`;
    ids.push({ id, userId: users[index % users.length] });
    await db.enqueueHostedExecution({ id, idempotencyKey: `benchmark-key-${queueSize}-${suffix}-${index}`, userId: users[index % users.length], taskId: `task-${index}`, ...route });
  }
  const enqueueMs = performance.now() - enqueueStart;
  // Model steady-state autovacuum: dead tuples from prior fixtures' bulk updates would otherwise
  // charge their scan cost to this size's measurement.
  await client.query("VACUUM ANALYZE hosted_executions");
  const rowCount = Number((await client.query(`SELECT COUNT(*)::int AS count FROM hosted_executions`)).rows[0].count);
  const fairPlan = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    WITH RECURSIVE queued_users AS (
      (SELECT user_id FROM hosted_executions WHERE status = 'queued' ORDER BY user_id LIMIT 1)
      UNION ALL
      (SELECT n.user_id FROM queued_users qu CROSS JOIN LATERAL (
        SELECT user_id FROM hosted_executions
        WHERE status = 'queued' AND user_id > qu.user_id
        ORDER BY user_id LIMIT 1) n)
    ),
    user_heads AS (
      SELECT h.id FROM queued_users qu CROSS JOIN LATERAL (
        SELECT e2.id, e2.priority, e2.created_at FROM unnest(ARRAY['${route.providerId}']::text[]) p(pid) CROSS JOIN LATERAL (
          SELECT e3.id, e3.priority, e3.created_at FROM hosted_executions e3
          WHERE e3.status = 'queued' AND e3.user_id = qu.user_id AND e3.provider_id = p.pid
            AND e3.eligible_at <= NOW()
          ORDER BY e3.priority DESC, e3.created_at ASC, e3.id ASC LIMIT 1
        ) e2
        ORDER BY e2.priority DESC, e2.created_at ASC, e2.id ASC LIMIT 1
      ) h
    )
    SELECT e.* FROM user_heads head
    JOIN hosted_executions e ON e.id = head.id
    LEFT JOIN hosted_user_admission_state uas ON uas.user_id = e.user_id
    JOIN hosted_provider_capacity pc ON pc.provider_id = e.provider_id AND pc.model_id = e.model_id
    WHERE (SELECT COUNT(*) FROM hosted_capacity_leases ul WHERE ul.user_id = e.user_id AND ul.state = 'active' AND ul.lease_expires_at > NOW()) < 1
      AND (SELECT COUNT(*) FROM hosted_capacity_leases rl WHERE rl.provider_id = e.provider_id AND rl.model_id = e.model_id AND rl.state = 'active' AND rl.lease_expires_at > NOW()) < pc.max_concurrent
    ORDER BY CASE WHEN uas.last_admitted_at IS NULL THEN 0 ELSE 1 END, uas.last_admitted_at ASC NULLS FIRST, e.priority DESC, e.created_at ASC
    LIMIT 1`);
  plans[`fair_claim_${queueSize}`] = fairPlan.rows[0]["QUERY PLAN"][0];
  const latencies = [];
  const claimCount = Math.min(queueSize, 100);
  for (let index = 0; index < claimCount; index++) {
    const started = performance.now();
    const claim = await db.claimNextHostedExecution({ workerId: `benchmark-worker-${queueSize}-${index}`, leaseMs: 60_000, maxUserConcurrent: 1, providerIds: [route.providerId] });
    latencies.push(performance.now() - started);
    if (!claim) throw new Error(`claim missing at ${index}/${claimCount}`);
    await db.completeHostedExecution({ executionId: claim.execution.id, userId: claim.execution.userId, workerId: `benchmark-worker-${queueSize}-${index}`, leaseToken: claim.lease.id, status: "completed" });
  }
  // Drain the leftover fixture in one statement — cleanup is not part of the measured evidence.
  await client.query(
    `UPDATE hosted_executions SET status = 'cancelled', cancellation_requested = true, terminal_at = NOW(), updated_at = NOW()
     WHERE provider_id = $1 AND status NOT IN ('completed', 'failed', 'cancelled')`,
    [route.providerId],
  );
  latencies.sort((a, b) => a - b);
  const percentile = (fraction) => latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * fraction) - 1)];
  samples.push({ queueSize, totalRowsAtMeasure: rowCount, enqueueMs, claimsMeasured: claimCount, claimLatencyMs: { p50: percentile(0.5), p90: percentile(0.9), p95: percentile(0.95), max: latencies.at(-1) }, fairClaimExecutionMs: fairPlan.rows[0]["QUERY PLAN"][0]["Execution Time"] });
}

for (const [name, query, values] of [
  ["idempotency_lookup", "SELECT * FROM hosted_executions WHERE idempotency_key = $1", [`benchmark-key-50000-${suffix}-49999`]],
  ["stale_lease_scan", "SELECT execution_id FROM hosted_capacity_leases WHERE state='active' AND lease_expires_at <= NOW()", []],
  ["receipt_lookup", "SELECT * FROM hosted_admission_receipts WHERE execution_id=$1 ORDER BY created_at ASC", [`benchmark-50000-${suffix}-0`]],
  ["active_route_count", "SELECT COUNT(*) FROM hosted_capacity_leases WHERE provider_id=$1 AND model_id=$2 AND state='active' AND lease_expires_at > NOW()", [`r20-benchmark-50000-${suffix}`, modelId]],
  ["terminal_batch_check", "SELECT id FROM hosted_executions WHERE id = ANY($1) AND status IN ('completed','failed','cancelled')", [[`benchmark-50000-${suffix}-0`, `benchmark-50000-${suffix}-1`]]],
]) {
  const result = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`, values);
  plans[name] = result.rows[0]["QUERY PLAN"][0];
}
await client.end();
await db.close();
const result = { schemaVersion: 2, evidenceClass: "local_real_postgresql", timestamp: new Date().toISOString(), users: users.length, samples, plans };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.writeFileSync(path.join(root, "docs", "evidence", "r20-platform-intelligence-scale", "03-managed-free", "results", "postgres-admission-benchmark.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ ...result, plans: Object.fromEntries(Object.entries(plans).map(([name, plan]) => [name, { planningTime: plan["Planning Time"], executionTime: plan["Execution Time"] }])) }, null, 2));
