import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { SQLiteCloudDatabase } from "../src/sqlite.js";
import type { HostedExecutionEvent, ICloudDatabase } from "../src/index.js";

const route = { providerId: "synthetic-dist", modelId: "free-model" };

const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("hosted distributed-runtime primitives — SQLite parity", () => {
  let db: SQLiteCloudDatabase;
  let userId: string;

  beforeEach(async () => {
    db = new SQLiteCloudDatabase();
    userId = (await db.createUser({ displayName: "Dist User", primaryIdentity: `dist:${randomUUID()}` })).id;
    await db.setHostedProviderCapacity({ ...route, maxConcurrent: 4 });
  });

  afterEach(async () => {
    await db.close();
  });

  const enqueue = async (suffix: string, extra: Record<string, unknown> = {}) =>
    db.enqueueHostedExecution({ id: `execution-${suffix}`, idempotencyKey: `key-${suffix}`, userId, taskId: `task-${suffix}`, ...route, ...extra });

  it("emits a correlation-only cancellation event after the durable commit", async () => {
    const events: HostedExecutionEvent[] = [];
    const sub = await db.subscribeHostedExecutionEvents((event) => events.push(event));
    try {
      const parent = await enqueue("evt-parent");
      const child = await enqueue("evt-child", { parentExecutionId: parent.execution.id, rootExecutionId: parent.execution.id });
      await db.cancelHostedExecution({ executionId: parent.execution.id, userId });
      await nextTick();
      const cancelEvents = events.filter((event) => event.kind === "execution.cancelled");
      expect(cancelEvents).toHaveLength(1);
      expect(cancelEvents[0]!.executionIds).toEqual(expect.arrayContaining([parent.execution.id, child.execution.id]));
      // The event must arrive only after the durable row is already terminal — a receiver that
      // re-reads immediately must see the committed state, never a stale one.
      expect((await db.getHostedExecution(parent.execution.id, userId))?.status).toBe("cancelled");
    } finally {
      await sub.close();
    }
  });

  it("stops emitting after the subscription closes", async () => {
    const events: HostedExecutionEvent[] = [];
    const sub = await db.subscribeHostedExecutionEvents((event) => events.push(event));
    await sub.close();
    const parent = await enqueue("evt-closed");
    await db.cancelHostedExecution({ executionId: parent.execution.id, userId });
    await nextTick();
    expect(events).toHaveLength(0);
  });

  it("reports batched terminal state for the cancellation observer", async () => {
    const a = await enqueue("term-a");
    const b = await enqueue("term-b");
    const c = await enqueue("term-c");
    await db.cancelHostedExecution({ executionId: a.execution.id, userId });
    const claim = await db.claimNextHostedExecution({ workerId: "w", leaseMs: 60_000, maxUserConcurrent: 4 });
    expect(claim).toBeDefined();
    const terminal = await db.listHostedTerminalExecutionIds([a.execution.id, b.execution.id, c.execution.id, "missing-id"]);
    expect(terminal).toEqual([a.execution.id]);
    expect(await db.listHostedTerminalExecutionIds([])).toEqual([]);
  });

  it("requeues recovery_pending only when a provider dispatch identity exists", async () => {
    const clock = Date.now() + 1_000;
    // Ambiguous route: no dispatch identity → requeue is forbidden, failed is the only resolution.
    const ambiguous = await enqueue("amb");
    const ambClaim = await db.claimNextHostedExecution({ workerId: "w1", leaseMs: 10, maxUserConcurrent: 4, now: new Date(clock) });
    await db.markHostedExecutionDispatching({ executionId: ambClaim!.execution.id, workerId: "w1", leaseToken: ambClaim!.lease.id });
    await db.recoverExpiredHostedLeases(new Date(clock + 11));
    await expect(db.resolveHostedRecoveryPending({ executionId: ambiguous.execution.id, workerId: "recovery", resolution: "requeue" })).rejects.toThrow(/dispatch identity/);
    const failed = await db.resolveHostedRecoveryPending({ executionId: ambiguous.execution.id, workerId: "recovery" });
    expect(failed.execution.status).toBe("failed");
    expect(failed.execution.resultError).toMatch(/ambiguous/i);

    // Safe-retry route: a persisted dispatch identity permits requeue and the identity survives.
    const safe = await enqueue("safe");
    const safeClaim = await db.claimNextHostedExecution({ workerId: "w2", leaseMs: 10, maxUserConcurrent: 4, now: new Date(clock) });
    await db.markHostedExecutionDispatching({ executionId: safeClaim!.execution.id, workerId: "w2", leaseToken: safeClaim!.lease.id, providerDispatchId: safeClaim!.execution.id });
    expect((await db.getHostedExecution(safe.execution.id, userId))?.providerDispatchId).toBe(safe.execution.id);
    await db.recoverExpiredHostedLeases(new Date(clock + 11));
    const requeued = await db.resolveHostedRecoveryPending({ executionId: safe.execution.id, workerId: "recovery", resolution: "requeue" });
    expect(requeued.transitioned).toBe(true);
    expect(requeued.execution.status).toBe("queued");
    expect(requeued.execution.providerDispatchId).toBe(safe.execution.id);
    // Requeued work is claimable again — with the same dispatch identity for provider dedupe.
    const reclaim = await db.claimNextHostedExecution({ workerId: "w3", leaseMs: 60_000, maxUserConcurrent: 4, now: new Date(clock + 12) });
    expect(reclaim?.execution.id).toBe(safe.execution.id);
    expect(reclaim?.execution.providerDispatchId).toBe(safe.execution.id);
  });

  it("enforces fan-out budgets atomically under concurrent child enqueues", async () => {
    const parent = await enqueue("fanout-parent");
    const limits = { maxChildrenPerParent: 4, maxDescendantsPerRoot: 6, maxDepth: 2 };
    // Race 10 concurrent children at a parent budgeted for 4 — the durable check must hold.
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => enqueue(`fanout-${index}`, { parentExecutionId: parent.execution.id, rootExecutionId: parent.execution.id, fanOutLimits: limits })));
    const created = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(created).toHaveLength(4);
    expect(rejected).toHaveLength(6);
    for (const failure of rejected) expect(String((failure as PromiseRejectedResult).reason)).toMatch(/fan-out budget/);
    const children = await db.listHostedExecutionChildren(parent.execution.id, userId);
    expect(children).toHaveLength(4);

    // Depth: a grandchild (depth 2) is allowed, a great-grandchild (depth 3) is not.
    const child = children[0]!;
    const grandchild = await enqueue("fanout-gc", { parentExecutionId: child.id, rootExecutionId: parent.execution.id, fanOutLimits: limits });
    expect(grandchild.execution.depth).toBe(2);
    await expect(enqueue("fanout-ggc", { parentExecutionId: grandchild.execution.id, rootExecutionId: parent.execution.id, fanOutLimits: limits })).rejects.toThrow(/depth 3 exceeds limit 2/);

    // Descendant ceiling: 4 children + 1 grandchild = 5; one more descendant reaches 6 → next is refused.
    const secondChild = children[1]!;
    await enqueue("fanout-gc2", { parentExecutionId: secondChild.id, rootExecutionId: parent.execution.id, fanOutLimits: limits });
    await expect(enqueue("fanout-gc3", { parentExecutionId: children[2]!.id, rootExecutionId: parent.execution.id, fanOutLimits: limits })).rejects.toThrow(/descendants/);
  });

  it("rejects a forged rootExecutionId and admits a child only under the authoritative root", async () => {
    const root = await enqueue("root-real");
    const otherRoot = await enqueue("root-other");
    const child = await enqueue("root-child", { parentExecutionId: root.execution.id, rootExecutionId: root.execution.id });
    expect(child.execution.rootExecutionId).toBe(root.execution.id);
    await expect(enqueue("forged", { parentExecutionId: child.execution.id, rootExecutionId: otherRoot.execution.id })).rejects.toThrow(/authoritative root/);
  });

  it("returns owner-scoped tree statistics without payload disclosure", async () => {
    const root = await enqueue("stats-root");
    const a = await enqueue("stats-a", { parentExecutionId: root.execution.id, rootExecutionId: root.execution.id });
    const b = await enqueue("stats-b", { parentExecutionId: root.execution.id, rootExecutionId: root.execution.id });
    await enqueue("stats-gc", { parentExecutionId: a.execution.id, rootExecutionId: root.execution.id });
    await db.cancelHostedExecution({ executionId: b.execution.id, userId });
    const claim = await db.claimNextHostedExecution({ workerId: "stats-w", leaseMs: 60_000, maxUserConcurrent: 4 });
    expect(claim).toBeDefined();

    const stats = await db.getHostedExecutionTreeStats(root.execution.id, userId);
    expect(stats).toBeDefined();
    expect(stats!.totalExecutions).toBe(4);
    expect(stats!.byStatus.cancelled).toBe(1);
    expect(stats!.byStatus.claimed ?? stats!.byStatus.queued).toBeDefined();
    expect(stats!.providerDispatchAttempts).toBe(1);
    expect(stats!.maxDepth).toBe(2);
    // Foreign users get no tree existence signal.
    const other = (await db.createUser({ displayName: "Other", primaryIdentity: `other:${randomUUID()}` })).id;
    expect(await db.getHostedExecutionTreeStats(root.execution.id, other)).toBeUndefined();
    expect(stats && "resultPayload" in stats).toBe(false);
  });
});
