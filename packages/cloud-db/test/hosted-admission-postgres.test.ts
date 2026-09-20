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

  it("delivers a cross-connection cancellation event carrying only correlation ids", async () => {
    const listener = databases[0]!;
    const canceller = await connection();
    const events: { kind: string; executionIds: string[] | "*" }[] = [];
    // The channel is shared: foreign tenants' cancellations arrive too, so the wait targets
    // this test's own execution id — receivers ignore ids they do not own.
    let targetId: string | undefined;
    const seen = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no event within 10s")), 10_000);
      void listener.subscribeHostedExecutionEvents((event) => {
        events.push(event);
        if (event.kind === "execution.cancelled" && (event.executionIds === "*" || (targetId != null && event.executionIds.includes(targetId)))) { clearTimeout(timer); resolve(); }
      });
    });
    const parent = await canceller.enqueueHostedExecution({ id: `pg-evt-parent-${suffix}`, idempotencyKey: `pg-evt-parent-key-${suffix}`, userId: users[0]!, taskId: "evt-parent", ...route });
    const child = await canceller.enqueueHostedExecution({ id: `pg-evt-child-${suffix}`, idempotencyKey: `pg-evt-child-key-${suffix}`, userId: users[0]!, taskId: "evt-child", ...route, parentExecutionId: parent.execution.id });
    targetId = parent.execution.id;
    // Give LISTEN a moment to attach on the server side, then cancel on a different connection.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await canceller.cancelHostedExecution({ executionId: parent.execution.id, userId: users[0]! });
    await seen;
    const delivered = events.find((event) => event.kind === "execution.cancelled" && (event.executionIds === "*" || event.executionIds.includes(parent.execution.id)))!;
    expect(delivered.executionIds === "*" || delivered.executionIds.includes(parent.execution.id)).toBe(true);
    // The durable row is already terminal by the time the hint arrives — receivers verify, not trust.
    expect((await listener.getHostedExecution(child.execution.id, users[0]!))?.status).toBe("cancelled");
  }, 30_000);

  it("emits a resync on listener death, reconnects, and keeps delivering", async () => {
    const listener = databases[0]!;
    const canceller = await connection();
    const events: string[] = [];
    const resyncSeen = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no resync within 10s")), 10_000);
      void listener.subscribeHostedExecutionEvents((event) => {
        events.push(event.kind);
        if (event.kind === "resync") { clearTimeout(timer); resolve(); }
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await listener._dropHostedEventListenerForTest();
    await resyncSeen;

    // After reconnect the channel must deliver a fresh cancellation again. Only this test's
    // victim counts — foreign tenant events on the shared channel must not satisfy the wait.
    let victimId: string | undefined;
    const cancelledSeen = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no cancel event after reconnect within 15s")), 15_000);
      void listener.subscribeHostedExecutionEvents((event) => {
        if (event.kind === "execution.cancelled" && (event.executionIds === "*" || (victimId != null && event.executionIds.includes(victimId)))) { clearTimeout(timer); resolve(); }
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const victim = await canceller.enqueueHostedExecution({ id: `pg-reconnect-${suffix}`, idempotencyKey: `pg-reconnect-key-${suffix}`, userId: users[0]!, taskId: "reconnect", ...route });
    victimId = victim.execution.id;
    await canceller.cancelHostedExecution({ executionId: victim.execution.id, userId: users[0]! });
    await cancelledSeen;
    expect(events).toContain("resync");
  }, 40_000);

  it("serializes concurrent child enqueues across connections inside the root budget", async () => {
    const writer = databases[0]!;
    const parent = await writer.enqueueHostedExecution({ id: `pg-race-parent-${suffix}`, idempotencyKey: `pg-race-parent-key-${suffix}`, userId: users[0]!, taskId: "race-parent", ...route });
    const limits = { maxChildrenPerParent: 5, maxDescendantsPerRoot: 8, maxDepth: 1 };
    const racers = await Promise.all(Array.from({ length: 3 }, () => connection()));
    const results = await Promise.allSettled(Array.from({ length: 15 }, (_, index) =>
      racers[index % racers.length]!.enqueueHostedExecution({ id: `pg-race-${suffix}-${index}`, idempotencyKey: `pg-race-key-${suffix}-${index}`, userId: users[0]!, taskId: `race-${index}`, ...route, parentExecutionId: parent.execution.id, rootExecutionId: parent.execution.id, fanOutLimits: limits })));
    const created = results.filter((r) => r.status === "fulfilled");
    expect(created).toHaveLength(5);
    for (const failure of results.filter((r) => r.status === "rejected")) {
      expect(String((failure as PromiseRejectedResult).reason)).toMatch(/fan-out budget/);
    }
    const children = await writer.listHostedExecutionChildren(parent.execution.id, users[0]!);
    expect(children).toHaveLength(5);
    const stats = await writer.getHostedExecutionTreeStats(parent.execution.id, users[0]!);
    expect(stats!.totalExecutions).toBe(6);
    expect(stats!.byStatus.queued).toBe(6);
    expect(stats!.activeDescendants).toBe(5);
  }, 30_000);

  it("gates recovery_pending requeue on a persisted provider dispatch identity", async () => {
    const db = databases[0]!;
    await db.enqueueHostedExecution({ id: `pg-req-${suffix}`, idempotencyKey: `pg-req-key-${suffix}`, userId: users[0]!, taskId: "req", ...route });
    const start = new Date(Date.now() + 1_000);
    const claim = await db.claimNextHostedExecution({ workerId: "pg-req-worker", leaseMs: 10, maxUserConcurrent: 1, providerIds: [route.providerId], now: start });
    await db.markHostedExecutionDispatching({ executionId: claim!.execution.id, workerId: "pg-req-worker", leaseToken: claim!.lease.id });
    await db.recoverExpiredHostedLeases(new Date(start.getTime() + 11));
    // No dispatch identity persisted → ambiguous → requeue must be refused.
    await expect(db.resolveHostedRecoveryPending({ executionId: claim!.execution.id, workerId: "pg-recovery", resolution: "requeue" })).rejects.toThrow(/dispatch identity/);
    const failed = await db.resolveHostedRecoveryPending({ executionId: claim!.execution.id, workerId: "pg-recovery" });
    expect(failed.execution.status).toBe("failed");

    // With an identity the requeue is safe_retry: row returns to queued keeping the identity.
    await db.enqueueHostedExecution({ id: `pg-req2-${suffix}`, idempotencyKey: `pg-req2-key-${suffix}`, userId: users[0]!, taskId: "req2", ...route });
    const claim2 = await db.claimNextHostedExecution({ workerId: "pg-req2-worker", leaseMs: 10, maxUserConcurrent: 1, providerIds: [route.providerId], now: start });
    await db.markHostedExecutionDispatching({ executionId: claim2!.execution.id, workerId: "pg-req2-worker", leaseToken: claim2!.lease.id, providerDispatchId: claim2!.execution.id });
    await db.recoverExpiredHostedLeases(new Date(start.getTime() + 11));
    const requeued = await db.resolveHostedRecoveryPending({ executionId: claim2!.execution.id, workerId: "pg-recovery", resolution: "requeue" });
    expect(requeued.transitioned).toBe(true);
    expect(requeued.execution.status).toBe("queued");
    expect(requeued.execution.providerDispatchId).toBe(claim2!.execution.id);
    const reclaim = await db.claimNextHostedExecution({ workerId: "pg-req3-worker", leaseMs: 60_000, maxUserConcurrent: 1, providerIds: [route.providerId] });
    expect(reclaim?.execution.id).toBe(claim2!.execution.id);
  }, 30_000);

  it("degrades an oversized cancellation fan-out notification to a resync marker", async () => {
    const listener = databases[0]!;
    const writer = databases[0]!;
    const events: { kind: string; executionIds: string[] | "*" }[] = [];
    // Wait for the degraded marker itself — foreign per-id cancellations share the channel
    // and must not satisfy the wait before this cascade's own "*" arrives.
    const seen = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no resync marker within 10s")), 10_000);
      void listener.subscribeHostedExecutionEvents((event) => {
        events.push(event);
        if (event.kind === "execution.cancelled" && event.executionIds === "*") { clearTimeout(timer); resolve(); }
      });
    });
    const parent = await writer.enqueueHostedExecution({ id: `pg-big-parent-${suffix}`, idempotencyKey: `pg-big-parent-key-${suffix}`, userId: users[0]!, taskId: "big-parent", ...route });
    for (let index = 0; index < 70; index++) {
      await writer.enqueueHostedExecution({ id: `pg-big-${suffix}-${index}`, idempotencyKey: `pg-big-key-${suffix}-${index}`, userId: users[0]!, taskId: `big-${index}`, ...route, parentExecutionId: parent.execution.id });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const cancelled = await writer.cancelHostedExecution({ executionId: parent.execution.id, userId: users[0]! });
    expect(cancelled.cancelledChildIds).toHaveLength(70);
    await seen;
    const delivered = events.find((event) => event.kind === "execution.cancelled" && event.executionIds === "*")!;
    // 71 ids exceed the bounded payload — the notification degrades to "*" so receivers resync
    // instead of acting on a truncated id list.
    expect(delivered.executionIds).toBe("*");
  }, 30_000);
});
