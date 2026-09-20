import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { SQLiteCloudDatabase } from "../src/sqlite.js";

const route = { providerId: "synthetic", modelId: "free-model" };

describe("durable hosted admission", () => {
  let db: SQLiteCloudDatabase;
  let users: string[];

  beforeEach(async () => {
    db = new SQLiteCloudDatabase();
    users = [];
    for (let index = 0; index < 20; index++) {
      users.push((await db.createUser({ displayName: `User ${index}`, primaryIdentity: `test:${randomUUID()}` })).id);
    }
    await db.setHostedProviderCapacity({ ...route, maxConcurrent: 4 });
  });

  afterEach(async () => {
    await db.close();
  });

  const enqueue = async (userId: string, suffix: string) => db.enqueueHostedExecution({ id: `execution-${suffix}`, idempotencyKey: `key-${suffix}`, userId, taskId: `task-${suffix}`, ...route });

  it("suppresses duplicate enqueue atomically and rejects cross-user idempotency-key reuse", async () => {
    const first = await enqueue(users[0]!, "same");
    const duplicate = await enqueue(users[0]!, "same");
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.execution.id).toBe(first.execution.id);
    await expect(db.enqueueHostedExecution({ id: "other", idempotencyKey: "key-same", userId: users[1]!, taskId: "other", ...route })).rejects.toThrow(/another user/);
    expect((await db.getHostedAdmissionMetrics()).duplicateRequestSuppressions).toBe(1);
  });

  it("never oversubscribes a shared provider ceiling under competing workers", async () => {
    for (let index = 0; index < 100; index++) await enqueue(users[index % users.length]!, `capacity-${index}`);
    const claims = await Promise.all(Array.from({ length: 100 }, (_, index) => db.claimNextHostedExecution({ workerId: `worker-${index}`, leaseMs: 60_000, maxUserConcurrent: 4 })));
    expect(claims.filter(Boolean)).toHaveLength(4);
    expect((await db.getHostedAdmissionMetrics()).activeReservations).toBe(4);
  });

  it("serves normal users before returning to a heavy user's backlog", async () => {
    for (let index = 0; index < 50; index++) await enqueue(users[0]!, `heavy-${index}`);
    for (let index = 1; index < users.length; index++) await enqueue(users[index]!, `normal-${index}`);
    const served: string[] = [];
    for (let index = 0; index < 20; index++) {
      const claim = await db.claimNextHostedExecution({ workerId: `worker-${index}`, leaseMs: 60_000, maxUserConcurrent: 1 });
      expect(claim).toBeDefined();
      served.push(claim!.execution.userId);
      await db.completeHostedExecution({ executionId: claim!.execution.id, userId: claim!.execution.userId, workerId: `worker-${index}`, leaseToken: claim!.lease.id, status: "completed" });
    }
    expect(new Set(served)).toHaveLength(20);
    expect(served[0]).toBe(users[0]);
  });

  it("recovers an expired pre-dispatch claim but quarantines ambiguous dispatched work", async () => {
    const clock = Date.now() + 1_000;
    await enqueue(users[0]!, "claimed-crash");
    const claimed = await db.claimNextHostedExecution({ workerId: "worker-a", leaseMs: 10, maxUserConcurrent: 1, now: new Date(clock) });
    expect(claimed).toBeDefined();
    expect((await db.recoverExpiredHostedLeases(new Date(clock + 11))).recovered).toBe(1);
    expect((await db.getHostedExecution(claimed!.execution.id, users[0]!))?.status).toBe("queued");

    const reclaimed = await db.claimNextHostedExecution({ workerId: "worker-b", leaseMs: 10, maxUserConcurrent: 1, now: new Date(clock + 12) });
    await db.markHostedExecutionDispatching({ executionId: reclaimed!.execution.id, workerId: "worker-b", leaseToken: reclaimed!.lease.id });
    expect((await db.recoverExpiredHostedLeases(new Date(clock + 23))).recovered).toBe(1);
    expect((await db.getHostedExecution(reclaimed!.execution.id, users[0]!))?.status).toBe("recovery_pending");
    expect(await db.claimNextHostedExecution({ workerId: "worker-c", leaseMs: 10, maxUserConcurrent: 1, now: new Date(clock + 24) })).toBeUndefined();
  });

  it("reconciles cancellation and prevents cross-user cancellation or receipt access", async () => {
    await enqueue(users[0]!, "cancel");
    const claim = await db.claimNextHostedExecution({ workerId: "worker", leaseMs: 60_000, maxUserConcurrent: 1 });
    await db.markHostedExecutionDispatching({ executionId: claim!.execution.id, workerId: "worker", leaseToken: claim!.lease.id });
    await expect(db.cancelHostedExecution({ executionId: claim!.execution.id, userId: users[1]! })).rejects.toThrow(/not found/);
    const cancelled = await db.cancelHostedExecution({ executionId: claim!.execution.id, userId: users[0]! });
    expect(cancelled.dispatchMayHaveStarted).toBe(true);
    expect(cancelled.execution.status).toBe("cancelled");
    expect((await db.getHostedAdmissionMetrics()).activeReservations).toBe(0);
    await expect(db.listHostedAdmissionReceipts(claim!.execution.id, users[1]!)).rejects.toThrow(/not found/);
    expect((await db.listHostedAdmissionReceipts(claim!.execution.id, users[0]!)).map((receipt) => receipt.eventType)).toEqual(["QUEUE_ENQUEUED", "CAPACITY_RESERVED", "DISPATCH_STARTED", "CANCEL_REQUESTED", "CANCELLED"]);
  });

  it("makes completion and capacity release idempotent", async () => {
    await enqueue(users[0]!, "complete");
    const claim = await db.claimNextHostedExecution({ workerId: "worker", leaseMs: 60_000, maxUserConcurrent: 1 });
    const first = await db.completeHostedExecution({ executionId: claim!.execution.id, userId: users[0]!, workerId: "worker", leaseToken: claim!.lease.id, status: "completed" });
    const duplicate = await db.completeHostedExecution({ executionId: claim!.execution.id, userId: users[0]!, workerId: "worker", leaseToken: claim!.lease.id, status: "completed" });
    expect(first.transitioned).toBe(true);
    expect(duplicate.transitioned).toBe(false);
    expect((await db.getHostedAdmissionMetrics()).activeReservations).toBe(0);
  });

  it("honors capacity reduction for new admissions while active leases finish", async () => {
    for (let index = 0; index < 10; index++) await enqueue(users[index]!, `drop-${index}`);
    const initial = await Promise.all(Array.from({ length: 4 }, (_, index) => db.claimNextHostedExecution({ workerId: `worker-${index}`, leaseMs: 60_000, maxUserConcurrent: 1 })));
    expect(initial.filter(Boolean)).toHaveLength(4);
    await db.setHostedProviderCapacity({ ...route, maxConcurrent: 3 });
    expect(await db.claimNextHostedExecution({ workerId: "worker-extra", leaseMs: 60_000, maxUserConcurrent: 1 })).toBeUndefined();
    await db.completeHostedExecution({ executionId: initial[0]!.execution.id, userId: initial[0]!.execution.userId, workerId: "worker-0", leaseToken: initial[0]!.lease.id, status: "completed" });
    await db.completeHostedExecution({ executionId: initial[1]!.execution.id, userId: initial[1]!.execution.userId, workerId: "worker-1", leaseToken: initial[1]!.lease.id, status: "completed" });
    expect(await db.claimNextHostedExecution({ workerId: "worker-after-drop", leaseMs: 60_000, maxUserConcurrent: 1 })).toBeDefined();
  });

  it("fences a stale worker out of dispatch, renewal, and completion after reclaim", async () => {
    const clock = Date.now() + 1_000;
    await enqueue(users[0]!, "fencing");
    const stale = await db.claimNextHostedExecution({ workerId: "worker-stale", leaseMs: 10, maxUserConcurrent: 1, now: new Date(clock) });
    expect(stale).toBeDefined();
    const staleToken = stale!.lease.id;

    // The lease expires and a new worker reclaims the execution pre-dispatch.
    expect((await db.recoverExpiredHostedLeases(new Date(clock + 11))).recovered).toBe(1);
    const fresh = await db.claimNextHostedExecution({ workerId: "worker-fresh", leaseMs: 60_000, maxUserConcurrent: 1, now: new Date(clock + 12) });
    expect(fresh).toBeDefined();
    expect(fresh!.execution.leaseToken).not.toBe(staleToken);

    // The stale worker can no longer dispatch, renew, or terminalize the reclaimed execution.
    await expect(db.markHostedExecutionDispatching({ executionId: stale!.execution.id, workerId: "worker-stale", leaseToken: staleToken })).rejects.toThrow(/lease/);
    await expect(db.renewHostedExecutionLease({ executionId: stale!.execution.id, workerId: "worker-stale", leaseToken: staleToken, leaseMs: 60_000 })).rejects.toThrow(/not found/i);
    await expect(db.completeHostedExecution({ executionId: stale!.execution.id, userId: users[0]!, workerId: "worker-stale", leaseToken: staleToken, status: "completed" })).rejects.toThrow(/fencing/i);

    // The fresh worker's dispatch succeeds and the stale worker still cannot overwrite it.
    await db.markHostedExecutionDispatching({ executionId: fresh!.execution.id, workerId: "worker-fresh", leaseToken: fresh!.lease.id });
    await expect(db.completeHostedExecution({ executionId: fresh!.execution.id, userId: users[0]!, workerId: "worker-stale", leaseToken: staleToken, status: "failed" })).rejects.toThrow(/fencing/i);
    const completed = await db.completeHostedExecution({ executionId: fresh!.execution.id, userId: users[0]!, workerId: "worker-fresh", leaseToken: fresh!.lease.id, status: "completed" });
    expect(completed.transitioned).toBe(true);
  });

  it("persists request and result payloads, and keeps the status list payload-free", async () => {
    const requestPayload = JSON.stringify({ request: { requestId: "r1", messages: [{ role: "user", content: "hello" }] } });
    await db.enqueueHostedExecution({ id: "execution-payload", idempotencyKey: "key-payload", userId: users[0]!, taskId: "task-payload", ...route, requestPayload });
    const claim = await db.claimNextHostedExecution({ workerId: "worker", leaseMs: 60_000, maxUserConcurrent: 1 });
    expect(claim!.execution.requestPayload).toBe(requestPayload);
    await db.markHostedExecutionDispatching({ executionId: claim!.execution.id, workerId: "worker", leaseToken: claim!.lease.id });
    const resultPayload = JSON.stringify({ outcome: { fullText: "done" }, events: [] });
    await db.completeHostedExecution({ executionId: claim!.execution.id, userId: users[0]!, workerId: "worker", leaseToken: claim!.lease.id, status: "completed", resultPayload });

    const stored = await db.getHostedExecution(claim!.execution.id, users[0]!);
    expect(stored?.resultPayload).toBe(resultPayload);
    expect(stored?.terminalAt).toBeTruthy();
    expect(stored?.dispatchedAt).toBeTruthy();

    const listed = await db.listHostedExecutions(users[0]!);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.requestPayload).toBeNull();
    expect(listed[0]!.resultPayload).toBeNull();
  });

  it("links child executions to a live same-user parent and cascades cancellation", async () => {
    const parent = await enqueue(users[0]!, "parent");
    const child = await db.enqueueHostedExecution({ id: "execution-child", idempotencyKey: "key-child", userId: users[0]!, taskId: "task-child", ...route, parentExecutionId: parent.execution.id });
    expect(child.execution.parentExecutionId).toBe(parent.execution.id);
    expect(child.execution.rootExecutionId).toBe(parent.execution.id);
    const grandchild = await db.enqueueHostedExecution({ id: "execution-grandchild", idempotencyKey: "key-grandchild", userId: users[0]!, taskId: "task-grandchild", ...route, parentExecutionId: child.execution.id });
    expect(grandchild.execution.rootExecutionId).toBe(parent.execution.id);

    // Cross-user and terminal-parent children are rejected before they can occupy the queue.
    await expect(db.enqueueHostedExecution({ id: "execution-foreign", idempotencyKey: "key-foreign", userId: users[1]!, taskId: "task-foreign", ...route, parentExecutionId: parent.execution.id })).rejects.toThrow(/another user/);

    const children = await db.listHostedExecutionChildren(parent.execution.id, users[0]!);
    expect(children.map((c) => c.id)).toEqual([child.execution.id]);
    await expect(db.listHostedExecutionChildren(parent.execution.id, users[1]!)).rejects.toThrow(/not found/);

    const cancelled = await db.cancelHostedExecution({ executionId: parent.execution.id, userId: users[0]! });
    expect(cancelled.cancelledChildIds.sort()).toEqual([child.execution.id, grandchild.execution.id].sort());
    expect((await db.getHostedExecution(child.execution.id, users[0]!))?.status).toBe("cancelled");
    expect((await db.getHostedExecution(grandchild.execution.id, users[0]!))?.status).toBe("cancelled");
    await expect(db.enqueueHostedExecution({ id: "execution-orphan", idempotencyKey: "key-orphan", userId: users[0]!, taskId: "task-orphan", ...route, parentExecutionId: parent.execution.id })).rejects.toThrow(/terminal/);
  });

  it("resolves recovery_pending to failed exactly once and releases its capacity", async () => {
    const clock = Date.now() + 1_000;
    await enqueue(users[0]!, "ambiguous");
    const claim = await db.claimNextHostedExecution({ workerId: "worker-crashed", leaseMs: 10, maxUserConcurrent: 1, now: new Date(clock) });
    await db.markHostedExecutionDispatching({ executionId: claim!.execution.id, workerId: "worker-crashed", leaseToken: claim!.lease.id });
    await db.recoverExpiredHostedLeases(new Date(clock + 11));
    expect((await db.getHostedExecution(claim!.execution.id, users[0]!))?.status).toBe("recovery_pending");

    const resolved = await db.resolveHostedRecoveryPending({ executionId: claim!.execution.id, workerId: "worker-recovery" });
    expect(resolved.transitioned).toBe(true);
    expect(resolved.execution.status).toBe("failed");
    expect(resolved.execution.resultError).toMatch(/ambiguous/i);
    expect((await db.getHostedAdmissionMetrics()).activeReservations).toBe(0);

    const again = await db.resolveHostedRecoveryPending({ executionId: claim!.execution.id, workerId: "worker-recovery" });
    expect(again.transitioned).toBe(false);
    // Terminal state is stable: nothing requeues a resolved execution into a duplicate provider call.
    expect(await db.claimNextHostedExecution({ workerId: "worker-next", leaseMs: 10, maxUserConcurrent: 1, now: new Date(clock + 20) })).toBeUndefined();
  });
});
