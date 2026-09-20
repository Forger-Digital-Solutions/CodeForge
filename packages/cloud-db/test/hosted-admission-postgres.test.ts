import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PostgresCloudDatabase } from "../src/postgres.js";

const TEST_PG = process.env.CODEFORGE_TEST_POSTGRES_URL || process.env.DATABASE_URL;
const suite = TEST_PG ? describe : describe.skip;

suite("durable hosted admission — real PostgreSQL", () => {
  const databases: PostgresCloudDatabase[] = [];
  let users: string[];
  const suffix = randomUUID();
  let route: { providerId: string; modelId: string };

  const connection = async () => {
    const db = new PostgresCloudDatabase({ connectionString: TEST_PG! });
    await db.init();
    databases.push(db);
    return db;
  };

  beforeEach(async () => {
    route = { providerId: `r20-pg-${randomUUID()}`, modelId: "verified-free" };
    const db = await connection();
    users = await Promise.all(Array.from({ length: 20 }, async (_, index) => (await db.createUser({ displayName: `PG User ${index}`, primaryIdentity: `r20-pg:${suffix}:${randomUUID()}` })).id));
    await db.setHostedProviderCapacity({ ...route, maxConcurrent: 4 });
  });

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.close()));
  });

  it("coordinates independent connections without oversubscribing capacity four", async () => {
    const writer = databases[0]!;
    for (let index = 0; index < 100; index++) {
      await writer.enqueueHostedExecution({ id: `pg-cap-${suffix}-${index}`, idempotencyKey: `pg-cap-key-${suffix}-${index}`, userId: users[index % users.length]!, taskId: `task-${index}`, ...route });
    }
    const workers = await Promise.all(Array.from({ length: 3 }, () => connection()));
    const claims = await Promise.all(Array.from({ length: 100 }, (_, index) => workers[index % workers.length]!.claimNextHostedExecution({ workerId: `pg-worker-${suffix}-${index}`, leaseMs: 60_000, maxUserConcurrent: 4, providerIds: [route.providerId] })));
    const routeClaims = claims.filter((claim) => claim?.execution.providerId === route.providerId && claim.execution.modelId === route.modelId);
    expect(routeClaims).toHaveLength(4);
    expect(new Set(routeClaims.map((claim) => claim!.execution.id))).toHaveLength(4);
  }, 30_000);

  it("preserves fair user rotation across three independent connections", async () => {
    const writer = databases[0]!;
    for (let index = 0; index < 50; index++) await writer.enqueueHostedExecution({ id: `pg-heavy-${suffix}-${index}`, idempotencyKey: `pg-heavy-key-${suffix}-${index}`, userId: users[0]!, taskId: `heavy-${index}`, ...route });
    for (let index = 1; index < users.length; index++) await writer.enqueueHostedExecution({ id: `pg-normal-${suffix}-${index}`, idempotencyKey: `pg-normal-key-${suffix}-${index}`, userId: users[index]!, taskId: `normal-${index}`, ...route });
    const workers = await Promise.all(Array.from({ length: 3 }, () => connection()));
    const served: string[] = [];
    for (let index = 0; index < 20; index++) {
      const worker = workers[index % workers.length]!;
      const claim = await worker.claimNextHostedExecution({ workerId: `fair-worker-${index % 3}`, leaseMs: 60_000, maxUserConcurrent: 1, providerIds: [route.providerId] });
      expect(claim).toBeDefined();
      served.push(claim!.execution.userId);
      await worker.completeHostedExecution({ executionId: claim!.execution.id, userId: claim!.execution.userId, workerId: `fair-worker-${index % 3}`, leaseToken: claim!.lease.id, status: "completed" });
    }
    expect(new Set(served)).toHaveLength(20);
  }, 30_000);

  it("enforces idempotency and stale-lease ambiguity across reconnects", async () => {
    const first = databases[0]!;
    const replay = await connection();
    const params = { id: `pg-replay-${suffix}`, idempotencyKey: `pg-replay-key-${suffix}`, userId: users[0]!, taskId: "replay", ...route };
    expect((await first.enqueueHostedExecution(params)).created).toBe(true);
    expect((await replay.enqueueHostedExecution({ ...params, id: `${params.id}-retry` })).created).toBe(false);
    const start = new Date(Date.now() + 1_000);
    const claim = await first.claimNextHostedExecution({ workerId: "crashed-worker", leaseMs: 10, maxUserConcurrent: 1, providerIds: [route.providerId], now: start });
    await first.markHostedExecutionDispatching({ executionId: claim!.execution.id, workerId: "crashed-worker", leaseToken: claim!.lease.id });
    await first.close();
    databases.splice(databases.indexOf(first), 1);
    const restarted = await connection();
    const recovered = await restarted.recoverExpiredHostedLeases(new Date(start.getTime() + 11));
    expect(recovered.executionIds).toContain(claim!.execution.id);
    expect((await restarted.getHostedExecution(claim!.execution.id, users[0]!))?.status).toBe("recovery_pending");
  });

  it("fences a stale worker out of completion after a cross-connection reclaim", async () => {
    const first = databases[0]!;
    await first.enqueueHostedExecution({ id: `pg-fence-${suffix}`, idempotencyKey: `pg-fence-key-${suffix}`, userId: users[0]!, taskId: "fence", ...route });
    const start = new Date(Date.now() + 1_000);
    const stale = await first.claimNextHostedExecution({ workerId: "pg-stale-worker", leaseMs: 10, maxUserConcurrent: 1, providerIds: [route.providerId], now: start });
    expect(stale).toBeDefined();

    const second = await connection();
    expect((await second.recoverExpiredHostedLeases(new Date(start.getTime() + 11))).recovered).toBe(1);
    const fresh = await second.claimNextHostedExecution({ workerId: "pg-fresh-worker", leaseMs: 60_000, maxUserConcurrent: 1, providerIds: [route.providerId], now: new Date(start.getTime() + 12) });
    expect(fresh).toBeDefined();

    await expect(first.markHostedExecutionDispatching({ executionId: stale!.execution.id, workerId: "pg-stale-worker", leaseToken: stale!.lease.id })).rejects.toThrow(/lease/i);
    await expect(first.renewHostedExecutionLease({ executionId: stale!.execution.id, workerId: "pg-stale-worker", leaseToken: stale!.lease.id, leaseMs: 60_000 })).rejects.toThrow(/not found/i);
    await expect(first.completeHostedExecution({ executionId: stale!.execution.id, userId: users[0]!, workerId: "pg-stale-worker", leaseToken: stale!.lease.id, status: "completed" })).rejects.toThrow(/fencing/i);

    await second.markHostedExecutionDispatching({ executionId: fresh!.execution.id, workerId: "pg-fresh-worker", leaseToken: fresh!.lease.id });
    const done = await second.completeHostedExecution({ executionId: fresh!.execution.id, userId: users[0]!, workerId: "pg-fresh-worker", leaseToken: fresh!.lease.id, status: "completed", resultPayload: JSON.stringify({ ok: true }) });
    expect(done.transitioned).toBe(true);
    expect(done.execution.resultPayload).toBe(JSON.stringify({ ok: true }));
    expect(done.execution.terminalAt).toBeTruthy();
  }, 30_000);

  it("cascades parent cancellation to children and resolves recovery_pending fail-closed", async () => {
    const db = databases[0]!;
    const parent = await db.enqueueHostedExecution({ id: `pg-parent-${suffix}`, idempotencyKey: `pg-parent-key-${suffix}`, userId: users[0]!, taskId: "parent", ...route });
    const child = await db.enqueueHostedExecution({ id: `pg-child-${suffix}`, idempotencyKey: `pg-child-key-${suffix}`, userId: users[0]!, taskId: "child", ...route, parentExecutionId: parent.execution.id });
    expect(child.execution.rootExecutionId).toBe(parent.execution.id);
    await expect(db.enqueueHostedExecution({ id: `pg-x-${suffix}`, idempotencyKey: `pg-x-key-${suffix}`, userId: users[1]!, taskId: "x", ...route, parentExecutionId: parent.execution.id })).rejects.toThrow(/another user/);

    const cancelled = await db.cancelHostedExecution({ executionId: parent.execution.id, userId: users[0]! });
    expect(cancelled.cancelledChildIds).toEqual([child.execution.id]);
    expect((await db.getHostedExecution(child.execution.id, users[0]!))?.status).toBe("cancelled");

    await db.enqueueHostedExecution({ id: `pg-amb-${suffix}`, idempotencyKey: `pg-amb-key-${suffix}`, userId: users[0]!, taskId: "amb", ...route });
    const start = new Date(Date.now() + 1_000);
    const claim = await db.claimNextHostedExecution({ workerId: "pg-amb-worker", leaseMs: 10, maxUserConcurrent: 1, providerIds: [route.providerId], now: start });
    await db.markHostedExecutionDispatching({ executionId: claim!.execution.id, workerId: "pg-amb-worker", leaseToken: claim!.lease.id });
    await db.recoverExpiredHostedLeases(new Date(start.getTime() + 11));
    const resolved = await db.resolveHostedRecoveryPending({ executionId: claim!.execution.id, workerId: "pg-recovery" });
    expect(resolved.transitioned).toBe(true);
    expect(resolved.execution.status).toBe("failed");
    expect((await db.resolveHostedRecoveryPending({ executionId: claim!.execution.id, workerId: "pg-recovery" })).transitioned).toBe(false);
  }, 30_000);
});
