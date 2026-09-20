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
      await db.completeHostedExecution({ executionId: claim!.execution.id, userId: claim!.execution.userId, status: "completed" });
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
    await db.markHostedExecutionDispatching({ executionId: reclaimed!.execution.id, workerId: "worker-b" });
    expect((await db.recoverExpiredHostedLeases(new Date(clock + 23))).recovered).toBe(1);
    expect((await db.getHostedExecution(reclaimed!.execution.id, users[0]!))?.status).toBe("recovery_pending");
    expect(await db.claimNextHostedExecution({ workerId: "worker-c", leaseMs: 10, maxUserConcurrent: 1, now: new Date(clock + 24) })).toBeUndefined();
  });

  it("reconciles cancellation and prevents cross-user cancellation or receipt access", async () => {
    await enqueue(users[0]!, "cancel");
    const claim = await db.claimNextHostedExecution({ workerId: "worker", leaseMs: 60_000, maxUserConcurrent: 1 });
    await db.markHostedExecutionDispatching({ executionId: claim!.execution.id, workerId: "worker" });
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
    const first = await db.completeHostedExecution({ executionId: claim!.execution.id, userId: users[0]!, status: "completed" });
    const duplicate = await db.completeHostedExecution({ executionId: claim!.execution.id, userId: users[0]!, status: "completed" });
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
    await db.completeHostedExecution({ executionId: initial[0]!.execution.id, userId: initial[0]!.execution.userId, status: "completed" });
    await db.completeHostedExecution({ executionId: initial[1]!.execution.id, userId: initial[1]!.execution.userId, status: "completed" });
    expect(await db.claimNextHostedExecution({ workerId: "worker-after-drop", leaseMs: 60_000, maxUserConcurrent: 1 })).toBeDefined();
  });
});
